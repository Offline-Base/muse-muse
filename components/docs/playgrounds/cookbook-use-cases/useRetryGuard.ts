"use client";

import { useMemo, useRef, useState } from "react";
import { retryText, type RetryOptions } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";

/**
 * Stop and the wait line for the short multi-call demos (alert copilot, chart analysis, slides): pass `options` to
 * withRetries, call `begin()` when Run starts and `stop()` from Stop. A rate-limit wait shows its line, Stop ends it
 * without sending the call again, and `waiting` keeps the demo looking busy while it waits.
 */
export function useRetryGuard(abort: () => void) {
  const stopped = useRef(false);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const options: RetryOptions = useMemo(
    () => ({ stopped: () => stopped.current, onRetry: (n) => setWaitNote(retryText(n)), onResume: () => setWaitNote(null) }),
    [],
  );
  return {
    options,
    waitNote,
    waiting: waitNote !== null,
    begin() {
      stopped.current = false;
      setWaitNote(null);
    },
    stop() {
      stopped.current = true;
      setWaitNote(null);
      abort();
    },
    stopped: () => stopped.current,
  };
}
