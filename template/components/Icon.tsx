import type { ReactNode } from "react";

/**
 * Outlined icons drawn for Muse Muse products on a 24 px grid with a 20 px live area and round strokes, in the
 * style of Meta's outlined app icons. They take the text color (currentColor). Use 20 in buttons and rows, 16 in
 * chips, 24 in icon circles. Decorative by default; pass `label` when the icon is the only thing that says what a
 * control does and the control has no aria-label of its own. Every icon carries its name in data-icon, which verify
 * reads to check that a button's icon fits its verb (meta-ui M3). A -filled icon is the "on" state of its outline,
 * like heart-filled on a favorite button with aria-pressed="true".
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
  print: (
    <>
      <path d="M7 8.25v-3.5A1.25 1.25 0 0 1 8.25 3.5h7.5A1.25 1.25 0 0 1 17 4.75v3.5" />
      <path d="M7 17H5.25A1.75 1.75 0 0 1 3.5 15.25V10a1.75 1.75 0 0 1 1.75-1.75h13.5A1.75 1.75 0 0 1 20.5 10v5.25A1.75 1.75 0 0 1 18.75 17H17" />
      <rect x="7" y="13.5" width="10" height="7" rx="1.25" />
      <path d="M16.9 11.5h.1" />
    </>
  ),
  share: (
    <>
      <circle cx="17.5" cy="5.75" r="2.5" />
      <circle cx="6.5" cy="12" r="2.5" />
      <circle cx="17.5" cy="18.25" r="2.5" />
      <path d="m8.67 10.77 6.66-3.79" />
      <path d="m8.67 13.23 6.66 3.79" />
    </>
  ),
  heart: <path d="M12 20.25 4.5 12.75A5.3 5.3 0 0 1 12 5.25a5.3 5.3 0 0 1 7.5 7.5Z" />,
  "heart-filled": <path d="M12 20.25 4.5 12.75A5.3 5.3 0 0 1 12 5.25a5.3 5.3 0 0 1 7.5 7.5Z" fill="currentColor" />,
  star: <path d="M12 3.35 14.53 9.12 20.8 9.74 16.09 13.93 17.44 20.08 12 16.9 6.56 20.08 7.91 13.93 3.2 9.74 9.47 9.12Z" />,
  "star-filled": (
    <path d="M12 3.35 14.53 9.12 20.8 9.74 16.09 13.93 17.44 20.08 12 16.9 6.56 20.08 7.91 13.93 3.2 9.74 9.47 9.12Z" fill="currentColor" />
  ),
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="m11 7 1.5-1.5a3.9 3.9 0 0 1 5.5 5.5l-1.5 1.5" />
      <path d="m13 17-1.5 1.5a3.9 3.9 0 0 1-5.5-5.5L7.5 11.5" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  undo: (
    <>
      <path d="M9 13.75 4.5 9.25 9 4.75" />
      <path d="M4.5 9.25h10a5 5 0 0 1 0 10H11" />
    </>
  ),
  settings: (
    <>
      <path d="M10.43 5.18 10.71 2.84A9.25 9.25 0 0 1 13.29 2.84L13.57 5.18A7 7 0 0 1 15.71 6.06L17.57 4.61A9.25 9.25 0 0 1 19.39 6.43L17.94 8.29A7 7 0 0 1 18.82 10.43L21.16 10.71A9.25 9.25 0 0 1 21.16 13.29L18.82 13.57A7 7 0 0 1 17.94 15.71L19.39 17.57A9.25 9.25 0 0 1 17.57 19.39L15.71 17.94A7 7 0 0 1 13.57 18.82L13.29 21.16A9.25 9.25 0 0 1 10.71 21.16L10.43 18.82A7 7 0 0 1 8.29 17.94L6.43 19.39A9.25 9.25 0 0 1 4.61 17.57L6.06 15.71A7 7 0 0 1 5.18 13.57L2.84 13.29A9.25 9.25 0 0 1 2.84 10.71L5.18 10.43A7 7 0 0 1 6.06 8.29L4.61 6.43A9.25 9.25 0 0 1 6.43 4.61L8.29 6.06A7 7 0 0 1 10.43 5.18Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eye: (
    <>
      <path d="M2.75 12C4.6 8.2 8 5.75 12 5.75s7.4 2.45 9.25 6.25c-1.85 3.8-5.25 6.25-9.25 6.25S4.6 15.8 2.75 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  filter: <path d="M3.75 4.5h16.5L14 12v5.5l-4 2V12Z" />,
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
      data-icon={name}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
