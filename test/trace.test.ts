import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTrace } from '../src/observability/trace.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-trace-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('createTrace', () => {
  it('is disabled unless CAKE_TRACE=1', () => {
    expect(createTrace(cwd, {})).toBeUndefined();
    expect(createTrace(cwd, { CAKE_TRACE: '0' })).toBeUndefined();
  });

  it('writes JSONL events, skipping text deltas and serializing errors', async () => {
    const trace = createTrace(cwd, { CAKE_TRACE: '1' });
    expect(trace).toBeDefined();
    if (!trace) return;

    trace.record({ type: 'start', model: { provider: 'anthropic', modelId: 'claude' } });
    trace.record({ type: 'text-delta', delta: 'ignored' });
    trace.record({
      type: 'tool-call',
      callId: 'call-1',
      toolName: 'read',
      input: { path: 'a.ts' },
    });
    trace.record({
      type: 'tool-error',
      callId: 'call-2',
      toolName: 'bash',
      error: new Error('boom'),
    });

    const lines = (await readFile(trace.file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.type)).toEqual(['start', 'tool-call', 'tool-error']);
    expect(lines[2]?.error).toEqual({ name: 'Error', message: 'boom' });
  });

  it('truncates oversized payloads', async () => {
    const trace = createTrace(cwd, { CAKE_TRACE: '1' });
    if (!trace) throw new Error('trace disabled');
    trace.record({
      type: 'tool-result',
      callId: 'call-1',
      toolName: 'read',
      input: {},
      output: 'x'.repeat(5_000),
    });

    const line = JSON.parse((await readFile(trace.file, 'utf8')).trim()) as {
      output: string;
    };
    expect(line.output.length).toBeLessThanOrEqual(2_001);
    expect(line.output.endsWith('…')).toBe(true);
  });
});
