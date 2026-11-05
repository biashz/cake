import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CakeTool, PermissionClass } from '../tools/types.js';
import { VERSION } from '../version.js';
import { adaptMcpTool, createMcpMetaTool, type McpToolSource, mcpToolName } from './adapt.js';
import { loadMcpConfig, type McpScope, type McpServerConfig } from './config.js';

const CONNECT_TIMEOUT_MS = 15_000;

/** What the panel shows per configured server: live, switched off, or failing. */
export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  scope: McpScope;
  enabled: boolean;
  connected: boolean;
  tools: number;
  /** Why it is not connected; null while live or merely switched off. */
  error: string | null;
  /** The entry as written, so an edit can start from what is really configured. */
  target: { command: string; args: string[] } | { url: string };
  /** The permission class the file pins, null when the tools decide on their own. */
  permission: PermissionClass | null;
}

export interface McpBundle {
  tools: CakeTool[];
  /** Names of servers that connected successfully. */
  servers: string[];
  /** One row per configured server, including those that did not connect. */
  status: McpServerStatus[];
  warnings: string[];
  close(): Promise<void>;
}

export interface McpConnectOptions {
  cwd: string;
  connectTimeoutMs?: number;
  onWarning?: (message: string) => void;
}

interface Connection {
  name: string;
  client: Client;
  close(): Promise<void>;
}

function emptyBundle(): McpBundle {
  return { tools: [], servers: [], status: [], warnings: [], close: async () => {} };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serverEnv(config: McpServerConfig): Record<string, string> {
  if (config.transport !== 'stdio') return {};
  return { ...getDefaultEnvironment(), ...config.env };
}

async function connectOne(
  config: McpServerConfig,
  options: McpConnectOptions,
): Promise<{ connection: Connection; tools: CakeTool[] }> {
  const timeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const client = new Client({ name: 'cake', version: VERSION });
  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: serverEnv(config),
          cwd: config.cwd ?? options.cwd,
          stderr: 'inherit',
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
        });

  try {
    await withTimeout(client.connect(transport), timeout, `MCP server "${config.name}" connect`);
    const listed = await withTimeout(
      client.listTools(),
      timeout,
      `MCP server "${config.name}" listTools`,
    );

    const source: McpToolSource = {
      server: config.name,
      client,
      ...(config.permission ? { permission: config.permission } : {}),
    };
    const used = new Set<string>();
    const tools: CakeTool[] = [];

    for (const definition of listed.tools.slice(0, config.maxTools)) {
      let name = mcpToolName(config.name, definition.name);
      let suffix = 2;
      while (used.has(name)) name = `${mcpToolName(config.name, definition.name)}_${suffix++}`;
      used.add(name);
      tools.push(adaptMcpTool(source, definition, name));
    }
    const hidden = listed.tools.slice(config.maxTools);
    if (hidden.length > 0) {
      let name = mcpToolName(config.name, 'more');
      let suffix = 2;
      while (used.has(name)) name = `${mcpToolName(config.name, 'more')}_${suffix++}`;
      tools.push({ ...createMcpMetaTool(source, hidden), name });
    }

    return {
      connection: {
        name: config.name,
        client,
        close: async () => {
          await client.close();
        },
      },
      tools,
    };
  } catch (err) {
    await client.close().catch(() => {});
    throw new Error(`MCP server "${config.name}" unavailable: ${(err as Error).message}`);
  }
}

/** Connect every enabled server; failures become warnings and a failed row. */
export async function connectMcpServers(
  configs: McpServerConfig[],
  options: McpConnectOptions,
): Promise<McpBundle> {
  const warnings: string[] = [];
  const connections: Connection[] = [];
  const tools: CakeTool[] = [];
  const status: McpServerStatus[] = [];
  const used = new Set<string>();

  const warn = (message: string) => {
    warnings.push(message);
    options.onWarning?.(message);
  };

  for (const config of configs) {
    const row = {
      name: config.name,
      transport: config.transport,
      scope: config.scope,
      enabled: config.enabled,
      permission: config.permission ?? null,
      target:
        config.transport === 'stdio'
          ? { command: config.command, args: config.args }
          : { url: config.url },
    };
    if (!config.enabled) {
      status.push({ ...row, connected: false, tools: 0, error: null });
      continue;
    }
    try {
      const result = await connectOne(config, options);
      connections.push(result.connection);
      for (const tool of result.tools) {
        let name = tool.name;
        let suffix = 2;
        while (used.has(name)) name = `${tool.name}_${suffix++}`;
        used.add(name);
        tools.push(name === tool.name ? tool : { ...tool, name });
      }
      status.push({
        ...row,
        connected: true,
        tools: result.tools.length,
        error: null,
      });
    } catch (err) {
      const message = (err as Error).message;
      warn(message);
      status.push({ ...row, connected: false, tools: 0, error: message });
    }
  }

  let closed = false;
  return {
    tools,
    servers: connections.map((connection) => connection.name),
    status,
    warnings,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(connections.map((connection) => connection.close()));
    },
  };
}

/** Load `<home>/.cake/mcp.json` + `<cwd>/.cake/mcp.json` and connect. */
export async function openMcpServers(options: McpConnectOptions): Promise<McpBundle> {
  let servers: McpServerConfig[];
  try {
    servers = loadMcpConfig({ cwd: options.cwd }).servers;
  } catch (err) {
    options.onWarning?.((err as Error).message);
    return emptyBundle();
  }
  if (servers.length === 0) return emptyBundle();
  return connectMcpServers(servers, options);
}
