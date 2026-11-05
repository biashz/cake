import { type ReactNode, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { Entry } from '../transcript';
import { Icon } from './Icons';
import { ToolCard } from './ToolCard';

function Bubble({
  kind,
  text,
  meta,
  live = false,
  copied = false,
  onCopy,
}: {
  kind: 'user' | 'assistant';
  text: string;
  meta?: string;
  live?: boolean;
  copied?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div
      className={`bubble bubble-${kind}${live ? ' bubble-live' : ''}`}
      data-testid={`bubble-${kind}`}
    >
      <span className="bubble-mark">{kind === 'user' ? 'you' : 'cake'}</span>
      <div className="bubble-body">
        {kind === 'assistant' ? (
          <div className="markdown">
            <Markdown>{text}</Markdown>
          </div>
        ) : (
          <div className="bubble-text">{text}</div>
        )}
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

function Note({ text }: { text: string }) {
  return <div className="entry-note">{text}</div>;
}

function ToolRun({ run }: { run: Entry[] }) {
  return (
    <div className="tool-run">
      {run.map((entry, index) =>
        entry.tool ? (
          <ToolCard
            key={entry.id}
            tool={entry.tool}
            {...(run.length > 1 ? { index: index + 1 } : {})}
          />
        ) : null,
      )}
    </div>
  );
}

export function Transcript({ entries, streaming }: { entries: Entry[]; streaming: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);

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

  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (!entry) {
      index++;
      continue;
    }

    if (entry.role === 'tool') {
      const run: Entry[] = [];
      while (index < entries.length && entries[index]?.role === 'tool') {
        const item = entries[index];
        if (item) run.push(item);
        index++;
      }
      nodes.push(<ToolRun key={`run-${run[0]?.id ?? index}`} run={run} />);
      continue;
    }

    if (entry.role === 'info') {
      nodes.push(<Note key={entry.id} text={entry.text ?? ''} />);
    } else if (entry.role === 'error') {
      nodes.push(
        <div key={entry.id} className="entry-error" data-testid="entry-error">
          {entry.text}
        </div>,
      );
    } else if (entry.role === 'user' || entry.role === 'assistant') {
      nodes.push(
        <Bubble
          key={entry.id}
          kind={entry.role}
          text={entry.text ?? ''}
          {...(entry.meta !== undefined ? { meta: entry.meta } : {})}
          copied={copied === entry.id}
          onCopy={() => copy(entry.id, entry.text ?? '')}
        />,
      );
    }
    index++;
  }

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
        {nodes}
        {streaming ? <Bubble kind="assistant" text={streaming} live /> : null}
      </div>
      {!pinned ? (
        <button type="button" className="jump-latest" onClick={jump}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
