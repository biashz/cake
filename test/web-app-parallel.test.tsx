// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyCostBoard } from '../src/core/cost-board.js';
import type {
  AgentEventEnvelope,
  AgentNoteEnvelope,
  CakeApi,
  CheckpointTurnRow,
  ContextPayload,
  InitPayload,
  PermissionRequestEnvelope,
  RunResult,
  SessionInfo,
  SessionPayload,
} from '../src/desktop/api.js';
import { App } from '../web/src/App';

afterEach(cleanup);

/** A stored turn, in the shape the kernel writes and `entriesFromMessages` reads. */
interface Stored {
  role: 'user' | 'assistant';
  content: string;
}

interface FakeKernel {
  api: CakeApi;
  /** One call of `run`, in the order they arrived. A pending turn is not in the store yet. */
  turns: { sessionId: string; prompt: string }[];
  /** Each read of the undo archives, in order: which session was asked for its list. */
  reads: string[];
  /** Each rewind asked for, with the confirmation that meant to override a conflict. */
  reverts: { checkpointId: string; force: boolean }[];
  /** The archives on offer, per session, in the shape the kernel answers with. */
  archives: Record<string, CheckpointTurnRow[]>;
  /** Answer a pending turn: write its exchange to the store, then close the run. */
  settle(sessionId: string, answer: string, undo?: { path: string }): Promise<void>;
  /** Close a pending turn with an error, leaving nothing but its archive. */
  fail(sessionId: string, message: string, undo?: { path: string }): Promise<void>;
  emit(sessionId: string, event: unknown): Promise<void>;
  note(sessionId: string | undefined, text: string): Promise<void>;
  ask(sessionId: string, id: string): Promise<void>;
  answered: { id: string; decision: string }[];
  stored: Record<string, Stored[]>;
}

const IDS = ['s1', 's2'] as const;

function fakeKernel(start: Record<string, Stored[]>): FakeKernel {
  const events = new Set<(wire: AgentEventEnvelope) => void>();
  const notes = new Set<(wire: AgentNoteEnvelope) => void>();
  const asks = new Set<(wire: PermissionRequestEnvelope) => void>();
  const stored = start;
  const turns: { sessionId: string; prompt: string }[] = [];
  const answered: { id: string; decision: string }[] = [];
  const waiters = new Map<string, (result: RunResult) => void>();
  const failers = new Map<string, (err: Error) => void>();
  const reads: string[] = [];
  const reverts: { checkpointId: string; force: boolean }[] = [];
  const archives: Record<string, CheckpointTurnRow[]> = { s1: [], s2: [] };
  let archived = 0;
  /** What the kernel keeps when a turn that moved a file closes, however it ends. */
  function nameArchive(sessionId: string, prompt: string, file: string): void {
    archived += 1;
    archives[sessionId] = [
      ...(archives[sessionId] ?? []),
      { checkpointId: `c-${archived}`, prompt, startedAt: archived, files: [file] },
    ];
  }

  const session = (id: string): SessionInfo => ({
    id,
    title: `Ticket ${id}`,
    cwd: '/repo',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    totalTokens: 10,
    costUsd: 0.01,
    unpricedTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  const payload = (id: string): SessionPayload => ({
    session: session(id),
    messages: stored[id] ?? [],
    plan: [],
  });

  const init = (): InitPayload => ({
    version: '0.1.0',
    workspace: { cwd: '/repo', sessionId: 's1' },
    recents: [],
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        defaultModelId: 'claude-sonnet-4-5',
        hasKey: true,
      },
    ],
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    attachments: { vision: false, perTurn: 4, maxBytes: 5_000_000 },
    mode: 'default',
    rules: { allow: [], deny: [], files: { project: null, global: null }, conflicts: [] },
    mcpStatus: {
      servers: [],
      tools: 0,
      warnings: [],
      rows: [],
      files: { global: null, project: null },
      changes: [],
    },
    missingKeys: [],
    cost: {
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      effective: null,
      source: null,
      overrides: [],
      builtin: [],
      configFile: null,
      board: emptyCostBoard(),
      rollup: null,
      workspace: null,
    },
    plan: [],
  });

  const context: ContextPayload = {
    layers: [],
    maxContext: 200_000,
    used: 0,
    free: 200_000,
    estimated: true,
  };

  const api: CakeApi = {
    init: async () => init(),
    pickWorkspace: async () => null,
    openWorkspace: async () => init(),
    listSessions: async () => IDS.map((id) => session(id)),
    newSession: async () => payload('s1'),
    openSession: async (id) => payload(id),
    renameSession: async () => IDS.map((id) => session(id)),
    deleteSession: async () => null,
    forkSession: async (id) => payload(id),
    exportSession: async () => ({ file: 'out.md', pictures: 0 }),
    checkpointTurns: async (sessionId) => {
      reads.push(sessionId);
      return archives[sessionId] ?? [];
    },
    revertCheckpoint: async (checkpointId, force) => {
      reverts.push({ checkpointId, force: force === true });
      const row = Object.values(archives)
        .flat()
        .find((item) => item.checkpointId === checkpointId);
      return {
        checkpointId,
        applied: true,
        changes: (row?.files ?? []).map((file) => ({ path: file, action: 'restored' as const })),
        overwrittenBy: [],
      };
    },
    run: async (sessionId, prompt) =>
      new Promise<RunResult>((resolve, reject) => {
        turns.push({ sessionId, prompt });
        waiters.set(sessionId, resolve);
        failers.set(sessionId, reject);
      }),
    abort: async () => {},
    respondPermission: async (id, decision) => {
      answered.push({ id, decision });
    },
    setModel: async () => init(),
    setMode: async () => init(),
    setPricing: async () => init(),
    getCost: async () => init().cost,
    setRule: async () => init(),
    moveRule: async () => init(),
    reloadMcp: async () => init(),
    setMcpServer: async () => init(),
    removeMcpServer: async () => init(),
    setMcpEnabled: async () => init(),
    listFiles: async () => [],
    runDoctor: async () => ({ checks: [], ok: true }),
    setProviderKey: async () => init(),
    rebuildIndex: async () => 'indexed',
    openDoctorFile: async () => 'config.json',
    revealDoctorStore: async () => 'cake.db',
    contextLayers: async () => context,
    onAgentEvent: (handler) => {
      events.add(handler);
      return () => events.delete(handler);
    },
    onAgentNote: (handler) => {
      notes.add(handler);
      return () => notes.delete(handler);
    },
    onPermissionRequest: (handler) => {
      asks.add(handler);
      return () => asks.delete(handler);
    },
    onMcpStatus: () => () => {},
  };

  const send = async (run: () => void) => {
    await act(async () => {
      run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  return {
    api,
    turns,
    answered,
    stored,
    reads,
    reverts,
    archives,
    settle: async (sessionId, answer, undo) => {
      const waiter = waiters.get(sessionId);
      if (!waiter) throw new Error(`no turn running in ${sessionId}`);
      waiters.delete(sessionId);
      failers.delete(sessionId);
      // The kernel writes the exchange when the turn ends, never while it runs.
      const prompt = turns.find((turn) => turn.sessionId === sessionId)?.prompt ?? '';
      stored[sessionId] = [
        ...(stored[sessionId] ?? []),
        { role: 'user', content: prompt },
        { role: 'assistant', content: answer },
      ];
      // ...and names the archive it closed with the same prompt, when the turn moved a file.
      if (undo) nameArchive(sessionId, prompt, undo.path);
      await send(() => {
        for (const handler of events) {
          handler({
            sessionId,
            event: {
              type: 'finish',
              text: answer,
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              costUsd: 0.001,
            },
          });
        }
        waiter({
          sessionId,
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          costUsd: 0.001,
          text: answer,
        });
      });
    },
    /** End a turn the way the kernel does when the provider cannot be reached. */
    fail: async (sessionId, message, undo) => {
      const reject = failers.get(sessionId);
      if (!reject) throw new Error(`no turn running in ${sessionId}`);
      failers.delete(sessionId);
      waiters.delete(sessionId);
      // A turn that died still names the archive it closed: that is the whole
      // point of the record, and it stores nothing else.
      if (undo) {
        nameArchive(
          sessionId,
          turns.find((turn) => turn.sessionId === sessionId)?.prompt ?? '',
          undo.path,
        );
      }
      await send(() => reject(new Error(message)));
    },
    emit: (sessionId, event) =>
      send(() => {
        for (const handler of events) handler({ sessionId, event });
      }),
    note: (sessionId, text) =>
      send(() => {
        for (const handler of notes) handler({ sessionId, note: { kind: 'index', text } });
      }),
    ask: (sessionId, id) =>
      send(() => {
        for (const handler of asks) {
          handler({
            sessionId,
            request: { id, tool: 'write_file', permission: 'write', target: 'src/a.ts' },
          });
        }
      }),
  };
}

/** Mount the app, wait for the bridge handshake, and return the session rows. */
async function boot(kernel: FakeKernel) {
  window.cake = kernel.api;
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    async type(prompt: string) {
      const input = screen.getByTestId('composer-input');
      fireEvent.change(input, { target: { value: prompt } });
      fireEvent.submit(input.closest('form') as HTMLFormElement);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async open(id: string) {
      await act(async () => {
        // Anchored: a waiting badge names the same session, and it is not the row.
        fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Ticket ${id}`) }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

/** The kernel notes currently on screen, in transcript order. */
function notes(): string[] {
  return screen.queryAllByTestId('entry-note').map((node) => node.textContent ?? '');
}

describe('App with two sessions', () => {
  it('keeps a running session its own transcript when you switch away and back', async () => {
    const kernel = fakeKernel({ s1: [{ role: 'user', content: 'old question' }], s2: [] });
    const ui = await boot(kernel);

    await ui.type('unfinished question');
    expect(kernel.turns).toEqual([{ sessionId: 's1', prompt: 'unfinished question' }]);

    await ui.open('s2');
    await ui.open('s1');

    // Nothing of this turn is in the store yet, so only the live buffer can show it.
    expect(screen.getByText('unfinished question')).toBeTruthy();
    // And the session is still the one that is running, not one to start over.
    expect(screen.getByTestId('composer-stop')).toBeTruthy();
  });

  it('reads the stored transcript of a session whose turn has finished', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('a finished question');
    await kernel.settle('s1', 'a finished answer');
    await ui.open('s2');
    await ui.open('s1');

    // Reloading from the store replaces the live buffer: one copy of each side.
    expect(screen.getAllByText('a finished question')).toHaveLength(1);
    expect(screen.getAllByText('a finished answer')).toHaveLength(1);
  });

  it('lets a second session start while the first is still waiting', async () => {
    const kernel = fakeKernel({ s1: [{ role: 'assistant', content: 'from the first' }], s2: [] });
    const ui = await boot(kernel);

    await ui.type('the first is waiting');
    await ui.open('s2');

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    await ui.type('the second starts anyway');

    expect(kernel.turns).toEqual([
      { sessionId: 's1', prompt: 'the first is waiting' },
      { sessionId: 's2', prompt: 'the second starts anyway' },
    ]);
    // The second session shows its own turn and none of the first's.
    expect(screen.getByText('the second starts anyway')).toBeTruthy();
    expect(screen.queryByText('the first is waiting')).toBeNull();
    expect(screen.queryByText('from the first')).toBeNull();
  });

  it('shows a background answer only in its own session', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question for the first');
    await ui.open('s2');
    await kernel.emit('s1', { type: 'text-delta', delta: 'the first’' });
    await kernel.emit('s1', { type: 'text-delta', delta: 's answer' });
    await kernel.settle('s1', 'the first’s answer');

    expect(screen.queryByText(/first’s answer/)).toBeNull();

    await ui.open('s1');
    expect(screen.getAllByText('the first’s answer')).toHaveLength(1);
  });

  it('holds an approval for the session that asked, not the one on screen', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    // Two turns waiting, and the card belongs to whichever session asks.
    await ui.type('the first waits');
    await ui.open('s2');
    await ui.type('the second waits');
    await ui.open('s1');

    await kernel.ask('s2', 'p7');
    expect(screen.queryByTestId('approvals')).toBeNull();
    // s2 is off screen and stuck, so the rail is the only place that can say so.
    expect(screen.getByTestId('rail-badge-waiting')).toBeTruthy();

    await ui.open('s2');
    await waitFor(() => expect(screen.getByTestId('approval-card')).toBeTruthy());
    // Now you are looking at it: the mark is gone, the card is not.
    expect(screen.queryByTestId('rail-badge-waiting')).toBeNull();

    fireEvent.click(screen.getByTestId('approval-allow'));
    await waitFor(() => expect(kernel.answered).toEqual([{ id: 'p7', decision: 'allow' }]));
    expect(screen.queryByTestId('approvals')).toBeNull();
  });

  it('routes a note to the session it belongs to', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('the first waits');
    await ui.open('s2');
    await ui.type('the second waits');
    await ui.open('s1');

    // A note tagged with a session waits inside that session, not on screen.
    await kernel.note('s2', 'indexed for the second');
    expect(notes().join(' ')).not.toContain('indexed for the second');
    await ui.open('s2');
    expect(notes().join(' ')).toContain('indexed for the second');

    // A note with no session describes the workspace, so it lands where you stand.
    await kernel.note(undefined, 'index for the workspace');
    expect(notes().join(' ')).toContain('index for the workspace');
    await ui.open('s1');
    expect(notes().join(' ')).not.toContain('index for the workspace');
  });

  it('marks the row of a session that is answering out of sight', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question in the first');
    await ui.open('s2');
    await ui.type('question in the second');

    // Two turns are in flight; only the one you are not reading needs a mark.
    expect(screen.getByTestId('rail-badge-running').textContent).toBe('answering');
    expect(screen.getByTestId('rail-live').textContent).toBe('2 answering');
    expect(screen.queryByText('question in the first')).toBeNull();
  });

  it('hands back an approval from the rail row that asked for it', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question in the first');
    await ui.open('s2');
    await kernel.ask('s1', 'p9');

    // The card is not on this transcript, but the rail says which session holds it.
    expect(screen.queryByTestId('approval-card')).toBeNull();
    expect(screen.getByTestId('rail-badge-waiting').textContent).toBe('waiting for approval');
    // A turn blocked on an approval is not progress, so it counts once.
    expect(screen.getByTestId('rail-live').textContent).toBe('1 waiting');

    await act(async () => {
      fireEvent.click(screen.getByTestId('rail-badge-waiting'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.getByTestId('approval-card')).toBeTruthy());
    expect(screen.queryByTestId('rail-live')).toBeNull();

    fireEvent.click(screen.getByTestId('approval-allow'));
    await waitFor(() => expect(kernel.answered).toEqual([{ id: 'p9', decision: 'allow' }]));
  });

  it('reads the transcript as a log, and keeps the streaming text out of it', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    const log = screen.getByTestId('transcript');
    expect(log.getAttribute('role')).toBe('log');
    expect(log.getAttribute('aria-live')).toBe('polite');

    await ui.type('a question being answered');
    await kernel.emit('s1', { type: 'text-delta', delta: 'part of an answer' });

    // Every token of a stream would be a new sentence to a screen reader, so
    // the text being written stays silent until the finished entry lands.
    await waitFor(() =>
      expect(screen.getByTestId('bubble-assistant').getAttribute('aria-live')).toBe('off'),
    );
  });

  it('names the approval and the failure in front of you as alerts', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('a question that will fail');
    await kernel.ask('s1', 'p4');
    expect(screen.getByTestId('approval-card').getAttribute('role')).toBe('alert');

    await kernel.fail('s1', 'provider is unreachable');
    expect(screen.getByTestId('entry-error').getAttribute('role')).toBe('alert');
  });

  it('says out loud what a session you are not looking at just did', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question in the first');
    await ui.open('s2');
    const spoken = screen.getByTestId('rail-announce');
    expect(spoken.getAttribute('aria-live')).toBe('polite');
    expect(spoken.textContent).toBe('');

    await kernel.ask('s1', 'p1');
    expect(spoken.textContent).toBe('“Ticket s1” is waiting for your approval.');

    await kernel.settle('s1', 'an answer you were not watching for');
    expect(spoken.textContent).toBe('“Ticket s1” has an answer.');
  });

  it('says when a background turn stops with an error instead of an answer', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question in the first');
    await ui.open('s2');
    await kernel.fail('s1', 'provider is unreachable');

    expect(screen.getByTestId('rail-announce').textContent).toBe(
      '“Ticket s1” stopped with an error.',
    );
  });

  it('stays quiet about the session you are already reading', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question in the first');
    await kernel.ask('s1', 'p1');
    await kernel.settle('s1', 'an answer on the screen in front of you');

    // The card and the finished entry speak for themselves; a second voice
    // describing the same session would talk over them.
    expect(screen.getByTestId('rail-announce').textContent).toBe('');
  });

  it('does not repeat, after you switch away, news you watched happen on screen', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('question in the first');
    await ui.open('s2');
    // The record has to stay current while the session is the one on screen,
    // or leaving it later would report an answer you had already read.
    await ui.open('s1');
    await kernel.settle('s1', 'an answer you watched arrive');
    await ui.open('s2');

    expect(screen.getByTestId('rail-announce').textContent).toBe('');
  });
});

describe('App undo wiring', () => {
  /** The last session whose archive list the app asked for. */
  function lastRead(kernel: FakeKernel): string | undefined {
    return kernel.reads[kernel.reads.length - 1];
  }

  it('re-reads the archives once the turn is over, so the card gets its undo', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);
    const before = kernel.reads.length;

    await ui.type('rewrite the parser');
    await kernel.settle('s1', 'parser rewritten', { path: 'src/parser.ts' });

    // A turn that moved a file has to be read again, not kept as the list from
    // before it ran: the archive only exists now.
    expect(kernel.reads.length).toBeGreaterThan(before);
    expect(lastRead(kernel)).toBe('s1');
    await waitFor(() => expect(screen.getByTestId('turn-undo')).toBeTruthy());
    expect(screen.getByTestId('turn-undo').textContent).toContain('src/parser.ts goes back');
  });

  it('keeps the undo on the card of the session that asked, across a switch', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('rewrite the parser');
    await kernel.settle('s1', 'parser rewritten', { path: 'src/parser.ts' });
    await waitFor(() => expect(screen.getByTestId('turn-undo')).toBeTruthy());

    await ui.open('s2');
    expect(screen.queryAllByTestId('turn-undo')).toHaveLength(0);

    // Back to a transcript rebuilt from stored messages: the archive is still
    // found, so the link rides on what the turn asked for, not on memory.
    await ui.open('s1');
    await waitFor(() => expect(screen.queryAllByTestId('turn-undo')).toHaveLength(1));
    expect(lastRead(kernel)).toBe('s1');
  });

  it('points the rewind at the archive its own card was given', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('rewrite the parser');
    await kernel.settle('s1', 'parser rewritten', { path: 'src/parser.ts' });
    await waitFor(() => expect(screen.getByTestId('turn-undo-button')).toBeTruthy());

    fireEvent.click(screen.getByTestId('turn-undo-button'));

    await waitFor(() => expect(kernel.reverts).toEqual([{ checkpointId: 'c-1', force: false }]));
    await waitFor(() =>
      expect(screen.getByTestId('turn-undo-list').textContent).toContain('src/parser.ts put back'),
    );
  });

  it('gives the undo to a turn the provider refused', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('rewrite the parser');
    // The turn ended in an error with the file already changed, and nothing was
    // written to the transcript: this card is the only place to give it back.
    await kernel.fail('s1', 'provider refused the request', { path: 'src/parser.ts' });

    await waitFor(() => expect(screen.getByTestId('turn-undo')).toBeTruthy());
    expect(screen.getByTestId('turn-undo').textContent).toContain('src/parser.ts goes back');
  });

  it('takes the offer away when the archive behind it is gone', async () => {
    const kernel = fakeKernel({ s1: [], s2: [] });
    const ui = await boot(kernel);

    await ui.type('rewrite the parser');
    await kernel.settle('s1', 'parser rewritten', { path: 'src/parser.ts' });
    await waitFor(() => expect(screen.getByTestId('turn-undo-button')).toBeTruthy());

    // The workspace pruned the archive while the card sat open: asking for it is
    // the last time it will ever be offered.
    kernel.archives.s1 = [];
    fireEvent.click(screen.getByTestId('turn-undo-button'));

    await waitFor(() => expect(kernel.reverts).toHaveLength(1));
    await waitFor(() => expect(screen.queryAllByTestId('turn-undo')).toHaveLength(0));
  });
});
