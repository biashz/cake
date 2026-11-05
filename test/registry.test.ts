import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createDeepSeekProvider } from '../src/providers/deepseek.js';
import { createDefaultRegistry, ProviderRegistry } from '../src/providers/registry.js';

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
