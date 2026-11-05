// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../web/src/components/ApprovalCard';
import { Composer } from '../web/src/components/Composer';
import { ToolCard } from '../web/src/components/ToolCard';
import { Transcript } from '../web/src/components/Transcript';

afterEach(cleanup);

describe('ToolCard', () => {
  it('renders an edit diff and toggles details', () => {
    render(
      <ToolCard
        tool={{
          name: 'edit',
          input: { path: 'a.ts', old_string: 'old line', new_string: 'new line' },
          status: 'done',
        }}
      />,
    );

    const diff = screen.getByTestId('diff');
    expect(diff.textContent).toContain('-old line');
    expect(diff.textContent).toContain('+new line');
    expect(screen.queryByText('input')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('input')).toBeTruthy();
  });

  it('shows failure state for tool errors', () => {
    render(
      <ToolCard
        tool={{ name: 'bash', input: { command: 'false' }, status: 'error', error: 'exit 1' }}
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
});

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
      />,
    );

    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('10 tokens')).toBeTruthy();
    expect(screen.getByTestId('entry-error').textContent).toBe('boom');
    expect(screen.getByText('partial')).toBeTruthy();
  });
});
