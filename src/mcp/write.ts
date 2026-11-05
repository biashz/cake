import { z } from 'zod';
import type { ConfigRecord } from '../config/write.js';
import { updateJsonFile } from '../config/write.js';
import { type McpScope, mcpConfigPaths } from './config.js';

/**
 * What the panel can author. `env`, `cwd`, `headers` and `maxTools` stay things a
 * person edits in the file, so an entry written here keeps only what was typed.
 */
const NameField = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
    'Use a short name of letters, digits, dot, dash or underscore',
  );

const PermissionField = z.enum(['read', 'write', 'shell']);

export const McpDraftSchema = z.discriminatedUnion('transport', [
  z.object({
    name: NameField,
    transport: z.literal('stdio'),
    command: z.string().min(1).max(500),
    args: z.array(z.string().max(500)).max(32).default([]),
    permission: PermissionField.optional(),
    enabled: z.boolean().default(true),
  }),
  z.object({
    name: NameField,
    transport: z.literal('http'),
    url: z.url(),
    permission: PermissionField.optional(),
    enabled: z.boolean().default(true),
  }),
]);

export type McpDraft = z.infer<typeof McpDraftSchema>;

export interface McpTarget {
  cwd: string;
  homeDir?: string;
  scope: McpScope;
}

function fileFor(target: McpTarget): string {
  return mcpConfigPaths(target.cwd, target.homeDir)[target.scope];
}

function serversOf(config: ConfigRecord): ConfigRecord {
  const servers = config.mcpServers;
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? (servers as ConfigRecord)
    : {};
}

function requireEntry(servers: ConfigRecord, name: string, file: string): ConfigRecord {
  const entry = servers[name];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`No server "${name}" in ${file}`);
  }
  return entry as ConfigRecord;
}

/** The keys this panel authors; anything else in an entry was edited by hand. */
const OWNED_KEYS = ['command', 'args', 'url', 'permission', 'enabled'];

function entryOf(draft: McpDraft): ConfigRecord {
  const shared: ConfigRecord = {
    enabled: draft.enabled,
    ...(draft.permission ? { permission: draft.permission } : {}),
  };
  return draft.transport === 'stdio'
    ? { command: draft.command, ...(draft.args.length > 0 ? { args: draft.args } : {}), ...shared }
    : { url: draft.url, ...shared };
}

/**
 * Rewrite the keys this panel owns and keep the rest, so saving a server does not
 * silently drop the `env`, `cwd`, `headers` or `maxTools` someone typed by hand.
 */
function mergedEntry(existing: ConfigRecord | undefined, draft: McpDraft): ConfigRecord {
  const next: ConfigRecord = { ...(existing ?? {}) };
  for (const key of OWNED_KEYS) delete next[key];
  if (draft.transport === 'stdio') delete next.url;
  else {
    delete next.command;
    delete next.args;
  }
  return { ...next, ...entryOf(draft) };
}

/** Add or replace one server entry in this scope's file. */
export async function setMcpServer(target: McpTarget, draft: unknown): Promise<string> {
  const parsed = McpDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Cannot save server: ${
        issue ? `${issue.path.join('.') || 'entry'} — ${issue.message}` : 'invalid entry'
      }`,
    );
  }
  return updateJsonFile(fileFor(target), (config) => {
    const servers = serversOf(config);
    const existing = servers[parsed.data.name];
    servers[parsed.data.name] = mergedEntry(
      typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? (existing as ConfigRecord)
        : undefined,
      parsed.data,
    );
    config.mcpServers = servers;
    return config;
  });
}

export async function removeMcpServer(target: McpTarget, name: string): Promise<string> {
  const file = fileFor(target);
  return updateJsonFile(file, (config) => {
    const servers = serversOf(config);
    requireEntry(servers, name, file);
    delete servers[name];
    config.mcpServers = servers;
    return config;
  });
}

/** Switch a configured server off or back on without rewriting its entry. */
export async function setMcpEnabled(
  target: McpTarget,
  name: string,
  enabled: boolean,
): Promise<string> {
  const file = fileFor(target);
  return updateJsonFile(file, (config) => {
    const servers = serversOf(config);
    const entry = requireEntry(servers, name, file);
    servers[name] = { ...entry, enabled };
    config.mcpServers = servers;
    return config;
  });
}
