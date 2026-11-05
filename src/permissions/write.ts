import type { ConfigRecord } from '../config/write.js';
import { updateJsonFile } from '../config/write.js';
import type { PermissionRules } from './rules.js';
import { parseRule } from './rules.js';
import { loadSettingsLayers, type RuleScope, settingsPaths } from './settings.js';

/** Which of the two lists a rule belongs to. */
export type RuleList = keyof PermissionRules;

export interface RuleTarget {
  cwd: string;
  homeDir?: string;
  scope: RuleScope;
  list: RuleList;
}

const MAX_RULE_LENGTH = 200;

/**
 * Trim and validate a typed rule, failing with the shape the matcher expects
 * rather than accepting a string that would silently never fire.
 */
export function normalizeRule(input: string): string {
  const rule = input.trim();
  if (!rule) throw new Error('A rule is a tool name, optionally with a pattern');
  if (rule.length > MAX_RULE_LENGTH) {
    throw new Error(`Rule is too long (${rule.length} characters, max ${MAX_RULE_LENGTH})`);
  }
  if (!parseRule(rule)) {
    throw new Error(`Invalid rule "${rule}". Use tool or tool(pattern), e.g. bash(git log *)`);
  }
  return rule;
}

function fileFor(target: RuleTarget): string {
  return settingsPaths(target.cwd, target.homeDir)[target.scope];
}

function permissionsOf(config: ConfigRecord): ConfigRecord {
  const permissions = config.permissions;
  return typeof permissions === 'object' && permissions !== null && !Array.isArray(permissions)
    ? (permissions as ConfigRecord)
    : {};
}

function listOf(permissions: ConfigRecord, list: RuleList): string[] {
  const value = permissions[list];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Writes one list and normalizes the other, so the file always matches the schema. */
function writeList(target: RuleTarget, mutate: (rules: string[]) => string[]): Promise<string> {
  return updateJsonFile(fileFor(target), (config) => {
    const permissions = permissionsOf(config);
    for (const list of ['allow', 'deny'] as const) {
      const rules = listOf(permissions, list);
      permissions[list] = list === target.list ? mutate(rules) : rules;
    }
    config.permissions = permissions;
    return config;
  });
}

/** Append a rule to this scope's list; the same rule already set elsewhere is refused. */
export async function addRule(target: RuleTarget, rule: string): Promise<string> {
  const key = normalizeRule(rule);
  for (const layer of await loadSettingsLayers({ cwd: target.cwd, homeDir: target.homeDir })) {
    if (layer.permissions[target.list].includes(key)) {
      throw new Error(`"${key}" is already in the ${scopeLabel(layer.scope)} ${target.list} rules`);
    }
  }
  return writeList(target, (rules) => [...rules, key]);
}

/** Drop a rule from this scope's list. */
export async function removeRule(target: RuleTarget, rule: string): Promise<string> {
  const key = rule.trim();
  let seen = false;
  await writeList(target, (rules) => {
    seen = rules.includes(key);
    return rules.filter((item) => item !== key);
  });
  if (!seen) {
    throw new Error(`No ${target.list} rule "${key}" in the ${scopeLabel(target.scope)} rules`);
  }
  return fileFor(target);
}

/** Move a rule one slot up (-1) or down (1) within its own scope's list. */
export async function moveRule(target: RuleTarget, rule: string, delta: number): Promise<string> {
  const key = rule.trim();
  await writeList(target, (rules) => {
    const from = rules.indexOf(key);
    if (from < 0) return rules;
    const to = from + delta;
    if (to < 0 || to >= rules.length) return rules;
    const next = [...rules];
    next.splice(from, 1);
    next.splice(to, 0, key);
    return next;
  });
  return fileFor(target);
}

export function scopeLabel(scope: RuleScope): string {
  return scope === 'project' ? 'workspace' : 'global';
}
