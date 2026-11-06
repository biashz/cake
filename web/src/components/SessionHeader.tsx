import { spendLabel } from '../../../src/core/cost.js';
import type { CostPayload, SessionInfo } from '../../../src/desktop/api.js';
import { nextTheme, THEME_LABEL, type ThemeName } from '../prefs';
import { Icon, type IconName } from './Icons';

const NEXT_ICON: Record<ThemeName, IconName> = { flour: 'sun', cocoa: 'moon', auto: 'contrast' };

export function SessionHeader({
  session,
  cost,
  railOpen,
  inspectorOpen,
  theme,
  onShowCost,
  onToggleRail,
  onToggleInspector,
  onToggleTheme,
  onOpenPalette,
}: {
  session: SessionInfo | null;
  cost: CostPayload;
  railOpen: boolean;
  inspectorOpen: boolean;
  theme: ThemeName;
  onShowCost: () => void;
  onToggleRail: () => void;
  onToggleInspector: () => void;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
}) {
  const title = session?.title || 'Untitled session';
  // The session row holds the spend; the board says how much of it no rate covers.
  const spend = spendLabel(
    cost.rollup?.costUsd ?? session?.costUsd ?? 0,
    cost.board?.totals.unpricedTokens ?? 0,
  );
  const tokens = (session?.totalTokens ?? 0).toLocaleString();

  return (
    <header className="session-header">
      <div className="header-leading">
        {!railOpen ? <span className="brand-mark header-brand">cake</span> : null}
        {!railOpen ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Show sessions"
            onClick={onToggleRail}
          >
            <Icon name="rail" />
          </button>
        ) : null}
        <div className="session-heading">
          <h1 className="header-title" title={title}>
            {title}
          </h1>
          <p className="session-context mono" title={session?.cwd}>
            {session?.cwd ?? 'No session'}
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
        <button
          type="button"
          className={`icon-button${inspectorOpen ? ' is-active' : ''}`}
          aria-label="Toggle inspector"
          title="Toggle inspector (Ctrl J)"
          onClick={onToggleInspector}
        >
          <Icon name="panel" />
        </button>
      </div>
    </header>
  );
}
