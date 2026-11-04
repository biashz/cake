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

async function readSettingsFile(file: string): Promise<CakeSettings | undefined> {
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
  return { permissions: parsed.data.permissions };
}

/**
 * Load layered settings: global `~/.cake/settings.json` first, then the project
 * `.cake/settings.json`. Lists are concatenated so project rules can add to or
 * override (deny always wins) global rules.
 */
export async function loadSettings(options: LoadSettingsOptions = {}): Promise<CakeSettings> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();
  const files = [
    path.join(home, '.cake', 'settings.json'),
    path.join(cwd, '.cake', 'settings.json'),
  ];

  const allow: string[] = [];
  const deny: string[] = [];
  for (const file of files) {
    const settings = await readSettingsFile(file);
    if (!settings) continue;
    allow.push(...settings.permissions.allow);
    deny.push(...settings.permissions.deny);
  }
  return { permissions: { allow, deny } };
}
