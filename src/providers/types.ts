import type { LanguageModel } from 'ai';

/**
 * Provider identifier. Known providers get literal types; arbitrary strings are
 * allowed so custom/self-hosted providers can be registered later.
 */
export type ProviderId = 'anthropic' | 'openai' | (string & {});

/** A fully-qualified model selection: which provider, which model. */
export interface ModelSpec {
  provider: ProviderId;
  modelId: string;
}

/** Coarse capability flags used for routing and validation. */
export interface ModelCapabilities {
  toolCalling: boolean;
  vision: boolean;
  /** Approximate context window in tokens. */
  maxContext: number;
}

/**
 * A model provider adapts a concrete backend (Anthropic, OpenAI, ...) to the
 * kernel. The kernel only ever talks to this interface, never to a vendor SDK.
 */
export interface ModelProvider {
  id: ProviderId;
  label: string;
  /** Model id used when the user/config does not specify one. */
  defaultModelId: string;
  /** Environment variable that holds this provider's API key. */
  apiKeyEnvVar: string;
  /** Resolve a callable language model for the given model id. */
  languageModel(modelId: string): LanguageModel;
  capabilities(modelId: string): ModelCapabilities;
}
