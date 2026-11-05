import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { configPaths, loadConfig } from '../config/config.js';
import { loadMcpConfig, mcpConfigPaths } from '../mcp/config.js';
import { loadSettings } from '../permissions/settings.js';
import { createDefaultRegistry } from '../providers/registry.js';
import { CodeIndexStore, defaultIndexFile } from '../rag/index-store.js';
import { defaultSessionFile, SessionStore } from '../session/store.js';
import { VERSION } from '../version.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  label: string;
  status: CheckStatus;
  detail: string;
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

function indexCheck(cwd: string): DoctorCheck {
  const file = defaultIndexFile(cwd);
  if (!existsSync(file)) {
    return {
      label: 'code index',
      status: 'warn',
      detail: 'not indexed yet; use @codebase in a prompt to build it',
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
    return { label: 'code index', status: 'fail', detail: `unreadable: ${(err as Error).message}` };
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
    return { label: 'sessions', status: 'fail', detail: `unreadable: ${(err as Error).message}` };
  }
}

/** Inspect the local environment and configuration without contacting any provider. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();
  const env = options.env ?? (process.env as Record<string, string | undefined>);
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
    });
  }
  checks.push({
    label: 'semantic search',
    status: registry.getApiKey('openai') ? 'ok' : 'warn',
    detail: registry.getApiKey('openai')
      ? 'enabled (OpenAI embeddings)'
      : 'disabled; set OPENAI_API_KEY for @codebase semantic search',
  });

  try {
    const settings = await loadSettings({ cwd, homeDir: home });
    checks.push({
      label: 'permission settings',
      status: 'ok',
      detail: `${settings.permissions.allow.length} allow / ${settings.permissions.deny.length} deny rules`,
    });
  } catch (err) {
    checks.push({ label: 'permission settings', status: 'fail', detail: (err as Error).message });
  }

  try {
    const mcp = loadMcpConfig({ cwd, homeDir: home, env });
    const paths = mcpConfigPaths(cwd, home);
    checks.push({
      label: 'MCP servers',
      status: 'ok',
      detail:
        mcp.servers.length === 0
          ? `none configured (${paths.project})`
          : mcp.servers.map((server) => `${server.name} (${server.transport})`).join(', '),
    });
  } catch (err) {
    checks.push({ label: 'MCP servers', status: 'fail', detail: (err as Error).message });
  }

  checks.push(sessionCheck(cwd));
  checks.push(indexCheck(cwd));

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
