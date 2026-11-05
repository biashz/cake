import { useEffect, useRef, useState } from 'react';
import type { InitPayload, ModelHandle, PermissionModeName } from '../../../src/desktop/api.js';
import { SLASH_COMMANDS, type SlashCommand } from '../commands';
import { MODE_LABEL, ModelMenu, ModeMenu, useDismiss } from './AgentMenus';
import { ContextSlice } from './ContextSlice';
import { Icon } from './Icons';

interface Suggestion {
  value: string;
  label: string;
  hint?: string;
}

interface SuggestState {
  kind: 'file' | 'command';
  start: number;
  end: number;
  items: Suggestion[];
}

export function Composer({
  value,
  running,
  disabled,
  onChange,
  onSubmit,
  onStop,
  loadFiles,
  commands = SLASH_COMMANDS,
  focusToken = 0,
  init,
  used = 0,
  maxContext = 0,
  modelMenuSignal = 0,
  modeMenuSignal = 0,
  onSetModel,
  onSetMode,
}: {
  value: string;
  running: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  loadFiles?: (query: string) => Promise<string[]>;
  commands?: SlashCommand[];
  focusToken?: number;
  init?: InitPayload;
  used?: number;
  maxContext?: number;
  modelMenuSignal?: number;
  modeMenuSignal?: number;
  onSetModel?: (model: ModelHandle) => void;
  onSetMode?: (mode: PermissionModeName) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelAnchor = useRef<HTMLDivElement>(null);
  const modeAnchor = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const [active, setActive] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const lastModelSignal = useRef(0);
  const lastModeSignal = useRef(0);

  const closeModel = () => setModelOpen(false);
  const closeMode = () => setModeOpen(false);
  useDismiss(modelAnchor, modelOpen, closeModel);
  useDismiss(modeAnchor, modeOpen, closeMode);

  useEffect(() => {
    if (modelMenuSignal === 0 || modelMenuSignal === lastModelSignal.current) return;
    lastModelSignal.current = modelMenuSignal;
    setModelOpen(true);
    setModeOpen(false);
  }, [modelMenuSignal]);

  useEffect(() => {
    if (modeMenuSignal === 0 || modeMenuSignal === lastModeSignal.current) return;
    lastModeSignal.current = modeMenuSignal;
    setModeOpen(true);
    setModelOpen(false);
  }, [modeMenuSignal]);

  useEffect(() => {
    if (!running) textareaRef.current?.focus();
  }, [running]);

  useEffect(() => {
    if (focusToken === 0) return;
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    const end = value.length;
    node.setSelectionRange(end, end);
    setCaret(end);
  }, [focusToken, value.length]);

  // value is a trigger: the textarea must be measured again after each edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: remeasure on input
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [value]);

  useEffect(() => {
    const before = value.slice(0, caret);
    const slash = /^\/([a-z]*)$/.exec(before);
    if (slash) {
      const query = slash[1] ?? '';
      const items = commands
        .filter((command) => command.name.startsWith(query))
        .map((command) => ({
          value: `/${command.name}`,
          label: `/${command.name}`,
          hint: command.hint,
        }));
      setSuggest({ kind: 'command', start: 0, end: caret, items });
      setActive(0);
      return;
    }

    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at && loadFiles) {
      const query = at[2] ?? '';
      const start = caret - query.length - 1;
      let cancelled = false;
      const timer = setTimeout(() => {
        void (async () => {
          try {
            const files = await loadFiles(query);
            if (cancelled) return;
            setSuggest({
              kind: 'file',
              start,
              end: caret,
              items: files.slice(0, 8).map((file) => ({
                value: `@${file}`,
                label: file,
                hint: 'file',
              })),
            });
            setActive(0);
          } catch {
            if (!cancelled) setSuggest(null);
          }
        })();
      }, 120);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    setSuggest(null);
  }, [value, caret, commands, loadFiles]);

  const apply = (index: number) => {
    const item = suggest?.items[index];
    if (!suggest || !item) return;
    const next = `${value.slice(0, suggest.start)}${item.value} ${value.slice(suggest.end)}`;
    const position = suggest.start + item.value.length + 1;
    onChange(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  const submit = () => {
    if (!running && !disabled && value.trim() !== '') onSubmit();
  };

  const controls = init && onSetModel && onSetMode;
  const percent = maxContext > 0 ? Math.round(Math.min(used / maxContext, 1) * 100) : 0;
  const contextTitle = maxContext
    ? `${percent}% of ${maxContext.toLocaleString()} tokens · ${used.toLocaleString()} used`
    : 'Context usage unknown';

  return (
    <div className="composer-wrap">
      {suggest && suggest.items.length > 0 ? (
        <div className="suggestions" role="listbox" aria-label="Suggestions">
          <div className="suggestion-head mono">
            {suggest.kind === 'file' ? 'Files' : 'Commands'}
          </div>
          {suggest.items.map((item, index) => (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`suggestion${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                apply(index);
              }}
            >
              <span className="suggestion-label mono">{item.label}</span>
              {item.hint ? <span className="suggestion-hint">{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="composer-row">
          <span className="prompt-mark mono" aria-hidden="true">
            ›
          </span>
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            className="composer-input"
            value={value}
            rows={1}
            disabled={running || disabled}
            placeholder={disabled ? 'Open a workspace to start' : 'Ask cake to change the code…'}
            onChange={(event) => {
              onChange(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) =>
              setCaret((event.target as HTMLTextAreaElement).selectionStart ?? value.length)
            }
            onKeyDown={(event) => {
              if (suggest && suggest.items.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActive((index) => Math.min(index + 1, suggest.items.length - 1));
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActive((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  apply(active);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setSuggest(null);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="composer-toolbar">
          {controls ? (
            <div className="composer-controls">
              <div className="menu-anchor" ref={modelAnchor}>
                <button
                  type="button"
                  className="composer-chip"
                  onClick={() => {
                    setModelOpen((open) => !open);
                    setModeOpen(false);
                  }}
                  disabled={running || disabled}
                  title="Switch provider and model"
                  aria-haspopup="dialog"
                  aria-expanded={modelOpen}
                >
                  <span className="composer-chip-provider">{init.model.provider}</span>
                  <span className="composer-chip-value mono">{init.model.modelId}</span>
                  <Icon name="chevron-down" size={12} />
                </button>
                {modelOpen ? (
                  <ModelMenu init={init} onSetModel={onSetModel} onClose={closeModel} />
                ) : null}
              </div>

              <div className="menu-anchor" ref={modeAnchor}>
                <button
                  type="button"
                  className={`composer-chip mode-${init.mode}`}
                  onClick={() => {
                    setModeOpen((open) => !open);
                    setModelOpen(false);
                  }}
                  title="Switch permission mode"
                  aria-haspopup="dialog"
                  aria-expanded={modeOpen}
                >
                  <span className="mode-dot" />
                  <span>{MODE_LABEL[init.mode]}</span>
                  <Icon name="chevron-down" size={12} />
                </button>
                {modeOpen ? (
                  <ModeMenu mode={init.mode} onSetMode={onSetMode} onClose={closeMode} />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="composer-controls" />
          )}

          <div className="composer-actions">
            {init ? (
              <span className="composer-context" title={contextTitle}>
                <ContextSlice used={used} max={maxContext} running={running} size={24} />
                <span className="composer-context-value mono">{percent}%</span>
              </span>
            ) : null}
            {running ? (
              <button type="button" className="stop" data-testid="composer-stop" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="primary composer-send"
                data-testid="composer-send"
                disabled={disabled || value.trim() === ''}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </form>

      <div className="composer-hints mono">
        <span>
          <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
        </span>
        <span>
          <kbd>@</kbd> files · <kbd>/</kbd> commands
        </span>
      </div>
    </div>
  );
}
