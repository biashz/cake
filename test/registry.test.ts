import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
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

describe('createDefaultRegistry', () => {
  it('registers anthropic + openai and resolves keys from env', () => {
    const registry = createDefaultRegistry(
      { provider: 'anthropic', providers: {} },
      { ANTHROPIC_API_KEY: 'a-key' },
    );
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.has('openai')).toBe(true);
    expect(registry.getApiKey('anthropic')).toBe('a-key');
    expect(registry.getApiKey('openai')).toBeUndefined();
  });

  it('prefers config-file api key over nothing, and env over config', () => {
    const registry = createDefaultRegistry(
      { provider: 'anthropic', providers: { anthropic: { apiKey: 'file-key' } } },
      { ANTHROPIC_API_KEY: 'env-key' },
    );
    expect(registry.getApiKey('anthropic')).toBe('env-key');
  });
});
