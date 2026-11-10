import { useEffect, useState } from 'react';
import { spendLabel } from '../../../src/core/cost.js';
import type { PermissionModeName } from '../../../src/desktop/api.js';

const MODE_LABEL: Record<PermissionModeName, string> = {
  plan: 'Plan',
  default: 'Default',
  acceptEdits: 'Accept edits',
  yolo: 'YOLO',
};

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function HeatBar({
  running,
  providerLabel,
  modelId,
  mode,
  startedAt,
  costUsd,
  tokens,
  unpriced,
  pendingApprovals,
}: {
  running: boolean;
  providerLabel: string;
  modelId: string;
  mode: PermissionModeName;
  startedAt: number | null;
  costUsd: number;
  tokens: number;
  /** Tokens with no rate; their spend is unknown, so the read-out must not say $0. */
  unpriced: number;
  pendingApprovals: number;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  const state = pendingApprovals > 0 ? 'Waiting for approval' : running ? 'Working' : 'Ready';

  return (
    <footer className={`heat${running && pendingApprovals === 0 ? ' is-hot' : ''}`}>
      <span className="sr-only">Run status</span>
      <span className="heat-pulse" aria-hidden="true" />
      <strong className="heat-state">{state}</strong>

      {/* kept in the layout while idle so the read-out does not jump when a run starts */}
      <span className="heat-clock mono">
        {running && startedAt !== null ? elapsed(startedAt) : ''}
      </span>

      <span className="heat-model mono" title={`${providerLabel} · ${modelId}`}>
        {providerLabel} / {modelId}
      </span>

      <span className={`heat-mode is-${mode}`}>{MODE_LABEL[mode]}</span>

      <span className="heat-usage mono">
        {tokens > 0
          ? `${tokens.toLocaleString()} tok · ${spendLabel(costUsd, unpriced)}`
          : 'no spend yet'}
      </span>

      {pendingApprovals > 0 ? (
        <span className="heat-flag mono" role="status">
          {pendingApprovals} approval{pendingApprovals > 1 ? 's' : ''} waiting
        </span>
      ) : null}
    </footer>
  );
}
