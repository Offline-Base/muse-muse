"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VoiceInputButton, type DictationField } from "@/components/voice/VoiceInputButton";
import { looksLikeData, offersVoice } from "@/lib/client/dictation";

/** How long the mic stays after the pointer leaves, so the reader can reach it. */
const LINGER_MS = 220;

function isEligible(el: Element | null): el is DictationField {
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return false;
  return offersVoice({
    tag: el.tagName.toLowerCase(),
    type: el instanceof HTMLInputElement ? el.type : "textarea",
    names: [el.name, el.id, el.getAttribute("aria-label"), el.labels?.[0]?.innerText, el.placeholder].filter(Boolean).join(" "),
    autocomplete: el.getAttribute("autocomplete") ?? "",
    className: el.className,
    readOnly: el.readOnly,
    disabled: el.disabled,
    noSpellcheck: el.getAttribute("spellcheck") === "false",
    voice: el.dataset.voice ?? null,
    looksLikeData: looksLikeData(el.placeholder) || looksLikeData(el.value),
    width: el.getBoundingClientRect().width,
  });
}

/**
 * Voice input for every text field on the platform, without each form having to add it: the demos alone have over a
 * hundred. One mic follows the field the reader is pointing at or typing in, inside its top right corner. Fields with
 * a button of their own set data-voice="inline", and offersVoice leaves out secrets and exact values. Inside a modal
 * dialog the mic mounts in the dialog, since nothing else can draw above it.
 */
export function VoiceInputLayer() {
  const [field, setField] = useState<DictationField | null>(null);
  const current = useRef<DictationField | null>(null);
  const busy = useRef(false);
  const hover = useRef<DictationField | null>(null);
  const overMic = useRef(false);
  const linger = useRef<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const decide = useCallback(() => {
    if (busy.current) return;
    if (linger.current !== null) window.clearTimeout(linger.current);
    const focused = document.activeElement;
    const next = hover.current ?? (isEligible(focused) ? focused : null);
    const apply = (value: DictationField | null) => {
      current.current = value;
      setField(value);
    };
    if (next) apply(next);
    else if (!overMic.current) linger.current = window.setTimeout(() => !busy.current && !overMic.current && apply(null), LINGER_MS);
  }, []);

  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = e.target instanceof Element ? e.target : null;
      overMic.current = Boolean(el?.closest(".voice-layer"));
      hover.current = isEligible(el) ? el : null;
      decide();
    };
    window.addEventListener("pointerover", onOver, true);
    window.addEventListener("focusin", decide, true);
    window.addEventListener("focusout", decide, true);
    return () => {
      window.removeEventListener("pointerover", onOver, true);
      window.removeEventListener("focusin", decide, true);
      window.removeEventListener("focusout", decide, true);
      if (linger.current !== null) window.clearTimeout(linger.current);
    };
  }, [decide]);

  // Follows the field through scrolling and layout changes while it's showing.
  useEffect(() => {
    if (!field) return;
    let frame = 0;
    const place = () => {
      const el = wrap.current;
      if (el && field.isConnected) {
        const r = field.getBoundingClientRect();
        const multiline = field instanceof HTMLTextAreaElement && r.height > 56;
        el.style.transform = `translate(${Math.round(r.right - el.offsetWidth - 4)}px, ${Math.round(multiline ? r.top + 4 : r.top + (r.height - el.offsetHeight) / 2)}px)`;
        el.style.visibility = r.width && r.bottom > 0 && r.top < window.innerHeight ? "visible" : "hidden";
      } else if (!field.isConnected && !busy.current) {
        hover.current = null;
        current.current = null;
        setField(null);
        return;
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [field]);

  const target = useCallback(() => current.current, []);
  const onBusyChange = useCallback(
    (next: boolean) => {
      busy.current = next;
      if (!next) decide();
    },
    [decide],
  );

  if (!field) return null;
  return createPortal(
    <div ref={wrap} className="voice-layer">
      <VoiceInputButton target={target} size={16} onBusyChange={onBusyChange} />
    </div>,
    field.closest("dialog") ?? document.body,
  );
}
