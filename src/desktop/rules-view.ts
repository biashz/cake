import type { RuleScope, SettingsLayer } from '../permissions/settings.js';
import type { RuleList } from '../permissions/write.js';
import type { RuleRow, RulesPayload } from './api.js';

/** The order the Inspector lists scopes in: what this workspace says, then the user-wide file. */
const SCOPE_ORDER: readonly RuleScope[] = ['project', 'global'];

/**
 * Turns the layered files into the panel's view: rows tagged with their scope, and
 * the allow rules that an identical deny cancels out.
 */
export function rulesView(
  layers: SettingsLayer[],
  files: Record<'global' | 'project', string | null>,
): RulesPayload {
  const rows = (list: RuleList): RuleRow[] =>
    SCOPE_ORDER.flatMap((scope) =>
      (layers.find((layer) => layer.scope === scope)?.permissions[list] ?? []).map((rule) => ({
        rule,
        scope,
      })),
    );
  const allow = rows('allow');
  const deny = rows('deny');
  const denied = new Set(deny.map((row) => row.rule));
  return {
    allow,
    deny,
    files,
    conflicts: allow.filter((row) => denied.has(row.rule)).map((row) => row.rule),
  };
}
