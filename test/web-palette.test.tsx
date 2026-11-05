// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type PaletteAction } from '../web/src/components/CommandPalette';
import { fuzzyMatch, rankActions } from '../web/src/palette';

// jsdom has no layout engine; the palette scrolls the active option into view.
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

describe('fuzzyMatch', () => {
  it('matches a subsequence and merges contiguous hits into ranges', () => {
    const match = fuzzyMatch('New session', 'nse');
    expect(match).not.toBeNull();
    expect(match?.ranges).toEqual([
      [0, 1],
      [4, 6],
    ]);
  });

  it('rejects characters that do not appear in order', () => {
    expect(fuzzyMatch('Open folder', 'np')).toBeNull();
  });

  it('scores word starts above mid-word hits', () => {
    const wordStart = fuzzyMatch('New session', 'ns')?.score ?? 0;
    const midWord = fuzzyMatch('Sessions list', 'ns')?.score ?? 0;
    expect(wordStart).toBeGreaterThan(midWord);
  });
});

describe('rankActions', () => {
  const actions: PaletteAction[] = [
    { id: 'new', label: 'New session', group: 'Session', run: () => {} },
    { id: 'open', label: 'Open folder…', group: 'Workspace', run: () => {} },
    { id: 'cost', label: 'Show session cost', group: 'Session', keywords: 'spend', run: () => {} },
  ];
  const fields = (action: PaletteAction) => [
    action.label,
    action.group,
    ...(action.keywords ? action.keywords.split(' ') : []),
  ];

  it('keeps input order for an empty query', () => {
    expect(rankActions(actions, '', fields).map((hit) => hit.action.id)).toEqual([
      'new',
      'open',
      'cost',
    ]);
  });

  it('finds an action through its keywords alone', () => {
    const ranked = rankActions(actions, 'spend', fields);
    expect(ranked.map((hit) => hit.action.id)).toEqual(['cost']);
  });

  it('drops actions the query does not reach', () => {
    const ranked = rankActions(actions, 'fold', fields);
    expect(ranked.map((hit) => hit.action.id)).toEqual(['open']);
  });

  it('will not chain letters across separate fields', () => {
    // "f" is only in the label and "w" only in the group; neither field holds "fw".
    expect(rankActions(actions, 'fw', fields)).toEqual([]);
  });

  it('only highlights when the label itself matched', () => {
    const ranked = rankActions(actions, 'spend', fields);
    expect(ranked[0]?.ranges).toEqual([]);

    const labelled = rankActions(actions, 'New', fields);
    expect(labelled[0]?.ranges).toEqual([[0, 3]]);
  });
});

function build(): PaletteAction[] {
  return [
    { id: 'new', label: 'New session', group: 'Session', hint: 'Ctrl N', run: vi.fn() },
    {
      id: 'open',
      label: 'Open folder…',
      group: 'Workspace',
      keywords: 'directory recent',
      run: vi.fn(),
    },
    {
      id: 'doctor',
      label: 'Run diagnostics',
      group: 'Workspace',
      keywords: 'spend',
      run: vi.fn(),
    },
    { id: 'locked', label: 'Reload MCP servers', group: 'Workspace', disabled: true, run: vi.fn() },
  ];
}

describe('CommandPalette', () => {
  it('runs the highlighted option on Enter and reports the id', () => {
    const actions = build();
    const onRun = vi.fn();
    render(<CommandPalette open actions={actions} recents={[]} onRun={onRun} onClose={() => {}} />);

    fireEvent.keyDown(screen.getByLabelText('Command palette search'), { key: 'Enter' });
    expect(actions[0]?.run).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith('new');
  });

  it('will not chain letters from a label into the group behind it', () => {
    render(
      <CommandPalette open actions={build()} recents={[]} onRun={() => {}} onClose={() => {}} />,
    );
    // "f" is only in "Open folder…" and "w" only in its "Workspace" group.
    fireEvent.change(screen.getByLabelText('Command palette search'), { target: { value: 'fw' } });
    expect(screen.queryAllByTestId('palette-option')).toHaveLength(0);

    // A keyword hit reaches the row but must not paint over the label's letters.
    fireEvent.change(screen.getByLabelText('Command palette search'), {
      target: { value: 'spend' },
    });
    const hit = screen.getByTestId('palette-option');
    expect(hit.textContent).toBe('Run diagnostics');
    expect(hit.querySelector('mark')).toBeNull();

    // Keyword aliases are words of their own, so "y" and "re" cannot join up.
    fireEvent.change(screen.getByLabelText('Command palette search'), { target: { value: 'yre' } });
    expect(screen.queryAllByTestId('palette-option')).toHaveLength(0);
  });

  it('filters, highlights the matched characters, and skips disabled actions', () => {
    const actions = build();
    render(
      <CommandPalette open actions={actions} recents={[]} onRun={() => {}} onClose={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText('Command palette search'), {
      target: { value: 'diag' },
    });
    const options = screen.getAllByTestId('palette-option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toBe('Run diagnostics');
    expect(options[0]?.querySelector('mark')?.textContent).toBe('diag');

    fireEvent.change(screen.getByLabelText('Command palette search'), {
      target: { value: 'reload' },
    });
    const disabled = screen.getByTestId('palette-option') as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Command palette search'), { key: 'Enter' });
    expect(actions[3]?.run).not.toHaveBeenCalled();
  });

  it('lifts recent actions into their own group and suggests when nothing matches', () => {
    render(
      <CommandPalette
        open
        actions={build()}
        recents={['doctor']}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getAllByText('Run diagnostics')).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('Command palette search'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    expect(screen.getByText(/Try/)).toBeTruthy();
  });

  it('wraps arrow-key navigation and exposes the active option', () => {
    render(
      <CommandPalette open actions={build()} recents={[]} onRun={() => {}} onClose={() => {}} />,
    );
    const input = screen.getByLabelText('Command palette search');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('listbox').querySelector('[aria-selected="true"]')?.textContent).toBe(
      'Run diagnostics',
    );
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-option-0');
  });
});
