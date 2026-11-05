import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';

export interface PaletteAction {
  id: string;
  label: string;
  group: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  open,
  actions,
  onClose,
}: {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter((action) =>
      `${action.label} ${action.group} ${action.hint ?? ''}`.toLowerCase().includes(needle),
    );
  }, [actions, query]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(filtered.length - 1, 0));
  }, [filtered.length, active]);

  if (!open) return null;

  const run = (action: PaletteAction | undefined) => {
    if (!action || action.disabled) return;
    onClose();
    action.run();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses the dialog
    <div className="palette-overlay" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, filtered.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                run(filtered[active]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Run a command or jump to a session"
            spellCheck={false}
            aria-label="Command palette search"
          />
          <span className="palette-esc mono">esc</span>
        </div>

        <div className="palette-list" role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <p className="palette-empty">No command matches “{query}”.</p>
          ) : (
            filtered.map((action, index) => {
              const showGroup = index === 0 || filtered[index - 1]?.group !== action.group;
              return (
                <div key={action.id}>
                  {showGroup ? <div className="palette-group">{action.group}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`palette-item${index === active ? ' is-active' : ''}`}
                    disabled={action.disabled}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(action)}
                  >
                    <span className="palette-label">{action.label}</span>
                    {action.hint ? <span className="palette-hint mono">{action.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="palette-footer mono">
          <span>↑↓ move</span>
          <span>enter run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
