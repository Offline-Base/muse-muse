"use client";

import type { ComponentProps } from "react";
import { Icon, type IconName } from "@/components/icons";

/**
 * A 36 px white circle with a soft shadow and a 16 px glyph in the text color (docs/UI_MUSE_APP.md, "The top-right
 * buttons"), such as share and more over a conversation. Icon only, so `label` is required: it names the button for
 * screen readers and shows as its tooltip.
 */
export function FloatButton({
  icon,
  label,
  className,
  ...rest
}: { icon: IconName; label: string } & Omit<ComponentProps<"button">, "children" | "type" | "aria-label">) {
  return (
    <button type="button" className={`chat-float${className ? ` ${className}` : ""}`} aria-label={label} title={label} {...rest}>
      {/* A 20 px box draws about a 16 px glyph. "More" is three round stroke ends, so it takes a wider stroke to read. */}
      <Icon name={icon} size={20} strokeWidth={icon === "more" ? 3 : 1.75} />
    </button>
  );
}
