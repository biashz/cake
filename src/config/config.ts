import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
});

const ConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  providers: z
    .object({
      deepseek: ProviderConfigSchema.optional(),
      anthropic: ProviderConfigSchema.optional(),
      openai: ProviderConfigSchema.optional(),
    })
    .optional(),
});

type RawConfig = z.infer<typeof ConfigSchema>;

export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export interface CakeConfig {
  /** Default provider id after merging file config + env. */
  provider: string;
  /** Default model id (undefined → provider default). */
  model?: string;
  providers: {
    deepseek?: ProviderConfig;
    anthropic?: ProviderConfig;
    openai?: ProviderConfig;
  };
}

const DEFAULT_PROVIDER = 'deepseek';

export interface LoadConfigOptions {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export function configPaths(
  cwd = process.cwd(),
  home = homedir(),
): {
  global: string;
  project: string;
} {
  return {
    global: join(home, '.cake', 'config.json'),
    project: join(cwd, '.cake', 'config.json'),
  };
}

/**
 * Load configuration by layering (lowest → highest precedence):
 * global `~/.cake/config.json` → project `./.cake/config.json` → env vars.
 *
 * API keys are intentionally NOT resolved from env here; `resolveApiKey` owns key
 * precedence so this stays free of secret handling. Env only sets provider/model/baseURL.
 */
export function loadConfig(opts: LoadConfigOptions = {}): CakeConfig {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const paths = configPaths(opts.cwd, opts.homeDir);

  const globalCfg = readConfigFile(paths.global);
  const projectCfg = readConfigFile(paths.project);
  const merged = mergeConfigs(globalCfg, projectCfg);

  const provider = env.CAKE_PROVIDER ?? merged.provider ?? DEFAULT_PROVIDER;
  const model = env.CAKE_MODEL ?? merged.model;

  const providers: CakeConfig['providers'] = {
    deepseek: { ...merged.providers?.deepseek },
    anthropic: { ...merged.providers?.anthropic },
    openai: { ...merged.providers?.openai },
  };
  if (env.DEEPSEEK_BASE_URL)
    providers.deepseek = { ...providers.deepseek, baseURL: env.DEEPSEEK_BASE_URL };
  if (env.ANTHROPIC_BASE_URL)
    providers.anthropic = { ...providers.anthropic, baseURL: env.ANTHROPIC_BASE_URL };
  if (env.OPENAI_BASE_URL) providers.openai = { ...providers.openai, baseURL: env.OPENAI_BASE_URL };

  return { provider, model, providers };
}

function readConfigFile(path: string): RawConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Failed to read config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config at ${path}: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config at ${path}: ${result.error.message}`);
  }
  return result.data;
}

function mergeConfigs(base?: RawConfig, override?: RawConfig): RawConfig {
  if (!base) return override ?? {};
  if (!override) return base;
  return {
    provider: override.provider ?? base.provider,
    model: override.model ?? base.model,
    providers: {
      deepseek: { ...base.providers?.deepseek, ...override.providers?.deepseek },
      anthropic: { ...base.providers?.anthropic, ...override.providers?.anthropic },
      openai: { ...base.providers?.openai, ...override.providers?.openai },
    },
  };
}
