import type { ModelMessage } from 'ai';
import { contentText, estimateTextTokens } from '../core/context.js';
import type {
  ContextEntryPayload,
  ContextLayerId,
  ContextLayerPayload,
  ContextPayload,
} from './api.js';

export interface ContextMapInput {
  /** System prompt without the project-instructions section. */
  systemBase: string;
  projectSections: { path: string; text: string }[];
  messages: ModelMessage[];
  /** Work already produced in a live run that has not been persisted yet. */
  turn?: ContextEntryPayload[];
  maxContext: number;
}

const MAX_ENTRIES_PER_LAYER = 14;
/** Mention blocks the kernel injects into a turn, attributed to the Retrieved layer. */
const INJECTED = [
  { re: /<file path="([^"]*)">([\s\S]*?)<\/file>/g, kind: 'file' as const },
  { re: /<codebase query="([^"]*)">([\s\S]*?)<\/codebase>/g, kind: 'codebase' as const },
] as const;

const LAYER_ORDER: ContextLayerId[] = ['system', 'project', 'retrieved', 'history', 'turn'];

const LAYER_LABEL: Record<ContextLayerId, string> = {
  system: 'System',
  project: 'Project',
  retrieved: 'Retrieved',
  history: 'History',
  turn: 'This turn',
};

function mergeEntry(
  entries: ContextEntryPayload[],
  label: string,
  tokens: number,
  detail?: string,
) {
  const existing = entries.find((entry) => entry.label === label);
  if (existing) {
    existing.tokens += tokens;
    return;
  }
  if (entries.length < MAX_ENTRIES_PER_LAYER) entries.push({ label, tokens, detail });
}

/**
 * Splits the stored conversation into the layers that actually occupy the context
 * window, so the desktop Slice shows composition rather than one opaque total.
 */
export function buildContextMap(input: ContextMapInput): ContextPayload {
  const layers = new Map<ContextLayerId, ContextLayerPayload>();
  const layer = (id: ContextLayerId): ContextLayerPayload => {
    const found = layers.get(id);
    if (found) return found;
    const created: ContextLayerPayload = { id, label: LAYER_LABEL[id], tokens: 0, entries: [] };
    layers.set(id, created);
    return created;
  };

  const system = layer('system');
  system.tokens = estimateTextTokens(input.systemBase);
  if (system.tokens > 0)
    system.entries.push({ label: 'Agent instructions', tokens: system.tokens });

  for (const section of input.projectSections) {
    const tokens = estimateTextTokens(section.text);
    const project = layer('project');
    project.tokens += tokens;
    mergeEntry(project.entries, section.path, tokens, 'AGENTS.md');
  }

  const retrieved = layer('retrieved');
  const history = layer('history');

  for (const message of input.messages) {
    const text = contentText(message.content);
    if (!text) continue;

    let injected = 0;
    for (const { re, kind } of INJECTED) {
      re.lastIndex = 0;
      for (let match = re.exec(text); match; match = re.exec(text)) {
        const tokens = estimateTextTokens(match[0]);
        injected += tokens;
        const label = kind === 'file' ? `@${match[1]}` : `@codebase ${match[1]}`;
        mergeEntry(retrieved.entries, label.slice(0, 60), tokens, kind);
      }
    }
    retrieved.tokens += injected;

    const own = estimateTextTokens(text) - injected;
    if (own > 0) {
      history.tokens += own;
      mergeEntry(history.entries, message.role, own);
    }
  }

  if (input.turn && input.turn.length > 0) {
    const turn = layer('turn');
    for (const entry of input.turn) {
      mergeEntry(turn.entries, entry.label, entry.tokens, entry.detail);
    }
    turn.tokens = turn.entries.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  const ordered = LAYER_ORDER.map((id) => layers.get(id)).filter(
    (item): item is ContextLayerPayload => item !== undefined && item.tokens > 0,
  );
  const used = ordered.reduce((sum, item) => sum + item.tokens, 0);

  return {
    layers: ordered,
    maxContext: input.maxContext,
    used,
    free: Math.max(0, input.maxContext - used),
    estimated: true,
  };
}
