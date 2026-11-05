import { useMemo, useState } from 'react';
import { diffForTool } from '../changes';
import { cap, type DiffLine, type DiffResult, fitHunks } from '../diff';
import { type AgentRun, stringifyOutput, summarizeInput, type ToolInfo } from '../transcript';

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

function bareName(name: string): string {
  const split = name.indexOf(':');
  return split === -1 ? name : name.slice(split + 1);
}

/** The live tree: what a child agent is doing, inside the call that spawned it. */
function AgentBranch({ agent }: { agent: AgentRun }) {
  const [showText, setShowText] = useState(false);
  const running = agent.status === 'running';

  return (
    <div className="agent-branch" data-testid="agent-branch">
      <div className="agent-head mono">
        <span className={`agent-dot${running ? ' is-running' : ''}`} aria-hidden="true" />
        <span className="agent-type">{agent.type}</span>
        <span className="agent-count">
          {agent.children.length === 0
            ? 'no calls yet'
            : `${agent.children.length} ${agent.children.length === 1 ? 'call' : 'calls'}`}
        </span>
        {agent.tokens !== undefined ? (
          <span className="agent-tokens">{agent.tokens} tok</span>
        ) : null}
      </div>

      <p className="agent-prompt">{truncate(agent.prompt, 160)}</p>

      {agent.children.length > 0 ? (
        <ul className="agent-kids">
          {agent.children.map((child) => (
            <li key={child.callId} className={`agent-kid tool-${child.status}`}>
              <span className="tool-marker" aria-hidden="true">
                {child.status === 'running' ? '→' : child.status === 'error' ? '✗' : '←'}
              </span>
              <span className="tool-name mono">{bareName(child.name)}</span>
              <span className="agent-kid-target">{summarizeInput(child.input)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {agent.text === undefined ? null : (
        <>
          <button
            type="button"
            className="agent-text-toggle"
            aria-expanded={showText}
            onClick={() => setShowText((value) => !value)}
          >
            {showText ? 'hide summary' : 'show summary'}
          </button>
          {showText ? (
            <div className="agent-text">
              <pre>{truncate(agent.text, 4000)}</pre>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function ToolCard({ tool, index }: { tool: ToolInfo; index?: number }) {
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => diffForTool(tool), [tool]);

  return (
    <div className={`tool-card tool-${tool.status}`} data-testid="tool-card">
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)}>
        {index !== undefined ? (
          <span className="tool-seq mono" aria-hidden="true">
            {String(index).padStart(2, '0')}
          </span>
        ) : null}
        <span className="tool-marker" aria-hidden="true">
          {tool.status === 'running' ? '→' : tool.status === 'error' ? '✗' : '←'}
        </span>
        <span className="tool-name mono">{tool.name}</span>
        <span className="tool-target">{summarizeInput(tool.input)}</span>
        <span className="tool-state">
          {tool.status === 'running' ? 'running…' : tool.status === 'error' ? 'failed' : 'done'}
        </span>
      </button>

      {tool.agent ? <AgentBranch agent={tool.agent} /> : null}

      {diff.lines.length > 0 ? <DiffView diff={diff} /> : null}

      {open ? (
        <div className="tool-detail">
          <div className="detail-label">input</div>
          <pre>{truncate(JSON.stringify(tool.input, null, 2) ?? '', 4000)}</pre>
          {tool.error !== undefined ? (
            <>
              <div className="detail-label">error</div>
              <pre className="error-text">{tool.error}</pre>
            </>
          ) : null}
          {tool.output !== undefined ? (
            <>
              <div className="detail-label">result</div>
              <pre>{truncate(stringifyOutput(tool.output), 4000)}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DiffView({ diff, max = 0 }: { diff: DiffResult; max?: number }) {
  const view = useMemo(() => fitHunks(diff.lines, max), [diff, max]);
  const [closed, setClosed] = useState<number[]>([]);

  if (view.hunks.length === 0) {
    const shown = max > 0 ? cap(diff, max) : diff;
    return (
      <div className="diff" data-testid="diff">
        {shown.lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
          <DiffRow key={`${index}-${line.text}`} line={line} />
        ))}
        {shown.hidden > 0 ? <HiddenNotice diff={shown} /> : null}
      </div>
    );
  }

  const hidden = view.hidden + diff.hidden;

  return (
    <div className="diff" data-testid="diff">
      {view.hunks.map(({ hunk, lines }) => {
        const open = !closed.includes(hunk.start);
        return (
          <section key={hunk.start} className={`diff-hunk${open ? ' is-open' : ''}`}>
            <button
              type="button"
              className="diff-hunk-head"
              aria-expanded={open}
              onClick={() =>
                setClosed((list) =>
                  list.includes(hunk.start)
                    ? list.filter((start) => start !== hunk.start)
                    : [...list, hunk.start],
                )
              }
            >
              <span className="diff-hunk-at mono">@{hunk.start}</span>
              <span className="diff-count-add mono" data-testid="diff-count-add">
                +{hunk.adds}
              </span>
              <span className="diff-count-remove mono" data-testid="diff-count-remove">
                −{hunk.removes}
              </span>
              <span className="diff-hunk-caret" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
            </button>
            {open ? (
              <div className="diff-hunk-body">
                {lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity beyond position
                  <DiffRow key={`${index}-${line.text}`} line={line} />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
      {hidden > 0 ? <HiddenNotice diff={diff} hidden={hidden} /> : null}
    </div>
  );
}

/**
 * The footer of a trimmed diff. `diff.adds`/`diff.removes` always describe the
 * whole change, so a tallied view cannot read as a smaller one than it is.
 */
function HiddenNotice({ diff, hidden = diff.hidden }: { diff: DiffResult; hidden?: number }) {
  return (
    <p className="diff-hidden mono" data-testid="diff-hidden">
      +{diff.adds} −{diff.removes} in all · {hidden} more lines not shown
    </p>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line diff-${line.type}`} data-testid="diff-line">
      <span className="diff-mark">
        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
      </span>
      <span className="mono">{line.text}</span>
    </div>
  );
}
