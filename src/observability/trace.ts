import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../core/events.js';

const MAX_FIELD_CHARS = 2_000;

export interface Trace {
  file: string;
  record(event: AgentEvent): void;
}

/** Local-only run log. Opt-in via CAKE_TRACE=1; nothing leaves the machine. */
export function createTrace(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Trace | undefined {
  if (env.CAKE_TRACE !== '1') return undefined;
  const dir = path.join(cwd, '.cake', 'logs');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `run-${stamp}.jsonl`);

  return {
    file,
    record(event) {
      if (event.type === 'text-delta') return;
      try {
        appendFileSync(file, `${JSON.stringify(serialize(event))}\n`, 'utf8');
      } catch {
        // Tracing must never break a run.
      }
    },
  };
}

function truncate(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

function serialize(event: AgentEvent): Record<string, unknown> {
  const base = { ts: new Date().toISOString(), type: event.type };
  switch (event.type) {
    case 'tool-error':
    case 'error':
      return { ...base, error: { name: event.error.name, message: event.error.message } };
    case 'tool-call':
      return { ...base, toolName: event.toolName, input: truncate(event.input) };
    case 'tool-result':
      return {
        ...base,
        toolName: event.toolName,
        input: truncate(event.input),
        output: truncate(event.output),
      };
    default:
      return { ...base, ...event };
  }
}
