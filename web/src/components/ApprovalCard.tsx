import type { PermissionRequestPayload } from '../../../src/desktop/api.js';

export function ApprovalCard({
  request,
  pending,
  onRespond,
}: {
  request: PermissionRequestPayload;
  pending: number;
  onRespond: (id: string, decision: 'allow' | 'deny') => void;
}) {
  return (
    <div className={`approval-card${request.danger ? ' danger' : ''}`} data-testid="approval-card">
      <div className="approval-rail" aria-hidden="true" />
      <div className="approval-content">
        <div className="approval-head">
          <span className="approval-badge mono">approval</span>
          <span className="approval-meta mono">
            {request.tool}
            {request.permission === request.tool ? '' : ` · ${request.permission}`}
            {pending > 0 ? ` · ${pending} more queued` : ''}
          </span>
        </div>
        <p className="approval-title">Allow this action?</p>
        <div className="approval-target mono">{request.target}</div>
        {request.danger ? <div className="approval-danger">danger: {request.danger}</div> : null}
        <div className="approval-actions">
          <button
            type="button"
            className="primary"
            data-testid="approval-allow"
            onClick={() => onRespond(request.id, 'allow')}
          >
            Allow
          </button>
          <button
            type="button"
            data-testid="approval-deny"
            onClick={() => onRespond(request.id, 'deny')}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
