import type { ReactNode } from "react";

/**
 * What a turn made (docs/UI_MUSE_APP.md, "The finished turn", "Output"): an image, a video or a live preview at the
 * column's full width, with about 24 px rounded corners. It keeps the media's own aspect ratio, or `ratio` for media
 * without one, such as an iframe. `label` is a small caption that shows at its top-right corner on hover and focus.
 */
export function MediaCard({ children, label, ratio }: { children: ReactNode; label?: string; ratio?: string }) {
  return (
    <figure className="chat-media">
      <div className={`chat-media-frame${ratio ? " has-ratio" : ""}`} style={ratio ? { aspectRatio: ratio } : undefined}>
        {children}
      </div>
      {label ? <figcaption className="chat-media-label">{label}</figcaption> : null}
    </figure>
  );
}
