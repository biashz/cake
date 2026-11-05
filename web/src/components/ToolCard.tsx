import { useMemo, useState } from 'react';
import { diffForTool } from '../changes';
import type { DiffLine } from '../diff';
import { stringifyOutput, summarizeInput, type ToolInfo } from '../transcript';

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
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

      {diff.length > 0 ? <DiffView lines={diff} /> : null}

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

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff" data-testid="diff">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity beyond position
        <div key={`${index}-${line.type}`} className={`diff-line diff-${line.type}`}>
          <span className="diff-mark">
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
          </span>
          <span className="mono">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
