import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { PermissionClass } from '../tools/types.js';

const PermissionSchema = z.enum(['read', 'write', 'shell']);

const StdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  permission: PermissionSchema.optional(),
  maxTools: z.number().int().min(1).optional(),
});

const HttpServerSchema = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  permission: PermissionSchema.optional(),
  maxTools: z.number().int().min(1).optional(),
});

const ServerSchema = z.union([StdioServerSchema, HttpServerSchema]);

const FileSchema = z.object({
  mcpServers: z.record(z.string(), ServerSchema).default({}),
});

interface McpConfigBase {
  name: string;
  /** Explicit tool permission class; otherwise inferred from tool annotations. */
  permission?: PermissionClass;
  /** Directly exposed tools per server; extras move behind a meta tool. */
  maxTools: number;
  /** Directory used to resolve a relative `cwd`. */
  baseDir: string;
  source: string;
}

export interface McpStdioConfig extends McpConfigBase {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig extends McpConfigBase {
  transport: 'http';
  url: string;
  headers: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpLoadOptions {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export interface McpConfigResult {
  servers: McpServerConfig[];
  /** Paths that contributed at least one server. */
  files: string[];
}

const DEFAULT_MAX_TOOLS = 24;

function expandEnv(value: string, env: Record<string, string | undefined>, source: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new Error(`${source} references environment variable ${name}, which is not set`);
    }
    return resolved;
  });
}

function expandRecord(
  record: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
  source: string,
): Record<string, string> {
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, expandEnv(value, env, source)]),
  );
}

export function mcpConfigPaths(
  cwd = process.cwd(),
  home = homedir(),
): { global: string; project: string } {
  return {
    global: path.join(home, '.cake', 'mcp.json'),
    project: path.join(cwd, '.cake', 'mcp.json'),
  };
}

function readFile(file: string): unknown | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Failed to read MCP config at ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in MCP config at ${file}: ${(err as Error).message}`);
  }
}

function parseServer(
  name: string,
  value: unknown,
  options: { baseDir: string; source: string; env: Record<string, string | undefined> },
): McpServerConfig {
  const parsed = ServerSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid MCP server "${name}" in ${options.source}: ${parsed.error.message}`);
  }
  const base = {
    name,
    ...(parsed.data.permission ? { permission: parsed.data.permission as PermissionClass } : {}),
    maxTools: parsed.data.maxTools ?? DEFAULT_MAX_TOOLS,
    baseDir: options.baseDir,
    source: options.source,
  };
  if ('command' in parsed.data) {
    return {
      ...base,
      transport: 'stdio',
      command: expandEnv(parsed.data.command, options.env, options.source),
      args: (parsed.data.args ?? []).map((arg) => expandEnv(arg, options.env, options.source)),
      env: expandRecord(parsed.data.env, options.env, options.source),
      ...(parsed.data.cwd
        ? {
            cwd: path.resolve(
              options.baseDir,
              expandEnv(parsed.data.cwd, options.env, options.source),
            ),
          }
        : {}),
    };
  }
  return {
    ...base,
    transport: 'http',
    url: expandEnv(parsed.data.url, options.env, options.source),
    headers: expandRecord(parsed.data.headers, options.env, options.source),
  };
}

function parseFile(
  file: string,
  baseDir: string,
  env: Record<string, string | undefined>,
): McpServerConfig[] {
  const raw = readFile(file);
  if (raw === undefined) return [];
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid MCP config at ${file}: ${parsed.error.message}`);
  }
  return Object.entries(parsed.data.mcpServers).map(([name, value]) =>
    parseServer(name, value, { baseDir, source: file, env }),
  );
}

/**
 * Load MCP servers from `<home>/.cake/mcp.json` and `<cwd>/.cake/mcp.json`.
 * A project entry with the same name replaces the global one. Missing files are
 * fine; malformed files throw so configuration errors surface early.
 */
export function loadMcpConfig(options: McpLoadOptions = {}): McpConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const paths = mcpConfigPaths(cwd, home);

  const merged = new Map<string, McpServerConfig>();
  const files: string[] = [];
  for (const [file, baseDir] of [
    [paths.global, home],
    [paths.project, cwd],
  ] as const) {
    const servers = parseFile(file, baseDir, env);
    if (servers.length > 0) files.push(file);
    for (const server of servers) merged.set(server.name, server);
  }
  return { servers: [...merged.values()], files };
}
