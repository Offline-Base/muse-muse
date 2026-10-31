"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and insecure origins: copy through a hidden textarea.
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    el.remove();
    return ok;
  }
}

/** Copies a value and confirms in place. `label` is the accessible name, such as "Copy connector URL". */
export function CopyButton({
  value,
  label,
  text,
  className = "btn",
  icon = "copy",
}: {
  value: string;
  label: string;
  text?: string;
  className?: string;
  icon?: "copy" | "plug";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className={className}
      aria-label={text ? undefined : label}
      title={label}
      onClick={async () => {
        const ok = await copyText(value);
        setState(ok ? "copied" : "failed");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 2000);
      }}
    >
      <Icon name={state === "copied" ? "check" : icon} size={18} />
      {text ? <span>{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : text}</span> : null}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}

/** A read-only URL field with a copy button, for connector URLs. */
export function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="copy-field">
      <input type="text" readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} className="icon-btn" />
    </div>
  );
}
