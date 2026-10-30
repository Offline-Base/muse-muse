"use client";

import { useEffect, useRef, type TextareaHTMLAttributes } from "react";
import { TextArea } from "@/components/docs/kit/Field";

/**
 * The kit's TextArea, grown to fit its text at whatever width it gets, so a long prompt never hides lines on a narrow
 * screen. `rows` is the height before the first measurement (and the minimum); the height follows the text as it
 * changes and the box as it resizes.
 */
export function AutoTextArea({ value, rows = 2, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      // scrollHeight leaves out the border; offsetHeight minus clientHeight is the border (and any scrollbar).
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);

  return <TextArea ref={ref} value={value} rows={rows} {...props} />;
}
