/**
 * The model table is the one place cake states what it believes about a model
 * id, so every number a surface prints and every budget a turn takes is claimed
 * here — the claim that a row was guessed along with the rows themselves.
 */
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createDeepSeekProvider } from '../src/providers/deepseek.js';
import { modelCapabilities } from '../src/providers/models.js';
import { createOpenAIProvider } from '../src/providers/openai.js';

describe('modelCapabilities', () => {
  it('numbers the Claude generations it names', () => {
    expect(modelCapabilities('anthropic', 'claude-sonnet-4-5')).toEqual({
      toolCalling: true,
      vision: true,
      maxContext: 200_000,
      assumed: false,
    });
    expect(modelCapabilities('anthropic', 'claude-3-5-haiku-20241022').vision).toBe(true);
  });

  it('answers with the longer family prefix', () => {
    // The generation row says Claude 3 reads images; the model under it does not.
    expect(modelCapabilities('anthropic', 'claude-3-haiku-20240307')).toEqual({
      toolCalling: true,
      vision: false,
      maxContext: 200_000,
      assumed: false,
    });
  });

  it('keeps the OpenAI model that sees nothing out of the image path', () => {
    expect(modelCapabilities('openai', 'o1-mini')).toEqual({
      toolCalling: false,
      vision: false,
      maxContext: 128_000,
      assumed: false,
    });
    expect(modelCapabilities('openai', 'gpt-4o-mini').vision).toBe(true);
  });

  it('keeps the reasoner out of the tool calls', () => {
    expect(modelCapabilities('deepseek', 'deepseek-chat').toolCalling).toBe(true);
    expect(modelCapabilities('deepseek', 'deepseek-reasoner').toolCalling).toBe(false);
    expect(modelCapabilities('deepseek', 'deepseek-reasoner').vision).toBe(false);
  });

  it('calls the baseline what it is', () => {
    // An id with no row still gets the provider's numbers, but not their authority.
    expect(modelCapabilities('anthropic', 'claude-2-1')).toEqual({
      toolCalling: true,
      vision: true,
      maxContext: 200_000,
      assumed: true,
    });
    expect(modelCapabilities('openai', 'gpt-5').assumed).toBe(true);
    expect(modelCapabilities('deepseek', 'deepseek-v4').assumed).toBe(true);
  });

  it('claims nothing about a provider the table does not list', () => {
    expect(modelCapabilities('groq', 'llama-3.3-70b')).toEqual({
      toolCalling: false,
      vision: false,
      maxContext: 0,
      assumed: true,
    });
  });

  it('is what the adapters hand back, so no surface reads a second copy', () => {
    const adapters = [
      createAnthropicProvider({ apiKey: 'x' }),
      createDeepSeekProvider({ apiKey: 'x' }),
      createOpenAIProvider({ apiKey: 'x' }),
    ];
    for (const adapter of adapters) {
      for (const modelId of ['claude-3-haiku', 'o1-mini', 'deepseek-reasoner', 'unknown-9']) {
        expect(adapter.capabilities(modelId)).toEqual(modelCapabilities(adapter.id, modelId));
      }
    }
  });

  it('knows every default model id it registers', () => {
    for (const adapter of [
      createAnthropicProvider({ apiKey: 'x' }),
      createDeepSeekProvider({ apiKey: 'x' }),
      createOpenAIProvider({ apiKey: 'x' }),
    ]) {
      expect(adapter.capabilities(adapter.defaultModelId).assumed).toBe(false);
    }
  });
});
