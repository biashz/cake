import type { SubAgentRunnerOptions } from '../orchestration/runner.js';
import { createAgentTool } from '../orchestration/tool.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createEmbedder, DEFAULT_EMBEDDING_MODEL, type Embedder } from '../rag/embedder.js';
import { createRagTools } from '../rag/tools.js';
import { createDefaultTools } from '../tools/registry.js';
import type { CakeTool } from '../tools/types.js';

/** Embeddings come from OpenAI; semantic tools stay off when that key is absent. */
export function resolveEmbedder(registry: ProviderRegistry): Embedder | undefined {
  if (!registry.getApiKey('openai')) return undefined;
  const model = registry.resolveEmbeddingModel('openai', DEFAULT_EMBEDDING_MODEL);
  return model ? createEmbedder(model) : undefined;
}

/** Built-in tools, plus RAG and MCP tools when available. */
export function buildBaseTools(
  embedder: Embedder | undefined,
  mcpTools: CakeTool[] = [],
): CakeTool[] {
  const local = embedder
    ? [...createDefaultTools(), ...createRagTools(embedder)]
    : createDefaultTools();
  return [...local, ...mcpTools];
}

/** Full catalog handed to the kernel and to child agents (minus nesting). */
export function buildToolCatalog(
  embedder: Embedder | undefined,
  mcpTools: CakeTool[],
  agent: Omit<SubAgentRunnerOptions, 'tools'>,
): CakeTool[] {
  const base = buildBaseTools(embedder, mcpTools);
  return [...base, createAgentTool({ ...agent, tools: base })];
}
