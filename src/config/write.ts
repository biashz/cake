import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pricing } from '../core/pricing.js';
import { configPaths } from './config.js';

export type ConfigRecord = Record<string, unknown>;

async function readRawConfig(file: string): Promise<ConfigRecord> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never overwrite a file we cannot read: the user's keys would be lost.
    throw new Error(`Fix or remove the invalid JSON in ${file} first`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as ConfigRecord;
}

/**
 * Read-modify-write one JSON config file so edits from the app keep keys the
 * schema does not know about (and comments are not promised).
 */
export async function updateJsonFile(
  file: string,
  mutate: (config: ConfigRecord) => ConfigRecord,
): Promise<string> {
  const current = await readRawConfig(file);
  const next = mutate(structuredClone(current));
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temp, file);
  return file;
}

/** The workspace's own `.cake/config.json`. */
export async function updateProjectConfig(
  cwd: string,
  mutate: (config: ConfigRecord) => ConfigRecord,
): Promise<string> {
  return updateJsonFile(configPaths(cwd).project, mutate);
}

function pricingRecord(config: ConfigRecord): ConfigRecord {
  const pricing = config.pricing;
  return typeof pricing === 'object' && pricing !== null && !Array.isArray(pricing)
    ? (pricing as ConfigRecord)
    : {};
}

/** Set one `provider/model` rate, or remove it with null to fall back to built-in. */
export async function setPricingEntry(
  cwd: string,
  pattern: string,
  rates: Pricing | null,
): Promise<string> {
  return updateProjectConfig(cwd, (config) => {
    const pricing = pricingRecord(config);
    if (rates === null) delete pricing[pattern];
    else pricing[pattern] = { inputPer1M: rates.inputPer1M, outputPer1M: rates.outputPer1M };
    config.pricing = pricing;
    return config;
  });
}

/** The config schema names these three and has no room for others. */
const PROVIDER_IDS = ['deepseek', 'anthropic', 'openai'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

function knownProvider(value: string): ProviderId {
  const found = PROVIDER_IDS.find((id) => id === value);
  if (!found)
    throw new Error(`Unknown provider "${value}"; expected one of ${PROVIDER_IDS.join(', ')}`);
  return found;
}

/**
 * Store a provider key in the global config, where it works for every workspace
 * and cannot be committed by accident. Keys the file already holds survive.
 */
export async function setProviderApiKey(
  homeDir: string | undefined,
  provider: string,
  apiKey: string,
): Promise<string> {
  const id = knownProvider(provider);
  const key = apiKey.trim();
  if (!key) throw new Error('An API key cannot be empty');
  return updateJsonFile(configPaths(undefined, homeDir).global, (config) => {
    const providers =
      typeof config.providers === 'object' &&
      config.providers !== null &&
      !Array.isArray(config.providers)
        ? (config.providers as ConfigRecord)
        : {};
    const entry =
      typeof providers[id] === 'object' && providers[id] !== null && !Array.isArray(providers[id])
        ? (providers[id] as ConfigRecord)
        : {};
    entry.apiKey = key;
    providers[id] = entry;
    config.providers = providers;
    return config;
  });
}
