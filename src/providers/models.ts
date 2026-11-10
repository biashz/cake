import type { ModelCapabilities } from './types.js';

/** The three numbers a surface may print and a turn may budget against. */
export interface ModelRow {
  toolCalling: boolean;
  vision: boolean;
  maxContext: number;
}

/** A row is the id family it covers plus the numbers cake states for it. */
interface TableEntry {
  prefix: string;
  row: ModelRow;
}

interface ProviderTable {
  /** What an id with no matching entry gets, and what says it was assumed. */
  baseline: ModelRow;
  entries: readonly TableEntry[];
}

/**
 * The model families cake is willing to name numbers for. An entry is written
 * only when all three numbers are cake's own claim: a family whose window cake
 * cannot state gets no entry, and its ids fall to the baseline and are reported
 * as assumed rather than given a number that looks like knowledge.
 */
const TABLES: Record<'anthropic' | 'openai' | 'deepseek', ProviderTable> = {
  anthropic: {
    baseline: { toolCalling: true, vision: true, maxContext: 200_000 },
    entries: [
      // Claude 3 Haiku is the one model of that generation that cannot see.
      { prefix: 'claude-3-haiku', row: { toolCalling: true, vision: false, maxContext: 200_000 } },
      { prefix: 'claude-3', row: { toolCalling: true, vision: true, maxContext: 200_000 } },
      { prefix: 'claude-haiku-4', row: { toolCalling: true, vision: true, maxContext: 200_000 } },
      { prefix: 'claude-opus-4', row: { toolCalling: true, vision: true, maxContext: 200_000 } },
      { prefix: 'claude-sonnet-4', row: { toolCalling: true, vision: true, maxContext: 200_000 } },
    ],
  },
  openai: {
    baseline: { toolCalling: true, vision: true, maxContext: 128_000 },
    entries: [
      { prefix: 'gpt-4o', row: { toolCalling: true, vision: true, maxContext: 128_000 } },
      // o1-mini reads text only and takes no tool calls.
      { prefix: 'o1-mini', row: { toolCalling: false, vision: false, maxContext: 128_000 } },
    ],
  },
  deepseek: {
    baseline: { toolCalling: true, vision: false, maxContext: 128_000 },
    entries: [
      { prefix: 'deepseek-chat', row: { toolCalling: true, vision: false, maxContext: 128_000 } },
      {
        prefix: 'deepseek-reasoner',
        row: { toolCalling: false, vision: false, maxContext: 128_000 },
      },
    ],
  },
};

/** A provider the table does not list has no window cake can state at all. */
const NOT_LISTED: ModelCapabilities = {
  toolCalling: false,
  vision: false,
  maxContext: 0,
  assumed: true,
};

/**
 * The table's answer for one id. The longest prefix wins, so
 * `claude-3-haiku-20240307` reads the haiku entry rather than its generation.
 */
export function modelCapabilities(providerId: string, modelId: string): ModelCapabilities {
  const table = TABLES[providerId as keyof typeof TABLES];
  if (!table) return NOT_LISTED;

  const matched = table.entries
    .filter((entry) => modelId.startsWith(entry.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (matched) return { ...matched.row, assumed: false };
  return { ...table.baseline, assumed: true };
}
