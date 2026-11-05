import type { SVGProps } from 'react';

export type IconName =
  | 'plus'
  | 'folder'
  | 'search'
  | 'settings'
  | 'x'
  | 'pencil'
  | 'trash'
  | 'copy'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'rail'
  | 'panel'
  | 'sun'
  | 'moon'
  | 'command'
  | 'file'
  | 'terminal'
  | 'spark';

const PATHS: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-3.5-3.5',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2-1.2L15 3h-6l-.5 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5A8 8 0 0 0 4 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2 1.2L9 21h6l.5-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z',
  x: 'M6 6l12 12M18 6 6 18',
  pencil: 'M4 20h4l10-10-4-4L4 16v4Zm10-14 4 4',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v6M14 11v6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 13l4 4L19 7',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  rail: 'M4 5h16v14H4zM9 5v14',
  panel: 'M4 5h16v14H4zM15 5v14',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  command:
    'M9 6a3 3 0 1 0-3 3h3V6Zm0 0h6m0 0a3 3 0 1 1 3 3h-3V6ZM9 18a3 3 0 1 0-3-3h3v3Zm0 0h6m0 0a3 3 0 1 0 3-3h-3v3Zm0-6v-6M9 12v6',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
};

export function Icon({
  name,
  size = 16,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
