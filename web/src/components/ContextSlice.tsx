import { useId } from 'react';

/**
 * The signature gauge: a cake slice that fills from the tip as the context
 * window is consumed. It doubles as the running indicator.
 */
export function ContextSlice({
  used,
  max,
  running = false,
  size = 36,
}: {
  used: number;
  max: number;
  running?: boolean;
  size?: number;
}) {
  const clipId = `slice-${useId().replace(/[:]/g, '')}`;
  const ratio = max > 0 ? Math.min(Math.max(used / max, 0), 1) : 0;
  const percent = Math.round(ratio * 100);
  const fillY = 44 - ratio * 30;
  const label =
    max > 0
      ? `Context ${percent}% · ${used.toLocaleString()} of ${max.toLocaleString()} tokens`
      : 'Context usage unknown';

  return (
    <svg
      className={`context-slice${running ? ' is-running' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <defs>
        <clipPath id={clipId}>
          <path d="M24 44 6 14h36Z" />
        </clipPath>
      </defs>
      <path className="slice-bed" d="M24 44 6 14h36Z" />
      <g clipPath={`url(#${clipId})`}>
        <rect className="slice-fill" x="4" y={fillY} width="40" height={44 - fillY} />
      </g>
      <g className="slice-layers" clipPath={`url(#${clipId})`}>
        <path className="slice-layer" d="M11 22h26M14 30h20" />
      </g>
      <path className="slice-edge" d="M24 44 6 14h36Z" />
      <path className="slice-crust" d="M7 14h34" />
    </svg>
  );
}
