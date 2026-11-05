import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool as McpToolDefinition } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  adaptMcpTool,
  createMcpMetaTool,
  formatMcpContent,
  mcpToolName,
} from '../src/mcp/adapt.js';
import type { ToolContext } from '../src/tools/types.js';

const ctx = {
  cwd: process.cwd(),
  tasks: [],
  askPermission: async () => 'allow',
  log: () => {},
} as ToolContext;

let server: McpServer;
let client: Client;
let definitions: McpToolDefinition[];

beforeEach(async () => {
  server = new McpServer({ name: 'demo', version: '1.0.0' });
  server.registerTool(
    'echo',
    {
      description: 'Echo text',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );
  server.registerTool(
    'add',
    { description: 'Add numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );
  server.registerTool('explode', { description: 'Always fails' }, async () => ({
    content: [{ type: 'text', text: 'kaboom' }],
    isError: true,
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  definitions = (await client.listTools()).tools;
});

afterEach(async () => {
  await client.close();
  await server.close();
});

function definition(name: string): McpToolDefinition {
  const found = definitions.find((item) => item.name === name);
  if (!found) throw new Error(`missing fixture tool ${name}`);
  return found;
}

describe('adaptMcpTool', () => {
  it('namespaces tool names and infers permissions from annotations', () => {
    const echo = adaptMcpTool({ server: 'demo', client }, definition('echo'));
    const add = adaptMcpTool({ server: 'demo', client }, definition('add'));

    expect(echo.name).toBe('mcp__demo__echo');
    expect(echo.permission).toBe('read');
    expect(add.permission).toBe('write');
    expect(add.matchTarget({ a: 1, b: 2 })).toBe('demo/add');
    expect(mcpToolName('my server', 'read-file')).toBe('mcp__my_server__read_file');
  });

  it('lets an explicit config permission override annotations', () => {
    const add = adaptMcpTool({ server: 'demo', client, permission: 'read' }, definition('add'));
    expect(add.permission).toBe('read');
  });

  it('executes a tool through the client and returns its text', async () => {
    const echo = adaptMcpTool({ server: 'demo', client }, definition('echo'));
    await expect(echo.execute({ text: 'hi' }, ctx)).resolves.toBe('hi');

    const add = adaptMcpTool({ server: 'demo', client }, definition('add'));
    await expect(add.execute({ a: 4, b: 5 }, ctx)).resolves.toBe('9');
  });

  it('turns MCP error results into thrown errors', async () => {
    const explode = adaptMcpTool({ server: 'demo', client }, definition('explode'));
    await expect(explode.execute({}, ctx)).rejects.toThrow(/kaboom/);
  });
});

describe('formatMcpContent', () => {
  it('flattens text, media and structured content', () => {
    const text = formatMcpContent({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } },
      ],
      structuredContent: { ok: true },
    });
    expect(text).toContain('hello');
    expect(text).toContain('[image image/png]');
    expect(text).toContain('[resource file:///a.txt]');
    expect(text).toContain('"ok":true');
  });
});

describe('createMcpMetaTool', () => {
  it('lists hidden schemas and calls a hidden tool by name', async () => {
    const hidden = [definition('add'), definition('explode')];
    const meta = createMcpMetaTool({ server: 'demo', client, permission: 'read' }, hidden);

    expect(meta.name).toBe('mcp__demo__more');
    expect(meta.permission).toBe('read');
    expect(meta.description).toContain('add');

    const listing = JSON.parse(await meta.execute({ action: 'list' }, ctx)) as Array<{
      name: string;
    }>;
    expect(listing.map((item) => item.name)).toEqual(['add', 'explode']);

    await expect(
      meta.execute({ action: 'call', tool: 'add', arguments: { a: 2, b: 3 } }, ctx),
    ).resolves.toBe('5');
    await expect(meta.execute({ action: 'call' }, ctx)).rejects.toThrow(/requires a tool name/);
    await expect(meta.execute({ action: 'call', tool: 'add', arguments: {} }, ctx)).rejects.toThrow(
      /Invalid arguments|invalid_type|expected number/i,
    );
  });
});
