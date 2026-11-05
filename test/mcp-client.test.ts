import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectMcpServers } from '../src/mcp/client.js';
import type { McpServerConfig } from '../src/mcp/config.js';
import type { ToolContext } from '../src/tools/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mcp-echo-server.mjs');

const ctx = {
  cwd: process.cwd(),
  askPermission: async () => 'allow',
  log: () => {},
} as ToolContext;

function stdioConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: {},
    maxTools: 24,
    baseDir: here,
    source: fixture,
    ...overrides,
  } as McpServerConfig;
}

describe('connectMcpServers over stdio', () => {
  it('discovers tools from a real MCP server and calls them', async () => {
    const bundle = await connectMcpServers([stdioConfig()], { cwd: here });
    try {
      expect(bundle.servers).toEqual(['fixture']);
      expect(bundle.warnings).toEqual([]);
      const echo = bundle.tools.find((tool) => tool.name === 'mcp__fixture__echo');
      expect(echo).toBeDefined();
      expect(echo?.permission).toBe('read');
      await expect(echo?.execute({ text: 'hi' }, ctx)).resolves.toBe('echo:hi');
    } finally {
      await bundle.close();
    }
  }, 20_000);

  it('keeps extra tools behind the meta tool when maxTools is exceeded', async () => {
    const bundle = await connectMcpServers([stdioConfig({ maxTools: 1 })], { cwd: here });
    try {
      const names = bundle.tools.map((tool) => tool.name);
      expect(names).toContain('mcp__fixture__more');
      expect(names.filter((name) => name === 'mcp__fixture__echo').length).toBeLessThanOrEqual(1);

      const meta = bundle.tools.find((tool) => tool.name === 'mcp__fixture__more');
      if (!meta) throw new Error('meta tool missing');
      const listing = JSON.parse((await meta.execute({ action: 'list' }, ctx)) as string) as Array<{
        name: string;
      }>;
      expect(listing.map((item) => item.name)).toContain('add');
    } finally {
      await bundle.close();
    }
  }, 20_000);

  it('turns a broken server into a warning instead of failing the run', async () => {
    const warnings: string[] = [];
    const bundle = await connectMcpServers(
      [stdioConfig({ name: 'broken', command: path.join(here, 'missing-binary') })],
      { cwd: here, connectTimeoutMs: 5_000, onWarning: (message) => warnings.push(message) },
    );
    try {
      expect(bundle.servers).toEqual([]);
      expect(bundle.tools).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0] ?? '').toMatch(/broken/);
    } finally {
      await bundle.close();
    }
  }, 20_000);
});
