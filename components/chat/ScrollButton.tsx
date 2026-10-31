"use client";

import type { ComponentProps } from "react";
import { Icon } from "@/components/icons";

/**
 * The scroll button (docs/UI_MUSE_APP.md, "The scroll button"): a 32 px white circle with a down chevron, shown while
 * the conversation is scrolled up, centered on the column 16 px above the composer. The parent places it and scrolls.
 */
export function ScrollButton({ className, ...rest }: Omit<ComponentProps<"button">, "children" | "type" | "aria-label">) {
  return (
    <button
      type="button"
      className={`chat-scroll${className ? ` ${className}` : ""}`}
      aria-label="Jump to the newest message"
      title="Jump to the newest message"
      {...rest}
    >
      <Icon name="chevronDown" size={16} />
    </button>
  );
}
