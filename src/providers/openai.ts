import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { modelCapabilities } from './models.js';
import type { ModelCapabilities, ModelProvider } from './types.js';

export interface OpenAIAdapterSettings {
  apiKey?: string;
  baseURL?: string;
  defaultModelId?: string;
}

const PROVIDER_ID = 'openai';
const DEFAULT_MODEL = 'gpt-4o';

export function createOpenAIProvider(settings: OpenAIAdapterSettings = {}): ModelProvider {
  const client = createOpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
  });
  const defaultModelId = settings.defaultModelId ?? DEFAULT_MODEL;

  return {
    id: PROVIDER_ID,
    label: 'OpenAI',
    defaultModelId,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    languageModel(modelId: string): LanguageModel {
      return client(modelId);
    },
    embeddingModel(modelId: string): EmbeddingModel {
      return client.embedding(modelId);
    },
    capabilities(modelId: string): ModelCapabilities {
      return modelCapabilities(PROVIDER_ID, modelId);
    },
  };
}
