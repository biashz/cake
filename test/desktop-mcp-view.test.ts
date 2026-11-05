import { describe, expect, it } from 'vitest';
import { describeMcpChange, mcpView } from '../src/desktop/mcp-view.js';
import type { McpServerStatus } from '../src/mcp/client.js';

const files = { global: '/home/u/.cake/mcp.json', project: '/tmp/demo/.cake/mcp.json' };

function row(name: string, overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name,
    transport: 'stdio',
    scope: 'project',
    enabled: true,
    connected: true,
    tools: 2,
    error: null,
    target: { command: 'npx', args: [] },
    permission: null,
    ...overrides,
  };
}

describe('mcpView', () => {
  it('counts only what is live and keeps the config files visible', () => {
    const rows = [row('files'), row('broken', { connected: false, tools: 0, error: 'boom' })];
    const view = mcpView(rows, ['MCP config problem'], files, rows);
    expect(view.servers).toEqual(['files']);
    expect(view.tools).toBe(2);
    expect(view.warnings).toEqual(['MCP config problem']);
    expect(view.files).toEqual(files);
    expect(view.changes).toEqual([]);
  });

  it('copies the rows so the panel cannot mutate the kernel state', () => {
    const rows = [row('files')];
    const view = mcpView(rows, [], files, rows);
    const first = view.rows[0];
    if (!first) throw new Error('row missing');
    first.tools = 99;
    expect(rows[0]?.tools).toBe(2);
  });
});

describe('describeMcpChange', () => {
  it('stays quiet when nothing moved', () => {
    const rows = [row('files'), row('search')];
    expect(describeMcpChange(rows, rows)).toEqual([]);
  });

  it('names what was added, removed, switched, and whether it came up', () => {
    expect(describeMcpChange([], [row('files')])).toEqual(['files added — online with 2 tools']);
    expect(describeMcpChange([row('files')], [])).toEqual(['files removed']);
    expect(describeMcpChange([row('files')], [row('files', { enabled: false })])).toEqual([
      'files switched off — switched off, so it never starts',
    ]);
    expect(
      describeMcpChange([row('files', { enabled: false })], [row('files', { tools: 3 })]),
    ).toEqual(['files switched on — online with 3 tools']);
  });

  it('reports a server that fell over with its reason', () => {
    const after = row('search', { connected: false, tools: 0, error: 'spawn ENOENT' });
    expect(describeMcpChange([row('search')], [after])).toEqual([
      'search went down — not connected: spawn ENOENT',
    ]);
  });

  it('mentions a tool count that changed while staying online', () => {
    expect(describeMcpChange([row('files')], [row('files', { tools: 5 })])).toEqual([
      'files now exposes 5 tools (was 2)',
    ]);
  });

  it('uses the singular for one tool', () => {
    expect(describeMcpChange([], [row('files', { tools: 1 })])).toEqual([
      'files added — online with 1 tool',
    ]);
  });
});
