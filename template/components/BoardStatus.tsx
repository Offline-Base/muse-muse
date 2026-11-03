"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";

/** What app/api/board-status answers (lib/meta/board-status.ts). */
interface Status {
  connected: boolean;
  line: string;
  detail: string | null;
}

/** lib/meta/board-status.ts's NOT_CONNECTED_LINE. This file can't import it: that module reaches the model client. */
const NOT_CONNECTED = "Not connected to a board";
const NO_CHECK: Status = { connected: false, line: NOT_CONNECTED, detail: "The board check didn't answer just now." };

/**
 * The board line every edge product shows near its main answer (the muse-edge skill): "Connected to <board>" or "Not
 * connected to a board", from app/api/board-status. It asks no model. Pass `looks` when the product looks at photos with
 * segmentOrEdge, so Meta SAM 3.1's board is checked too. The outage drill reads `data-board-status` on the page.
 */
export function BoardStatus({ looks = false }: { looks?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(`/api/board-status${looks ? "?looks=1" : ""}`, { cache: "no-store" });
      const json = (await res.json()) as Partial<Status> | null;
      setStatus(json && typeof json.line === "string" ? { connected: json.connected === true, line: json.line, detail: json.detail ?? null } : NO_CHECK);
    } catch {
      setStatus(NO_CHECK);
    } finally {
      setChecking(false);
    }
  }, [looks]);

  useEffect(() => {
    void check();
  }, [check]);

  const state = !status ? "checking" : status.connected ? "connected" : "not-connected";
  return (
    <div className="row" role="status" aria-live="polite" data-board-status={state}>
      <span className={`chip${status?.connected ? " positive" : ""}`}>
        <Icon name={status?.connected ? "check" : "info"} size={14} />
        {status ? status.line : "Checking for a board"}
      </span>
      {status?.detail ? <span className="hint">{status.detail}</span> : null}
      <button type="button" className="text" onClick={() => void check()} disabled={checking} aria-busy={checking ? "true" : undefined}>
        Check again
      </button>
    </div>
  );
}
