export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export const EMPTY_RULES: PermissionRules = { allow: [], deny: [] };

export interface ParsedRule {
  tool: string;
  pattern?: string;
}

const RULE_RE = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/;

/** Parse `tool` or `tool(pattern)`. Returns null for malformed rules. */
export function parseRule(rule: string): ParsedRule | null {
  const match = RULE_RE.exec(rule.trim());
  if (!match?.[1]) return null;
  const pattern = match[2]?.trim();
  return pattern ? { tool: match[1], pattern } : { tool: match[1] };
}

/** Translate a rule glob (`*`, `?`) into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function ruleMatches(rule: string, toolName: string, target: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== toolName) return false;
  if (parsed.pattern === undefined) return true;
  return globToRegExp(parsed.pattern).test(target);
}

export type RuleOutcome = 'allow' | 'deny' | 'neutral';

/**
 * Evaluate allow/deny rules for a tool call. Deny wins over allow; no match is
 * neutral and falls through to the permission-mode policy.
 */
export function evaluateRules(
  rules: PermissionRules,
  toolName: string,
  target: string,
): RuleOutcome {
  const normalized = target.replace(/\\/g, '/');
  if (rules.deny.some((rule) => ruleMatches(rule, toolName, normalized))) return 'deny';
  if (rules.allow.some((rule) => ruleMatches(rule, toolName, normalized))) return 'allow';
  return 'neutral';
}
