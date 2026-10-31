"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useDocsPage, type DocsPageInfo } from "@/components/docs/kit/DocsPageContext";
import { Icon } from "@/components/icons";
import { copyText } from "@/components/docs/page/clipboard";
import { CheckIcon, ChevronDownIcon, CopyIcon, ExternalIcon, SparkIcon } from "@/components/docs/page/icons";
import { DISCLAIMER } from "@/components/shell/disclaimer";
import { buildAgentPrompt, CODING_AGENTS, PROMPT_LANGUAGES, type CodingAgent } from "@/lib/docs/agent-prompt";
import type { AgentPromptSpec, PromptLanguage } from "@/lib/docs/demos/types";

type CopyState = "idle" | "copied" | "failed";

/** A choice kept in localStorage, read after hydration so the server and first client render agree. */
function useStoredChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key) as T | null;
      if (stored && allowed.includes(stored)) setValue(stored);
    } catch {
      // Storage off: keep the default.
    }
  }, [key, allowed]);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Storage off: the choice lasts for this page view.
      }
    },
    [key],
  );
  return [value, set];
}

function useFlash(): [CopyState, (ok: boolean) => void] {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback((ok: boolean) => {
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2200);
  }, []);
  return [state, flash];
}

const AGENT_IDS = CODING_AGENTS.map((a) => a.id);
const LANGUAGE_IDS = PROMPT_LANGUAGES.map((l) => l.id);

/**
 * What Muse Muse adds to a docs page: "Try it live" (opens the demo panel), "Ask Muse Muse to build" (opens
 * BuildWithThis, a build that starts from this page), "Copy prompt for your coding agent" (a
 * prompt built by lib/docs/agent-prompt from the page's agentPrompt, with a menu to pick the agent, the language and
 * whether to include the request the reader just ran), "Copy page" (the page's Markdown from /docs/md/<slug>), and
 * "View on dev.meta.ai". `rail` stacks them under "On this page" on wide screens, with the concept disclaimer;
 * `inline` is the row under the H1 on narrower screens.
 */
export function PageActions({
  page,
  spec,
  variant,
}: {
  page: DocsPageInfo;
  spec: AgentPromptSpec | null;
  variant: "rail" | "inline";
}) {
  const { lastRequest, setTryOpen, setBuildOpen } = useDocsPage();
  const [menuUp, setMenuUp] = useState(false);
  const [agent, setAgent] = useStoredChoice<CodingAgent>("docs:prompt-agent", "claude-code", AGENT_IDS);
  const [language, setLanguage] = useStoredChoice<PromptLanguage>("docs:prompt-language", "python", LANGUAGE_IDS);
  const [includeRun, setIncludeRun] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [promptState, flashPrompt] = useFlash();
  const [pageState, flashPage] = useFlash();
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const markdown = useRef<Promise<string> | null>(null);

  const prompt = useMemo(
    () => buildAgentPrompt({ page, spec, agent, language, lastRequest: includeRun ? lastRequest : null }),
    [page, spec, agent, language, includeRun, lastRequest],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        chevron.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /** Fetches the copy-ready Markdown once; hovering Copy page starts it so the click can copy right away. */
  const loadMarkdown = useCallback(() => {
    if (!markdown.current) {
      const pending = fetch(`/docs/md/${page.slug}`).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      });
      // A failed fetch is forgotten so the next click tries again.
      pending.catch(() => {
        if (markdown.current === pending) markdown.current = null;
      });
      markdown.current = pending;
    }
    return markdown.current;
  }, [page.slug]);

  const copyPrompt = async () => flashPrompt(await copyText(prompt));
  const copyPage = async () => flashPage(await copyText(loadMarkdown()));

  return (
    <div className={`docs-actions docs-actions-${variant}`}>
      <button type="button" className="docs-btn docs-btn-primary docs-try-open" onClick={() => setTryOpen(true)}>
        <SparkIcon size={16} />
        <span>Try it live</span>
      </button>
      <button type="button" className="docs-btn docs-btn-secondary" onClick={() => setBuildOpen(true)} title="Ask Muse Muse to build you something with this">
        <Icon name="rocket" size={16} />
        <span>Ask Muse Muse to build</span>
      </button>
      <div className="docs-split" ref={wrap}>
        <button type="button" className="docs-btn docs-btn-secondary docs-split-main" onClick={copyPrompt} title="Copy prompt for your coding agent">
          {promptState === "copied" ? <CheckIcon size={16} /> : <SparkIcon size={16} />}
          <span>{promptState === "copied" ? "Prompt copied" : promptState === "failed" ? "Copy failed" : variant === "rail" ? "Copy agent prompt" : "Copy prompt for your coding agent"}</span>
        </button>
        <button
          ref={chevron}
          type="button"
          className="docs-btn docs-btn-secondary docs-split-chevron"
          aria-label="Prompt options"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => {
            // Open toward the room there is: upward when the button sits in the lower half of the window.
            const top = wrap.current?.getBoundingClientRect().top ?? 0;
            setMenuUp(top > window.innerHeight / 2);
            setMenuOpen((v) => !v);
          }}
        >
          <ChevronDownIcon size={16} />
        </button>
        <div id={menuId} className={menuUp ? "docs-prompt-menu is-up" : "docs-prompt-menu"} hidden={!menuOpen} role="group" aria-label="Prompt options">
          <fieldset className="docs-choice">
            <legend>Coding agent</legend>
            <div className="docs-choice-row">
              {CODING_AGENTS.map((a) => (
                <label key={a.id} className="docs-chip">
                  <input type="radio" name={`${menuId}-agent`} checked={agent === a.id} onChange={() => setAgent(a.id)} />
                  <span>{a.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="docs-choice">
            <legend>Language</legend>
            <div className="docs-choice-row">
              {PROMPT_LANGUAGES.map((l) => (
                <label key={l.id} className="docs-chip">
                  <input type="radio" name={`${menuId}-language`} checked={language === l.id} onChange={() => setLanguage(l.id)} />
                  <span>{l.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className={lastRequest ? "docs-check" : "docs-check is-disabled"}>
            <input
              type="checkbox"
              checked={includeRun && Boolean(lastRequest)}
              disabled={!lastRequest}
              onChange={(e) => setIncludeRun(e.target.checked)}
            />
            <span>
              Include what I just ran
              <span className="docs-check-hint">
                {lastRequest ? (
                  <>
                    {" "}
                    <code>
                      {lastRequest.method} /v1/{lastRequest.path.replace(/^\/+/, "")}
                    </code>
                  </>
                ) : (
                  " (run a demo or a code block first)"
                )}
              </span>
            </span>
          </label>
          <pre className="docs-prompt-preview" aria-label="Prompt preview" tabIndex={0}>
            {prompt}
          </pre>
          <div className="docs-prompt-foot">
            <span className="docs-prompt-count">{prompt.length.toLocaleString("en-US")} characters</span>
            <button
              type="button"
              className="docs-btn docs-btn-primary docs-btn-sm"
              onClick={async () => {
                await copyPrompt();
                setMenuOpen(false);
              }}
            >
              <CopyIcon size={15} />
              <span>Copy prompt</span>
            </button>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="docs-btn docs-btn-secondary"
        onClick={copyPage}
        onPointerEnter={() => void loadMarkdown().catch(() => {})}
        onFocus={() => void loadMarkdown().catch(() => {})}
        title="Copy this page as Markdown"
      >
        {pageState === "copied" ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
        <span>{pageState === "copied" ? "Copied" : pageState === "failed" ? "Copy failed" : "Copy page"}</span>
      </button>
      <a className="docs-btn docs-btn-secondary" href={page.sourceUrl} target="_blank" rel="noopener noreferrer">
        <ExternalIcon size={16} />
        <span>View on dev.meta.ai</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      {variant === "rail" ? <p className="docs-rail-note">{DISCLAIMER}</p> : null}
    </div>
  );
}
