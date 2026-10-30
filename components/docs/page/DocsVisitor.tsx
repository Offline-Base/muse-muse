"use client";

import { useEffect } from "react";

const ASKED_KEY = "mm-docs-visitor";

/**
 * Calls GET /api/docs/limits once per tab before any demo runs. For a first-time reader its reply sets the mm_docs
 * visitor cookie (lib/docs/proxy/visitor.ts), so two demos that start at the same moment can't each be handed a
 * different visitor id and then fail to find each other's uploads. Renders nothing; a failure only skips the warm-up,
 * since the first live call sets the cookie anyway.
 */
export function DocsVisitor() {
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(ASKED_KEY)) return;
      window.sessionStorage.setItem(ASKED_KEY, "1");
    } catch {
      // No sessionStorage (private mode): ask on every page load instead.
    }
    void fetch("/api/docs/limits", { credentials: "same-origin", cache: "no-store" }).catch(() => {});
  }, []);
  return null;
}
