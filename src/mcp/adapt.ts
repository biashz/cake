import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult, Tool as McpToolDefinition } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CakeTool, PermissionClass } from '../tools/types.js';

const CALL_TIMEOUT_MS = 120_000;

export interface McpToolSource {
  server: string;
  client: Client;
  /** Explicit permission from config; annotations fill the gap otherwise. */
  permission?: PermissionClass;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`;
}

/** Flatten MCP content blocks into text the model can read. */
export function formatMcpContent(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    switch (item.type) {
      case 'text':
        parts.push(item.text);
        break;
      case 'image':
        parts.push(`[image ${item.mimeType}]`);
        break;
      case 'audio':
        parts.push(`[audio ${item.mimeType}]`);
        break;
      case 'resource':
        parts.push(`[resource ${item.resource.uri}]`);
        break;
      case 'resource_link':
        parts.push(`[resource ${item.uri}]`);
        break;
      default:
        parts.push(JSON.stringify(item));
    }
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const text = parts.join('\n').trim() || '(no content)';
  if (result.isError) throw new Error(`MCP tool failed: ${text}`);
  return text;
}

function inferPermission(source: McpToolSource, definition: McpToolDefinition): PermissionClass {
  if (source.permission) return source.permission;
  return definition.annotations?.readOnlyHint ? 'read' : 'write';
}

type ArgsSchema = z.ZodType<Record<string, unknown>, Record<string, unknown>>;

function inputSchemaFor(definition: McpToolDefinition): ArgsSchema {
  try {
    const schema = definition.inputSchema as unknown as Parameters<typeof z.fromJSONSchema>[0];
    return z.fromJSONSchema(schema) as unknown as ArgsSchema;
  } catch {
    return z.record(z.string(), z.unknown()) as unknown as ArgsSchema;
  }
}

function summariseArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args ?? {});
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

/** Adapt one MCP tool to the internal tool contract. */
export function adaptMcpTool(
  source: McpToolSource,
  definition: McpToolDefinition,
  name = mcpToolName(source.server, definition.name),
): CakeTool<Record<string, unknown>, string> {
  return {
    name,
    description: `[${source.server}] ${definition.description ?? definition.name}`,
    permission: inferPermission(source, definition),
    inputSchema: inputSchemaFor(definition),
    summarize: (args) => `${definition.name}(${summariseArgs(args)})`,
    matchTarget: () => `${source.server}/${definition.name}`,
    async execute(args) {
      const result = (await source.client.callTool(
        { name: definition.name, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      return formatMcpContent(result);
    },
  };
}

const metaSchema = z.object({
  action: z.enum(['list', 'call']).describe('list hidden tool schemas, or call one by name'),
  tool: z.string().optional().describe('Tool name (required for action=call)'),
  arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments for action=call'),
});

type MetaArgs = z.infer<typeof metaSchema>;

/**
 * Compact access to tools that were not exposed directly because the server's
 * catalog exceeded `maxTools`. Keeps large catalogs out of the prompt while
 * still making every tool reachable.
 */
export function createMcpMetaTool(
  source: McpToolSource,
  hidden: McpToolDefinition[],
): CakeTool<MetaArgs, string> {
  const names = hidden.map((tool) => tool.name);
  return {
    name: mcpToolName(source.server, 'more'),
    description: `[${source.server}] Access ${hidden.length} additional MCP tools: ${names.join(', ')}. Use action=list to inspect their input schemas, then action=call with a tool name and arguments.`,
    permission: source.permission ?? 'write',
    inputSchema: metaSchema,
    summarize: (args) =>
      args.action === 'call'
        ? `${args.tool ?? '?'}(${summariseArgs(args.arguments ?? {})})`
        : 'list',
    matchTarget: (args) => `${source.server}/${args.tool ?? 'list'}`,
    async execute(args) {
      if (args.action === 'list') {
        return JSON.stringify(
          hidden.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          null,
          2,
        );
      }
      if (!args.tool) throw new Error('action=call requires a tool name');
      const result = (await source.client.callTool(
        { name: args.tool, arguments: args.arguments ?? {} },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      return formatMcpContent(result);
    },
  };
}
