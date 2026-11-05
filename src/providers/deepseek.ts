import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelCapabilities, ModelProvider } from './types.js';

export interface DeepSeekAdapterSettings {
  apiKey?: string;
  baseURL?: string;
  defaultModelId?: string;
}

const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

export function createDeepSeekProvider(settings: DeepSeekAdapterSettings = {}): ModelProvider {
  const client = createOpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL ?? DEFAULT_BASE_URL,
  });
  const defaultModelId = settings.defaultModelId ?? DEFAULT_MODEL;

  return {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModelId,
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    languageModel(modelId: string): LanguageModel {
      // DeepSeek only implements chat completions; the default OpenAI call uses
      // the Responses API, which DeepSeek does not serve.
      return client.chat(modelId);
    },
    capabilities(modelId: string): ModelCapabilities {
      return {
        toolCalling: !modelId.includes('reasoner'),
        vision: false,
        maxContext: 128_000,
      };
    },
  };
}
