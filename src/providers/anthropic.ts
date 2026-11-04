import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { ModelCapabilities, ModelProvider } from './types.js';

export interface AnthropicAdapterSettings {
  apiKey?: string;
  baseURL?: string;
  defaultModelId?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';

export function createAnthropicProvider(settings: AnthropicAdapterSettings = {}): ModelProvider {
  const client = createAnthropic({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
  });
  const defaultModelId = settings.defaultModelId ?? DEFAULT_MODEL;

  return {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModelId,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    languageModel(modelId: string): LanguageModel {
      return client(modelId);
    },
    capabilities(modelId: string): ModelCapabilities {
      return {
        toolCalling: true,
        vision: !modelId.startsWith('claude-3-haiku'),
        maxContext: 200_000,
      };
    },
  };
}
