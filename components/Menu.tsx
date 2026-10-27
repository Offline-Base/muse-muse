"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";

/**
 * A button that opens a small popover of links or buttons (the disclosure pattern). Closes on outside click, on
 * Escape (returning focus to the button) and when a link inside is followed.
 */
export function Menu({
  text,
  label,
  icon,
  children,
  align = "end",
  disabled,
  buttonClassName = "btn",
}: {
  text?: string;
  label: string;
  icon?: IconName;
  children: ReactNode;
  align?: "start" | "end";
  disabled?: boolean;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={buttonClassName}
        aria-expanded={open}
        aria-controls={id}
        aria-label={text ? undefined : label}
        title={text ? undefined : label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {icon ? <Icon name={icon} size={18} /> : null}
        {text ? <span>{text}</span> : null}
        {text ? <Icon name="chevronDown" size={16} className="btn-chevron" /> : null}
      </button>
      <div
        id={id}
        className={`menu menu-${align}`}
        hidden={!open}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
