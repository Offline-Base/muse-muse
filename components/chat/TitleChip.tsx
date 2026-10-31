import type { ReactNode } from "react";

/**
 * The conversation's title in a white pill with a soft shadow (docs/UI_MUSE_APP.md, "The title chip"): the product or
 * build name, floating at the top left. Long names end in an ellipsis. `as` picks the element, so it can be the page's
 * heading.
 */
export function TitleChip({ children, as: Tag = "p" }: { children: ReactNode; as?: "h1" | "h2" | "p" }) {
  return <Tag className="chat-title-chip">{children}</Tag>;
}
