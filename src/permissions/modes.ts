import type { PermissionMode } from '../tools/types.js';

/** The modes cake accepts, in the order it lists them wherever it explains itself. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'plan',
  'default',
  'acceptEdits',
  'yolo',
];

/** What each mode lets through. The engine's table is `decidePermission`. */
export const MODE_BEHAVIOR: Record<PermissionMode, string> = {
  plan: 'Read-only: file reads and searches, nothing else',
  default: 'Read tools run freely; writes and shell need approval',
  acceptEdits: 'Writes run freely; shell still needs approval',
  yolo: 'Everything runs without asking',
};

/** `plan | default | acceptEdits | yolo` — the shape the flag help and refusals use. */
export const MODE_NAMES = PERMISSION_MODES.join(' | ');

/** A mode name as typed, or nothing when it is not one of the four. */
export function parsePermissionMode(value: string): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => mode === value);
}

/** The four rows cake prints wherever it explains the modes. */
export function modeHelp(): string {
  return PERMISSION_MODES.map((mode) =>
    `  ${mode.padEnd(14)}${MODE_BEHAVIOR[mode]}`.trimEnd(),
  ).join('\n');
}
