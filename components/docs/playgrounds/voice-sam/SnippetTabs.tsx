"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CopyButton } from "@/components/CopyButton";
import { tintCode } from "@/lib/docs/client/tint";
import type { Snippet } from "@/components/docs/playgrounds/voice-sam/voice-request";

/**
 * Code for requests the kit's CodeView can't write: a multipart call with an Accept header and a sessionId, a
 * WebSocket session, a parser loop. Drawn exactly like CodeView and the mirrored blocks (app/docs/docs.css): language
 * tabs inside the frame, the syntax label and a copy button in the header, the same syntax colors. The key is always
 * read from MODEL_API_KEY in the code itself.
 */
export function SnippetTabs({ snippets, caption, note }: { snippets: readonly Snippet[]; caption?: string; note?: string }) {
  const idBase = useId();
  const [lang, setLang] = useState(snippets[0]?.lang ?? "curl");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = snippets.find((s) => s.lang === lang) ?? snippets[0];
  const tinted = useMemo(() => (active ? tintCode(active.code, active.syntax) : []), [active]);
  if (!active) return null;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = snippets.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    setLang(snippets[next].lang);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="pg-codeview">
      {caption ? <p className="pg-codeview-caption">{caption}</p> : null}
      <div className="docs-code docs-code-grouped pg-codeview-block">
        <div className="docs-tabs" role="tablist" aria-label="Language">
          {snippets.map((s, i) => (
            <button
              key={s.lang}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${s.lang}`}
              aria-selected={s.lang === active.lang}
              aria-controls={`${idBase}-panel`}
              tabIndex={s.lang === active.lang ? 0 : -1}
              className="docs-tab"
              onClick={() => setLang(s.lang)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="docs-tab-text" data-label={s.label}>
                {s.label}
              </span>
            </button>
          ))}
        </div>
        <div className="docs-code-head">
          <span className="docs-code-label">{active.syntax}</span>
          <span className="docs-code-tools">
            <CopyButton value={active.code} label={`Copy the ${active.label} code`} className="icon-btn icon-btn-plain icon-btn-sm pg-code-copy" />
          </span>
        </div>
        <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${active.lang}`} className="docs-code-body pg-codeview-body" tabIndex={0}>
          <pre>
            <code>
              {tinted.map((t, i) =>
                t.tone ? (
                  <span key={i} className={`pg-tok pg-tok-${t.tone}`}>
                    {t.text}
                  </span>
                ) : (
                  t.text
                ),
              )}
            </code>
          </pre>
        </div>
      </div>
      <p className="pg-codeview-note">
        Set <code>MODEL_API_KEY</code> to your own Model API key before you run it.{note ? ` ${note}` : ""}
      </p>
    </div>
  );
}
