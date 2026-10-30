"use client";

import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { copyText } from "@/components/docs/page/clipboard";
import { CheckIcon, CopyIcon, PlayIcon } from "@/components/docs/page/icons";
import type { ParsedRequest } from "@/lib/docs/curl";

/** Loaded on the first Run click, so pages don't ship the API console until someone uses it. */
const RunPanel = lazy(() => import("@/components/docs/page/RunPanel"));

export interface CodeTabView {
  label: string | null;
  lang: string;
  /** Shiki's highlighted <pre>, built on the server from the code text (lib/docs/highlight.ts). */
  html: string;
}

// The tab a reader last picked ("curl", "Python (OpenAI SDK)") selects the same tab in every group on every page.
const TAB_KEY = "docs:code-tab";
const listeners = new Set<() => void>();
let preferred: string | null | undefined;

function readPreferred(): string | null {
  if (preferred === undefined) {
    try {
      preferred = window.localStorage.getItem(TAB_KEY);
    } catch {
      preferred = null;
    }
  }
  return preferred;
}

function choose(label: string) {
  preferred = label;
  try {
    window.localStorage.setItem(TAB_KEY, label);
  } catch {
    // Private mode: the choice lasts for this page view.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A fenced code block, or a tab group when the Markdown labels consecutive fences (docs/DOCS_MIRROR.md, "Content").
 * The header shows the language (or the block's label), a Run button when the block calls https://api.meta.ai/v1, and
 * one copy button that copies the visible tab. Run opens the API console under the block with that request.
 */
export function CodeGroup({ tabs, request }: { tabs: CodeTabView[]; request: ParsedRequest | null }) {
  const id = useId();
  const pref = useSyncExternalStore(subscribe, readPreferred, () => null);
  const [picked, setPicked] = useState(0);
  const prefIndex = pref ? tabs.findIndex((t) => t.label === pref) : -1;
  const active = tabs.length > 1 && prefIndex >= 0 ? prefIndex : picked;
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const grouped = tabs.length > 1;
  const tab = tabs[active] ?? tabs[0];
  const headLabel = grouped ? tab.lang || "text" : tab.label ?? (tab.lang || "text");

  const select = (i: number) => {
    setPicked(i);
    const label = tabs[i]?.label;
    if (label) choose(label);
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    select(next);
    tabRefs.current[next]?.focus();
  };

  const copy = async () => {
    const text = panels.current[active]?.querySelector("code")?.textContent ?? "";
    const ok = await copyText(text);
    setCopied(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied("idle"), 2000);
  };

  return (
    <div className={grouped ? "docs-code docs-code-grouped" : "docs-code"}>
      {grouped ? (
        <div className="docs-tabs" role="tablist" aria-label="Code examples">
          {tabs.map((t, i) => (
            <button
              key={i}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${id}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              className="docs-tab"
              onClick={() => select(i)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className="docs-tab-text" data-label={t.label ?? (t.lang || "text")}>
                {t.label ?? (t.lang || "text")}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="docs-code-head">
        <span className="docs-code-label">{headLabel}</span>
        <span className="docs-code-tools">
          {request ? (
            // A quiet toggle: the open console has its own Close, so the pill keeps saying Run and shows it's pressed.
            <button
              type="button"
              className={running ? "docs-run-btn is-open" : "docs-run-btn"}
              aria-expanded={running}
              onClick={() => setRunning((v) => !v)}
              title={running ? "Hide the live console" : `Send this request live: ${request.method} /v1/${request.path}`}
            >
              <PlayIcon size={11} />
              <span>Run</span>
            </button>
          ) : null}
          <button type="button" className="docs-copy-btn" onClick={copy} aria-label="Copy code" title="Copy code">
            {copied === "copied" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            <span className="sr-only" aria-live="polite">
              {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : ""}
            </span>
          </button>
        </span>
      </div>
      {tabs.map((t, i) => (
        <div
          key={i}
          ref={(el) => {
            panels.current[i] = el;
          }}
          id={grouped ? `${id}-panel-${i}` : undefined}
          role={grouped ? "tabpanel" : "group"}
          aria-labelledby={grouped ? `${id}-tab-${i}` : undefined}
          aria-label={grouped ? undefined : headLabel}
          hidden={i !== active}
          className="docs-code-body"
          dangerouslySetInnerHTML={{ __html: t.html }}
        />
      ))}
      {running && request ? (
        <Suspense fallback={<div className="docs-run docs-run-loading">Opening the live console...</div>}>
          <RunPanel request={request} onClose={() => setRunning(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
