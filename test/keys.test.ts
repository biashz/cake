import { describe, expect, it } from 'vitest';
import { resolveApiKey } from '../src/providers/keys.js';

describe('resolveApiKey', () => {
  it('prefers explicit over env and config', () => {
    const key = resolveApiKey('anthropic', 'ANTHROPIC_API_KEY', {
      explicit: ' explicit-key ',
      env: { ANTHROPIC_API_KEY: 'env-key' },
      config: { anthropic: 'config-key' },
    });
    expect(key).toBe('explicit-key');
  });

  it('prefers env over config', () => {
    const key = resolveApiKey('anthropic', 'ANTHROPIC_API_KEY', {
      env: { ANTHROPIC_API_KEY: 'env-key' },
      config: { anthropic: 'config-key' },
    });
    expect(key).toBe('env-key');
  });

  it('falls back to config', () => {
    const key = resolveApiKey('anthropic', 'ANTHROPIC_API_KEY', {
      env: {},
      config: { anthropic: 'config-key' },
    });
    expect(key).toBe('config-key');
  });

  it('returns undefined when no source provides a key', () => {
    const key = resolveApiKey('anthropic', 'ANTHROPIC_API_KEY', { env: {}, config: {} });
    expect(key).toBeUndefined();
  });

  it('ignores blank/whitespace-only values', () => {
    const key = resolveApiKey('openai', 'OPENAI_API_KEY', {
      env: { OPENAI_API_KEY: '   ' },
      config: {},
    });
    expect(key).toBeUndefined();
  });
});
