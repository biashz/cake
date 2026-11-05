import { useState } from 'react';
import type { ContextLayerId, ContextPayload } from '../../../src/desktop/api.js';

const BURN_THRESHOLD = 0.12;

function tokens(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function summary(payload: ContextPayload): string {
  if (payload.maxContext <= 0) return 'Context window unknown';
  const percent = Math.round((payload.used / payload.maxContext) * 100);
  const parts = payload.layers.map((layer) => `${layer.label} ${tokens(layer.tokens)}`).join(' · ');
  return `Context ${percent}% · ${payload.used.toLocaleString()} of ${payload.maxContext.toLocaleString()} tokens (estimated) · ${parts}`;
}

/**
 * The composer-sized reading of the same measurement: how full the window is,
 * coloured by what fills it. A nearly empty window still shows a sliver so the
 * composition stays legible; the exact numbers sit in the label beside it.
 */
const STRIP_FLOOR = 8;

export function SliceStrip({ context }: { context: ContextPayload | null }) {
  if (!context || context.maxContext <= 0 || context.used <= 0) {
    return <span className="slice-strip is-empty" role="img" aria-label="No context in use yet" />;
  }
  const freeRatio = context.free / context.maxContext;
  const usedRatio = (context.used / context.maxContext) * 100;
  return (
    <span
      className={`slice-strip${freeRatio < BURN_THRESHOLD ? ' is-burning' : ''}`}
      role="img"
      aria-label={summary(context)}
      title={summary(context)}
    >
      <span
        className="slice-used"
        style={{ width: `${Math.min(Math.max(usedRatio, STRIP_FLOOR), 100)}%` }}
      >
        {context.layers.map((layer) => (
          <span
            key={layer.id}
            className={`slice-seg is-${layer.id}`}
            style={{ flexGrow: layer.tokens / context.used }}
          />
        ))}
      </span>
    </span>
  );
}

/**
 * The signature component: the window read twice — one absolute bar of what is
 * left, then every layer ranked against the largest one. Click a layer to read
 * what is inside it.
 */
export function SliceBlock({ context }: { context: ContextPayload | null }) {
  const [selected, setSelected] = useState<ContextLayerId | null>(null);
  if (!context || context.maxContext <= 0) {
    return (
      <p className="hint">
        Open a session and send a prompt to see how the context window is filled.
      </p>
    );
  }

  const percent = Math.round((context.used / context.maxContext) * 100);
  const freeRatio = context.free / context.maxContext;
  const largest = Math.max(...context.layers.map((layer) => layer.tokens), 1);
  const active =
    context.layers.find((layer) => layer.id === selected) ??
    context.layers.find((layer) => layer.tokens === largest && largest > 0);

  return (
    <div className="slice-block">
      <p className="sr-only">{summary(context)}</p>

      <div className="slice-window-head mono">
        <span>Window</span>
        <span>
          <strong>{percent > 0 ? `${percent}%` : context.used > 0 ? '<1%' : '0%'}</strong> used ·{' '}
          {tokens(context.maxContext)} max
        </span>
      </div>
      <div className={`slice-window${freeRatio < BURN_THRESHOLD ? ' is-burning' : ''}`}>
        {context.layers.map((layer) => (
          <span
            key={layer.id}
            className={`slice-window-seg is-${layer.id}`}
            style={{ width: `${(layer.tokens / context.maxContext) * 100}%` }}
          />
        ))}
      </div>

      <div className="slice-layers">
        {context.layers.map((layer) => (
          <button
            key={layer.id}
            type="button"
            className={`slice-row is-${layer.id}${active?.id === layer.id ? ' is-active' : ''}`}
            aria-label={`${layer.label}: ${tokens(layer.tokens)} tokens`}
            aria-pressed={active?.id === layer.id}
            onClick={() => setSelected(layer.id)}
            onMouseEnter={() => setSelected(layer.id)}
          >
            <span className="slice-row-name">{layer.label}</span>
            <span className="slice-row-track">
              <span
                className="slice-row-fill"
                style={{ width: `${Math.max((layer.tokens / largest) * 100, 2)}%` }}
              />
            </span>
            <span className="slice-row-tokens mono">{tokens(layer.tokens)}</span>
          </button>
        ))}
        {context.layers.length === 0 ? (
          <p className="slice-entry is-empty">Nothing in the window yet.</p>
        ) : null}
      </div>

      {active ? (
        <ul className="slice-entries">
          {active.entries.length === 0 ? (
            <li className="slice-entry is-empty">Nothing recorded in this layer yet.</li>
          ) : (
            active.entries.map((entry) => (
              <li key={entry.label} className="slice-entry">
                <span className="slice-entry-label" title={entry.label}>
                  {entry.label}
                </span>
                {entry.detail ? (
                  <span className="slice-entry-kind mono">{entry.detail}</span>
                ) : null}
                <span className="slice-entry-tokens mono">{tokens(entry.tokens)}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {freeRatio < BURN_THRESHOLD ? (
        <p className="slice-warning">
          Under {Math.round(freeRatio * 100)}% of the window is free — the next turn compresses
          older history into a summary.
        </p>
      ) : null}
    </div>
  );
}
