// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCostBoard, type CostRow, emptyCostBoard } from '../src/core/cost-board.js';
import type {
  AttachmentCaps,
  CheckpointTurnRow,
  CostPayload,
  DoctorFixPayload,
  InitPayload,
  McpDraft,
  McpServerRow,
  McpStatus,
  RevertResult,
  RuleScopeName,
  RulesPayload,
  SessionInfo,
} from '../src/desktop/api.js';
import type { Attachment } from '../web/src/attachments';
import { ApprovalCard } from '../web/src/components/ApprovalCard';
import { Composer } from '../web/src/components/Composer';
import { HeatBar } from '../web/src/components/HeatBar';
import {
  CostPanel,
  FixControl,
  Inspector,
  type InspectorTab,
  McpSection,
  PlanPanel,
  RulesSection,
} from '../web/src/components/Inspector';
import { SessionHeader } from '../web/src/components/SessionHeader';
import { Sidebar } from '../web/src/components/Sidebar';
import { ToolCard } from '../web/src/components/ToolCard';
import { Transcript } from '../web/src/components/Transcript';
import type { Entry } from '../web/src/transcript';

afterEach(cleanup);

/** A card with nothing to give back, which is what most transcript tests draw. */
const noUndo = {
  checkpoints: [] as CheckpointTurnRow[],
  running: false,
  onUndo: async () =>
    ({
      checkpointId: 'none',
      applied: true,
      changes: [],
      overwrittenBy: [],
    }) satisfies RevertResult,
};

describe('ToolCard', () => {
  it('renders an edit diff as a hunk and toggles details', () => {
    render(
      <ToolCard
        tool={{
          callId: 'edit-1',
          name: 'edit',
          input: { path: 'a.ts', old_string: 'old line', new_string: 'new line' },
          status: 'done',
        }}
      />,
    );

    const diff = screen.getByTestId('diff');
    expect(diff.textContent).toContain('-old line');
    expect(diff.textContent).toContain('+new line');
    expect(diff.textContent).toContain('@1');
    expect(diff.textContent).toContain('+1');
    expect(screen.queryByText('input')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /edit/ }));
    expect(screen.getByText('input')).toBeTruthy();
  });

  it('collapses a hunk without losing its counts', () => {
    render(
      <ToolCard
        tool={{
          callId: 'edit-2',
          name: 'edit',
          input: { path: 'a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\n2\ntwo\nthree' },
          status: 'done',
        }}
      />,
    );

    const head = screen.getByRole('button', { name: /@1/ });
    fireEvent.click(head);
    expect(screen.queryByText('two')).toBeNull();
    expect(screen.getByTestId('diff').textContent).toContain('+1');
  });

  it('shows failure state for tool errors', () => {
    render(
      <ToolCard
        tool={{
          callId: 'bash-1',
          name: 'bash',
          input: { command: 'false' },
          status: 'error',
          error: 'exit 1',
        }}
      />,
    );
    expect(screen.getByText('failed')).toBeTruthy();
  });
});

describe('ApprovalCard', () => {
  it('reports allow and deny decisions', () => {
    const onRespond = vi.fn();
    render(
      <ApprovalCard
        request={{ id: 'p1', tool: 'write', permission: 'write', target: 'a.ts' }}
        pending={1}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText(/1 more queued/)).toBeTruthy();
    expect(screen.queryByTestId('approval-preview')).toBeNull();
    fireEvent.click(screen.getByTestId('approval-allow'));
    fireEvent.click(screen.getByTestId('approval-deny'));
    expect(onRespond.mock.calls).toEqual([
      ['p1', 'allow'],
      ['p1', 'deny'],
    ]);
  });

  it('flags dangerous requests', () => {
    render(
      <ApprovalCard
        request={{
          id: 'p2',
          tool: 'bash',
          permission: 'shell',
          target: 'rm -rf build',
          danger: 'recursive delete',
        }}
        pending={0}
        onRespond={() => {}}
      />,
    );
    expect(screen.getByText(/danger: recursive delete/)).toBeTruthy();
  });

  it('shows the proposed change before asking for a decision', () => {
    render(
      <ApprovalCard
        request={{
          id: 'p3',
          tool: 'edit',
          permission: 'write',
          target: 'src/a.ts',
          preview: {
            path: 'src/a.ts',
            diff: {
              lines: [
                { type: 'context', text: 'keep' },
                { type: 'remove', text: 'old line' },
                { type: 'add', text: 'new line' },
              ],
              adds: 1,
              removes: 1,
              hidden: 0,
            },
          },
        }}
        pending={0}
        onRespond={() => {}}
      />,
    );

    const preview = screen.getByTestId('approval-preview');
    expect(preview.textContent).toContain('-old line');
    expect(preview.textContent).toContain('+new line');
    // Counts describe the whole change, not the window being shown.
    expect(preview.textContent).toContain('+1');
    expect(preview.textContent).toContain('−1');
  });

  it('caps a long preview and says how much is hidden', () => {
    const lines = Array.from({ length: 90 }, (_, index) => ({
      type: 'add' as const,
      text: `line${index}`,
    }));
    render(
      <ApprovalCard
        request={{
          id: 'p4',
          tool: 'write',
          permission: 'write',
          target: 'src/big.ts',
          preview: { path: 'src/big.ts', diff: { lines, adds: 90, removes: 0, hidden: 0 } },
        }}
        pending={0}
        onRespond={() => {}}
      />,
    );

    expect(screen.getAllByTestId('diff-line')).toHaveLength(60);
    expect(screen.getByTestId('diff-hidden').textContent).toContain('30 more lines not shown');
    // The tally still reports the full change.
    expect(screen.getByTestId('diff-count-add').textContent).toBe('+90');
  });
});

describe('PlanPanel', () => {
  const tasks = [
    { id: 1, subject: 'read code', status: 'completed' as const },
    { id: 2, subject: 'edit file', status: 'in_progress' as const },
    { id: 3, subject: 'run tests', status: 'pending' as const },
  ];

  it('lists every step with its mark, class, and screen-reader status', () => {
    render(<PlanPanel tasks={tasks} />);

    expect(screen.getByText('1 of 3 done').textContent).toBe('1 of 3 done');
    expect(screen.getByText('1 active')).toBeTruthy();

    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.className)).toEqual([
      'plan-item plan-completed',
      'plan-item plan-in_progress',
      'plan-item plan-pending',
    ]);
    expect(within(items[0] as HTMLElement).getByText('[x]')).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText('[~]')).toBeTruthy();
    expect(within(items[2] as HTMLElement).getByText('[ ]')).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText('edit file')).toBeTruthy();
    // The mark is decoration; the words are what a reader announces.
    expect(within(items[0] as HTMLElement).getByText('done')).toBeTruthy();
    expect(within(items[2] as HTMLElement).getByText('not started')).toBeTruthy();

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    expect((bar.querySelector('.plan-bar-fill') as HTMLElement).style.width).toBe('33%');
  });

  it('says a plan is empty instead of showing a blank panel', () => {
    render(<PlanPanel tasks={[]} />);

    expect(screen.getByText('No plan yet.')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText(/Ask cake to plan/)).toBeTruthy();
  });
});

describe('CostPanel', () => {
  const fixture = (over: Partial<CostPayload> = {}): CostPayload => ({
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    effective: { pattern: 'anthropic/sonnet', inputPer1M: 3, outputPer1M: 15 },
    source: 'builtin',
    overrides: [],
    builtin: [
      { pattern: 'anthropic/sonnet', inputPer1M: 3, outputPer1M: 15 },
      { pattern: 'deepseek/', inputPer1M: 0.28, outputPer1M: 0.42 },
    ],
    configFile: '/repo/.cake/config.json',
    ...over,
    board: over.board ?? emptyCostBoard(),
    rollup: over.rollup ?? null,
    workspace: over.workspace ?? null,
  });

  it('shows the rate in use, its source, and the built-in card', () => {
    render(<CostPanel cost={fixture()} onSetPricing={vi.fn(async () => {})} />);

    expect(screen.getByText('anthropic/claude-sonnet-4-5')).toBeTruthy();
    expect(screen.getByText('Input per 1M')).toBeTruthy();
    expect(screen.getAllByText('$3').length).toBeGreaterThan(1);
    expect(screen.getByText(/From cake/)).toBeTruthy();
    expect(screen.getByText('deepseek/')).toBeTruthy();
    expect(screen.getByText(/Indicative list prices/)).toBeTruthy();
  });

  it('credits the workspace when one of its rates answers', () => {
    render(
      <CostPanel
        cost={fixture({
          source: 'config',
          effective: { pattern: 'anthropic/sonnet-4-5', inputPer1M: 1, outputPer1M: 4 },
          overrides: [{ pattern: 'anthropic/sonnet-4-5', inputPer1M: 1, outputPer1M: 4 }],
        })}
        onSetPricing={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByText(/From this workspace/)).toBeTruthy();
    // once in "Rate in use", once in the workspace row that produced it
    expect(screen.getAllByText('$1').length).toBe(2);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('says no price is set instead of implying free', () => {
    render(<CostPanel cost={fixture({ effective: null, source: null })} onSetPricing={vi.fn()} />);

    expect(screen.getByText(/No price set/)).toBeTruthy();
    expect(screen.queryByText('Input per 1M')).toBeNull();
    // An unpriced model still gets the editor, which is how it gets a price.
    expect(screen.queryByText('Open a workspace to store rates.')).toBeNull();
    expect(screen.getByLabelText('Pattern')).toBeTruthy();
  });

  it('saves the typed rates under the pattern it shows', async () => {
    const onSet = vi.fn(async () => {});
    render(<CostPanel cost={fixture()} onSetPricing={onSet} />);

    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '10' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    });

    expect(onSet).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5', {
      inputPer1M: 2.5,
      outputPer1M: 10,
    });
    expect(screen.getByRole('button', { name: 'Save rate' }).hasAttribute('disabled')).toBe(false);
  });

  it('blocks a pattern with no provider and a rate that is not usable', () => {
    render(<CostPanel cost={fixture()} onSetPricing={vi.fn()} />);
    const save = screen.getByRole('button', { name: 'Save rate' });

    fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: 'sonnet' } });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Use provider/model.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: 'anthropic/sonnet' } });
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '-2' } });
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '' } });
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('removes a workspace rate by writing null', async () => {
    const onSet = vi.fn(async () => {});
    render(
      <CostPanel
        cost={fixture({
          source: 'config',
          effective: { pattern: 'deepseek/', inputPer1M: 0.1, outputPer1M: 0.2 },
          overrides: [{ pattern: 'deepseek/', inputPer1M: 0.1, outputPer1M: 0.2 }],
        })}
        onSetPricing={onSet}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(onSet).toHaveBeenCalledWith('deepseek/', null);
  });

  it('offers no editor when no workspace is open', () => {
    render(<CostPanel cost={fixture({ configFile: null })} onSetPricing={vi.fn()} />);

    expect(screen.getByText('Open a workspace to store rates.')).toBeTruthy();
    expect(screen.queryByLabelText('Pattern')).toBeNull();
  });

  const boardRow = (over: Partial<CostRow> = {}): CostRow => ({
    turn: 1,
    seq: 0,
    occurredAt: new Date('2026-11-06T09:20:00').getTime(),
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    scope: 'main',
    agentType: '',
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    costUsd: 0.0042,
    priced: true,
    ...over,
  });
  const nested = (over: Partial<CostRow> = {}): CostRow =>
    boardRow({
      seq: 1,
      scope: 'subagent',
      agentType: 'Explore',
      provider: 'deepseek',
      model: 'deepseek-chat',
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costUsd: 0.0004,
      ...over,
    });

  it('breaks the session down turn by turn, nested work inside its turn', () => {
    render(
      <CostPanel
        cost={fixture({
          board: buildCostBoard([
            boardRow(),
            boardRow({ turn: 2, costUsd: 0.0031, totalTokens: 900 }),
            nested({ turn: 2 }),
          ]),
          rollup: { costUsd: 0.0077, totalTokens: 2700 },
        })}
        onSetPricing={vi.fn()}
      />,
    );

    // Newest first, so the turn that just finished is the one at the top.
    const turns = screen.getAllByTestId('cost-turn-row');
    expect(turns).toHaveLength(2);
    expect(turns[0]?.querySelector('.board-num')?.textContent).toBe('2');
    expect(within(turns[0] as HTMLElement).getAllByTestId('cost-line')).toHaveLength(2);
    expect(within(turns[1] as HTMLElement).getAllByTestId('cost-line')).toHaveLength(1);
    expect(screen.getAllByText('Main model')).toHaveLength(2);
    expect(screen.getAllByText('Subagent: Explore')).toHaveLength(2);
    expect(screen.getByTestId('cost-spend').textContent).toBe('$0.0077');
    // Each turn is stamped with the clock alone — the same rule the transcript's
    // loose cards follow, restated here rather than called, so a formatter that
    // starts printing the date is caught by both surfaces.
    expect(turns[0]?.querySelector('.board-when')?.textContent).toBe(
      new Date(boardRow().occurredAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    expect(screen.queryByTestId('cost-detail-note')).toBeNull();
  });

  it('groups spend by model and by work, and offers a rate only where one is missing', () => {
    render(
      <CostPanel
        cost={fixture({
          board: buildCostBoard([
            boardRow(),
            boardRow({ turn: 2 }),
            nested({ priced: false, costUsd: 0 }),
          ]),
        })}
        onSetPricing={vi.fn()}
      />,
    );

    const groups = screen.getAllByTestId('cost-group-row').map((row) => row.textContent ?? '');
    // Model groups are named by model, work groups by who ran it.
    expect(groups.filter((text) => text.includes('deepseek/deepseek-chat'))).toHaveLength(1);
    expect(groups.filter((text) => text.includes('Subagent: Explore'))).toHaveLength(1);
    expect(groups.filter((text) => text.includes('Main model ·'))).toHaveLength(1);

    // Only a model group with no rate can be priced; a work group has nothing to price.
    const setRate = screen.getAllByRole('button', { name: 'Set rate' });
    expect(setRate).toHaveLength(1);
    expect(setRate[0]?.getAttribute('title')).toContain('No rate for deepseek/deepseek-chat');

    fireEvent.click(setRate[0] as HTMLElement);
    expect((screen.getByLabelText('Pattern') as HTMLInputElement).value).toBe(
      'deepseek/deepseek-chat',
    );
  });

  it('counts tokens with no rate instead of calling them free', () => {
    render(
      <CostPanel
        cost={fixture({
          effective: null,
          source: null,
          board: buildCostBoard([boardRow({ priced: false, costUsd: 0 })]),
          rollup: { costUsd: 0, totalTokens: 1200 },
        })}
        onSetPricing={vi.fn()}
      />,
    );

    expect(screen.getByTestId('cost-spend').textContent).toBe('no price set');
    expect(screen.getByText('Without a rate').nextElementSibling?.textContent).toBe('1.2k');
    expect(screen.getByTestId('cost-line')?.textContent).toContain('no price set');
  });

  it('says part of the session has no rate rather than hiding it', () => {
    render(
      <CostPanel
        cost={fixture({
          board: buildCostBoard([boardRow(), nested({ priced: false, costUsd: 0 })]),
        })}
        onSetPricing={vi.fn()}
      />,
    );

    expect(screen.getByTestId('cost-spend').textContent).toBe('$0.0042 + unpriced');
  });

  it('says nothing is billed rather than showing a zero', () => {
    render(<CostPanel cost={fixture()} onSetPricing={vi.fn()} />);

    expect(screen.queryByTestId('cost-spend')).toBeNull();
    expect(screen.getByText(/Nothing billed yet/)).toBeTruthy();
    expect(screen.queryAllByTestId('cost-turn-row')).toHaveLength(0);
  });

  it('discloses that per-turn detail covers less than the session used', () => {
    render(
      <CostPanel
        cost={fixture({
          board: buildCostBoard([boardRow()]),
          rollup: { costUsd: 0.5, totalTokens: 5_000 },
        })}
        onSetPricing={vi.fn()}
      />,
    );

    expect(screen.getByTestId('cost-detail-note').textContent).toContain('covers 1.2k of the 5.0k');
  });

  it('totals the workspace across its sessions', () => {
    render(
      <CostPanel
        cost={fixture({
          workspace: { sessions: 4, costUsd: 1.234, totalTokens: 90_000, unpricedTokens: 1_200 },
        })}
        onSetPricing={vi.fn()}
      />,
    );

    const roll = screen.getByTestId('cost-workspace');
    expect(within(roll).getByText('Sessions').nextElementSibling?.textContent).toBe('4');
    expect(within(roll).getByText('Total spend').nextElementSibling?.textContent).toBe(
      '$1.234 + unpriced',
    );
    expect(within(roll).getByText('Total tokens').nextElementSibling?.textContent).toBe('90.0k');
  });

  it('warns that the oldest turns are grouped but not listed', () => {
    render(
      <CostPanel
        cost={fixture({
          board: buildCostBoard([boardRow(), boardRow({ turn: 2 }), boardRow({ turn: 3 })], 2),
        })}
        onSetPricing={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId('cost-turn-row')).toHaveLength(2);
    expect(screen.getByTestId('cost-truncated').textContent).toContain('Older than the 2 turns');
  });
});

/** The composer reads the caps out of init; the rest of the payload belongs to other panels. */
function composerInit(attachments: Partial<AttachmentCaps> = {}): InitPayload {
  return {
    attachments: { vision: true, perTurn: 4, maxBytes: 1_000_000, ...attachments },
  } as InitPayload;
}

function attached(dataUrl: string, label: string): Attachment {
  return { dataUrl, label };
}

describe('Composer', () => {
  it('submits, stops, and reports edits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <Composer
        value=""
        running={false}
        disabled={false}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={onStop}
      />,
    );

    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledWith('hi');

    rerender(
      <Composer
        value="hi"
        running={false}
        disabled={false}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={onStop}
      />,
    );
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <Composer
        value=""
        running
        disabled={false}
        onChange={onChange}
        onSubmit={onSubmit}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByTestId('composer-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('takes a pasted, dropped or picked picture as a request to attach', () => {
    const onAttach = vi.fn();
    const file = new File(['a picture'], 'shot.png', { type: 'image/png' });
    render(
      <Composer
        value="look"
        running={false}
        disabled={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={composerInit()}
        onAttach={onAttach}
      />,
    );

    const input = screen.getByTestId('composer-input');
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    fireEvent.drop(input.closest('form') as HTMLFormElement, { dataTransfer: { files: [file] } });
    expect(onAttach).toHaveBeenCalledTimes(2);
    expect(onAttach).toHaveBeenLastCalledWith([file]);

    const picker = screen.getByTestId('composer-attach-input') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [file] } });
    expect(onAttach).toHaveBeenCalledTimes(3);
    expect(onAttach).toHaveBeenLastCalledWith([file]);
  });

  it('shows a staged picture and takes it off the turn again', () => {
    const onDetach = vi.fn();
    render(
      <Composer
        value="look"
        running={false}
        disabled={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={composerInit()}
        attachments={[attached('data:image/png;base64,YQ==', 'image/png · 1 B')]}
        onAttach={vi.fn()}
        onDetach={onDetach}
      />,
    );

    expect(screen.getByText('image/png · 1 B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove image/png · 1 B' }));
    expect(onDetach).toHaveBeenCalledWith(0);
  });

  it('keeps Attach out of reach, and the clipboard out of the turn, without a vision model', () => {
    const onAttach = vi.fn();
    render(
      <Composer
        value="look"
        running={false}
        disabled={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={composerInit({ vision: false })}
        onAttach={onAttach}
      />,
    );

    expect(screen.getByTestId('composer-attach').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('composer-attach').getAttribute('title')).toBe(
      'This model cannot read images — switch to a vision model',
    );
    expect(screen.getByTestId('composer-attach-input').hasAttribute('disabled')).toBe(true);

    const input = screen.getByTestId('composer-input');
    const file = new File(['a picture'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    fireEvent.drop(input.closest('form') as HTMLFormElement, { dataTransfer: { files: [file] } });
    expect(onAttach).not.toHaveBeenCalled();
  });

  it('sends a picture with the words that say what to look for, never on its own', () => {
    const { rerender } = render(
      <Composer
        value=""
        running={false}
        disabled={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={composerInit()}
        attachments={[attached('data:image/png;base64,YQ==', 'image/png · 1 B')]}
      />,
    );

    const send = screen.getByTestId('composer-send');
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(send.getAttribute('title')).toBe('Say what to look for before sending an image');

    rerender(
      <Composer
        value="what is in this shot"
        running={false}
        disabled={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={composerInit()}
        attachments={[attached('data:image/png;base64,YQ==', 'image/png · 1 B')]}
      />,
    );
    expect(screen.getByTestId('composer-send').hasAttribute('disabled')).toBe(false);
  });

  it('holds Attach back while the turn runs, so a picture cannot join a spent one', () => {
    render(
      <Composer
        value="look"
        running
        disabled={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={composerInit()}
        attachments={[attached('data:image/png;base64,YQ==', 'image/png · 1 B')]}
        onAttach={vi.fn()}
        onDetach={vi.fn()}
      />,
    );

    expect(screen.getByTestId('composer-attach').hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Remove image/png · 1 B' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  const menuInit = {
    ...composerInit(),
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        defaultModelId: 'claude-sonnet-4-5',
        maxContext: 200_000,
        hasKey: true,
      },
    ],
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    mode: 'default',
  } as InitPayload;

  /** The chip is named by what it shows: the provider and model it selects. */
  const withMenus = (onSetMode = vi.fn()) => {
    render(
      <Composer
        value=""
        running={false}
        disabled={false}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={menuInit}
        onSetModel={vi.fn()}
        onSetMode={onSetMode}
      />,
    );
    return screen.getByRole('button', { name: /anthropic/ });
  };

  it('moves focus into the model menu and hands it back when Escape closes it', () => {
    const trigger = withMenus();
    trigger.focus();
    fireEvent.click(trigger);

    const menu = screen.getByRole('dialog', { name: 'Choose model' });
    expect(menu.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the keyboard inside an open menu and lets the arrows walk it', () => {
    const trigger = withMenus();
    trigger.focus();
    fireEvent.click(trigger);

    const menu = screen.getByRole('dialog', { name: 'Choose model' });
    const items = Array.from(menu.querySelectorAll('button, input')) as HTMLElement[];
    const first = items[0] as HTMLElement;
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    // From the last control Tab wraps into the menu instead of leaving it.
    (items[items.length - 1] as HTMLElement).focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('gives the mode menu the same contract, because it is the same hook', () => {
    const onSetMode = vi.fn();
    const chips = withMenus(onSetMode);
    expect(chips).toBeTruthy();
    const mode = screen.getByRole('button', { name: /default/ });
    mode.focus();
    fireEvent.click(mode);

    const menu = screen.getByRole('dialog', { name: 'Choose permission mode' });
    expect(menu.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Choose permission mode' })).toBeNull();
    expect(document.activeElement).toBe(mode);
  });

  /** A held composer is the only state where the reason has to be said. */
  const holding = (over: { disabled: boolean; value?: string }) => {
    render(
      <Composer
        value={over.value ?? ''}
        running={false}
        disabled={over.disabled}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        init={composerInit()}
      />,
    );
  };

  it('says what it is waiting for, not that a folder is missing', () => {
    holding({ disabled: true });

    const line = screen.getByTestId('composer-hold');
    expect(line.textContent).toBe('Waiting for cake to finish a workspace change');
    // The old sentence sent you to open a folder you had already opened: a
    // composer only exists once one is open.
    expect(line.textContent).not.toContain('Open a workspace');
    expect(screen.queryByText(/send/)).toBeNull();
  });

  it('teaches the keys again the moment nothing is holding it', () => {
    holding({ disabled: false });

    expect(screen.queryByTestId('composer-hold')).toBeNull();
    expect(screen.getByText(/send/)).toBeTruthy();
  });

  it('puts the reason where it can be heard and read, not only in the field it cannot reach', () => {
    holding({ disabled: true });

    // A disabled textarea is not focusable, so its placeholder is unreachable;
    // the line is a live region and the dead Send carries the same sentence.
    expect(screen.getByTestId('composer-hold').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe(
      'Waiting for cake to finish a workspace change',
    );
    expect(screen.getByTestId('composer-send').getAttribute('title')).toBe(
      'Waiting for cake to finish a workspace change',
    );
  });
});

describe('Transcript', () => {
  it('renders messages, markdown, meta, errors, and the live stream', () => {
    render(
      <Transcript
        entries={[
          { id: 0, role: 'user', text: 'hello' },
          { id: 1, role: 'assistant', text: '**bold** answer', meta: '10 tokens' },
          { id: 2, role: 'error', text: 'boom' },
        ]}
        streaming="partial"
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );

    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('10 tokens')).toBeTruthy();
    expect(screen.getByTestId('entry-error').textContent).toBe('boom');
    expect(screen.getByText('partial')).toBeTruthy();
  });

  it('shows the pictures a turn was sent with, beside the words that asked', () => {
    const { rerender } = render(
      <Transcript
        entries={[
          {
            id: 0,
            role: 'user',
            text: 'what is in this shot',
            images: ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='],
          },
        ]}
        streaming=""
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );

    expect(screen.getByTestId('turn').textContent).toContain('2 images');
    const list = screen.getByRole('list', { name: 'Pictures sent with this turn' });
    expect(Array.from(list.querySelectorAll('img')).map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,YQ==',
      'data:image/png;base64,Yg==',
    ]);

    rerender(
      <Transcript
        entries={[{ id: 1, role: 'user', text: 'no pictures here' }]}
        streaming=""
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );
    expect(screen.queryByRole('list', { name: 'Pictures sent with this turn' })).toBeNull();
    expect(screen.getByTestId('turn').textContent).not.toContain('image');
  });

  it('groups consecutive calls under one turn and tallies repeats', () => {
    render(
      <Transcript
        entries={[
          { id: 0, role: 'user', text: 'check both files', at: 1_000 },
          {
            id: 1,
            role: 'tool',
            at: 1_100,
            tool: { callId: 'r1', name: 'read', input: { path: 'a.ts' }, status: 'done' },
          },
          {
            id: 2,
            role: 'tool',
            at: 1_200,
            tool: {
              callId: 'r2',
              name: 'read',
              input: { path: 'b.ts' },
              status: 'error',
              error: 'nope',
            },
          },
          { id: 3, role: 'assistant', text: 'done', at: 1_300 },
        ]}
        streaming=""
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );

    const turn = screen.getByTestId('turn');
    expect(turn.textContent).toContain('check both files');
    // Sub-second work is not a duration worth reporting.
    expect(turn.textContent).toContain('2 calls');
    expect(turn.textContent).not.toContain('0s');

    const group = screen.getByTestId('tool-group');
    expect(group.textContent).toContain('read ×2');
    expect(group.textContent).toContain('1 failed');
  });

  it('collapses a turn without dropping its count', () => {
    render(
      <Transcript
        entries={[
          { id: 0, role: 'user', text: 'first' },
          {
            id: 1,
            role: 'tool',
            tool: { callId: 'w1', name: 'write', input: { path: 'a.ts' }, status: 'done' },
          },
          { id: 2, role: 'user', text: 'second' },
        ]}
        streaming=""
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );

    const turns = screen.getAllByTestId('turn');
    expect(turns).toHaveLength(2);
    expect(screen.getByTestId('tool-group')).toBeTruthy();

    fireEvent.click(within(turns[0] as HTMLElement).getByRole('button', { name: /first/ }));
    expect(screen.queryByTestId('tool-group')).toBeNull();
    expect((turns[0] as HTMLElement).textContent).toContain('1 call');
  });

  it('renders a subagent branch with its child calls nested', () => {
    render(
      <Transcript
        entries={[
          { id: 0, role: 'user', text: 'explore the repo' },
          {
            id: 1,
            role: 'tool',
            tool: {
              callId: 'agent-1',
              name: 'agent',
              input: { type: 'explore', prompt: 'find it' },
              status: 'running',
              agent: {
                type: 'explore',
                prompt: 'find it',
                status: 'running',
                children: [
                  {
                    callId: 'agent-1/read-1',
                    name: 'explore:read',
                    input: { path: 'a.ts' },
                    status: 'done',
                  },
                ],
              },
            },
          },
        ]}
        streaming=""
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );

    const branch = screen.getByTestId('agent-branch');
    expect(branch.textContent).toContain('1 call');
    expect(branch.textContent).toContain('a.ts');
    // The child lives in the branch, not as a sibling card.
    expect(screen.getAllByTestId('tool-card')).toHaveLength(1);
  });

  it('renders a codebase note as cards that quote the file back', () => {
    const onInsertFile = vi.fn();
    render(
      <Transcript
        entries={[
          { id: 0, role: 'user', text: 'where is auth checked?' },
          {
            id: 1,
            role: 'note',
            kind: 'codebase',
            text: 'attached 2 chunks',
            hits: [
              {
                path: 'src/auth.ts',
                startLine: 12,
                endLine: 40,
                kind: 'function_declaration',
                score: 0.91,
                via: 'both',
              },
              {
                path: 'src/session.ts',
                startLine: 3,
                endLine: 9,
                kind: 'class_declaration',
                score: 0.62,
                via: 'lexical',
              },
            ],
          },
        ]}
        streaming=""
        onInsertFile={onInsertFile}
        {...noUndo}
      />,
    );

    const cards = screen.getAllByTestId('codebase-hit');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('src/auth.ts');
    expect(cards[0]?.textContent).toContain('12–40');
    expect(cards[0]?.textContent).toContain('meaning + keywords');
    expect(cards[1]?.textContent).toContain('keywords');
    expect(cards[1]?.textContent).toContain('0.62');

    fireEvent.click(cards[1] as HTMLElement);
    expect(onInsertFile).toHaveBeenCalledWith('src/session.ts');
  });

  it('keeps a note without hits as plain text', () => {
    render(
      <Transcript
        entries={[
          { id: 0, role: 'user', text: 'hello' },
          { id: 1, role: 'note', kind: 'codebase', text: 'no embedding provider configured' },
        ]}
        streaming=""
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );

    expect(screen.getByTestId('entry-note').textContent).toContain('no embedding provider');
    expect(screen.queryByTestId('codebase-hit')).toBeNull();
  });

  it('says which note wrote the file and where it went', () => {
    render(
      <Transcript
        entries={[
          { id: 0, role: 'user', text: '/export' },
          {
            id: 1,
            role: 'note',
            kind: 'export',
            text: 'Markdown transcript → /repo/.cake/exports/repo-a1b2c3d4.md',
          },
        ]}
        streaming=""
        onInsertFile={vi.fn()}
        {...noUndo}
      />,
    );

    const note = screen.getByTestId('entry-note');
    expect(note.querySelector('.entry-note-kind')?.textContent).toBe('export');
    expect(note.textContent).toContain('repo-a1b2c3d4.md');
  });

  it('names the empty transcript instead of repeating the placeholder at you', () => {
    render(<Transcript entries={[]} streaming="" onInsertFile={vi.fn()} {...noUndo} />);

    expect(screen.getByTestId('transcript-empty').textContent).toBe('No turns yet.');
    // The invitation stays, but now it answers a named state rather than standing in
    // for the input box's own text in a place you cannot type.
    expect(screen.getByText('Ask cake to change the code…')).toBeTruthy();
  });
});

describe('RulesSection', () => {
  const fixture = (over: Partial<RulesPayload> = {}): RulesPayload => ({
    allow: [
      { rule: 'read', scope: 'global' },
      { rule: 'bash(npm test*)', scope: 'project' },
      { rule: 'web_search', scope: 'project' },
    ],
    deny: [{ rule: 'bash(rm *)', scope: 'project' }],
    files: { global: '/home/u/.cake/settings.json', project: '/repo/.cake/settings.json' },
    conflicts: [],
    ...over,
  });

  const handlers = () => ({
    onSetRule: vi.fn(async () => {}),
    onMoveRule: vi.fn(async () => {}),
  });

  it('lists each rule under its list and scope', () => {
    render(
      <RulesSection rules={fixture()} hasWorkspace onSetRule={vi.fn()} onMoveRule={vi.fn()} />,
    );

    const allow = within(screen.getByTestId('rule-group-allow'));
    expect(allow.getByText('read')).toBeTruthy();
    expect(allow.getByText('bash(npm test*)')).toBeTruthy();
    expect(screen.getAllByText('workspace')).toHaveLength(2);
    expect(screen.getByText('global')).toBeTruthy();
    expect(within(screen.getByTestId('rule-group-deny')).getByText('bash(rm *)')).toBeTruthy();
  });

  it('adds the typed rule to the chosen list and scope', () => {
    const { onSetRule } = handlers();
    render(
      <RulesSection rules={fixture()} hasWorkspace onSetRule={onSetRule} onMoveRule={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: '  web_search  ' } });
    expect(screen.getByText('Every web_search call runs without asking.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('List'), { target: { value: 'deny' } });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'global' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    expect(onSetRule).toHaveBeenCalledWith('add', 'deny', 'global', 'web_search');
  });

  it('explains a pattern rule and refuses one the matcher cannot read', () => {
    const { onSetRule } = handlers();
    render(
      <RulesSection rules={fixture()} hasWorkspace onSetRule={onSetRule} onMoveRule={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'bash(git log *)' } });
    expect(screen.getByText(/bash calls matching git log \* run without asking/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'bash git log' } });
    expect(screen.getByText('Use tool or tool(pattern).')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add rule' }).hasAttribute('disabled')).toBe(true);
  });

  it('removes and reorders a rule in place', async () => {
    const { onSetRule, onMoveRule } = handlers();
    render(
      <RulesSection rules={fixture()} hasWorkspace onSetRule={onSetRule} onMoveRule={onMoveRule} />,
    );

    // bash(npm test*) leads its scope block, so it can only move down.
    expect(
      screen.getByRole('button', { name: 'Move bash(npm test*) up' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Move web_search down' }).hasAttribute('disabled'),
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Move bash(npm test*) down' }));
    });
    expect(onMoveRule).toHaveBeenCalledWith('allow', 'project', 'bash(npm test*)', 1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove bash(npm test*)' }));
    });
    expect(onSetRule).toHaveBeenCalledWith('remove', 'allow', 'project', 'bash(npm test*)');
  });

  it('says when an allow is cancelled by the same deny', () => {
    render(
      <RulesSection
        rules={fixture({
          allow: [{ rule: 'bash(rm *)', scope: 'project' }],
          conflicts: ['bash(rm *)'],
        })}
        hasWorkspace
        onSetRule={vi.fn()}
        onMoveRule={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/In both lists, so the allow does nothing: bash\(rm \*\)/),
    ).toBeTruthy();
  });

  it('offers no editor without a workspace', () => {
    render(
      <RulesSection
        rules={fixture()}
        hasWorkspace={false}
        onSetRule={vi.fn()}
        onMoveRule={vi.fn()}
      />,
    );

    expect(screen.getByText('Open a workspace to edit rules.')).toBeTruthy();
    expect(screen.queryByLabelText('Rule')).toBeNull();
  });
});

describe('McpSection', () => {
  const fixture = (over: Partial<McpStatus> = {}): McpStatus => ({
    servers: ['files'],
    tools: 2,
    warnings: [],
    rows: [
      {
        name: 'files',
        transport: 'stdio',
        scope: 'project',
        enabled: true,
        connected: true,
        tools: 2,
        error: null,
        target: { command: 'npx', args: ['-y', 'srv.js'] },
        permission: 'shell',
      },
      {
        name: 'search',
        transport: 'http',
        scope: 'global',
        enabled: true,
        connected: false,
        tools: 0,
        error: 'MCP server "search" unavailable: timed out',
        target: { url: 'https://api.test/mcp' },
        permission: null,
      },
      {
        name: 'quiet',
        transport: 'stdio',
        scope: 'global',
        enabled: false,
        connected: false,
        tools: 0,
        error: null,
        target: { command: 'node', args: ['server.js'] },
        permission: null,
      },
    ],
    files: { global: '/home/u/.cake/mcp.json', project: '/repo/.cake/mcp.json' },
    changes: [],
    ...over,
  });

  const section = (props: {
    mcp?: McpStatus;
    hasWorkspace?: boolean;
    onReload?: () => Promise<void>;
    onSetServer?: (scope: RuleScopeName, draft: McpDraft) => Promise<void>;
    onToggleServer?: (scope: RuleScopeName, name: string, enabled: boolean) => Promise<void>;
    onRemoveServer?: (scope: RuleScopeName, name: string) => Promise<void>;
  }) =>
    render(
      <McpSection
        mcp={props.mcp ?? fixture()}
        hasWorkspace={props.hasWorkspace ?? true}
        onReload={props.onReload ?? vi.fn(async () => {})}
        onSetServer={props.onSetServer ?? vi.fn(async () => {})}
        onToggleServer={props.onToggleServer ?? vi.fn(async () => {})}
        onRemoveServer={props.onRemoveServer ?? vi.fn(async () => {})}
      />,
    );

  it('lists every configured server with what it runs and how it ended up', () => {
    section({});
    expect(within(screen.getByTestId('mcp-row-files')).getByText('2 tools')).toBeTruthy();
    expect(screen.getByText('npx -y srv.js')).toBeTruthy();
    expect(within(screen.getByTestId('mcp-row-search')).getByText('failed')).toBeTruthy();
    expect(screen.getByText(/timed out/)).toBeTruthy();
    expect(screen.getByText('https://api.test/mcp')).toBeTruthy();
    expect(within(screen.getByTestId('mcp-row-quiet')).getByText('off')).toBeTruthy();
  });

  it('saves a new stdio server with the arguments split out', async () => {
    const onSetServer = vi.fn(async () => {});
    section({ onSetServer });

    const add = await act(async () => {
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'db' } });
      fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
      fireEvent.change(screen.getByLabelText('Arguments'), { target: { value: '-y db-server' } });
      expect(
        screen.getByText('Starts npx -y db-server and reads its tools over stdio.'),
      ).toBeTruthy();
      return screen.getByRole('button', { name: 'Add server' });
    });
    await act(async () => {
      fireEvent.click(add);
    });

    expect(onSetServer).toHaveBeenCalledWith('project', {
      name: 'db',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'db-server'],
    });
    // The form is empty again, so the next entry starts clean.
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('');
  });

  it('keeps Save out of reach until the entry would actually load', () => {
    section({});
    const add = screen.getByRole('button', { name: 'Add server' });
    expect(add.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'my server' } });
    expect(screen.getByRole('button', { name: 'Add server' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Names start with a letter or digit/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'db' } });
    expect(screen.getByText(/needs the command cake starts/)).toBeTruthy();
  });

  it('asks for a URL once the transport is http', () => {
    section({});
    fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'http' } });
    expect(screen.queryByLabelText('Command')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add server' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'remote' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'api.test' } });
    expect(screen.getByText(/needs a full URL/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://api.test/mcp' } });
    expect(screen.getByRole('button', { name: 'Add server' }).hasAttribute('disabled')).toBe(false);
  });

  it('starts an edit from the entry on disk and holds its name', () => {
    const onSetServer = vi.fn(async () => {});
    section({ onSetServer });

    fireEvent.click(screen.getByRole('button', { name: 'Edit search' }));
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('search');
    expect(name.hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://api.test/mcp');
    expect(screen.getByRole('button', { name: 'Save server' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
    expect(onSetServer).toHaveBeenCalledWith('global', {
      name: 'search',
      transport: 'http',
      url: 'https://api.test/mcp',
    });
  });

  it('holds the permission class the file pins while a server is edited', () => {
    const onSetServer = vi.fn(async () => {});
    section({ onSetServer });

    fireEvent.click(screen.getByRole('button', { name: 'Edit files' }));
    expect((screen.getByLabelText('Permission') as HTMLSelectElement).value).toBe('shell');

    fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
    expect(onSetServer).toHaveBeenCalledWith('project', {
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'srv.js'],
      permission: 'shell',
    });
  });

  it('switches a server off and removes it from where it is declared', async () => {
    const onToggleServer = vi.fn(async () => {});
    const onRemoveServer = vi.fn(async () => {});
    section({ onToggleServer, onRemoveServer });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch off files' }));
    });
    expect(onToggleServer).toHaveBeenCalledWith('project', 'files', false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch on quiet' }));
    });
    expect(onToggleServer).toHaveBeenCalledWith('global', 'quiet', true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove files' }));
    });
    expect(onRemoveServer).toHaveBeenCalledWith('project', 'files');
  });

  it('reports what the last connect changed, and any warning', () => {
    section({
      mcp: fixture({
        changes: ['files added — online with 2 tools', 'search went down — not connected: boom'],
        warnings: ['Invalid MCP config at /repo/.cake/mcp.json'],
      }),
    });

    const changes = screen.getByTestId('mcp-changes');
    expect(changes.textContent).toContain('files added');
    expect(changes.textContent).toContain('search went down');
    expect(screen.getByText(/Invalid MCP config/)).toBeTruthy();
  });

  it('shows the list but no editor when no workspace is open', () => {
    section({ hasWorkspace: false });
    expect(screen.getByTestId('mcp-row-files')).toBeTruthy();
    expect(screen.getByText('Open a workspace to edit servers.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add server' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Spend read-outs outside the board', () => {
  const row = (over: Partial<CostRow> = {}): CostRow => ({
    turn: 1,
    seq: 0,
    occurredAt: Date.now(),
    provider: 'anthropic',
    model: 'claude-mystery-1',
    scope: 'main',
    agentType: '',
    inputTokens: 1_000,
    outputTokens: 200,
    totalTokens: 1_200,
    costUsd: 0,
    priced: false,
    ...over,
  });

  const cost = (over: Partial<CostPayload> = {}): CostPayload => ({
    model: { provider: 'anthropic', modelId: 'claude-mystery-1' },
    effective: null,
    source: null,
    overrides: [],
    builtin: [],
    configFile: null,
    board: emptyCostBoard(),
    rollup: null,
    workspace: null,
    ...over,
  });

  const session: SessionInfo = {
    id: 's1',
    title: 'Run',
    cwd: '/repo',
    provider: 'anthropic',
    model: 'claude-mystery-1',
    totalTokens: 1_200,
    costUsd: 0,
    unpricedTokens: 1_200,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const heat = (over: Partial<{ costUsd: number; tokens: number; unpriced: number }> = {}) =>
    render(
      <HeatBar
        running={false}
        providerLabel="Anthropic"
        modelId="claude-mystery-1"
        mode="default"
        startedAt={null}
        costUsd={0}
        tokens={1_200}
        unpriced={1_200}
        pendingApprovals={0}
        {...over}
      />,
    );

  it('says the header spend is unknown instead of $0.0000, and opens the board', () => {
    const onShowCost = vi.fn();
    render(
      <SessionHeader
        session={session}
        cost={cost({ board: buildCostBoard([row()]) })}
        railOpen
        inspectorOpen
        theme="flour"
        onShowCost={onShowCost}
        onToggleRail={vi.fn()}
        onToggleInspector={vi.fn()}
        onToggleTheme={vi.fn()}
        onOpenPalette={vi.fn()}
      />,
    );

    const chip = screen.getByTestId('cost-chip');
    expect(chip.textContent).toContain('no price set');
    expect(chip.textContent).not.toContain('$0.0000');
    fireEvent.click(chip);
    expect(onShowCost).toHaveBeenCalled();
  });

  it('keeps the known estimate and names the unknown part beside it', () => {
    render(
      <SessionHeader
        session={{ ...session, costUsd: 0.0042 }}
        cost={cost({
          board: buildCostBoard([row(), row({ turn: 2, priced: true, costUsd: 0.0042 })]),
          rollup: { costUsd: 0.0042, totalTokens: 2_400 },
        })}
        railOpen
        inspectorOpen
        theme="flour"
        onShowCost={vi.fn()}
        onToggleRail={vi.fn()}
        onToggleInspector={vi.fn()}
        onToggleTheme={vi.fn()}
        onOpenPalette={vi.fn()}
      />,
    );

    expect(screen.getByTestId('cost-chip').textContent).toContain('$0.0042 + unpriced');
  });

  it('reads the run-out as unknown for a model with no rate', () => {
    heat();
    expect(screen.getByText('1,200 tok · no price set')).toBeTruthy();
  });

  it('does not call a run free when part of it has no rate', () => {
    heat({ costUsd: 0.0042, tokens: 1_800, unpriced: 600 });
    expect(screen.getByText('1,800 tok · $0.0042 + unpriced')).toBeTruthy();
  });
});

describe('Sidebar', () => {
  const rowOf = (name: string, over: Partial<McpServerRow> = {}): McpServerRow => ({
    name,
    transport: 'stdio',
    scope: 'project',
    enabled: true,
    connected: true,
    tools: 2,
    error: null,
    target: { command: 'npx', args: [] },
    permission: null,
    ...over,
  });

  const session: SessionInfo = {
    id: 's1',
    title: 'Fix the loader',
    cwd: '/repo',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    totalTokens: 120,
    costUsd: 0.02,
    unpricedTokens: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const rail = (
    rows: McpServerRow[],
    over: Partial<SessionInfo> = {},
    handlers: {
      onForkSession?: (id: string) => void;
      onExportSession?: (id: string) => void;
      onOpenSession?: (id: string) => void;
      runningIds?: string[];
      waitingIds?: string[];
      /** More sessions in the list, so a rail can hold several rows at once. */
      others?: SessionInfo[];
      /** Folders behind the workspace switcher; the menu only exists when these are non-empty. */
      recents?: string[];
    } = {},
  ) =>
    render(
      <Sidebar
        version="0.1.0"
        workspace={{ cwd: '/repo', sessionId: 's1' }}
        recents={handlers.recents ?? []}
        sessions={[{ ...session, ...over }, ...(handlers.others ?? [])]}
        activeSessionId="s1"
        runningIds={handlers.runningIds ?? []}
        waitingIds={handlers.waitingIds ?? []}
        mcpStatus={{
          servers: rows.filter((entry) => entry.connected).map((entry) => entry.name),
          tools: rows.reduce((total, entry) => total + entry.tools, 0),
          warnings: [],
          rows,
          files: { global: null, project: '/repo/.cake/mcp.json' },
          changes: [],
        }}
        onNewSession={vi.fn()}
        onOpenSession={handlers.onOpenSession ?? vi.fn()}
        onRenameSession={vi.fn()}
        onForkSession={handlers.onForkSession ?? vi.fn()}
        onExportSession={handlers.onExportSession ?? vi.fn()}
        onDeleteSession={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onOpenRecent={vi.fn()}
        onDiagnostics={vi.fn()}
      />,
    );

  it('counts live servers and names the ones that failed', () => {
    rail([rowOf('files'), rowOf('search', { connected: false, tools: 0, error: 'timed out' })]);

    const line = screen.getByTestId('mcp-line');
    expect(line.textContent).toBe('MCP 1 live · 2 tools · search failed');
  });

  it('stays quiet when every server is live', () => {
    rail([rowOf('files')]);
    expect(screen.getByTestId('mcp-line').textContent).toBe('MCP 1 live · 2 tools');
  });

  it('never reads a session with an unpriced model as free', () => {
    rail([rowOf('files')], { costUsd: 0, totalTokens: 600, unpricedTokens: 600 });

    const meta = screen.getByTitle('spend: no price set');
    expect(meta.textContent).toContain('no price set');
    expect(meta.textContent).not.toContain('$0.0000');
  });

  it('sends the session the button is standing on, not the open one', () => {
    const onForkSession = vi.fn();
    const onExportSession = vi.fn();
    rail([rowOf('files')], { id: 's9' }, { onForkSession, onExportSession });

    fireEvent.click(screen.getByLabelText('Fork session'));
    fireEvent.click(screen.getByLabelText('Export session as Markdown'));

    expect(onForkSession).toHaveBeenCalledWith('s9');
    expect(onExportSession).toHaveBeenCalledWith('s9');
  });

  it('locks the fork of the running session on screen, and never its export', () => {
    const onForkSession = vi.fn();
    const onExportSession = vi.fn();
    rail([rowOf('files')], {}, { onForkSession, onExportSession, runningIds: ['s1'] });

    const fork = screen.getByLabelText('Fork session') as HTMLButtonElement;
    expect(fork.disabled).toBe(true);
    fireEvent.click(fork);
    expect(onForkSession).not.toHaveBeenCalled();

    // Writing a transcript to a file cannot disturb a turn, so it stays offered.
    const exportButton = screen.getByLabelText('Export session as Markdown') as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    fireEvent.click(exportButton);
    expect(onExportSession).toHaveBeenCalledWith('s1');
  });

  it('gives the status line of a running row the room its dead controls used to take', () => {
    // Off screen and mid-turn: branching or deleting it would cut a turn in
    // half, so those controls step out and the row says what it is doing
    // instead. The ones that still work stay.
    rail([rowOf('files')], { id: 's9' }, { runningIds: ['s9'] });

    expect(screen.getByTestId('rail-badge-running').textContent).toBe('answering');
    expect(screen.queryByLabelText('Fork session')).toBeNull();
    expect(screen.queryByLabelText('Delete session')).toBeNull();
    expect(
      (screen.getByLabelText('Export session as Markdown') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((screen.getByLabelText('Rename session') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads another session while one is running', () => {
    const onOpenSession = vi.fn();
    const onForkSession = vi.fn();
    rail([rowOf('files')], { id: 's9' }, { onOpenSession, onForkSession, runningIds: ['s1'] });

    const row = screen.getByRole('button', { name: /Fix the loader/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    fireEvent.click(row);
    expect(onOpenSession).toHaveBeenCalledWith('s9');

    // This row is idle, so branching it does not have to wait for the other session.
    const fork = screen.getByLabelText('Fork session') as HTMLButtonElement;
    expect(fork.disabled).toBe(false);
    fireEvent.click(fork);
    expect(onForkSession).toHaveBeenCalledWith('s9');
  });

  it('names the session that is answering off screen', () => {
    rail([rowOf('files')], { id: 's9' }, { runningIds: ['s9'] });

    expect(screen.getByTestId('rail-badge-running').textContent).toBe('answering');
    expect(screen.getByTestId('rail-live').textContent).toContain('1 answering');
  });

  it('opens the session that asked, from the badge it put in the rail', () => {
    const onOpenSession = vi.fn();
    rail([rowOf('files')], { id: 's9' }, { onOpenSession, waitingIds: ['s9'] });

    const badge = screen.getByTestId('rail-badge-waiting');
    expect(badge.textContent).toContain('waiting');
    fireEvent.click(badge);
    expect(onOpenSession).toHaveBeenCalledWith('s9');

    expect(screen.getByTestId('rail-live').textContent).toContain('1 waiting');
  });

  it('counts a stuck turn as waiting rather than as answering', () => {
    rail([rowOf('files')], { id: 's9' }, { runningIds: ['s9'], waitingIds: ['s9'] });

    // The turn is in flight, but the thing worth reading is that it cannot move.
    expect(screen.getByTestId('rail-badge-waiting')).toBeTruthy();
    expect(screen.queryByTestId('rail-badge-running')).toBeNull();
    expect(screen.getByTestId('rail-live').textContent).toBe('1 waiting');
    // The dot follows the same precedence, or the row contradicts itself.
    expect(String(document.querySelector('.session-dot')?.className)).toContain('is-waiting');
  });

  it('leaves a session with nothing to report unmarked', () => {
    rail([rowOf('files')], { id: 's9' });

    expect(screen.queryByTestId('rail-live')).toBeNull();
    expect(screen.queryByTestId('rail-badge-running')).toBeNull();
    expect(screen.queryByTestId('rail-badge-waiting')).toBeNull();
  });

  it('keeps the session you are reading out of the rail’s tally', () => {
    rail([rowOf('files')], { id: 's9' }, { waitingIds: ['s1'], runningIds: ['s1'] });

    // Its approval card and its streaming text are already in front of you.
    expect(screen.queryByTestId('rail-live')).toBeNull();
    expect(screen.queryByTestId('rail-badge-waiting')).toBeNull();
  });

  it('holds the recent-workspaces menu to the same keyboard contract', () => {
    rail([rowOf('files')], {}, { recents: ['/repo/old', '/repo/newer'] });

    const toggle = screen.getByRole('button', { name: 'Recent workspaces' });
    toggle.focus();
    fireEvent.click(toggle);

    // The chip is not the menu: focus has to cross into the list of folders.
    const menu = screen.getByRole('menu', { name: 'Recent workspaces' });
    expect(menu.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menu.querySelectorAll('button')[1]);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Recent workspaces' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});

describe('FixControl', () => {
  it('names the action each fix performs and asks for exactly that', async () => {
    const fixes: Array<[DoctorFixPayload, string]> = [
      [{ kind: 'reindex' }, 'Rebuild index'],
      [{ kind: 'reload-mcp' }, 'Reconnect servers'],
      [{ kind: 'open-workspace' }, 'Open a workspace'],
      [{ kind: 'open-file', target: 'mcp-global' }, 'Open MCP config'],
      [{ kind: 'open-file', target: 'settings-project' }, 'Open rules'],
      [{ kind: 'open-file', target: 'config-global' }, 'Open config'],
      [{ kind: 'reveal', target: 'sessions' }, 'Show sessions'],
      [{ kind: 'reveal', target: 'index' }, 'Show index'],
    ];
    for (const [fix, label] of fixes) {
      cleanup();
      const onApply = vi.fn(async () => {});
      render(<FixControl fix={fix} onApply={onApply} />);
      const button = screen.getByRole('button', { name: label });
      fireEvent.click(button);
      await act(async () => {});
      expect(onApply).toHaveBeenCalledWith(fix, undefined);
    }
  });

  it('holds the key off the button until something is typed', async () => {
    const fix: DoctorFixPayload = { kind: 'set-key', provider: 'openai', envVar: 'OPENAI_API_KEY' };
    const onApply = vi.fn(async () => {});
    render(<FixControl fix={fix} onApply={onApply} />);

    const field = screen.getByLabelText('openai API key');
    const save = screen.getByRole('button', { name: 'Save key' });
    expect(field.getAttribute('type')).toBe('password');
    expect(field.getAttribute('placeholder')).toBe('OPENAI_API_KEY');
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.change(field, { target: { value: 'sk-test' } });
    expect(save.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });

    expect(onApply).toHaveBeenCalledWith(fix, 'sk-test');
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('refuses to submit a key that is only spaces', () => {
    const fix: DoctorFixPayload = {
      kind: 'set-key',
      provider: 'anthropic',
      envVar: 'ANTHROPIC_API_KEY',
    };
    const onApply = vi.fn(async () => {});
    render(<FixControl fix={fix} onApply={onApply} />);

    fireEvent.change(screen.getByLabelText('anthropic API key'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save key' }).hasAttribute('disabled')).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('says it is working while a fix runs and ignores a second press', async () => {
    let release: () => void = () => {};
    const fix: DoctorFixPayload = { kind: 'reindex' };
    const onApply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(<FixControl fix={fix} onApply={onApply} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rebuild index' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole('button', { name: 'Working…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    fireEvent.click(busy);
    expect(onApply).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    expect(screen.getByRole('button', { name: 'Rebuild index' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

/** The inspector reads its panels out of one payload, so a test of one tab still needs the rest. */
const inspectorInit = {
  rules: { allow: [], deny: [], files: { project: null, global: null }, conflicts: [] },
  mcpStatus: {
    servers: [],
    tools: 0,
    warnings: [],
    rows: [],
    files: { project: null, global: null },
    changes: [],
  },
  cost: {
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    effective: { pattern: 'anthropic/sonnet', inputPer1M: 3, outputPer1M: 15 },
    source: 'builtin',
    overrides: [],
    builtin: [{ pattern: 'anthropic/sonnet', inputPer1M: 3, outputPer1M: 15 }],
    configFile: '/repo/.cake/config.json',
    board: emptyCostBoard(),
    rollup: null,
    workspace: null,
  },
} as unknown as InitPayload;

function renderInspector(tab: InspectorTab) {
  const onTab = vi.fn();
  render(
    <Inspector
      init={inspectorInit}
      session={null}
      context={null}
      lastUsage={null}
      changes={[]}
      plan={[]}
      tab={tab}
      doctor={null}
      doctorBusy={false}
      onTab={onTab}
      onClose={vi.fn()}
      onRunDoctor={vi.fn()}
      onApplyFix={async () => {}}
      onReloadMcp={async () => {}}
      onSetMcpServer={async () => {}}
      onToggleMcpServer={async () => {}}
      onRemoveMcpServer={async () => {}}
      onInsertFile={vi.fn()}
      onSetPricing={async () => {}}
      onSetRule={async () => {}}
      onMoveRule={async () => {}}
    />,
  );
  return onTab;
}

describe('Inspector tabs', () => {
  const withTabs = renderInspector;

  it('puts only the chosen tab in the tab order', () => {
    withTabs('plan');

    const indexes = screen.getAllByRole('tab').map((tab) => (tab as HTMLButtonElement).tabIndex);
    expect(indexes).toEqual([-1, 0, -1, -1, -1]);
    // One Tab press reaches the section you are looking at, not the first one.
    expect(screen.getByRole('tab', { name: 'Plan' }).tabIndex).toBe(0);
  });

  it('moves the selection and the focus together on the arrow keys', () => {
    const onTab = withTabs('context');
    const context = screen.getByRole('tab', { name: 'Cost' });

    // A keyboard on a tab that is out of the order still gets to speak: the
    // handler is on the group, and the group answers for all of them.
    fireEvent.keyDown(context, { key: 'ArrowLeft' });
    expect(onTab).toHaveBeenCalledWith('plan');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Plan' }));

    onTab.mockClear();
    fireEvent.keyDown(context, { key: 'End' });
    expect(onTab).toHaveBeenCalledWith('files');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Files' }));

    onTab.mockClear();
    fireEvent.keyDown(context, { key: 'Home' });
    expect(onTab).toHaveBeenCalledWith('changes');
  });

  it('wraps at the ends rather than stopping at the edge', () => {
    const onTab = withTabs('changes');
    const changes = screen.getByRole('tab', { name: 'Changes' });

    fireEvent.keyDown(changes, { key: 'ArrowLeft' });
    expect(onTab).toHaveBeenCalledWith('files');
  });

  it('lets every tab control the one panel, named by the tab it shows', () => {
    withTabs('plan');

    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-plan');
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    }
  });
});

describe('Files panel', () => {
  /** The panel debounces the filter by 120ms, so a settle has to outlast it. */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
  };

  afterEach(() => {
    window.cake = undefined;
  });

  it('says when the listing failed instead of that nothing matched', async () => {
    window.cake = {
      listFiles: async () => {
        throw new Error('the workspace folder moved');
      },
    } as unknown as typeof window.cake;
    renderInspector('files');
    await settle();

    const line = screen.getByTestId('files-error');
    expect(line.textContent).toContain('the workspace folder moved');
    expect(line.getAttribute('role')).toBe('alert');
    // A failure and an empty folder read alike here, but mean opposite things.
    expect(screen.queryByText('No files match that filter.')).toBeNull();
  });

  it('keeps saying nothing matched when the folder really did come back empty', async () => {
    window.cake = { listFiles: async () => [] } as unknown as typeof window.cake;
    renderInspector('files');
    await settle();

    expect(screen.getByText('No files match that filter.')).toBeTruthy();
    expect(screen.queryByTestId('files-error')).toBeNull();
  });

  it('drops the rows a failed refresh was about, rather than leaving them up', async () => {
    let broken = false;
    window.cake = {
      listFiles: async () => {
        if (broken) throw new Error('folder unreadable');
        return ['src/a.ts'];
      },
    } as unknown as typeof window.cake;
    renderInspector('files');
    await settle();
    expect(screen.getByText('a.ts')).toBeTruthy();

    broken = true;
    fireEvent.change(screen.getByLabelText('Filter workspace files'), { target: { value: 'b' } });
    await settle();

    // Those rows answer the filter you already changed, not this one.
    expect(screen.queryByText('a.ts')).toBeNull();
    expect(screen.getByTestId('files-error')).toBeTruthy();
  });

  it('holds off saying anything until the listing lands', async () => {
    window.cake = {
      listFiles: () => new Promise<string[]>(() => {}),
    } as unknown as typeof window.cake;
    renderInspector('files');

    expect(screen.getByText('Loading files…')).toBeTruthy();
    expect(screen.queryByText('No files match that filter.')).toBeNull();
  });

  it('teaches clicking only while there is something to click', async () => {
    window.cake = { listFiles: async () => ['src/a.ts'] } as unknown as typeof window.cake;
    renderInspector('files');
    await settle();

    expect(screen.getByText('Click a file to add `@path` to the prompt.')).toBeTruthy();
    // A standing instruction is not news; only a failure gets to interrupt.
    expect(screen.queryByRole('alert')).toBeNull();

    window.cake = { listFiles: async () => [] } as unknown as typeof window.cake;
    fireEvent.change(screen.getByLabelText('Filter workspace files'), { target: { value: 'zz' } });
    await settle();

    // The panel cannot click its own rows into existence, so the instruction goes
    // with them rather than hovering over an empty list.
    expect(screen.queryByText('Click a file to add `@path` to the prompt.')).toBeNull();
    expect(screen.getByText('No files match that filter.')).toBeTruthy();
  });

  it('gives way in the directory, never in the name', async () => {
    window.cake = {
      listFiles: async () => ['src/components/deeply/nested/Inspector.tsx', 'notes.md'],
    } as unknown as typeof window.cake;
    renderInspector('files');
    await settle();

    const name = screen.getByText('Inspector.tsx');
    expect(name.className).toBe('file-name');
    expect(screen.getByText('src/components/deeply/nested/').className).toBe('file-dir');
    // A file at the folder's own root has no directory to show at all.
    expect(document.querySelectorAll('.file-row')).toHaveLength(2);
    expect(document.querySelectorAll('.file-dir')).toHaveLength(1);
    // The whole path is still the thing the row hands back and the title names.
    expect(name.closest('.file-row')?.getAttribute('title')).toBe(
      'Add @src/components/deeply/nested/Inspector.tsx',
    );
  });
});

describe('Transcript undo', () => {
  /** One archived turn, as the kernel describes it. */
  function archived(overrides: Partial<CheckpointTurnRow> = {}): CheckpointTurnRow {
    return {
      checkpointId: 'c-1',
      prompt: 'rename the parser',
      startedAt: 1_700_000_000_000,
      files: ['src/parser.ts'],
      ...overrides,
    };
  }

  function reverted(overrides: Partial<RevertResult> = {}): RevertResult {
    return {
      checkpointId: 'c-1',
      applied: true,
      changes: [{ path: 'src/parser.ts', action: 'restored' }],
      overwrittenBy: [],
      ...overrides,
    };
  }

  const asked: Entry[] = [
    { id: 0, role: 'user', text: 'rename the parser' },
    {
      id: 1,
      role: 'tool',
      tool: {
        callId: 'w-1',
        name: 'write',
        input: { path: 'src/parser.ts', content: 'x\n' },
        status: 'done',
      },
    },
  ];

  function withUndo(
    checkpoints: CheckpointTurnRow[],
    onUndo: (checkpointId: string, force: boolean) => Promise<RevertResult>,
    running = false,
  ) {
    render(
      <Transcript
        entries={asked}
        streaming=""
        onInsertFile={vi.fn()}
        checkpoints={checkpoints}
        running={running}
        onUndo={onUndo}
      />,
    );
  }

  it('names the files an undo would give back before it offers one', () => {
    withUndo(
      [archived()],
      vi.fn(async () => reverted()),
    );

    const row = screen.getByTestId('turn-undo');
    expect(row.textContent).toContain('1 file');
    expect(row.textContent).toContain('src/parser.ts');
    expect(screen.getByTestId('turn-undo-button').textContent).toBe('Undo this turn');
    // The limit of the archive is said with the offer, not after the fact.
    expect(row.textContent).toContain(
      'Changes a shell command or an MCP tool made are not in this undo.',
    );
    expect(screen.getByText('can undo').textContent).toBe('can undo');
  });

  it('offers no undo to a turn that changed no file', () => {
    withUndo(
      [],
      vi.fn(async () => reverted()),
    );
    expect(screen.queryByTestId('turn-undo')).toBeNull();
    expect(screen.queryByText('can undo')).toBeNull();
  });

  it('gives the files back and says what moved', async () => {
    const onUndo = vi.fn(async () => reverted());
    withUndo([archived()], onUndo);

    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-undo-button'));
    });

    expect(onUndo).toHaveBeenCalledWith('c-1', false);
    const list = screen.getByTestId('turn-undo-list');
    expect(list.textContent).toContain('src/parser.ts');
    expect(list.textContent).toContain('put back');
    expect(screen.getByTestId('turn-undo-button').textContent).toBe('Undo again');
  });

  it('names a file it could not keep a copy of as it is', async () => {
    const onUndo = vi.fn(
      async (): Promise<RevertResult> =>
        reverted({
          changes: [{ path: 'big.ts', action: 'left', note: 'no copy was kept: too large' }],
        }),
    );
    withUndo([archived()], onUndo);

    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-undo-button'));
    });

    expect(screen.getByTestId('turn-undo-list').textContent).toContain(
      'left as it is (no copy was kept: too large)',
    );
  });

  it('stops when a later turn has the same files, and only goes on when asked twice', async () => {
    const rows = [archived(), archived({ checkpointId: 'c-2', prompt: 'split the parser' })];
    const asks: [string, boolean][] = [];
    const onUndo = vi.fn(async (id: string, force: boolean): Promise<RevertResult> => {
      asks.push([id, force]);
      // The first ask is refused; the second, after the card has been told why,
      // is the one that says to go ahead anyway.
      return asks.length === 1
        ? reverted({ applied: false, changes: [], overwrittenBy: ['c-2'] })
        : reverted();
    });
    withUndo(rows, onUndo);
    // c-2 has no card of its own in this transcript, so it is offered at the foot
    // as well; the clicks below are the ones made from the card that asked.
    const card = screen.getByTestId('turn');

    await act(async () => {
      fireEvent.click(within(card).getByTestId('turn-undo-button'));
    });

    const blocked = screen.getByTestId('turn-undo-blocked');
    // Who is in the way, in the words they themselves used.
    expect(blocked.textContent).toContain('“split the parser”');
    expect(blocked.textContent).toContain('Nothing moved');
    expect(asks).toEqual([['c-1', false]]);

    await act(async () => {
      fireEvent.click(within(card).getByTestId('turn-undo-button'));
    });

    expect(asks).toEqual([
      ['c-1', false],
      ['c-1', true],
    ]);
    expect(screen.queryByTestId('turn-undo-blocked')).toBeNull();
    expect(within(card).getByTestId('turn-undo-list')).toBeTruthy();
  });

  it('says what the kernel answered instead of pretending it moved', async () => {
    const onUndo = vi.fn(() => Promise.reject(new Error('Cannot undo while a turn is running')));
    withUndo([archived()], onUndo);

    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-undo-button'));
    });

    expect(screen.getByTestId('turn-undo-error').textContent).toContain(
      'Cannot undo while a turn is running',
    );
    expect(screen.queryByTestId('turn-undo-list')).toBeNull();
  });

  it('waits for the turn on screen before it will touch the files', () => {
    withUndo(
      [archived()],
      vi.fn(async () => reverted()),
      true,
    );
    expect((screen.getByTestId('turn-undo-button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Transcript: the turns with no card above', () => {
  function loose(overrides: Partial<CheckpointTurnRow> = {}): CheckpointTurnRow {
    return {
      checkpointId: 'c-9',
      prompt: 'write the report',
      startedAt: 1_700_000_500_000,
      files: ['report.md'],
      ...overrides,
    };
  }

  function show(
    entries: Entry[],
    checkpoints: CheckpointTurnRow[],
    onUndo = vi.fn(async () => ({
      checkpointId: 'c-9',
      applied: true,
      changes: [{ path: 'report.md', action: 'restored' as const }],
      overwrittenBy: [],
    })),
  ) {
    render(
      <Transcript
        entries={entries}
        streaming=""
        onInsertFile={vi.fn()}
        checkpoints={checkpoints}
        running={false}
        onUndo={onUndo}
      />,
    );
    return onUndo;
  }

  /** One answered turn, asking something other than the archive was filed under. */
  const otherTurn: Entry[] = [{ id: 0, role: 'user', text: 'something the session kept' }];

  it('gives an archive no card claimed a card of its own', () => {
    show(otherTurn, [loose()]);
    const tray = screen.getByTestId('turn-loose');
    expect(tray.textContent).toContain('Turns with no card above');
    // The one card the session kept is still the only card; the tray is not a
    // second copy of it. This is the `@codebase` case: a turn that answered, whose
    // recorded ask no longer reads like the card's, so nothing claims it.
    expect(screen.getAllByTestId('turn')).toHaveLength(1);
    // Whose turn it was, said in the words the turn itself used, and stamped with
    // the clock alone — spelled out here rather than called, so a formatter that
    // drifts is caught on this surface too.
    expect(tray.textContent).toContain('write the report');
    expect(tray.textContent).toContain(
      new Date(1_700_000_500_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    // And the same offer a turn card makes, files named before anything moves.
    const row = within(tray).getByTestId('turn-undo');
    expect(row.textContent).toContain('report.md');
    expect(within(tray).getByTestId('turn-undo-button').textContent).toBe('Undo this turn');
    // This is the second cause, and the tray has to keep naming it: a turn whose
    // ask was rewritten answered just fine, and blaming its silence is a lie.
    expect(tray.textContent).toContain('its ask was rewritten');
  });

  it('names the turn that stored nothing as the reason it has no card', () => {
    show([], [loose()]);
    // Nothing was answered here, so this is the case the sentence was written for.
    expect(screen.getByTestId('turn-loose').textContent).toContain('stopped before it answered');
  });

  it('says once what the archive does not cover', () => {
    show(otherTurn, [
      loose(),
      loose({ checkpointId: 'c-10', prompt: 'and the charts', files: ['chart.png', 'a.ts'] }),
    ]);
    const node = screen.getByTestId('turn-loose');
    const caveat = 'Changes a shell command or an MCP tool made are not in this undo.';
    expect(node.textContent?.split(caveat)).toHaveLength(2);
    // Two archives nobody claimed, so two separate ways back.
    expect(within(node).getAllByTestId('turn-undo')).toHaveLength(2);
    expect(within(node).getByText('2 files')).toBeTruthy();
  });

  it('moves the files when the loose card is asked to', async () => {
    const onUndo = show(otherTurn, [loose()]);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('turn-loose')).getByTestId('turn-undo-button'));
    });
    expect(onUndo).toHaveBeenCalledWith('c-9', false);
    expect(
      within(screen.getByTestId('turn-loose')).getByTestId('turn-undo-list').textContent,
    ).toContain('report.md');
  });

  it('keeps a claimed archive on its own card and out of the loose ones', () => {
    show(
      [
        { id: 0, role: 'user', text: 'rename the parser' },
        {
          id: 1,
          role: 'tool',
          tool: {
            callId: 'w-1',
            name: 'write',
            input: { path: 'src/parser.ts', content: 'x\n' },
            status: 'done',
          },
        },
      ],
      [
        {
          checkpointId: 'c-1',
          prompt: 'rename the parser',
          startedAt: 1,
          files: ['src/parser.ts'],
        },
      ],
    );
    expect(screen.queryByTestId('turn-loose')).toBeNull();
    // The undo is still there — it just lives under the card that asked for it.
    expect(screen.getByTestId('turn-undo')).toBeTruthy();
    expect(screen.getByText('can undo')).toBeTruthy();
  });

  it('shows the loose card in a session whose stored transcript is empty', () => {
    show([], [loose()]);
    // "No turns yet" would contradict the card right under it.
    expect(screen.queryByTestId('transcript-empty')).toBeNull();
    expect(screen.getByTestId('turn-loose')).toBeTruthy();
  });

  it('keeps the empty invitation when there is nothing to give back at all', () => {
    show([], []);
    expect(screen.getByTestId('transcript-empty')).toBeTruthy();
    expect(screen.queryByTestId('turn-loose')).toBeNull();
  });

  it('offers the files of an archive whose ask was never recorded', () => {
    show(otherTurn, [loose({ prompt: '' })]);
    const node = screen.getByTestId('turn-loose');
    expect(node.textContent).toContain('no ask recorded');
    expect(within(node).getByTestId('turn-undo')).toBeTruthy();
  });
});
