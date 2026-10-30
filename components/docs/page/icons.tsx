import type { SVGProps } from "react";

/**
 * Icons the docs pages and the docs sidebar draw: outline glyphs on a 24 px grid like components/icons.tsx, plus the
 * filled callout badges dev.meta.ai uses (a solid circle with a white mark). Decorative: aria-hidden, currentColor.
 */

type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, "children">;

function Outline({ size = 20, d, ...rest }: IconProps & { d: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => <Outline {...p} d="M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4.5-4.5" />;
export const HomeIcon = (p: IconProps) => (
  <Outline {...p} d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-3.5v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19v-8.5z" />
);
export const ArrowUpRightIcon = (p: IconProps) => <Outline {...p} d="M7 17L17 7 M8.5 7H17v8.5" />;
export const ChevronDownIcon = (p: IconProps) => <Outline {...p} d="M6 9.5l6 6 6-6" />;
export const ChevronRightIcon = (p: IconProps) => <Outline {...p} d="M9.5 6l6 6-6 6" />;
export const ChevronLeftIcon = (p: IconProps) => <Outline {...p} d="M14.5 6l-6 6 6 6" />;
export const LinkIcon = (p: IconProps) => (
  <Outline
    {...p}
    d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"
  />
);
export const CopyIcon = (p: IconProps) => (
  <Outline {...p} d="M9 9h10.5v10.5H9z M15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9" />
);
export const CheckIcon = (p: IconProps) => <Outline {...p} d="M5 12.5l4.5 4.5L19 7.5" />;
export const CloseIcon = (p: IconProps) => <Outline {...p} d="M6 6l12 12 M18 6L6 18" />;
export const ExternalIcon = (p: IconProps) => (
  <Outline {...p} d="M14 4h6v6 M20 4l-9 9 M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
);
export const DocIcon = (p: IconProps) => (
  <Outline {...p} d="M7 3.5h10A1.5 1.5 0 0 1 18.5 5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z M9 8h6 M9 11.5h6 M9 15h3.5" />
);
export const HashIcon = (p: IconProps) => <Outline {...p} d="M5 9h14 M4 15h14 M10 4L8 20 M16 4l-2 16" />;
export const SparkIcon = (p: IconProps) => (
  <Outline {...p} d="M12 3.5l1.6 4.6a3 3 0 0 0 1.8 1.8l4.6 1.6-4.6 1.6a3 3 0 0 0-1.8 1.8L12 19.5l-1.6-4.6a3 3 0 0 0-1.8-1.8L4 11.5l4.6-1.6a3 3 0 0 0 1.8-1.8L12 3.5z" />
);
export const ChatIcon = (p: IconProps) => (
  <Outline {...p} d="M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" />
);
export const UploadIcon = (p: IconProps) => <Outline {...p} d="M12 16V4.5 M7 9.5l5-5 5 5 M5 19.5h14" />;
/** An open book: the cookbook's recipe tiles. */
export const BookIcon = (p: IconProps) => (
  <Outline {...p} d="M12 6.8C10.2 5.4 7.6 4.8 4 5v12.6c3.6-.2 6.2.4 8 1.8 1.8-1.4 4.4-2 8-1.8V5c-3.6-.2-6.2.4-8 1.8z M12 6.8v12.6" />
);

/** A filled triangle: the Run button's play glyph. */
export function PlayIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden focusable="false" {...rest}>
      <path fill="currentColor" d="M3 1.8v8.4c0 .5.5.8.9.5l6.3-4.2c.4-.2.4-.8 0-1L3.9 1.3c-.4-.3-.9 0-.9.5z" />
    </svg>
  );
}

/** The solid badge at the start of a callout: info for NOTE, a bulb for TIP, ! for WARNING, IMPORTANT and CAUTION. */
export function CalloutIcon({ kind, size = 20 }: { kind: "note" | "tip" | "warning" | "important" | "caution"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden focusable="false">
      {kind === "warning" ? (
        <path fill="currentColor" d="M8.6 2.8a1.6 1.6 0 0 1 2.8 0l6.9 12a1.6 1.6 0 0 1-1.4 2.4H3.1a1.6 1.6 0 0 1-1.4-2.4l6.9-12z" />
      ) : kind === "caution" ? (
        <path fill="currentColor" d="M6.9 1.5h6.2l4.4 4.4v6.2l-4.4 4.4H6.9l-4.4-4.4V5.9z" />
      ) : (
        <circle cx="10" cy="10" r="8.5" fill="currentColor" />
      )}
      {kind === "note" ? (
        <path fill="#fff" d="M9.1 8.6h1.8v5.6H9.1z M10 5.3a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z" />
      ) : kind === "tip" ? (
        <path
          fill="#fff"
          d="M10 4.6a3.6 3.6 0 0 0-2.2 6.5c.4.3.6.7.6 1.2v.4h3.2v-.4c0-.5.2-.9.6-1.2A3.6 3.6 0 0 0 10 4.6z M8.4 13.8h3.2v.7a1 1 0 0 1-1 1h-1.2a1 1 0 0 1-1-1z"
        />
      ) : (
        <path fill="#fff" d={kind === "warning" ? "M9.1 6.8h1.8l-.2 5.2H9.3z M10 13.2a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" : "M9.1 5.2h1.8l-.2 6H9.3z M10 12.6a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z"} />
      )}
    </svg>
  );
}
