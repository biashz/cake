import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { buildTurns, type Entry, previewValue, type ToolInfo, type Turn } from '../transcript';
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

function Note({ text, kind }: { text: string; kind?: string }) {
  return (
    <div className="entry-note" data-testid="entry-note">
      {kind ? <span className="entry-note-kind mono">{kind}</span> : null}
      <span className="entry-note-text">{text}</span>
    </div>
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
      nodes.push(<Note key={entry.id} text={entry.text ?? ''} kind={entry.kind} />);
    } else if (entry.role === 'error') {
      nodes.push(
        <div key={entry.id} className="entry-error" data-testid="entry-error">
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

/** One request and everything done about it, collapsible so long sessions scan. */
function TurnCard({
  turn,
  number,
  open,
  onToggle,
  copy,
  copiedId,
}: {
  turn: Turn;
  number: number;
  open: boolean;
  onToggle: () => void;
  copy: (id: number, text: string) => void;
  copiedId: number | null;
}) {
  const prompt = turn.user?.text ?? '';
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
        {summary === '' ? null : <span className="turn-stats mono">{summary}</span>}
        <span className="turn-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div className="turn-body">{bodyNodes(turn.body, copy, copiedId)}</div> : null}
    </section>
  );
}

export function Transcript({ entries, streaming }: { entries: Entry[]; streaming: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [closedTurns, setClosedTurns] = useState<number[]>([]);

  const turns = useMemo(() => buildTurns(entries), [entries]);

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
      <div className="transcript" data-testid="transcript" ref={scrollRef} onScroll={onScroll}>
        {entries.length === 0 && streaming === '' ? (
          <div className="transcript-empty">
            <span className="transcript-empty-mark" aria-hidden="true">
              <Icon name="spark" size={20} />
            </span>
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
          />
        ))}
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
