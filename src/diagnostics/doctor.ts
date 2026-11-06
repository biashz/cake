import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { configPaths, loadConfig } from '../config/config.js';
import { loadMcpConfig, mcpConfigPaths } from '../mcp/config.js';
import { loadSettings, settingsPaths } from '../permissions/settings.js';
import { createDefaultRegistry } from '../providers/registry.js';
import { CodeIndexStore, defaultIndexFile } from '../rag/index-store.js';
import { defaultSessionFile, SessionStore } from '../session/store.js';
import { VERSION } from '../version.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** Which config file a fix should open; resolved to a path in the main process. */
export type DoctorFileTarget =
  | 'config-project'
  | 'config-global'
  | 'mcp-project'
  | 'mcp-global'
  | 'settings-project'
  | 'settings-global';

/** A store file that cannot be edited as text, so the fix only reveals it. */
export type DoctorStoreTarget = 'sessions' | 'index';

/**
 * What the app can actually do about a check. Every warn or fail carries one when
 * there is an action; the ones left without it need something outside cake.
 */
export type DoctorFix =
  | { kind: 'set-key'; provider: string; envVar: string }
  | { kind: 'reindex' }
  | { kind: 'reload-mcp' }
  | { kind: 'open-workspace' }
  | { kind: 'open-file'; target: DoctorFileTarget }
  | { kind: 'reveal'; target: DoctorStoreTarget };

export interface DoctorCheck {
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: DoctorFix;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorOptions {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  /** False when no workspace is open, so file fixes become "open a workspace". */
  hasWorkspace?: boolean;
}

const MIN_MAJOR = 22;
const MIN_MINOR = 5;

function parseVersion(value: string): [number, number] {
  const [major = 0, minor = 0] =
    value
      .replace(/^v/, '')
      .split('-')[0]
      ?.split('.')
      .map((part) => Number.parseInt(part, 10) || 0) ?? [];
  return [major, minor];
}

function nodeCheck(version: string): DoctorCheck {
  const [major, minor] = parseVersion(version);
  const ok = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
  return {
    label: `Node >= ${MIN_MAJOR}.${MIN_MINOR}`,
    status: ok ? 'ok' : 'fail',
    detail: ok ? version : `${version} is too old; node:sqlite needs >= ${MIN_MAJOR}.${MIN_MINOR}`,
  };
}

function fileCheck(label: string, file: string, missing: string): DoctorCheck {
  return existsSync(file)
    ? { label, status: 'ok', detail: file }
    : { label, status: 'ok', detail: `${missing} (${file})` };
}

type TargetPair = readonly [
  { path: string; target: DoctorFileTarget },
  { path: string; target: DoctorFileTarget },
];

/** The file worth opening: the workspace's own when it exists, else the global one. */
function problemTarget([project, global]: TargetPair): DoctorFileTarget {
  return existsSync(project.path) ? project.target : global.target;
}

function indexCheck(cwd: string, hasWorkspace: boolean, canEmbed: boolean): DoctorCheck {
  const file = defaultIndexFile(cwd);
  if (!hasWorkspace) {
    return {
      label: 'code index',
      status: 'warn',
      detail: 'no workspace open, so nothing is indexed',
      fix: { kind: 'open-workspace' },
    };
  }
  if (!existsSync(file)) {
    return canEmbed
      ? {
          label: 'code index',
          status: 'warn',
          detail: 'not indexed yet; build it now or mention @codebase in a prompt',
          fix: { kind: 'reindex' },
        }
      : {
          label: 'code index',
          status: 'warn',
          detail: 'not indexed yet; embeddings need an OpenAI key before any file can be indexed',
          fix: { kind: 'set-key', provider: 'openai', envVar: 'OPENAI_API_KEY' },
        };
  }
  try {
    const store = CodeIndexStore.open(file);
    try {
      const stats = store.stats();
      return {
        label: 'code index',
        status: 'ok',
        detail: `${stats.chunks} chunks across ${stats.files} files (${file})`,
      };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      label: 'code index',
      status: 'fail',
      detail: `unreadable: ${(err as Error).message}`,
      fix: { kind: 'reveal', target: 'index' },
    };
  }
}

function sessionCheck(cwd: string): DoctorCheck {
  const file = defaultSessionFile(cwd);
  if (!existsSync(file)) {
    return { label: 'sessions', status: 'ok', detail: 'none yet (created on first run)' };
  }
  try {
    const store = SessionStore.open(file);
    try {
      const latest = store.latest(cwd);
      return {
        label: 'sessions',
        status: 'ok',
        detail: latest
          ? `latest ${latest.id.slice(0, 8)} “${latest.title ?? 'untitled'}” (${file})`
          : `${file} (no sessions for this workspace)`,
      };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      label: 'sessions',
      status: 'fail',
      detail: `unreadable: ${(err as Error).message}`,
      fix: { kind: 'reveal', target: 'sessions' },
    };
  }
}

/** Inspect the local environment and configuration without contacting any provider. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const hasWorkspace = options.hasWorkspace ?? true;
  const checks: DoctorCheck[] = [nodeCheck(options.nodeVersion ?? process.versions.node)];

  if (typeof (process.versions as Record<string, string | undefined>).sqlite !== 'string') {
    checks.push({
      label: 'node:sqlite',
      status: 'fail',
      detail: 'module unavailable; sessions and the code index need Node >= 22.5',
    });
  } else {
    checks.push({ label: 'node:sqlite', status: 'ok', detail: 'available' });
  }

  const config = loadConfig({ cwd, homeDir: home, env });
  const paths = configPaths(cwd, home);
  checks.push(fileCheck('global config', paths.global, 'absent (env/defaults apply)'));
  checks.push(fileCheck('project config', paths.project, 'absent (fine, optional)'));

  const registry = createDefaultRegistry(config, env);
  for (const provider of registry.list()) {
    const key = registry.getApiKey(provider.id);
    checks.push({
      label: `${provider.id} API key`,
      status: key ? 'ok' : 'warn',
      detail: key
        ? 'resolved'
        : `missing; set ${provider.apiKeyEnvVar} or providers.${provider.id}.apiKey`,
      fix: key
        ? undefined
        : { kind: 'set-key', provider: provider.id, envVar: provider.apiKeyEnvVar },
    });
  }
  const embeddingsKey = registry.getApiKey('openai');
  checks.push({
    label: 'semantic search',
    status: embeddingsKey ? 'ok' : 'warn',
    detail: embeddingsKey
      ? 'enabled (OpenAI embeddings)'
      : 'disabled; set OPENAI_API_KEY for @codebase semantic search',
    fix: embeddingsKey
      ? undefined
      : { kind: 'set-key', provider: 'openai', envVar: 'OPENAI_API_KEY' },
  });

  const settingsFiles = settingsPaths(cwd, home);
  try {
    const settings = await loadSettings({ cwd, homeDir: home });
    checks.push({
      label: 'permission settings',
      status: 'ok',
      detail: `${settings.permissions.allow.length} allow / ${settings.permissions.deny.length} deny rules`,
    });
  } catch (err) {
    checks.push({
      label: 'permission settings',
      status: 'fail',
      detail: (err as Error).message,
      fix: {
        kind: 'open-file',
        target: problemTarget([
          { path: settingsFiles.project, target: 'settings-project' },
          { path: settingsFiles.global, target: 'settings-global' },
        ]),
      },
    });
  }

  const mcpFiles = mcpConfigPaths(cwd, home);
  try {
    const mcp = loadMcpConfig({ cwd, homeDir: home, env });
    checks.push({
      label: 'MCP servers',
      status: 'ok',
      detail:
        mcp.servers.length === 0
          ? `none configured (${mcpFiles.project})`
          : mcp.servers.map((server) => `${server.name} (${server.transport})`).join(', '),
      fix:
        mcp.servers.length === 0
          ? { kind: 'open-file', target: 'mcp-project' }
          : { kind: 'reload-mcp' },
    });
  } catch (err) {
    checks.push({
      label: 'MCP servers',
      status: 'fail',
      detail: (err as Error).message,
      fix: {
        kind: 'open-file',
        target: problemTarget([
          { path: mcpFiles.project, target: 'mcp-project' },
          { path: mcpFiles.global, target: 'mcp-global' },
        ]),
      },
    });
  }

  checks.push(sessionCheck(cwd));
  checks.push(indexCheck(cwd, hasWorkspace, Boolean(embeddingsKey)));

  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}

export function formatDoctor(report: DoctorReport): string {
  const fails = report.checks.filter((check) => check.status === 'fail').length;
  const warns = report.checks.filter((check) => check.status === 'warn').length;
  const lines = [
    `cake ${VERSION} · node ${process.versions.node} · ${process.platform} ${process.arch}`,
    '',
    ...report.checks.map((check) => `[${check.status}] ${check.label} — ${check.detail}`),
    '',
    report.ok
      ? `ready${warns > 0 ? ` (${warns} warning${warns === 1 ? '' : 's'})` : ''}`
      : `${fails} failure${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`,
  ];
  return lines.join('\n');
}
