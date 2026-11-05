import { type RefObject, useEffect, useState } from 'react';
import type {
  InitPayload,
  ModelHandle,
  PermissionModeName,
  ProviderSummary,
} from '../../../src/desktop/api.js';
import { Icon } from './Icons';

export const MODES: Array<{ id: PermissionModeName; label: string; hint: string }> = [
  { id: 'plan', label: 'Plan', hint: 'Reads and searches only; no writes or shell.' },
  { id: 'default', label: 'Default', hint: 'Reads run freely; writes and shell ask first.' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Writes run freely; shell still asks.' },
  { id: 'yolo', label: 'YOLO', hint: 'Every tool call runs without asking.' },
];

export const MODE_LABEL: Record<PermissionModeName, string> = {
  plan: 'plan',
  default: 'default',
  acceptEdits: 'accept edits',
  yolo: 'yolo',
};

function keyEnv(providerId: string): string {
  return `${providerId.toUpperCase()}_API_KEY`;
}

export function useDismiss(
  ref: RefObject<HTMLDivElement | null>,
  open: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}

export function ModelMenu({
  init,
  onSetModel,
  onClose,
}: {
  init: InitPayload;
  onSetModel: (model: ModelHandle) => void;
  onClose: () => void;
}) {
  const [providerId, setProviderId] = useState(init.model.provider);
  const [modelId, setModelId] = useState(init.model.modelId);
  const provider = init.providers.find((item) => item.id === providerId);

  const apply = () => {
    const value = modelId.trim();
    if (!value) return;
    onSetModel({ provider: providerId, modelId: value });
    onClose();
  };

  return (
    <div className="popover popover-up model-menu" role="dialog" aria-label="Choose model">
      <div className="popover-heading">Model</div>
      <div className="popover-label">Provider</div>
      <div className="provider-list">
        {init.providers.map((item: ProviderSummary) => (
          <button
            key={item.id}
            type="button"
            className={`provider-option${item.id === providerId ? ' is-selected' : ''}`}
            onClick={() => {
              setProviderId(item.id);
              setModelId(item.defaultModelId);
            }}
          >
            <span className={`status-dot${item.hasKey ? ' is-live' : ' is-missing'}`} />
            <span className="provider-copy">
              <span className="provider-name">{item.label}</span>
              <span className="provider-model mono">{item.defaultModelId}</span>
            </span>
            {item.hasKey ? null : <span className="provider-warning mono">no key</span>}
          </button>
        ))}
      </div>

      <label className="popover-label" htmlFor="model-id-input">
        Model id
      </label>
      <input
        id="model-id-input"
        className="model-input mono"
        value={modelId}
        onChange={(event) => setModelId(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply();
          }
        }}
        spellCheck={false}
        autoComplete="off"
      />
      <p className="popover-hint mono">
        {provider
          ? `context ${provider.maxContext.toLocaleString()} · ${
              provider.hasKey ? 'key ready' : `set ${keyEnv(provider.id)}`
            }`
          : 'Unknown provider'}
      </p>
      <button
        type="button"
        className="primary popover-submit"
        onClick={apply}
        disabled={!modelId.trim()}
      >
        Use model
      </button>
    </div>
  );
}

export function ModeMenu({
  mode,
  onSetMode,
  onClose,
}: {
  mode: PermissionModeName;
  onSetMode: (mode: PermissionModeName) => void;
  onClose: () => void;
}) {
  return (
    <div className="popover popover-up mode-menu" role="dialog" aria-label="Choose permission mode">
      <div className="popover-heading">Permission mode</div>
      {MODES.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`mode-option mode-${item.id}${item.id === mode ? ' is-selected' : ''}`}
          onClick={() => {
            onSetMode(item.id);
            onClose();
          }}
        >
          <span className="mode-option-copy">
            <span className="mode-option-name">{item.label}</span>
            <span className="mode-option-hint">{item.hint}</span>
          </span>
          {item.id === mode ? <Icon name="check" size={14} /> : null}
        </button>
      ))}
    </div>
  );
}
