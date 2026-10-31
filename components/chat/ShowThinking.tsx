"use client";

import { WorkingIcon } from "@/components/chat/WorkingIcon";
import { Icon } from "@/components/icons";

/**
 * A finished turn's steps folded into one row (docs/UI_MUSE_APP.md, "The finished turn"): the still working icon, "Show
 * thinking" and a small chevron. It works both ways. To open the steps panel, pass `onClick`. To unfold the steps
 * inline, as the narrow docs sidebar does, also pass `expanded` and `controls` (the id of the steps it shows): it is then
 * a disclosure button, and its chevron turns down while they're open.
 */
export function ShowThinking({ onClick, expanded, controls }: { onClick: () => void; expanded?: boolean; controls?: string }) {
  return (
    <button type="button" className="chat-thinking" onClick={onClick} aria-expanded={expanded} aria-controls={controls}>
      <WorkingIcon state="still" />
      <span className="chat-thinking-label">
        Show thinking
        <Icon name="chevronRight" size={22} className="chat-thinking-chevron" />
      </span>
    </button>
  );
}
