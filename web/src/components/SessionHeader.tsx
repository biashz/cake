import { spendLabel } from '../../../src/core/cost.js';
import type { CostPayload, SessionInfo } from '../../../src/desktop/api.js';
import { nextTheme, THEME_LABEL, type ThemeName } from '../prefs';
import { Icon, type IconName } from './Icons';

const NEXT_ICON: Record<ThemeName, IconName> = { flour: 'sun', cocoa: 'moon', auto: 'contrast' };

export function SessionHeader({
  session,
  cost,
  theme,
  onShowCost,
  onToggleTheme,
  onOpenPalette,
}: {
  session: SessionInfo | null;
  cost: CostPayload;
  theme: ThemeName;
  onShowCost: () => void;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
}) {
  const title = session?.title || 'New session';
  const folder = session?.cwd.split(/[\\/]/).filter(Boolean).pop();
  const spend = spendLabel(
    cost.rollup?.costUsd ?? session?.costUsd ?? 0,
    cost.board?.totals.unpricedTokens ?? 0,
  );
  const tokens = (session?.totalTokens ?? 0).toLocaleString();

  return (
    <header className="session-header">
      <div className="header-leading">
        <Icon name="terminal" size={17} />
        <div className="session-heading">
          <h1 className="header-title" title={title}>
            {title}
          </h1>
          <p className="session-context" title={session?.cwd}>
            {folder ?? 'Workspace'} <span aria-hidden="true">/</span> Local session
          </p>
        </div>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="chip cost-chip mono"
          data-testid="cost-chip"
          aria-label={`Session spend ${spend} from ${tokens} tokens. Show the cost board.`}
          title="Session spend · open the cost board"
          onClick={onShowCost}
        >
          <span>{spend}</span>
          <span className="cost-chip-tokens">{tokens}</span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Open command palette"
          title="Command palette (Ctrl K)"
          onClick={onOpenPalette}
        >
          <Icon name="command" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Change palette"
          title={`Switch to the ${THEME_LABEL[nextTheme(theme)]} palette`}
          onClick={onToggleTheme}
        >
          <Icon name={NEXT_ICON[nextTheme(theme)]} />
        </button>
      </div>
    </header>
  );
}
