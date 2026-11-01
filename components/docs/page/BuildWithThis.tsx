"use client";

import { useEffect, useMemo, useRef } from "react";
import { Composer } from "@/components/composer/Composer";
import { Icon } from "@/components/icons";
import { useDocsPage } from "@/components/docs/kit/DocsPageContext";
import { blankWish, buildContext, buildIdeas } from "@/lib/docs/build-note";
import type { AgentPromptSpec } from "@/lib/docs/demos/types";

/**
 * "Ask Muse Muse to build you something with this": a dialog on every docs page with the same muse box as the Make page
 * (its uploads, limits and sign-in), plus ideas that fit the page. What the page adds to the note is shown, so the
 * reader knows what the build reads. Sending starts a normal build and moves to its build room. A #build link opens it,
 * which is also how a reader gets back here after signing in.
 */
export function BuildWithThis({ spec, signedIn, contributorNotice }: { spec: AgentPromptSpec | null; signedIn: boolean; contributorNotice?: boolean }) {
  const { page, lastRequest, buildOpen, setBuildOpen } = useDocsPage();
  const dialog = useRef<HTMLDialogElement>(null);
  const context = useMemo(() => buildContext({ page, spec, lastRequest }), [page, spec, lastRequest]);

  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash === "#build") setBuildOpen(true);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [setBuildOpen]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (buildOpen && !el.open) el.showModal();
    else if (!buildOpen && el.open) el.close();
  }, [buildOpen]);

  return (
    <dialog
      ref={dialog}
      className="docs-build"
      aria-labelledby="docs-build-title"
      onClose={() => setBuildOpen(false)}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === dialog.current) setBuildOpen(false);
      }}
    >
      {buildOpen ? (
        <div className="docs-build-body">
          <div className="docs-build-head">
            <h2 id="docs-build-title">Ask Muse Muse to build you something with this</h2>
            <button type="button" className="icon-btn icon-btn-plain" aria-label="Close" onClick={() => setBuildOpen(false)}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <p className="docs-build-lead">
            Say what you want, and Muse Muse builds it as its own working app using <strong>{page.title}</strong>. It usually takes about five minutes.
          </p>
          <Composer
            mode="new"
            signedIn={signedIn}
            contributorNotice={contributorNotice}
            autoFocus
            examples={buildIdeas(page.slug).map((idea) => ({ label: idea.label, note: idea.note }))}
            examplesLabel="Ideas"
            placeholder="What should it do? Leave this empty and Muse Muse picks something."
            context={context}
            blankNote={blankWish(page.title)}
            draftId={`docs:${page.slug}`}
            returnTo={`/docs/${page.slug}#build`}
          />
          <details className="docs-build-context">
            <summary>What this page adds to your note</summary>
            <pre tabIndex={0}>{context}</pre>
          </details>
        </div>
      ) : null}
    </dialog>
  );
}
