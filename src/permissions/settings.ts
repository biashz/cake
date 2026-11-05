import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { type PermissionRules, parseRule } from './rules.js';

const SettingsSchema = z.object({
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [] }),
});

export interface CakeSettings {
  permissions: PermissionRules;
}

export const DEFAULT_SETTINGS: CakeSettings = { permissions: { allow: [], deny: [] } };

export interface LoadSettingsOptions {
  cwd?: string;
  homeDir?: string;
}

/** Which file a rule lives in: the workspace's own, or the user-wide one. */
export type RuleScope = 'project' | 'global';

export interface SettingsLayer {
  scope: RuleScope;
  file: string;
  permissions: PermissionRules;
}

export function globalSettingsPath(homeDir: string | undefined = homedir()): string {
  return path.join(homeDir ?? homedir(), '.cake', 'settings.json');
}

export function settingsPaths(
  cwd: string,
  homeDir: string | undefined = homedir(),
): Record<RuleScope, string> {
  return {
    global: globalSettingsPath(homeDir),
    project: path.join(cwd, '.cake', 'settings.json'),
  };
}

async function readSettingsFile(file: string): Promise<PermissionRules | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid settings JSON: ${file}`);
  }
  const parsed = SettingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid settings: ${file} (${parsed.error.issues[0]?.message ?? 'schema'})`);
  }
  for (const rule of [...parsed.data.permissions.allow, ...parsed.data.permissions.deny]) {
    if (!parseRule(rule)) throw new Error(`Invalid permission rule "${rule}" in ${file}`);
  }
  return parsed.data.permissions;
}

/**
 * Load layered settings: global `~/.cake/settings.json` first, then the project
 * `.cake/settings.json`. Each layer keeps its own file, so the Inspector can say
 * where a rule came from and write back to the right scope.
 */
export async function loadSettingsLayers(
  options: LoadSettingsOptions = {},
): Promise<SettingsLayer[]> {
  const cwd = options.cwd ?? process.cwd();
  const paths = settingsPaths(cwd, options.homeDir);
  const layers: SettingsLayer[] = [];
  for (const scope of ['global', 'project'] as const) {
    const permissions = await readSettingsFile(paths[scope]);
    if (permissions) layers.push({ scope, file: paths[scope], permissions });
  }
  return layers;
}

/**
 * Lists are concatenated so project rules can add to or override (deny always
 * wins) global rules.
 */
export function mergeSettings(layers: SettingsLayer[]): PermissionRules {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const layer of layers) {
    allow.push(...layer.permissions.allow);
    deny.push(...layer.permissions.deny);
  }
  return { allow, deny };
}

export async function loadSettings(options: LoadSettingsOptions = {}): Promise<CakeSettings> {
  return { permissions: mergeSettings(await loadSettingsLayers(options)) };
}
