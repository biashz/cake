import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { modelCapabilities } from './models.js';
import type { ModelCapabilities, ModelProvider } from './types.js';

export interface AnthropicAdapterSettings {
  apiKey?: string;
  baseURL?: string;
  defaultModelId?: string;
}

const PROVIDER_ID = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

export function createAnthropicProvider(settings: AnthropicAdapterSettings = {}): ModelProvider {
  const client = createAnthropic({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
  });
  const defaultModelId = settings.defaultModelId ?? DEFAULT_MODEL;

  return {
    id: PROVIDER_ID,
    label: 'Anthropic',
    defaultModelId,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    languageModel(modelId: string): LanguageModel {
      return client(modelId);
    },
    capabilities(modelId: string): ModelCapabilities {
      return modelCapabilities(PROVIDER_ID, modelId);
    },
  };
}
