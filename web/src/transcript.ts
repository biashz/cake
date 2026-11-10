import type { CheckpointTurnRow } from '../../src/desktop/api.js';
import type { CodebaseHit } from '../../src/rag/retrieval.js';
import { imagesOfContent } from './attachments';

export type EntryRole = 'user' | 'assistant' | 'tool' | 'info' | 'note' | 'error';

/**
 * A child agent spawned by the `agent` tool. Its own calls live in `children`;
 * they are live-only, because a child keeps its own conversation and never
 * writes into the parent's stored history.
 */
export interface AgentRun {
  type: string;
  prompt: string;
  status: 'running' | 'done' | 'error';
  text?: string;
  tokens?: number;
  costUsd?: number;
  children: ToolInfo[];
}

export interface ToolInfo {
  /** Pairs a result with the call that produced it; same-tool calls share a name. */
  callId: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  status: 'running' | 'done' | 'error';
  agent?: AgentRun;
}

export interface Entry {
  id: number;
  role: EntryRole;
  text?: string;
  meta?: string;
  /** Pictures this turn was sent with, as inline data URLs. */
  images?: string[];
  /** Eyebrow label for kernel notes, e.g. "index" or "context". */
  kind?: string;
  /** On a codebase note: the chunks cake actually read, rendered as hit cards. */
  hits?: CodebaseHit[];
  tool?: ToolInfo;
  /** Wall clock of the event, so a finished turn can report how long it took. */
  at?: number;
}

export function previewValue(value: unknown, max = 160): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const line = (raw ?? '').split('\n').find((item) => item.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Turns are listed by clock time, not by the moment's full timestamp. */
export function shortTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One-line target for a tool call: path, command, prompt, query, or fallback JSON. */
export function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return previewValue(input);
  const record = input as Record<string, unknown>;
  // Only the plan tool takes an action, and its steps read as steps, not JSON.
  if (typeof record.action === 'string') {
    if (record.action === 'add' && typeof record.subject === 'string') {
      return `add "${record.subject}"`;
    }
    if (record.action === 'update')
      return `#${String(record.id ?? '?')} → ${String(record.status ?? '?')}`;
    return record.action;
  }
  for (const key of ['path', 'command', 'prompt', 'query', 'pattern', 'type']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return previewValue(value);
  }
  return previewValue(input);
}

export function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null) {
    const record = output as Record<string, unknown>;
    if (typeof record.value === 'string') return record.value;
  }
  return JSON.stringify(output ?? '', null, 2);
}

/** Calls a turn is responsible for, counting what its subagents did as its own. */
function toolWeight(entry: Entry): number {
  if (!entry.tool) return 0;
  return 1 + (entry.tool.agent?.children.length ?? 0);
}

export interface Turn {
  /** First entry of the turn, so collapse state survives new content. */
  key: number;
  user?: Entry;
  body: Entry[];
  toolCount: number;
  /** Set only when every entry in the turn carries a timestamp. */
  startedAt?: number;
  endedAt?: number;
}

/** One turn per user message: the request plus everything done about it. */
export function buildTurns(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];

  for (const entry of entries) {
    const last = turns[turns.length - 1];
    if (entry.role === 'user' || last === undefined) {
      turns.push({
        key: entry.id,
        ...(entry.role === 'user' ? { user: entry } : {}),
        body: entry.role === 'user' ? [] : [entry],
        toolCount: toolWeight(entry),
      });
    } else {
      last.body.push(entry);
      last.toolCount += toolWeight(entry);
    }
  }

  for (const turn of turns) {
    const members = [turn.user, ...turn.body].filter((entry) => entry !== undefined);
    const stamps = members.flatMap((entry) => (entry.at === undefined ? [] : [entry.at]));
    if (stamps.length === members.length && stamps.length > 0) {
      turn.startedAt = Math.min(...stamps);
      turn.endedAt = Math.max(...stamps);
    }
  }
  return turns;
}

/** Best-effort rendering of stored ModelMessage history back into transcript entries. */
export function entriesFromMessages(messages: unknown[]): Entry[] {
  let entries: Entry[] = [];
  let nextId = 0;

  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message.role === 'user' || message.role === 'system') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => (part as { text?: string }).text ?? '').join('')
            : '';
      const images = imagesOfContent(message.content);
      if (text.trim() || images.length > 0) {
        entries.push({
          id: nextId++,
          role: 'user',
          text,
          images: images.length > 0 ? images : undefined,
        });
      }
      continue;
    }
    if (message.role === 'assistant') {
      const parts = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: String(message.content ?? '') }];
      for (const rawPart of parts) {
        const part = rawPart as {
          type?: string;
          text?: string;
          toolCallId?: string;
          toolName?: string;
          input?: unknown;
        };
        if (part.type === 'text' && part.text?.trim()) {
          entries.push({ id: nextId++, role: 'assistant', text: part.text });
        } else if (part.type === 'tool-call') {
          entries.push({
            id: nextId++,
            role: 'tool',
            tool: {
              callId: part.toolCallId ?? '',
              name: part.toolName ?? 'tool',
              input: part.input,
              status: 'running',
            },
          });
        }
      }
      continue;
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        const part = rawPart as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
          output?: unknown;
        };
        if (part.type !== 'tool-result') continue;
        entries = attachToolResult(
          entries,
          part.toolCallId ?? '',
          stringifyOutput(part.output),
          'done',
          part.toolName ?? 'tool',
        );
      }
    }
  }
  return entries;
}

function settled(tool: ToolInfo, output: unknown, status: 'done' | 'error'): ToolInfo {
  return { ...tool, status, ...(status === 'error' ? { error: String(output) } : { output }) };
}

function isOpen(tool: ToolInfo, callId: string, legacyName?: string): boolean {
  if (tool.status !== 'running') return false;
  return callId !== '' ? tool.callId === callId : tool.name === legacyName;
}

function lastOpenChild(children: ToolInfo[], callId: string, legacyName?: string): number {
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child && isOpen(child, callId, legacyName)) return index;
  }
  return -1;
}

function replaceTool(entries: Entry[], index: number, tool: ToolInfo): Entry[] {
  return entries.map((entry, position) =>
    position === index && entry.tool ? { ...entry, tool } : entry,
  );
}

/**
 * Close the call with this id, at either depth. Sessions stored before call ids
 * arrive with `callId: ''` and are matched by tool name instead.
 */
export function attachToolResult(
  entries: Entry[],
  callId: string,
  output: unknown,
  status: 'done' | 'error',
  legacyName?: string,
): Entry[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const tool = entries[index]?.tool;
    if (!tool) continue;

    const agent = tool.agent;
    if (agent) {
      const childIndex = lastOpenChild(agent.children, callId, legacyName);
      if (childIndex >= 0) {
        const children = agent.children.map((child, position) =>
          position === childIndex ? settled(child, output, status) : child,
        );
        return replaceTool(entries, index, { ...tool, agent: { ...agent, children } });
      }
    }
    if (isOpen(tool, callId, legacyName)) {
      return replaceTool(entries, index, settled(tool, output, status));
    }
  }
  return entries;
}

/** Record a tool call, nesting it under the subagent that made it when there is one. */
export function addToolCall(
  entries: Entry[],
  tool: ToolInfo,
  nextId: () => number,
  agentCallId?: string,
): Entry[] {
  const fresh: Entry = { id: nextId(), role: 'tool', at: Date.now(), tool };

  if (agentCallId !== undefined) {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      const agent = entry?.tool?.agent;
      if (entry?.tool && agent && entry.tool.callId === agentCallId) {
        return replaceTool(entries, index, {
          ...entry.tool,
          agent: { ...agent, children: [...agent.children, tool] },
        });
      }
    }
    // A child whose parent card is missing still has to show up.
    return [...entries, fresh];
  }

  const placeholder = tool.callId === '' ? -1 : indexOfCall(entries, tool.callId);
  if (placeholder === -1) return [...entries, fresh];

  // The branch stood in for this call; adopt the real name and input, keep its tree.
  const existing = entries[placeholder]?.tool;
  return replaceTool(
    entries,
    placeholder,
    existing?.agent ? { ...tool, agent: existing.agent } : tool,
  );
}

function indexOfCall(entries: Entry[], callId: string): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.tool?.callId === callId) return index;
  }
  return -1;
}

/**
 * Open a subagent branch. A child can report before the parent's `agent` call
 * reaches the view, so the card is created on demand instead of dropped.
 */
export function startAgent(
  entries: Entry[],
  callId: string,
  run: { type: string; prompt: string },
  nextId: () => number,
): Entry[] {
  const agent: AgentRun = { ...run, status: 'running', children: [] };
  const index = indexOfCall(entries, callId);
  if (index === -1) {
    return [
      ...entries,
      {
        id: nextId(),
        role: 'tool',
        at: Date.now(),
        tool: {
          callId,
          name: 'agent',
          input: { type: run.type, prompt: run.prompt },
          status: 'running',
          agent,
        },
      },
    ];
  }
  return entries.map((entry, position) =>
    position === index && entry.tool
      ? {
          ...entry,
          tool: {
            ...entry.tool,
            agent: {
              ...agent,
              children: entry.tool.agent?.children ?? agent.children,
            },
          },
        }
      : entry,
  );
}

export function endAgent(
  entries: Entry[],
  callId: string,
  result: { text: string; tokens: number; costUsd: number },
): Entry[] {
  return entries.map((entry) => {
    const agent = entry.tool?.agent;
    return entry.tool?.callId === callId && agent
      ? { ...entry, tool: { ...entry.tool, agent: { ...agent, ...result, status: 'done' } } }
      : entry;
  });
}

/** Every file a turn's calls named, child agents included: what an undo could move. */
function touchedPaths(turn: Turn): Set<string> {
  const paths = new Set<string>();
  const walk = (tools: ToolInfo[]): void => {
    for (const tool of tools) {
      const input = tool.input;
      if (input !== null && typeof input === 'object') {
        const path = (input as Record<string, unknown>).path;
        if (typeof path === 'string' && path.trim() !== '') paths.add(path);
      }
      if (tool.agent) walk(tool.agent.children);
    }
  };
  walk(turn.body.map((entry) => entry.tool).filter((tool): tool is ToolInfo => tool !== undefined));
  return paths;
}

/**
 * The prompt as it was typed, which is what a card shows, against the message
 * that was stored: an `@file` mention keeps the words ahead of the blocks it
 * pulled in, so a stored prompt is the typed one or the typed one and an annex.
 */
function sameAsk(row: string, card: string): boolean {
  return row === card || card.startsWith(`${row}\n\n`);
}

/**
 * Which card each undo archive belongs to, and which ones belong to none.
 *
 * Turn numbers cannot answer that: a compressed or a failed turn changes what
 * the nth turn is on one side of the wire and not the other, and a wrong answer
 * silently reverts the wrong files. The prompt a card prints is the one part of
 * a turn both sides keep, so a card answers to an archive only when that
 * archive asked its own words — and when two cards ask the same words, only the
 * one whose own calls named a file the archive can put back. Anything still
 * tied is left off the cards, which is where `unclaimed` picks it up: the
 * archive is a fact about the workspace whatever did it, so it gets a card of
 * its own rather than vanishing from the screen.
 */
export interface UndoLinks {
  /** The archive a card can give back, by card key. Absent means that card has nothing to undo. */
  byTurn: Map<number, CheckpointTurnRow>;
  /** Every archive no card took, in the order the turns ran. */
  unclaimed: CheckpointTurnRow[];
}

export function linkUndos(turns: Turn[], rows: CheckpointTurnRow[]): UndoLinks {
  const claims: { turn: Turn; rows: CheckpointTurnRow[] }[] = [];
  for (const turn of turns) {
    const asked = turn.user?.text;
    if (asked === undefined || asked.trim() === '') continue;
    const matching = rows.filter((row) => sameAsk(row.prompt, asked));
    if (matching.length > 0) claims.push({ turn, rows: matching });
  }

  const shares = new Map<Turn, Set<string>>();
  const touches = (turn: Turn, row: CheckpointTurnRow): boolean => {
    const paths = shares.get(turn) ?? touchedPaths(turn);
    shares.set(turn, paths);
    return row.files.some((path) => paths.has(path));
  };

  for (const row of rows) {
    const suitors = claims.filter((claim) => claim.rows.includes(row));
    if (suitors.length < 2) continue;
    for (const suitor of suitors) {
      if (touches(suitor.turn, row)) continue;
      suitor.rows = suitor.rows.filter((item) => item !== row);
    }
  }

  const byTurn = new Map<number, CheckpointTurnRow>();
  for (const claim of claims) {
    const row = claim.rows.length === 1 ? claim.rows[0] : undefined;
    if (!row) continue;
    // Still answered by another card that can prove it too: neither is told.
    if (claims.filter((other) => other.rows[0] === row).length > 1) continue;
    byTurn.set(claim.turn.key, row);
  }

  const taken = new Set(byTurn.values());
  return { byTurn, unclaimed: rows.filter((row) => !taken.has(row)) };
}
