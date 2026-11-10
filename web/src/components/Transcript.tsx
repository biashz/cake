import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { RewindChange } from '../../../src/core/checkpoints.js';
import type { CheckpointTurnRow, RevertResult } from '../../../src/desktop/api.js';
import type { CodebaseHit } from '../../../src/rag/retrieval.js';
import {
  buildTurns,
  type Entry,
  linkUndos,
  previewValue,
  shortTime,
  type ToolInfo,
  type Turn,
} from '../transcript';
import { Icon } from './Icons';
import { ToolCard } from './ToolCard';

function Bubble({
  text,
  meta,
  live = false,
  copied = false,
  onCopy,
}: {
  text: string;
  meta?: string;
  live?: boolean;
  copied?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div
      className={`bubble bubble-assistant${live ? ' bubble-live' : ''}`}
      data-testid="bubble-assistant"
      // A stream would announce every token; the finished entry is what the log says.
      {...(live ? { 'aria-live': 'off' as const } : {})}
    >
      <span className="bubble-mark">cake</span>
      <div className="bubble-body">
        <div className="markdown">
          <Markdown>{text}</Markdown>
        </div>
        {meta || onCopy ? (
          <div className="bubble-foot">
            {meta ? <div className="bubble-meta">{meta}</div> : null}
            {onCopy && !live ? (
              <button
                type="button"
                className="bubble-copy"
                aria-label={copied ? 'Copied message' : 'Copy message'}
                title={copied ? 'Copied' : 'Copy message'}
                onClick={onCopy}
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Why a hit was chosen, in the words the card shows instead of a bare number. */
const VIA_LABEL: Record<CodebaseHit['via'], string> = {
  both: 'meaning + keywords',
  semantic: 'meaning',
  lexical: 'keywords',
};

/**
 * The chunks that actually went into the prompt. Each card is a handle: clicking it
 * puts `@path` in the composer, so a good hit is one keystroke away from a follow-up.
 */
function HitCards({
  hits,
  onInsertFile,
}: {
  hits: CodebaseHit[];
  onInsertFile: (path: string) => void;
}) {
  return (
    <div className="hit-cards" data-testid="hit-cards">
      {hits.map((hit) => (
        <button
          type="button"
          key={`${hit.path}:${hit.startLine}-${hit.endLine}`}
          className="hit-card"
          data-testid="codebase-hit"
          title={`Attach @${hit.path} to the prompt`}
          onClick={() => onInsertFile(hit.path)}
        >
          <span className="hit-path mono">{hit.path}</span>
          <span className="hit-lines mono">
            {hit.startLine}–{hit.endLine}
          </span>
          <span className="hit-via">{VIA_LABEL[hit.via]}</span>
          <span className="hit-score mono">{hit.score.toFixed(2)}</span>
        </button>
      ))}
    </div>
  );
}

function Note({
  text,
  kind,
  hits,
  onInsertFile,
}: {
  text: string;
  kind?: string;
  hits?: CodebaseHit[];
  onInsertFile: (path: string) => void;
}) {
  return (
    <>
      <div className="entry-note" data-testid="entry-note">
        {kind ? <span className="entry-note-kind mono">{kind}</span> : null}
        <span className="entry-note-text">{text}</span>
      </div>
      {hits && hits.length > 0 ? <HitCards hits={hits} onInsertFile={onInsertFile} /> : null}
    </>
  );
}

/** Strip the `explore:` style prefix a child call carries so the row reads as the tool. */
function bareName(name: string): string {
  const split = name.indexOf(':');
  return split === -1 ? name : name.slice(split + 1);
}

/** Consecutive calls read as one block: what ran, in order, with failures called out. */
function ToolGroup({ run }: { run: Entry[] }) {
  const [open, setOpen] = useState(true);
  const tools = run
    .map((entry) => entry.tool)
    .filter((tool): tool is ToolInfo => tool !== undefined);
  const failed = tools.filter((tool) => tool.status === 'error').length;
  const running = tools.some((tool) => tool.status === 'running');

  const tally = new Map<string, number>();
  for (const tool of tools) {
    const name = bareName(tool.name);
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  const summary = [...tally]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(', ');

  return (
    <div className="tool-group" data-testid="tool-group">
      <button
        type="button"
        className="tool-group-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-group-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="tool-group-count">
          {tools.length === 1 ? '1 tool call' : `${tools.length} tool calls`}
        </span>
        <span className="tool-group-tally mono">{previewValue(summary, 70)}</span>
        {failed > 0 ? <span className="tool-group-failed">{failed} failed</span> : null}
        {running ? <span className="tool-group-running mono">running…</span> : null}
      </button>
      {open ? (
        <div className="tool-group-body">
          {tools.map((tool, index) => (
            <ToolCard
              key={tool.callId}
              tool={tool}
              {...(tools.length > 1 ? { index: index + 1 } : {})}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function bodyNodes(
  body: Entry[],
  copy: (id: number, text: string) => void,
  copiedId: number | null,
  onInsertFile: (path: string) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < body.length) {
    const entry = body[index];
    if (!entry) {
      index++;
      continue;
    }

    if (entry.role === 'tool') {
      const run: Entry[] = [];
      while (index < body.length && body[index]?.role === 'tool') {
        const item = body[index];
        if (item) run.push(item);
        index++;
      }
      nodes.push(<ToolGroup key={`run-${run[0]?.id ?? index}`} run={run} />);
      continue;
    }

    if (entry.role === 'info' || entry.role === 'note') {
      nodes.push(
        <Note
          key={entry.id}
          text={entry.text ?? ''}
          kind={entry.kind}
          hits={entry.hits}
          onInsertFile={onInsertFile}
        />,
      );
    } else if (entry.role === 'error') {
      nodes.push(
        <div key={entry.id} className="entry-error" data-testid="entry-error" role="alert">
          {entry.text}
        </div>,
      );
    } else if (entry.role === 'assistant') {
      nodes.push(
        <Bubble
          key={entry.id}
          text={entry.text ?? ''}
          {...(entry.meta !== undefined ? { meta: entry.meta } : {})}
          copied={copiedId === entry.id}
          onCopy={() => copy(entry.id, entry.text ?? '')}
        />,
      );
    }
    index++;
  }
  return nodes;
}

function duration(turn: Turn): string {
  if (turn.startedAt === undefined || turn.endedAt === undefined) return '';
  const seconds = Math.round((turn.endedAt - turn.startedAt) / 1000);
  // A turn that finished inside the rounding is not "0 seconds of work".
  if (seconds < 1) return '';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** What the turn did, not what it cost: the answer bubble already carries that. */
function stats(turn: Turn): string {
  const parts: string[] = [];
  if (turn.toolCount > 0) {
    parts.push(`${turn.toolCount} ${turn.toolCount === 1 ? 'call' : 'calls'}`);
  }
  const time = duration(turn);
  if (time !== '') parts.push(time);
  return parts.join(' · ');
}

/** What one file did in an undo, in the words a person can act on. */
function undoneAs(change: RewindChange): string {
  if (change.action === 'deleted') return 'removed (the turn created it)';
  if (change.action === 'failed')
    return `could not be put back (${change.note ?? 'unknown reason'})`;
  if (change.action === 'left') return `left as it is (${change.note ?? 'no copy was kept'})`;
  return 'put back';
}

/** Said every time an undo is on offer, because the archive really does not cover it. */
const NOT_UNDONE = 'Changes a shell command or an MCP tool made are not in this undo.';

type UndoState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; result: RevertResult }
  | { kind: 'failed'; message: string };

/**
 * The turn's own undo. It says which files go back before it offers to move them,
 * and when a later turn has since changed the same files it stops and asks,
 * because giving this one back would lose that work too.
 */
function UndoRow({
  row,
  running,
  onUndo,
  laterWords,
  caveat = true,
}: {
  row: CheckpointTurnRow;
  running: boolean;
  onUndo: (checkpointId: string, force: boolean) => Promise<RevertResult>;
  laterWords: (ids: string[]) => string;
  /** False where the same sentence is already said once above a group of rows. */
  caveat?: boolean;
}) {
  const [state, setState] = useState<UndoState>({ kind: 'idle' });
  const blocked = state.kind === 'done' && !state.result.applied;
  const fileCount = row.files.length;
  const shown =
    fileCount <= 3
      ? row.files.join(', ')
      : `${row.files.slice(0, 3).join(', ')} +${fileCount - 3} more`;

  const ask = (force: boolean) => {
    setState({ kind: 'working' });
    void (async () => {
      try {
        setState({ kind: 'done', result: await onUndo(row.checkpointId, force) });
      } catch (err) {
        setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  };

  return (
    <div className="turn-undo" data-testid="turn-undo">
      <div className="turn-undo-ask">
        <span className="turn-undo-files mono" title={row.files.join('\n')}>
          {fileCount === 1 ? '1 file' : `${fileCount} files`}
        </span>
        <span className="turn-undo-hint">
          {shown} {fileCount === 1 ? 'goes' : 'go'} back
        </span>
        <button
          type="button"
          className="turn-undo-button"
          data-testid="turn-undo-button"
          disabled={state.kind === 'working' || running}
          title={running ? 'Wait for the running turn to finish' : undefined}
          onClick={() => ask(blocked)}
        >
          {state.kind === 'working'
            ? 'Giving it back…'
            : blocked
              ? 'Undo anyway'
              : state.kind === 'done'
                ? 'Undo again'
                : 'Undo this turn'}
        </button>
      </div>
      {state.kind === 'failed' ? (
        <p className="turn-undo-error" data-testid="turn-undo-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'done' && !state.result.applied ? (
        <p className="turn-undo-blocked" data-testid="turn-undo-blocked">
          Nothing moved: {laterWords(state.result.overwrittenBy)}{' '}
          {state.result.overwrittenBy.length === 1 ? 'has' : 'have'} changed these files since. Undo
          anyway loses those changes too.
        </p>
      ) : null}
      {state.kind === 'done' && state.result.applied ? (
        <ul className="turn-undo-list" data-testid="turn-undo-list">
          {state.result.changes.map((change) => (
            <li key={change.path} className="mono">
              <span className="turn-undo-path">{change.path}</span>{' '}
              <span className="turn-undo-action">{undoneAs(change)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {caveat ? <p className="turn-undo-caveat">{NOT_UNDONE}</p> : null}
    </div>
  );
}

/** One request and everything done about it, collapsible so long sessions scan. */
function TurnCard({
  turn,
  number,
  open,
  onToggle,
  copy,
  copiedId,
  onInsertFile,
  undo,
  running,
  onUndo,
  laterWords,
}: {
  turn: Turn;
  number: number;
  open: boolean;
  onToggle: () => void;
  copy: (id: number, text: string) => void;
  copiedId: number | null;
  onInsertFile: (path: string) => void;
  undo?: CheckpointTurnRow;
  running: boolean;
  onUndo: (checkpointId: string, force: boolean) => Promise<RevertResult>;
  laterWords: (ids: string[]) => string;
}) {
  const prompt = turn.user?.text ?? '';
  const images = turn.user?.images ?? [];
  const summary = stats(turn);
  return (
    <section className={`turn${open ? ' is-open' : ''}`} data-testid="turn">
      <button type="button" className="turn-head" aria-expanded={open} onClick={onToggle}>
        <span className="turn-seq mono" aria-hidden="true">
          {String(number).padStart(2, '0')}
        </span>
        <span className="turn-prompt" title={prompt === '' ? undefined : prompt}>
          {prompt === '' ? 'Session notes' : prompt}
        </span>
        {images.length === 0 ? null : (
          <span className="turn-images mono" title="Pictures sent with this turn">
            {images.length === 1 ? '1 image' : `${images.length} images`}
          </span>
        )}
        {summary === '' ? null : <span className="turn-stats mono">{summary}</span>}
        {undo ? (
          <span className="turn-undone-tag mono" title="This turn can be given back">
            can undo
          </span>
        ) : null}
        <span className="turn-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="turn-body">
          {images.length === 0 ? null : (
            <ul className="turn-attachments" aria-label="Pictures sent with this turn">
              {images.map((src) => (
                <li key={src}>
                  <img className="turn-attach" src={src} alt="" />
                </li>
              ))}
            </ul>
          )}
          {bodyNodes(turn.body, copy, copiedId, onInsertFile)}
          {undo ? (
            <UndoRow row={undo} running={running} onUndo={onUndo} laterWords={laterWords} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function Transcript({
  entries,
  streaming,
  onInsertFile,
  checkpoints,
  running,
  onUndo,
}: {
  entries: Entry[];
  streaming: string;
  onInsertFile: (path: string) => void;
  /** The session's turns that left an undo archive, as the kernel counted them. */
  checkpoints: CheckpointTurnRow[];
  running: boolean;
  onUndo: (checkpointId: string, force: boolean) => Promise<RevertResult>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [closedTurns, setClosedTurns] = useState<number[]>([]);

  const turns = useMemo(() => buildTurns(entries), [entries]);
  const undos = useMemo(() => linkUndos(turns, checkpoints), [turns, checkpoints]);

  /** A blocked undo names the turns in the way by what they asked for. */
  const laterWords = useCallback(
    (ids: string[]) => {
      const byId = new Map(checkpoints.map((row) => [row.checkpointId, row.prompt] as const));
      return ids.map((id) => `“${previewValue(byId.get(id) ?? 'a later turn', 48)}”`).join(', ');
    },
    [checkpoints],
  );

  // entries/streaming are effect triggers: new content should pull the view down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    if (!pinned) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, streaming, pinned]);

  useEffect(() => {
    if (entries.length === 0) setPinned(true);
  }, [entries.length]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
  };

  const jump = () => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    setPinned(true);
  };

  const copy = (id: number, text: string) => {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(text);
        setCopied(id);
        window.setTimeout(() => setCopied((value) => (value === id ? null : value)), 1600);
      } catch {
        // Clipboard access can be denied; the message stays selectable.
      }
    })();
  };

  const toggle = (key: number) => {
    setClosedTurns((list) =>
      list.includes(key) ? list.filter((item) => item !== key) : [...list, key],
    );
  };

  return (
    <div className="transcript-shell">
      <div
        className="transcript"
        data-testid="transcript"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {entries.length === 0 && streaming === '' && undos.unclaimed.length === 0 ? (
          <div className="transcript-empty">
            <span className="transcript-empty-mark" aria-hidden="true">
              <Icon name="spark" size={20} />
            </span>
            {/* The same grammar every other empty panel uses: name the state, then say
                what fills it. Without the first line this is only the placeholder
                again, in a place no one can type into. */}
            <p className="transcript-empty-title" data-testid="transcript-empty">
              No turns yet.
            </p>
            <p className="hint">Ask cake to change the code…</p>
          </div>
        ) : null}
        {turns.map((turn, position) => (
          <TurnCard
            key={turn.key}
            turn={turn}
            number={position + 1}
            open={!closedTurns.includes(turn.key)}
            onToggle={() => toggle(turn.key)}
            copy={copy}
            copiedId={copied}
            onInsertFile={onInsertFile}
            {...(undos.byTurn.get(turn.key) ? { undo: undos.byTurn.get(turn.key) } : {})}
            running={running}
            onUndo={onUndo}
            laterWords={laterWords}
          />
        ))}
        {/* An archive no card took still describes the workspace, so it gets a card
            of its own instead of vanishing from the screen. Two turns end up here —
            one that died before it stored anything, one whose ask was rewritten on
            the way in — and the tray says both rather than guessing which. */}
        {undos.unclaimed.length === 0 ? null : (
          <section className="turn-loose" data-testid="turn-loose">
            <p className="turn-loose-title">Turns with no card above</p>
            <p className="turn-loose-hint">
              Each of these turns changed files and has no card of its own here: it either stopped
              before it answered, so nothing it said was kept, or its ask was rewritten on the way
              in. What it changed is archived, and this gives it back. {NOT_UNDONE}
            </p>
            {undos.unclaimed.map((row) => (
              <div className="turn-loose-row" data-testid="turn-loose-row" key={row.checkpointId}>
                <div className="turn-loose-ask">
                  <span className="turn-loose-prompt" title={row.prompt}>
                    {row.prompt.trim() === ''
                      ? 'no ask recorded'
                      : `“${previewValue(row.prompt, 90)}”`}
                  </span>
                  <span className="turn-loose-when mono">{shortTime(row.startedAt)}</span>
                </div>
                <UndoRow
                  row={row}
                  running={running}
                  onUndo={onUndo}
                  laterWords={laterWords}
                  caveat={false}
                />
              </div>
            ))}
          </section>
        )}
        {streaming ? <Bubble text={streaming} live /> : null}
      </div>
      {!pinned ? (
        <button type="button" className="jump-latest" onClick={jump}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
