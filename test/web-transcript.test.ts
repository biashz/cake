import { describe, expect, it } from 'vitest';
import type { CheckpointTurnRow } from '../src/desktop/api.js';
import { collectChanges } from '../web/src/changes';
import {
  addToolCall,
  attachToolResult,
  buildTurns,
  type Entry,
  endAgent,
  entriesFromMessages,
  linkUndos,
  previewValue,
  startAgent,
  stringifyOutput,
  summarizeInput,
  type ToolInfo,
} from '../web/src/transcript';

function tool(callId: string, name: string, input: unknown): ToolInfo {
  return { callId, name, input, status: 'running' };
}

function toolEntry(id: number, info: ToolInfo): Entry {
  return { id, role: 'tool', tool: info };
}

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

  it('reads plan steps as steps, matching the kernel summary', () => {
    expect(summarizeInput({ action: 'add', subject: 'read the code' })).toBe('add "read the code"');
    expect(summarizeInput({ action: 'update', id: 1, status: 'completed' })).toBe('#1 → completed');
    expect(summarizeInput({ action: 'clear' })).toBe('clear');
  });

  it('stringifies tool output shapes', () => {
    expect(stringifyOutput('text')).toBe('text');
    expect(stringifyOutput({ value: 'inner' })).toBe('inner');
    expect(stringifyOutput({ ok: true })).toBe('{\n  "ok": true\n}');
  });
});

describe('attachToolResult', () => {
  it('closes the call with the matching id, not merely the same tool', () => {
    const entries = [
      toolEntry(0, tool('read-1', 'read', { path: 'a.ts' })),
      toolEntry(1, tool('read-2', 'read', { path: 'b.ts' })),
    ];

    const first = attachToolResult(entries, 'read-1', 'contents of a', 'done');
    expect(first[0]?.tool).toMatchObject({ status: 'done', output: 'contents of a' });
    expect(first[1]?.tool?.status).toBe('running');

    const both = attachToolResult(first, 'read-2', 'contents of b', 'done');
    expect(both[1]?.tool).toMatchObject({ status: 'done', output: 'contents of b' });
  });

  it('records tool failures as errors', () => {
    const entries = [toolEntry(0, tool('bash-1', 'bash', { command: 'false' }))];
    const [result] = attachToolResult(entries, 'bash-1', 'exit 1', 'error');
    expect(result?.tool).toMatchObject({ status: 'error', error: 'exit 1' });
  });

  it('ignores results with no open call', () => {
    const entries = [{ id: 0, role: 'user' as const, text: 'hi' }];
    expect(attachToolResult(entries, 'write-1', 'out', 'done')).toBe(entries);
  });

  it('closes a call nested inside a subagent', () => {
    let entries = [toolEntry(0, tool('agent-1', 'agent', { type: 'explore' }))];
    entries = startAgent(entries, 'agent-1', { type: 'explore', prompt: 'find alpha' }, () => 9);
    entries = addToolCall(
      entries,
      tool('agent-1/grep-1', 'explore:grep', { pattern: 'alpha' }),
      () => 1,
      'agent-1',
    );

    const closed = attachToolResult(entries, 'agent-1/grep-1', '2 matches', 'done');
    expect(closed[0]?.tool?.agent?.children[0]).toMatchObject({
      status: 'done',
      output: '2 matches',
    });
  });

  it('matches by tool name when a stored session has no call ids', () => {
    const entries = [toolEntry(0, { ...tool('', 'write', { path: 'a.ts' }), status: 'running' })];
    const [result] = attachToolResult(entries, '', 'wrote a.ts', 'done', 'write');
    expect(result?.tool).toMatchObject({ status: 'done', output: 'wrote a.ts' });
  });
});

describe('subagent tree', () => {
  it('nests child calls under the agent call that made them', () => {
    const opened = startAgent(
      [toolEntry(0, tool('agent-1', 'agent', { type: 'explore' }))],
      'agent-1',
      { type: 'explore', prompt: 'look' },
      () => 9,
    );
    const entries = addToolCall(
      opened,
      tool('agent-1/read-1', 'explore:read', { path: 'a.ts' }),
      () => 1,
      'agent-1',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool?.agent?.children.map((child) => child.callId)).toEqual([
      'agent-1/read-1',
    ]);
  });

  it('opens the branch when a child reports before its parent call lands', () => {
    let entries: Entry[] = [];
    entries = startAgent(entries, 'agent-1', { type: 'explore', prompt: 'look' }, () => 0);
    entries = addToolCall(
      entries,
      tool('agent-1/read-1', 'explore:read', { path: 'a.ts' }),
      () => 1,
      'agent-1',
    );
    entries = attachToolResult(entries, 'agent-1/read-1', 'file a.ts', 'done', 'explore:read');
    entries = addToolCall(
      entries,
      tool('agent-1', 'agent', { type: 'explore', prompt: 'look' }),
      () => 2,
    );
    entries = endAgent(entries, 'agent-1', { text: 'Found it.', tokens: 12, costUsd: 0.001 });
    entries = attachToolResult(entries, 'agent-1', '[explore agent] Found it.', 'done', 'agent');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toMatchObject({ name: 'agent', status: 'done' });
    expect(entries[0]?.tool?.agent).toMatchObject({
      status: 'done',
      text: 'Found it.',
      tokens: 12,
    });
    expect(entries[0]?.tool?.agent?.children).toMatchObject([
      { callId: 'agent-1/read-1', status: 'done', output: 'file a.ts' },
    ]);
  });

  it('keeps two agents of the same type apart', () => {
    let entries = [
      toolEntry(0, tool('agent-1', 'agent', { type: 'explore' })),
      toolEntry(1, tool('agent-2', 'agent', { type: 'explore' })),
    ];
    entries = startAgent(entries, 'agent-1', { type: 'explore', prompt: 'find alpha' }, () => 9);
    entries = startAgent(entries, 'agent-2', { type: 'explore', prompt: 'find beta' }, () => 9);
    entries = addToolCall(
      entries,
      tool('agent-2/read-1', 'explore:read', { path: 'b.ts' }),
      () => 2,
      'agent-2',
    );

    expect(entries[0]?.tool?.agent?.children).toHaveLength(0);
    expect(entries[1]?.tool?.agent?.children).toHaveLength(1);
  });

  it('reports a child call at the top level if its agent card is missing', () => {
    const entries = addToolCall([], tool('gone/read-1', 'explore:read', {}), () => 0, 'gone');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.role).toBe('tool');
  });

  it('fills in the run summary and totals when the agent ends', () => {
    let entries = [toolEntry(0, tool('agent-1', 'agent', { type: 'general' }))];
    entries = startAgent(entries, 'agent-1', { type: 'general', prompt: 'do it' }, () => 9);
    entries = endAgent(entries, 'agent-1', { text: 'Done.', tokens: 35, costUsd: 0.004 });

    expect(entries[0]?.tool?.agent).toMatchObject({
      status: 'done',
      text: 'Done.',
      tokens: 35,
      costUsd: 0.004,
    });
  });
});

describe('buildTurns', () => {
  it('splits on user messages and counts nested calls', () => {
    let entries = [
      { id: 0, role: 'user' as const, text: 'first' },
      toolEntry(1, tool('read-1', 'read', {})),
      { id: 2, role: 'assistant' as const, text: 'answer' },
      { id: 3, role: 'user' as const, text: 'second' },
      toolEntry(4, tool('agent-1', 'agent', { type: 'explore' })),
    ];
    entries = startAgent(entries, 'agent-1', { type: 'explore', prompt: 'look' }, () => 9);
    entries = addToolCall(entries, tool('agent-1/read-1', 'explore:read', {}), () => 5, 'agent-1');

    const turns = buildTurns(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.user?.text).toBe('first');
    expect(turns[0]?.body.map((entry) => entry.id)).toEqual([1, 2]);
    expect(turns[1]?.toolCount).toBe(2);
  });

  it('opens an anonymous turn for content with no request behind it', () => {
    const turns = buildTurns([{ id: 0, role: 'note' as const, text: 'indexed' }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user).toBeUndefined();
    expect(turns[0]?.body).toHaveLength(1);
  });

  it('reports a duration only when the whole turn is timestamped', () => {
    const stamped = buildTurns([
      { id: 0, role: 'user' as const, text: 'go', at: 1_000 },
      { id: 1, role: 'assistant' as const, text: 'done', at: 4_500 },
    ]);
    expect(stamped[0]?.startedAt).toBe(1_000);
    expect(stamped[0]?.endedAt).toBe(4_500);

    const reloaded = buildTurns([
      { id: 0, role: 'user' as const, text: 'go' },
      { id: 1, role: 'assistant' as const, text: 'done' },
    ]);
    expect(reloaded[0]?.startedAt).toBeUndefined();
    expect(reloaded[0]?.endedAt).toBeUndefined();
  });
});

describe('entriesFromMessages', () => {
  it('rebuilds entries from stored model messages and resolves tool results', () => {
    const entries = entriesFromMessages([
      { role: 'user', content: 'please write' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'writing now' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'write', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'write',
            output: { value: 'wrote a.ts' },
          },
        ],
      },
      { role: 'assistant', content: 'done' },
    ]);

    expect(entries.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(entries[2]?.tool).toMatchObject({
      callId: 'call-1',
      name: 'write',
      status: 'done',
      output: 'wrote a.ts',
    });
    expect(entries[3]?.text).toBe('done');
  });

  it.each([
    { type: 'error-text', value: 'Permission denied: write' },
    { type: 'error-json', value: { message: 'File is read-only' } },
  ])('keeps stored $type results out of completed changes', (output) => {
    const entries = entriesFromMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'denied',
            toolName: 'write',
            input: { path: 'a.ts', content: 'not written' },
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'denied', toolName: 'write', output }],
      },
    ]);
    expect(entries[0]?.tool).toMatchObject({ status: 'error', error: stringifyOutput(output) });
    expect(entries[0]?.tool?.output).toBeUndefined();
    expect(collectChanges(entries)).toEqual([]);
  });

  it('still resolves history written without call ids', () => {
    const entries = entriesFromMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolName: 'read', input: { path: 'a.ts' } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolName: 'read', output: 'contents' }],
      },
    ]);
    expect(entries[0]?.tool).toMatchObject({ callId: '', status: 'done', output: 'contents' });
  });

  it('keeps the pictures a turn carried with the request they belong to', () => {
    const entries = entriesFromMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this shot' },
          { type: 'file', mediaType: 'image/png', data: 'aGVsbG8=' },
        ],
      },
      { role: 'assistant', content: 'a cat, asleep' },
    ]);

    expect(entries[0]).toMatchObject({
      role: 'user',
      text: 'what is in this shot',
      images: ['data:image/png;base64,aGVsbG8='],
    });
    // Words alone are not a picture, so nothing extra rides on the entry.
    expect(entriesFromMessages([{ role: 'user', content: 'plain' }])[0]?.images).toBeUndefined();

    // A picture with no words at all is still a turn the person sent.
    const only = entriesFromMessages([
      { role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: 'aGVsbG8=' }] },
    ]);
    expect(only[0]).toMatchObject({ role: 'user', text: '', images: [expect.any(String)] });
  });
});

/** An archive as the kernel hands it over. */
function archive(checkpointId: string, prompt: string, files: string[]): CheckpointTurnRow {
  return { checkpointId, prompt, startedAt: 1_700_000_000_000, files };
}

function wrote(id: number, callId: string, path: string): Entry {
  return {
    id,
    role: 'tool',
    tool: { callId, name: 'write', input: { path, content: 'x\n' }, status: 'done' },
  };
}

describe('linkUndos', () => {
  it('gives a card the archive of the turn that asked for it', () => {
    const turns = buildTurns([
      { id: 0, role: 'user', text: 'rename the parser' },
      wrote(1, 'w-1', 'src/parser.ts'),
    ]);
    const links = linkUndos(turns, [archive('c-1', 'rename the parser', ['src/parser.ts'])]);
    expect(links.byTurn.get(turns[0]?.key ?? -1)?.checkpointId).toBe('c-1');
    expect(links.unclaimed).toHaveLength(0);
  });

  it('reads a stored prompt through the annex an @file mention pulled in', () => {
    const typed = 'explain @parser.ts';
    const turns = buildTurns([
      { id: 0, role: 'user', text: `${typed}\n\n<file path="parser.ts">\nconst a = 1;\n</file>` },
      wrote(1, 'w-1', 'parser.ts'),
    ]);
    const links = linkUndos(turns, [archive('c-1', typed, ['parser.ts'])]);
    expect(links.byTurn.get(turns[0]?.key ?? -1)?.checkpointId).toBe('c-1');
  });

  it('will not read a longer ask as the one it starts with', () => {
    const turns = buildTurns([{ id: 0, role: 'user', text: 'fix the parser and the tests' }]);
    const links = linkUndos(turns, [archive('c-1', 'fix the parser', ['a.ts'])]);
    expect(links.byTurn.size).toBe(0);
  });

  it('tells two turns that asked the same words apart by the files they moved', () => {
    const turns = buildTurns([
      { id: 0, role: 'user', text: 'fix it' },
      wrote(1, 'w-1', 'a.ts'),
      { id: 2, role: 'user', text: 'fix it' },
      wrote(3, 'w-2', 'b.ts'),
    ]);
    const links = linkUndos(turns, [
      archive('c-a', 'fix it', ['a.ts']),
      archive('c-b', 'fix it', ['b.ts']),
    ]);
    expect(links.byTurn.get(turns[0]?.key ?? -1)?.checkpointId).toBe('c-a');
    expect(links.byTurn.get(turns[1]?.key ?? -1)?.checkpointId).toBe('c-b');
  });

  it('keeps one archive for the card its files prove, and tells the other nothing', () => {
    const turns = buildTurns([
      { id: 0, role: 'user', text: 'fix it' },
      wrote(1, 'w-1', 'a.ts'),
      { id: 2, role: 'user', text: 'fix it' },
      wrote(3, 'w-2', 'b.ts'),
    ]);
    const links = linkUndos(turns, [archive('c-a', 'fix it', ['a.ts'])]);
    expect(links.byTurn.get(turns[0]?.key ?? -1)?.checkpointId).toBe('c-a');
    expect(links.byTurn.has(turns[1]?.key ?? -1)).toBe(false);
  });

  it('leaves both cards without undo rather than guess between two identical asks', () => {
    const turns = buildTurns([
      { id: 0, role: 'user', text: 'fix it' },
      wrote(1, 'w-1', 'a.ts'),
      { id: 2, role: 'user', text: 'fix it' },
      wrote(3, 'w-2', 'a.ts'),
    ]);
    // Both cards wrote the same path, so the archive proves nothing about which
    // turn closed it.
    expect(linkUndos(turns, [archive('c-1', 'fix it', ['a.ts'])]).byTurn.size).toBe(0);
  });

  it('offers no undo when an ask matches more than one archive and no file settles it', () => {
    const turns = buildTurns([{ id: 0, role: 'user', text: 'fix it' }, wrote(1, 'w-1', 'z.ts')]);
    const links = linkUndos(turns, [
      archive('c-a', 'fix it', ['a.ts']),
      archive('c-b', 'fix it', ['b.ts']),
    ]);
    expect(links.byTurn.size).toBe(0);
  });

  it('says nothing to a card that never asked for anything', () => {
    const turns = buildTurns([
      { id: 0, role: 'note', kind: 'export', text: 'Markdown transcript' },
      { id: 1, role: 'user', text: '' },
    ]);
    expect(linkUndos(turns, [archive('c-1', '', ['a.ts'])]).byTurn.size).toBe(0);
  });

  it('hands back the archive of a turn that left no card at all', () => {
    // The turn was refused before it answered, so its transcript was never stored
    // and reopening the session shows no card. The archive is still a fact about
    // the workspace, so it comes back unclaimed rather than vanishing.
    const turns = buildTurns([{ id: 0, role: 'user', text: 'something else entirely' }]);
    const links = linkUndos(turns, [archive('c-1', 'write the report', ['report.md'])]);
    expect(links.byTurn.size).toBe(0);
    expect(links.unclaimed.map((row) => row.checkpointId)).toEqual(['c-1']);
  });

  it('keeps an archive out of the loose ones once a card has taken it', () => {
    const turns = buildTurns([
      { id: 0, role: 'user', text: 'rename the parser' },
      wrote(1, 'w-1', 'src/parser.ts'),
    ]);
    const links = linkUndos(turns, [archive('c-1', 'rename the parser', ['src/parser.ts'])]);
    expect(links.unclaimed).toHaveLength(0);
  });

  it('lists the loose archives in the order the turns ran', () => {
    const turns = buildTurns([{ id: 0, role: 'user', text: 'a turn answered' }]);
    const links = linkUndos(turns, [
      archive('c-1', 'the ask that died', ['a.ts']),
      archive('c-2', 'a later one that died', ['b.ts']),
    ]);
    expect(links.unclaimed.map((row) => row.checkpointId)).toEqual(['c-1', 'c-2']);
  });

  it('surfaces a loose archive whose ask was never recorded', () => {
    const links = linkUndos(buildTurns([]), [archive('c-1', '', ['a.ts'])]);
    expect(links.unclaimed.map((row) => row.checkpointId)).toEqual(['c-1']);
  });

  it('attaches nothing to a card whose turn has no archive at all', () => {
    const turns = buildTurns([{ id: 0, role: 'user', text: 'explain the parser' }]);
    const links = linkUndos(turns, []);
    expect(links.byTurn.size).toBe(0);
    expect(links.unclaimed).toHaveLength(0);
  });
});
