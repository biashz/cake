import type { ProviderId } from './types.js';

/** Sources consulted when resolving an API key, in increasing precedence order. */
export interface KeySources {
  /** Values from a config file (lowest precedence). */
  config?: Record<string, string | undefined>;
  /** Process environment (higher precedence than config). */
  env?: Record<string, string | undefined>;
  /** Explicitly provided key, e.g. via CLI flag (highest precedence). */
  explicit?: string;
}

/**
 * Resolve an API key for a provider.
 *
 * Precedence: explicit > environment > config. Returns undefined when no key is
 * available from any source, letting the caller produce an actionable message.
 */
export function resolveApiKey(
  provider: ProviderId,
  envVar: string,
  sources: KeySources = {},
): string | undefined {
  const { explicit, env = process.env as Record<string, string | undefined>, config } = sources;

  const candidates = [explicit, env[envVar], config?.[provider]];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
