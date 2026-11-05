import type { McpServerStatus } from '../mcp/client.js';
import type { McpStatus, RuleScopeName } from './api.js';

/**
 * The panel's MCP state, plus a plain-language account of what the last connect
 * changed compared with what the panel was showing before.
 */
export function mcpView(
  rows: McpServerStatus[],
  warnings: string[],
  files: Record<RuleScopeName, string | null>,
  previous: McpServerStatus[],
): McpStatus {
  return {
    servers: rows.filter((row) => row.connected).map((row) => row.name),
    tools: rows.reduce((total, row) => total + row.tools, 0),
    warnings,
    rows: rows.map((row) => ({ ...row })),
    files,
    changes: describeMcpChange(previous, rows),
  };
}

/** Lines a person can act on: what appeared, vanished, came up, or fell over. */
export function describeMcpChange(before: McpServerStatus[], after: McpServerStatus[]): string[] {
  const lines: string[] = [];
  const previous = new Map(before.map((row) => [row.name, row]));
  const current = new Set(after.map((row) => row.name));

  for (const row of after) {
    const past = previous.get(row.name);
    if (!past) {
      lines.push(`${row.name} added — ${outcome(row)}`);
      continue;
    }
    if (past.enabled !== row.enabled) {
      lines.push(`${row.name} switched ${row.enabled ? 'on' : 'off'} — ${outcome(row)}`);
      continue;
    }
    if (past.connected !== row.connected) {
      lines.push(`${row.name} ${row.connected ? 'came up' : 'went down'} — ${outcome(row)}`);
      continue;
    }
    if (past.tools !== row.tools && row.connected) {
      lines.push(`${row.name} now exposes ${row.tools} tools (was ${past.tools})`);
    }
  }
  for (const row of before) {
    if (!current.has(row.name)) lines.push(`${row.name} removed`);
  }
  return lines;
}

function outcome(row: McpServerStatus): string {
  if (!row.enabled) return 'switched off, so it never starts';
  if (row.connected) return `online with ${row.tools} ${row.tools === 1 ? 'tool' : 'tools'}`;
  return row.error ? `not connected: ${row.error}` : 'not connected';
}
