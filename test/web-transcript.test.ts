import { describe, expect, it } from 'vitest';
import {
  attachToolResult,
  entriesFromMessages,
  previewValue,
  stringifyOutput,
  summarizeInput,
} from '../web/src/transcript';

describe('transcript helpers', () => {
  it('previews the first non-empty line and truncates', () => {
    expect(previewValue('\nfirst line\nsecond', 20)).toBe('first line');
    expect(previewValue('x'.repeat(10), 4)).toBe('xxxx…');
  });

  it('summarizes tool input by its most useful field', () => {
    expect(summarizeInput({ path: 'src/a.ts', content: 'x' })).toBe('src/a.ts');
    expect(summarizeInput({ command: 'npm test' })).toBe('npm test');
    expect(summarizeInput({ unknown: 'value' })).toBe('{"unknown":"value"}');
    expect(summarizeInput('plain')).toBe('plain');
  });

  it('stringifies tool output shapes', () => {
    expect(stringifyOutput('text')).toBe('text');
    expect(stringifyOutput({ value: 'inner' })).toBe('inner');
    expect(stringifyOutput({ ok: true })).toBe('{\n  "ok": true\n}');
  });

  it('rebuilds entries from stored model messages and resolves tool results', () => {
    const entries = entriesFromMessages([
      { role: 'user', content: 'please write' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'writing now' },
          { type: 'tool-call', toolName: 'write', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolName: 'write', output: { value: 'wrote a.ts' } }],
      },
      { role: 'assistant', content: 'done' },
    ]);

    expect(entries.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const tool = entries[2]?.tool;
    expect(tool).toMatchObject({ name: 'write', status: 'done', output: 'wrote a.ts' });
    expect(entries[3]?.text).toBe('done');
  });

  it('ignores tool results without a matching running entry', () => {
    const entries = [{ id: 0, role: 'user' as const, text: 'hi' }];
    expect(attachToolResult(entries, 'write', 'out', 'done')).toBe(entries);
  });

  it('records tool failures as errors', () => {
    const entries = [
      {
        id: 0,
        role: 'tool' as const,
        tool: { name: 'bash', input: {}, status: 'running' as const },
      },
    ];
    const [result] = attachToolResult(entries, 'bash', 'exit 1', 'error');
    expect(result?.tool).toMatchObject({ status: 'error', error: 'exit 1' });
  });
});
