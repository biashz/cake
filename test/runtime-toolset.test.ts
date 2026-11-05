import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { Embedder } from '../src/rag/embedder.js';
import { buildBaseTools, buildToolCatalog } from '../src/runtime/toolset.js';
import type { CakeTool } from '../src/tools/types.js';

const embedder: Embedder = {
  id: 'test-embedder',
  embed: async (texts) => texts.map(() => [0, 0, 0]),
};

const mcpTool = {
  name: 'mcp__demo__ping',
  description: 'ping',
  permission: 'read',
  inputSchema: z.object({}),
  summarize: () => 'ping',
  matchTarget: () => 'ping',
  execute: async () => 'pong',
} as CakeTool;

function names(tools: CakeTool[]): string[] {
  return tools.map((tool) => tool.name);
}

function agentOptions() {
  return {
    registry: new ProviderRegistry(),
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    systemBase: 'system',
    mode: 'default' as const,
    rules: { allow: [], deny: [] },
    onEvent: () => {},
  };
}

describe('runtime toolset', () => {
  it('omits RAG tools when no embedder is configured', () => {
    const tools = buildBaseTools(undefined, [mcpTool]);
    const list = names(tools);

    expect(list).toContain('mcp__demo__ping');
    expect(list).not.toContain('search_code');
    expect(list).not.toContain('index_codebase');
    expect(list).not.toContain('agent');
  });

  it('adds RAG tools when an embedder is available', () => {
    const list = names(buildBaseTools(embedder));
    expect(list).toContain('search_code');
    expect(list).toContain('index_codebase');
  });

  it('appends the agent tool after the base catalog', () => {
    const base = buildBaseTools(embedder, [mcpTool]);
    const catalog = buildToolCatalog(embedder, [mcpTool], agentOptions());

    expect(names(catalog)).toEqual([...names(base), 'agent']);
  });
});
