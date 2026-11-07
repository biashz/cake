import { useEffect, useMemo, useRef, useState } from 'react';
import { rankActions } from '../palette';
import { Icon } from './Icons';

export interface PaletteAction {
  id: string;
  label: string;
  group: string;
  hint?: string;
  /** Extra words that should surface this action, e.g. "spend" for cost. */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

interface Row {
  action: PaletteAction;
  ranges: Array<[number, number]>;
}

const GROUP_ORDER = ['Recent', 'Session', 'Workspace', 'View', 'Sessions'];

/**
 * Each field is searched on its own so a needle cannot chain letters across
 * "Open folder" + "Workspace" and surface an action nobody asked for.
 * Keywords are split into words for the same reason.
 */
function searchFields(action: PaletteAction): string[] {
  const keywords = action.keywords
    ? action.keywords.split(/\s+/).filter((word) => word !== '')
    : [];
  return [action.label, action.group, action.hint ?? '', ...keywords];
}

function Highlight({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  if (ranges.length === 0) return <>{text}</>;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <mark key={`${start}-${end}`} className="palette-mark">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

export function CommandPalette({
  open,
  actions,
  recents,
  onRun,
  onClose,
}: {
  open: boolean;
  actions: PaletteAction[];
  /** Action ids, most recent first. */
  recents: string[];
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Whoever held the keyboard when the palette took it gets it back, unless
    // something else has claimed focus in the meantime.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
    return () => {
      if (opener && document.activeElement === document.body) opener.focus();
    };
  }, [open]);

  /** Idle view: recent actions move to their own group and leave their original one. */
  const grouped = useMemo<Array<{ group: string; items: PaletteAction[] }>>(() => {
    const recentIds = new Set(recents);
    const byGroup = new Map<string, PaletteAction[]>();
    const recent = actions
      .filter((action) => recentIds.has(action.id))
      .sort((a, b) => recents.indexOf(a.id) - recents.indexOf(b.id));
    if (recent.length > 0) byGroup.set('Recent', recent);

    for (const action of actions) {
      if (recentIds.has(action.id)) continue;
      const list = byGroup.get(action.group) ?? [];
      list.push(action);
      byGroup.set(action.group, list);
    }

    const ordered: Array<{ group: string; items: PaletteAction[] }> = [];
    for (const name of GROUP_ORDER) {
      const items = byGroup.get(name);
      if (items) ordered.push({ group: name, items });
    }
    for (const [group, items] of byGroup) {
      if (!GROUP_ORDER.includes(group)) ordered.push({ group, items });
    }
    return ordered;
  }, [actions, recents]);

  const sections = useMemo<Array<{ group: string; rows: Row[] }>>(() => {
    const needle = query.trim();
    if (needle !== '') {
      const ranked = rankActions(actions, needle, searchFields);
      if (ranked.length === 0) return [];
      return [
        {
          group: '',
          rows: ranked.map((hit) => ({ action: hit.action, ranges: hit.ranges })),
        },
      ];
    }
    return grouped.map((section) => ({
      group: section.group,
      rows: section.items.map((action) => ({ action, ranges: [] })),
    }));
  }, [grouped, actions, query]);

  /** Flattened order drives arrow keys, so listbox and keyboard always agree. */
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const rowIndex = useMemo(() => {
    const map = new Map<PaletteAction, number>();
    rows.forEach((row, index) => {
      map.set(row.action, index);
    });
    return map;
  }, [rows]);

  useEffect(() => {
    setActive((value) => Math.min(value, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: active is the trigger, not an input
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: 'nearest',
    });
  }, [active]);

  if (!open) return null;

  const run = (action: PaletteAction | undefined) => {
    if (!action || action.disabled) return;
    onRun(action.id);
    onClose();
    action.run();
  };

  /** Keyboard stops only on things it can actually run. */
  const nearestEnabled = (from: number, step: number): number => {
    if (rows.length === 0) return 0;
    let index = from;
    for (let guard = 0; guard < rows.length; guard++) {
      const row = rows[index];
      if (row && !row.action.disabled) return index;
      index = (index + step + rows.length) % rows.length;
    }
    return from;
  };

  const move = (step: number) => {
    if (rows.length === 0) return;
    setActive((value) => nearestEnabled((value + step + rows.length) % rows.length, step));
  };

  const suggestions = actions
    .filter((action) => !action.disabled)
    .slice(0, 3)
    .map((action) => action.label);

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
              if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
                event.preventDefault();
                move(1);
              } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
                event.preventDefault();
                move(-1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setActive(nearestEnabled(0, 1));
              } else if (event.key === 'End') {
                event.preventDefault();
                setActive(nearestEnabled(Math.max(rows.length - 1, 0), -1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                run(rows[active]?.action);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Run a command or jump to a session"
            spellCheck={false}
            aria-label="Command palette search"
            aria-controls="palette-list"
            aria-activedescendant={rows[active] ? `palette-option-${active}` : undefined}
          />
          <span className="palette-esc mono">esc</span>
        </div>

        <div
          className="palette-list"
          id="palette-list"
          role="listbox"
          aria-label="Commands"
          ref={listRef}
        >
          {sections.length === 0 ? (
            <div className="palette-none">
              <p className="palette-empty">Nothing matches “{query.trim()}”.</p>
              {suggestions.length > 0 ? (
                <p className="palette-suggest mono">
                  Try {suggestions.map((label) => `“${label}”`).join(', ')}
                </p>
              ) : null}
            </div>
          ) : (
            sections.map((section) => (
              // biome-ignore lint/a11y/useSemanticElements: a listbox only accepts role=group, not fieldset
              <div
                key={section.group || 'results'}
                className="palette-section"
                role="group"
                {...(section.group ? { 'aria-label': section.group } : {})}
              >
                {section.group ? <div className="palette-group">{section.group}</div> : null}
                {section.rows.map((row) => {
                  const index = rowIndex.get(row.action) ?? 0;
                  const isActive = index === active;
                  return (
                    <button
                      key={row.action.id}
                      id={`palette-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      // The search field holds the keyboard and points at the row
                      // through aria-activedescendant; a tabbable row would put a
                      // second, invisible cursor in the same list.
                      tabIndex={-1}
                      data-active={isActive || undefined}
                      data-testid="palette-option"
                      className={`palette-item${isActive ? ' is-active' : ''}`}
                      disabled={row.action.disabled}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => run(row.action)}
                    >
                      <span className="palette-label">
                        <Highlight text={row.action.label} ranges={row.ranges} />
                      </span>
                      {row.action.hint ? (
                        <span className="palette-hint mono">{row.action.hint}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
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
