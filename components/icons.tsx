import type { SVGProps } from "react";

/**
 * Inline outline icons: 24 px grid, 1.5 px stroke, round caps and joins, currentColor. Decorative by default
 * (aria-hidden); pass `title` to make one meaningful on its own.
 */
const PATHS = {
  sparkle:
    "M12 3.5l1.6 4.6a3 3 0 0 0 1.8 1.8l4.6 1.6-4.6 1.6a3 3 0 0 0-1.8 1.8L12 19.5l-1.6-4.6a3 3 0 0 0-1.8-1.8L4 11.5l4.6-1.6a3 3 0 0 0 1.8-1.8L12 3.5z M19 3v3 M20.5 4.5h-3",
  layers: "M12 3.5l8.5 4.5-8.5 4.5L3.5 8 12 3.5z M3.5 12l8.5 4.5 8.5-4.5 M3.5 16l8.5 4.5 8.5-4.5",
  rebuild: "M20 11a8 8 0 0 0-14.3-4.9L4 8 M4 4v4h4 M4 13a8 8 0 0 0 14.3 4.9L20 16 M20 20v-4h-4",
  grid: "M4 4h6.5v6.5H4z M13.5 4H20v6.5h-6.5z M4 13.5h6.5V20H4z M13.5 13.5H20V20h-6.5z",
  chart: "M4 20h16 M7 16v-5 M11.5 16V7 M16 16v-8",
  book: "M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2z M12 6.5v13",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10",
  plus: "M12 5v14 M5 12h14",
  arrowUp: "M12 19V5 M6 11l6-6 6 6",
  arrowDown: "M12 5v14 M6 13l6 6 6-6",
  close: "M6 6l12 12 M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  checkCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8.5 12.5l2.5 2.5 4.5-5",
  alert: "M12 8v5 M12 16.5v.01 M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  alertCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.5v5.5 M12 16.5v.01",
  stopCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.75 9.75h4.5v4.5h-4.5z",
  chevronDown: "M6 9.5l6 6 6-6",
  chevronLeft: "M14.5 6l-6 6 6 6",
  chevronRight: "M9.5 6l6 6-6 6",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  more: "M5.5 12h.01 M12 12h.01 M18.5 12h.01",
  copy: "M9 9h10.5v10.5H9z M15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9",
  image:
    "M4.5 5h15a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5z M4 16l4.5-4.5L13 16 M13 14l2.5-2.5L20 16 M15.5 8.5h.01",
  camera: "M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z M12 16.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z",
  film: "M4 5h16v14H4z M8 5v14 M16 5v14 M4 9h4 M4 15h4 M16 9h4 M16 15h4",
  mic: "M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z M5.5 11.5a6.5 6.5 0 0 0 13 0 M12 18v2.5",
  file: "M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5z M14 3.5V8h4.5 M9 13h6 M9 16.5h6",
  play: "M8 5.5v13l10.5-6.5L8 5.5z",
  download: "M12 4v11 M7 10.5l5 5 5-5 M5 19.5h14",
  calendar: "M5 6h14v14H5z M5 10h14 M9 4v4 M15 4v4",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5.5 M12 7.5v.01",
  history: "M4 12a8 8 0 1 0 2.4-5.7L4 8.5 M4 4.5v4h4 M12 8v4.5l3 2",
  plug: "M9 3.5V8 M15 3.5V8 M6.5 8h11v3a5.5 5.5 0 0 1-11 0V8z M12 16.5v4",
  monitor: "M3.5 5h17v11h-17z M9 20h6 M12 16v4",
  logout: "M14 4.5h4.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H14 M10 16.5L5.5 12 10 7.5 M5.5 12H15",
  terminal: "M4 5h16v14H4z M8 10l3 2.5L8 15 M13 15h3.5",
  clipboard: "M9 4.5h6v3H9z M9 6H6.5v14h11V6H15 M9 13.5l2 2 4-4",
  rocket:
    "M13.5 4.5c3-1 5.5-1 6 0 1 .5 1 3 0 6l-5 5-6-6 5-5z M8.5 9.5l-4 .5L3 12.5l4.5 1 M14.5 15.5l-.5 4-2.5 1.5-1-4.5 M6.5 15.5l-2 4 4-2 M15.5 8.5h.01",
  brief: "M6 3.5h9l3.5 3.5v13.5H6z M14.5 3.5V7.5h4 M9 11h6.5 M9 14h6.5 M9 17h4",
  video: "M4 6.5h11v11H4z M15 10.5l5-3v9l-5-3",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  share: "M20.5 3.5L10.6 13.4 M20.5 3.5l-6.3 17-3.6-7.1-7.1-3.6 17-6.3z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20a7.5 7.5 0 0 1 15 0",
  power: "M12 3.5v8 M7 6.2a7.5 7.5 0 1 0 10 0",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9 M19.5 4.5V9H15",
  dashboard:
    "M6 4.5h2.5A1.5 1.5 0 0 1 10 6v2.5A1.5 1.5 0 0 1 8.5 10H6A1.5 1.5 0 0 1 4.5 8.5V6A1.5 1.5 0 0 1 6 4.5z M15.5 4.5H18A1.5 1.5 0 0 1 19.5 6v2.5A1.5 1.5 0 0 1 18 10h-2.5A1.5 1.5 0 0 1 14 8.5V6a1.5 1.5 0 0 1 1.5-1.5z M6 14h2.5a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18v-2.5A1.5 1.5 0 0 1 6 14z M15.5 14H18a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5h-2.5A1.5 1.5 0 0 1 14 18v-2.5a1.5 1.5 0 0 1 1.5-1.5z",
  usage:
    "M12 20.5a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17z M12 12.5l3.5-3.5 M7 12.5h1.5 M15.5 12.5H17 M12 7v1.5 M8.3 8.8l1 1",
  doc: "M7 3.5h10A1.5 1.5 0 0 1 18.5 5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z M9 8h6 M9 11.5h6 M9 15h3.5",
  edit: "M19 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5h5 M17.3 3.9a1.8 1.8 0 0 1 2.6 2.6L13 13.4l-3.4.9.9-3.4 6.8-7z",
  code: "M8.5 7.5L4 12l4.5 4.5 M15.5 7.5L20 12l-4.5 4.5 M13.5 5l-3 14",
  tune: "M4 7h8.5 M17.5 7H20 M15 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z M4 17h2.5 M11.5 17H20 M9 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  title,
  ...rest
}: { name: IconName; size?: number; title?: string } & Omit<SVGProps<SVGSVGElement>, "children">) {
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
