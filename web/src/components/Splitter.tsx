import { type PointerEvent, useRef } from 'react';

export type SplitterEdge = 'rail' | 'inspector';

const STEP = 16;

/**
 * A draggable pane edge. Pointer, keyboard and double-click all reach the same
 * resize callback so the width never drifts between input methods.
 */
export function Splitter({
  edge,
  value,
  min,
  max,
  label,
  onResize,
  onReset,
}: {
  edge: SplitterEdge;
  value: number;
  min: number;
  max: number;
  label: string;
  onResize: (next: number) => void;
  onReset: () => void;
}) {
  const anchor = useRef<{ x: number; width: number } | null>(null);

  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  // Dragging away from the stage widens the rail; the inspector widens leftwards.
  const widthFor = (event: PointerEvent) => {
    if (!anchor.current) return value;
    const delta = event.clientX - anchor.current.x;
    return clamp(anchor.current.width + (edge === 'rail' ? delta : -delta));
  };

  return (
    <hr
      className={`splitter is-${edge}`}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        anchor.current = { x: event.clientX, width: value };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing');
      }}
      onPointerMove={(event) => {
        if (!anchor.current) return;
        onResize(widthFor(event));
      }}
      onPointerUp={(event) => {
        anchor.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove('is-resizing');
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const direction = event.key === 'ArrowLeft' ? -1 : 1;
          const sign = edge === 'rail' ? direction : -direction;
          onResize(clamp(value + sign * STEP));
        } else if (event.key === 'Home') {
          event.preventDefault();
          onReset();
        }
      }}
    />
  );
}
