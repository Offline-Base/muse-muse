import type { ReactNode } from "react";

/**
 * Outlined icons drawn for Muse Muse products on a 24 px grid with a 20 px live area and round strokes, in the
 * style of Meta's outlined app icons. They take the text color (currentColor). Use 20 in buttons and rows, 16 in
 * chips, 24 in icon circles. Decorative by default; pass `label` when the icon is the only thing that says what a
 * control does and the control has no aria-label of its own.
 */
const PATHS = {
  upload: (
    <>
      <path d="M12 15.5V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
    </>
  ),
  camera: (
    <>
      <path d="M4.75 7.5h2.4l1.35-2.03A1.5 1.5 0 0 1 9.75 4.8h4.5a1.5 1.5 0 0 1 1.25.67l1.35 2.03h2.4a1.75 1.75 0 0 1 1.75 1.75v8.5A1.75 1.75 0 0 1 19.25 19.5H4.75A1.75 1.75 0 0 1 3 17.75v-8.5A1.75 1.75 0 0 1 4.75 7.5Z" />
      <circle cx="12" cy="13.25" r="3.4" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.75" />
      <circle cx="8.75" cy="9.75" r="1.6" />
      <path d="m3.6 17.2 4.65-4.45a1.4 1.4 0 0 1 1.95.03l2.3 2.32" />
      <path d="m11.4 16.2 2.95-2.9a1.4 1.4 0 0 1 1.96 0L20.6 17.5" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3.25H7.25A2.25 2.25 0 0 0 5 5.5v13a2.25 2.25 0 0 0 2.25 2.25h9.5A2.25 2.25 0 0 0 19 18.5V8.75Z" />
      <path d="M13.5 3.25v3.5a2 2 0 0 0 2 2H19" />
      <path d="M8.75 13h6.5" />
      <path d="M8.75 16.5h4" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3.25" width="6" height="11" rx="3" />
      <path d="M5.75 11a6.25 6.25 0 0 0 12.5 0" />
      <path d="M12 17.25v3.5" />
      <path d="M9 20.75h6" />
    </>
  ),
  sparkle: (
    <>
      <path d="M10.5 3.75c.55 3.9 3 6.35 6.9 6.9-3.9.55-6.35 3-6.9 6.9-.55-3.9-3-6.35-6.9-6.9 3.9-.55 6.35-3 6.9-6.9Z" />
      <path d="M18 14.75c.25 1.65 1.1 2.5 2.75 2.75-1.65.25-2.5 1.1-2.75 2.75-.25-1.65-1.1-2.5-2.75-2.75 1.65-.25 2.5-1.1 2.75-2.75Z" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.25" />,
  alert: (
    <>
      <path d="M10.27 4.5 2.98 17.25A2 2 0 0 0 4.72 20.25h14.56a2 2 0 0 0 1.74-3L13.73 4.5a2 2 0 0 0-3.46 0Z" />
      <path d="M12 9.5v4.25" />
      <path d="M12 16.9v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 11v5.25" />
      <path d="M12 7.75v.1" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11.75" height="11.75" rx="2.5" />
      <path d="M15.5 8.5V6.25a2.5 2.5 0 0 0-2.5-2.5H6.25a2.5 2.5 0 0 0-2.5 2.5V13a2.5 2.5 0 0 0 2.5 2.5H8.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5v11" />
      <path d="m7.5 11 4.5 4.5 4.5-4.5" />
      <path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.25 12a7.25 7.25 0 1 1-2.12-5.13" />
      <path d="M19.5 4.25v4.5H15" />
    </>
  ),
  "arrow-right": (
    <>
      <path d="M4.75 12h14.5" />
      <path d="m13.25 6 6 6-6 6" />
    </>
  ),
  "chevron-left": <path d="M14.75 6.5 9.25 12l5.5 5.5" />,
  "chevron-right": <path d="m9.25 6.5 5.5 5.5-5.5 5.5" />,
  "chevron-down": <path d="m6.5 9.25 5.5 5.5 5.5-5.5" />,
  close: (
    <>
      <path d="M6.25 6.25 17.75 17.75" />
      <path d="M17.75 6.25 6.25 17.75" />
    </>
  ),
  play: <path d="M8 5.6v12.8a1.1 1.1 0 0 0 1.68.94l10.1-6.4a1.1 1.1 0 0 0 0-1.88l-10.1-6.4A1.1 1.1 0 0 0 8 5.6Z" />,
  stop: <rect x="6.25" y="6.25" width="11.5" height="11.5" rx="2.25" />,
  send: (
    <>
      <path d="M4.6 12 3.35 5.4a1 1 0 0 1 1.4-1.08l15.4 6.76a1 1 0 0 1 0 1.84l-15.4 6.76a1 1 0 0 1-1.4-1.08Z" />
      <path d="M4.6 12h6.65" />
    </>
  ),
  search: (
    <>
      <circle cx="10.75" cy="10.75" r="6.5" />
      <path d="m15.6 15.6 4.65 4.65" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  edit: (
    <>
      <path d="M4.75 15.5v3.75H8.5L18.66 9.09a2.65 2.65 0 0 0-3.75-3.75Z" />
      <path d="m13.4 6.85 3.75 3.75" />
    </>
  ),
  external: (
    <>
      <path d="M13.75 4.75h5.5v5.5" />
      <path d="M19.25 4.75 11 13" />
      <path d="M17.25 13.5v3.75a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2v-8.5a2 2 0 0 1 2-2h3.75" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.75" y="5.25" width="16.5" height="15" rx="2.75" />
      <path d="M3.75 10h16.5" />
      <path d="M8 3.25v4" />
      <path d="M16 3.25v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  trash: (
    <>
      <path d="M4.25 6.75h15.5" />
      <path d="M9.25 6.75V5a1.25 1.25 0 0 1 1.25-1.25h3A1.25 1.25 0 0 1 14.75 5v1.75" />
      <path d="m6.25 6.75.85 12.05A2 2 0 0 0 9.1 20.75h5.8a2 2 0 0 0 2-1.95l.85-12.05" />
      <path d="M10.25 10.75v6" />
      <path d="M13.75 10.75v6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 20, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={size <= 18 ? 2 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
