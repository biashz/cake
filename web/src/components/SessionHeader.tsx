import { formatCost } from '../../../src/core/cost.js';
import type { SessionInfo } from '../../../src/desktop/api.js';
import type { ThemeName } from '../prefs';
import { Icon } from './Icons';

export function SessionHeader({
  session,
  railOpen,
  inspectorOpen,
  theme,
  onToggleRail,
  onToggleInspector,
  onToggleTheme,
  onOpenPalette,
}: {
  session: SessionInfo | null;
  railOpen: boolean;
  inspectorOpen: boolean;
  theme: ThemeName;
  onToggleRail: () => void;
  onToggleInspector: () => void;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
}) {
  const title = session?.title || 'Untitled session';

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
        <span className="chip cost-chip mono" title="Session cost">
          {formatCost(session?.costUsd ?? 0)}
        </span>

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
          aria-label="Toggle theme"
          title={theme === 'night' ? 'Switch to parchment' : 'Switch to night'}
          onClick={onToggleTheme}
        >
          <Icon name={theme === 'night' ? 'sun' : 'moon'} />
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
