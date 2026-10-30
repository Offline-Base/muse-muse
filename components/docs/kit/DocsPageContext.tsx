"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Per-page state the docs page shares with its demos: which page this is, and the last request a demo or a Run button
 * sent, so "Copy prompt for your coding agent" can include what the reader just tried. Provided by the docs page.
 */

export interface DocsPageInfo {
  slug: string;
  title: string;
  description: string;
  /** https://dev.meta.ai/docs/<slug> */
  sourceUrl: string;
  /** https://dev.meta.ai/docs/<slug>.md */
  markdownUrl: string;
}

export interface RecordedRequest {
  method: "GET" | "POST" | "DELETE";
  /** Meta's path, such as "responses" or "files/file-abc/content". */
  path: string;
  /** The JSON body, or a short description of a multipart one ("multipart: file=photo.jpg, purpose=user_data"). */
  body?: unknown;
  /** The model the proxy actually ran, when it differs from the body's. */
  model?: string | null;
  status?: number;
  /** The start of the reply, for the prompt ("output_text: ..."). Kept short. */
  outcome?: string;
}

interface DocsPageState {
  page: DocsPageInfo;
  lastRequest: RecordedRequest | null;
  recordRequest: (request: RecordedRequest) => void;
  /** Whether the "Try it live" panel is open (components/docs/page/TryItLive.tsx). */
  tryOpen: boolean;
  setTryOpen: (open: boolean) => void;
}

const DocsPageCtx = createContext<DocsPageState | null>(null);

export function DocsPageProvider({ page, children }: { page: DocsPageInfo; children: ReactNode }) {
  const [lastRequest, setLastRequest] = useState<RecordedRequest | null>(null);
  const recordRequest = useCallback((request: RecordedRequest) => setLastRequest(request), []);
  const [tryOpen, setTryOpen] = useState(false);
  const value = useMemo(
    () => ({ page, lastRequest, recordRequest, tryOpen, setTryOpen }),
    [page, lastRequest, recordRequest, tryOpen],
  );
  return <DocsPageCtx.Provider value={value}>{children}</DocsPageCtx.Provider>;
}

/** The page's info and last request. Outside a docs page (tests, other routes) it returns a harmless default. */
export function useDocsPage(): DocsPageState {
  return (
    useContext(DocsPageCtx) ?? {
      page: { slug: "", title: "", description: "", sourceUrl: "", markdownUrl: "" },
      lastRequest: null,
      recordRequest: () => {},
      tryOpen: false,
      setTryOpen: () => {},
    }
  );
}
