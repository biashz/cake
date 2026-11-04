import type { LanguageModel } from 'ai';
import type { CakeConfig } from '../config/config.js';
import { createAnthropicProvider } from './anthropic.js';
import { resolveApiKey } from './keys.js';
import { createOpenAIProvider } from './openai.js';
import type { ModelProvider, ModelSpec, ProviderId } from './types.js';

/** A container that maps provider ids to adapters and resolves model selections. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly apiKeys = new Map<string, string | undefined>();

  register(provider: ModelProvider, apiKey?: string): this {
    this.providers.set(provider.id, provider);
    this.apiKeys.set(provider.id, apiKey);
    return this;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  get(id: ProviderId): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      const known = [...this.providers.keys()].join(', ') || '(none)';
      throw new Error(`Unknown provider "${id}". Registered providers: ${known}`);
    }
    return provider;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /** The API key associated with a provider, if one was resolved at registration. */
  getApiKey(id: ProviderId): string | undefined {
    return this.apiKeys.get(id);
  }

  resolveModel(spec: ModelSpec): LanguageModel {
    return this.get(spec.provider).languageModel(spec.modelId);
  }
}

/**
 * Build the default registry (Anthropic + OpenAI) from resolved config. API keys are
 * resolved through {@link resolveApiKey} (explicit > env > config file) and stored so
 * the CLI can fail fast with an actionable message when a key is missing.
 */
export function createDefaultRegistry(
  config: CakeConfig,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  const anthropicKey = resolveApiKey('anthropic', 'ANTHROPIC_API_KEY', {
    env,
    config: { anthropic: config.providers.anthropic?.apiKey },
  });
  registry.register(
    createAnthropicProvider({
      apiKey: anthropicKey,
      baseURL: config.providers.anthropic?.baseURL,
      defaultModelId: config.providers.anthropic?.model,
    }),
    anthropicKey,
  );

  const openaiKey = resolveApiKey('openai', 'OPENAI_API_KEY', {
    env,
    config: { openai: config.providers.openai?.apiKey },
  });
  registry.register(
    createOpenAIProvider({
      apiKey: openaiKey,
      baseURL: config.providers.openai?.baseURL,
      defaultModelId: config.providers.openai?.model,
    }),
    openaiKey,
  );

  return registry;
}
