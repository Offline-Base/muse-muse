"use client";

import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { Icon } from "@/components/icons";
import { ChatIcon, SparkIcon } from "@/components/docs/page/icons";

/** The page chat is loaded when its tab first opens. */
const AskPagePanel = lazy(() =>
  import("@/components/docs/playgrounds/common/AskPagePanel").then((m) => ({ default: m.AskPagePanel })),
);

type Tab = "demo" | "ask";

/**
 * The "Try it live" side panel: the page's live demo (its DemoSpec component, handed in as children) and a second tab
 * that chats about the page, opened from the page's actions (or a #try-it-live link) over the right of the window, so
 * the page's text stays in view beside it. Pages without a demo show the chat alone. The demo mounts when the panel
 * first opens and stays mounted after, so closing it or switching tabs keeps its state.
 */
export function TryItLive({
  slug,
  title,
  blurb,
  children,
}: {
  slug: string;
  title?: string;
  blurb?: string;
  children?: ReactNode;
}) {
  const id = useId();
  const hasDemo = children !== undefined && children !== null;
  const tabs: Tab[] = hasDemo ? ["demo", "ask"] : ["ask"];
  const [tab, setTab] = useState<Tab>(tabs[0]);
  const [askOpened, setAskOpened] = useState(!hasDemo);
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const { tryOpen, setTryOpen } = useDocsPage();
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  // Off by default: a demo opens as what to ask and a Run button. The reader's choice carries across pages.
  const [options, setOptions] = useState(false);

  useEffect(() => {
    try {
      setOptions(window.localStorage.getItem("docs:try-options") === "1");
    } catch {
      // No storage: stays off.
    }
  }, []);

  const toggleOptions = () => {
    const next = !options;
    setOptions(next);
    try {
      window.localStorage.setItem("docs:try-options", next ? "1" : "0");
    } catch {
      // No storage: it just won't carry over.
    }
  };

  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash === "#try-it-live") setTryOpen(true);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [setTryOpen]);

  useEffect(() => {
    if (!tryOpen) return;
    setMounted(true);
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    // Escape closes the panel, unless the reader is typing in a field or a demo already used the key.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      setTryOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnTo.current?.focus();
    };
  }, [tryOpen, setTryOpen]);

  const open = (next: Tab) => {
    setTab(next);
    if (next === "ask") setAskOpened(true);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (tabs.length < 2 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = tab === "demo" ? "ask" : "demo";
    open(next);
    refs.current[next]?.focus();
  };

  const label: Record<Tab, string> = { demo: "Live demo", ask: "Ask about this page" };

  return (
    <section ref={panel} tabIndex={-1} className={options ? "docs-try" : "docs-try is-simple"} id="try-it-live" aria-labelledby={`${id}-title`} hidden={!tryOpen}>
      <div className="docs-try-head">
        <h2 className="docs-try-heading" id={`${id}-title`}>
          <SparkIcon size={18} />
          Try it live
        </h2>
        <div className="docs-tabs docs-try-tabs" role="tablist" aria-label="Try it live">
          {tabs.map((t) => (
            <button
              key={t}
              ref={(el) => {
                refs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`${id}-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              className="docs-tab"
              onClick={() => open(t)}
              onKeyDown={onKey}
            >
              {t === "ask" ? <ChatIcon size={15} /> : null}
              <span className="docs-tab-text" data-label={label[t]}>
                {label[t]}
              </span>
            </button>
          ))}
        </div>
        <button type="button" className="docs-try-options" aria-pressed={options} onClick={toggleOptions}>
          <Icon name="tune" size={16} />
          <span>Options</span>
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-plain docs-try-close"
          aria-label="Close Try it live"
          onClick={() => setTryOpen(false)}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="docs-try-scroll">
        {hasDemo ? (
          <div
            id={`${id}-panel-demo`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-demo`}
            hidden={tab !== "demo"}
            className="docs-try-panel"
          >
            {title || blurb ? (
              <div className="docs-try-intro">
                {title ? <p className="docs-try-title">{title}</p> : null}
                {blurb ? <p className="docs-try-blurb">{blurb}</p> : null}
              </div>
            ) : null}
            {mounted ? children : null}
          </div>
        ) : null}
        <div
          id={`${id}-panel-ask`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-ask`}
          hidden={tab !== "ask"}
          className="docs-try-panel"
        >
          {askOpened ? (
            <Suspense fallback={<p className="docs-try-loading">Loading the page chat...</p>}>
              <AskPagePanel slug={slug} />
            </Suspense>
          ) : null}
        </div>
      </div>
    </section>
  );
}
