"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import type { DocsError } from "@/lib/docs/client/api";
import { explainError, waitLabel } from "@/lib/docs/client/errors";

/**
 * A failed demo call, explained: what kind of failure it is (a rate limit, the daily budget, a paused demo, a bad
 * request), the proxy's or Meta's own message, and, for a 429 with retry-after, a countdown to when a retry can work.
 * A stopped run shows nothing.
 */
export function ErrorBox({ error }: { error: DocsError | null }) {
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t0 = Date.now();
    setSince(t0);
    setNow(t0);
    if (!error?.retryAfterSec) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t - t0 >= (error.retryAfterSec ?? 0) * 1000) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [error]);

  if (!error || error.code === "aborted") return null;
  const why = explainError(error);
  const left = error.retryAfterSec ? Math.max(0, error.retryAfterSec - (now - since) / 1000) : null;
  return (
    <div className={`pg-error pg-error-${why.kind}`} role="alert">
      <Icon name="alert" size={18} className="pg-error-icon" />
      <div className="pg-error-body">
        <p className="pg-error-title">{why.title}</p>
        <p className="pg-error-message">{error.message}</p>
        <p className="pg-error-hint">{why.hint}</p>
        {left !== null ? <p className="pg-error-retry">{left > 0 ? `You can try again in ${waitLabel(left)}.` : "You can try again now."}</p> : null}
        {error.code || error.type ? (
          <p className="pg-error-code">
            {error.type ? <code>{error.type}</code> : null}
            {error.code && error.code !== error.type ? <code>{error.code}</code> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
