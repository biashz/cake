import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createDeepSeekProvider } from '../src/providers/deepseek.js';
import { modelCapabilities } from '../src/providers/models.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { createDefaultRegistry, ProviderRegistry } from '../src/providers/registry.js';
import type { ModelProvider } from '../src/providers/types.js';
import { DEFAULT_EMBEDDING_MODEL } from '../src/rag/embedder.js';

describe('ProviderRegistry', () => {
  it('registers and lists providers', () => {
    const registry = new ProviderRegistry().register(createAnthropicProvider({ apiKey: 'x' }));
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.list().map((p) => p.id)).toContain('anthropic');
  });

  it('throws for unknown providers', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('nope')).toThrow(/Unknown provider/);
  });

  it('resolves a language model without network', () => {
    const registry = new ProviderRegistry().register(createAnthropicProvider({ apiKey: 'x' }));
    const model = registry.resolveModel({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(model).toBeDefined();
    expect(model).toHaveProperty('modelId', 'claude-sonnet-4-5');
  });
});

describe('createDeepSeekProvider', () => {
  it('defaults to deepseek-chat with tool calling and no vision', () => {
    const provider = createDeepSeekProvider({ apiKey: 'x' });
    expect(provider.id).toBe('deepseek');
    expect(provider.apiKeyEnvVar).toBe('DEEPSEEK_API_KEY');
    expect(provider.defaultModelId).toBe('deepseek-chat');
    expect(provider.capabilities('deepseek-chat')).toEqual({
      toolCalling: true,
      vision: false,
      maxContext: 128_000,
      assumed: false,
    });
  });

  it('disables tool calling for the reasoner model', () => {
    const provider = createDeepSeekProvider({ apiKey: 'x' });
    expect(provider.capabilities('deepseek-reasoner').toolCalling).toBe(false);
  });

  it('resolves a language model without network', () => {
    const provider = createDeepSeekProvider({ apiKey: 'x' });
    expect(provider.languageModel('deepseek-chat')).toBeDefined();
  });
});

describe('createDefaultRegistry', () => {
  it('registers deepseek + anthropic + openai and resolves keys from env', () => {
    const registry = createDefaultRegistry(
      { provider: 'deepseek', pricing: {}, providers: {} },
      { DEEPSEEK_API_KEY: 'd-key', ANTHROPIC_API_KEY: 'a-key' },
    );
    expect(registry.has('deepseek')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.has('openai')).toBe(true);
    expect(registry.getApiKey('deepseek')).toBe('d-key');
    expect(registry.getApiKey('anthropic')).toBe('a-key');
    expect(registry.getApiKey('openai')).toBeUndefined();
    expect(registry.list()[0]?.id).toBe('deepseek');
  });

  it('prefers config-file api key over nothing, and env over config', () => {
    const registry = createDefaultRegistry(
      { provider: 'anthropic', pricing: {}, providers: { anthropic: { apiKey: 'file-key' } } },
      { ANTHROPIC_API_KEY: 'env-key' },
    );
    expect(registry.getApiKey('anthropic')).toBe('env-key');
  });
});

describe('resolveEmbeddingModel', () => {
  /** An embedder that names who answered, so a hand-off to the wrong vendor shows. */
  function embeddingProvider(id: string): ModelProvider {
    return {
      id,
      label: id,
      defaultModelId: `${id}-chat`,
      apiKeyEnvVar: `${id.toUpperCase()}_API_KEY`,
      languageModel: () => `${id}:chat`,
      embeddingModel: (modelId: string) => `${id}/${modelId}`,
      capabilities: (modelId: string) => modelCapabilities(id, modelId),
    };
  }

  it('asks the provider named rather than the first one that can embed', () => {
    const registry = new ProviderRegistry()
      .register(embeddingProvider('local'), 'local-key')
      .register(embeddingProvider('other'), 'other-key');

    expect(registry.resolveEmbeddingModel('other', 'vec-1')).toBe('other/vec-1');
    expect(registry.resolveEmbeddingModel('local', 'vec-1')).toBe('local/vec-1');
  });

  it('does not let an earlier provider take the OpenAI embedding id', () => {
    const registry = new ProviderRegistry()
      .register(embeddingProvider('local'), 'local-key')
      .register(createOpenAIProvider({ apiKey: 'o-key' }), 'o-key');

    const model = registry.resolveEmbeddingModel('openai', DEFAULT_EMBEDDING_MODEL);
    expect(model).toBeDefined();
    expect(model).not.toBe(`local/${DEFAULT_EMBEDDING_MODEL}`);
  });

  it('says nothing rather than guessing, for a provider that cannot embed', () => {
    const registry = new ProviderRegistry().register(createDeepSeekProvider({ apiKey: 'x' }));
    expect(registry.resolveEmbeddingModel('deepseek', DEFAULT_EMBEDDING_MODEL)).toBeUndefined();
    expect(registry.resolveEmbeddingModel('nowhere', DEFAULT_EMBEDDING_MODEL)).toBeUndefined();
  });
});
