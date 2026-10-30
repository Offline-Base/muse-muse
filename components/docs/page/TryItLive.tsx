"use client";

import { lazy, Suspense, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChatIcon, SparkIcon } from "@/components/docs/page/icons";

/** The page chat is loaded when its tab first opens. */
const AskPagePanel = lazy(() =>
  import("@/components/docs/playgrounds/common/AskPagePanel").then((m) => ({ default: m.AskPagePanel })),
);

type Tab = "demo" | "ask";

/**
 * The "Try it live" card between a page's lead and its first section: the page's live demo (its DemoSpec component,
 * rendered on the server and handed in as children) and a second tab that chats about the page. Pages without a demo
 * show the chat alone. The demo stays mounted while the chat tab is open, so switching back keeps its state.
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
    <section className="docs-try" id="try-it-live" aria-labelledby={`${id}-title`}>
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
      </div>
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
          {children}
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
    </section>
  );
}
