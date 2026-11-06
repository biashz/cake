import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configPaths } from '../config/config.js';
import { mcpConfigPaths } from '../mcp/config.js';
import { settingsPaths } from '../permissions/settings.js';
import { defaultIndexFile } from '../rag/index-store.js';
import { defaultSessionFile } from '../session/store.js';
import type { DoctorFileTarget, DoctorStoreTarget } from './doctor.js';

export interface DoctorTargetOptions {
  cwd: string;
  homeDir?: string;
}

/**
 * Resolve a fix to the file it points at. Only the target name crosses the IPC
 * boundary, so the renderer can never ask the app to open an arbitrary path.
 */
export function doctorFilePath(target: DoctorFileTarget, options: DoctorTargetOptions): string {
  const { cwd, homeDir } = options;
  const config = configPaths(cwd, homeDir);
  const mcp = mcpConfigPaths(cwd, homeDir);
  const settings = settingsPaths(cwd, homeDir);
  switch (target) {
    case 'config-project':
      return config.project;
    case 'config-global':
      return config.global;
    case 'mcp-project':
      return mcp.project;
    case 'mcp-global':
      return mcp.global;
    case 'settings-project':
      return settings.project;
    case 'settings-global':
      return settings.global;
  }
}

/** A store file is SQLite, so the fix can only reveal it, never open it for editing. */
export function doctorStorePath(target: DoctorStoreTarget, options: DoctorTargetOptions): string {
  return target === 'sessions' ? defaultSessionFile(options.cwd) : defaultIndexFile(options.cwd);
}

/** What a freshly created config file should hold so it loads as-is. */
function skeleton(target: DoctorFileTarget): string {
  if (target.startsWith('mcp')) return `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
  if (target.startsWith('settings'))
    return `${JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2)}\n`;
  return `${JSON.stringify({}, null, 2)}\n`;
}

/**
 * The file a fix opens, created with an empty-but-valid entry when it is missing,
 * so "no config yet" and "broken config" both end at something editable.
 */
export async function ensureDoctorFile(
  target: DoctorFileTarget,
  options: DoctorTargetOptions,
): Promise<string> {
  const file = doctorFilePath(target, options);
  if (existsSync(file)) return file;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, skeleton(target), 'utf8');
  return file;
}
