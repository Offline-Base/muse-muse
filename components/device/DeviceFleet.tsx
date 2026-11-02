"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import type { FleetBoard } from "@/lib/device/fleet";
import { pollFleet, type FleetLoadResult } from "@/lib/device/fleet-poll";

const NOT_REPORTED = "Not reported";
const UNREACHABLE = "The fleet can't be reached right now. This tries again every few minutes.";
const REFUSED = "The fleet refused this, so this stopped asking. Check that BOARD_FLEET_TOKEN is a current jpt_ token and that BOARD_FLEET_URL ends in /admin.";

const STATUS: Record<FleetBoard["status"], string> = { online: "Online", stale: "No recent numbers", offline: "Offline" };

const gigabytes = (mb: number) => (mb / 1024).toFixed(1);

/** Admin only: every board in the fleet, refreshed only while someone's looking (lib/device/fleet-poll.ts). It only reads (GET /api/device/fleet). */
export function DeviceFleet() {
  const id = useId();
  const [boards, setBoards] = useState<FleetBoard[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    const stop = new AbortController();

    async function load(): Promise<FleetLoadResult> {
      try {
        const res = await fetch("/api/device/fleet", { cache: "no-store", signal: stop.signal });
        const data = (await res.json().catch(() => ({}))) as { boards?: FleetBoard[]; error?: string };
        if (res.ok && data.boards) {
          setBoards(data.boards);
          setMessage(null);
          return "ok";
        }
        if (data.error === "fleet_not_configured") {
          setMessage("The fleet isn't set up. It takes BOARD_FLEET_URL, which must be https and include /admin, and BOARD_FLEET_TOKEN.");
          return "final";
        }
        if (data.error === "fleet_refused") {
          setMessage(REFUSED);
          return "final";
        }
        if (res.status === 502) {
          setMessage(UNREACHABLE);
          return "failed";
        }
        // This page's own request was refused, so asking again won't help.
        setMessage("The fleet can't be shown right now.");
        return "final";
      } catch {
        if (!stop.signal.aborted) setMessage(UNREACHABLE);
        return "failed";
      }
    }

    const poll = pollFleet(load, {
      hidden: () => document.visibilityState === "hidden",
      onReturn: (listener) => {
        document.addEventListener("visibilitychange", listener);
        window.addEventListener("focus", listener);
        return () => {
          document.removeEventListener("visibilitychange", listener);
          window.removeEventListener("focus", listener);
        };
      },
      onPaused: setPaused,
    });
    refresh.current = poll.refresh;
    return () => {
      stop.abort();
      poll.stop();
    };
  }, []);

  return (
    <section className="card section-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Fleet</h2>
      <p className="muted small">Every board on the fleet&apos;s control plane. Muse Wonder can read this list and ask a model a board already has loaded, and can&apos;t change anything on them.</p>
      <p>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => refresh.current()}>
          <Icon name="refresh" size={16} />
          <span>Refresh</span>
        </button>
      </p>
      {paused ? <p className="small muted">This stopped refreshing by itself, because each check counts toward the tunnel&apos;s monthly limit. Refresh to check again.</p> : null}
      {message ? (
        <p className="note train-callout-warn" role="alert">
          {message}
        </p>
      ) : null}
      {boards?.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Board</th>
                <th scope="col">Status</th>
                <th scope="col">Memory</th>
                <th scope="col">Hottest</th>
                <th scope="col">Loaded models</th>
              </tr>
            </thead>
            <tbody>
              {boards.map((board, i) => (
                <tr key={`${board.name}-${i}`}>
                  <td>
                    {board.name}
                    {board.pool ? <div className="muted small">{board.pool}</div> : null}
                  </td>
                  <td>
                    {STATUS[board.status]}
                    {board.maintenance ? <div className="muted small">In maintenance</div> : null}
                  </td>
                  <td>{board.memUsedMb !== null && board.memTotalMb !== null ? `${gigabytes(board.memUsedMb)} of ${gigabytes(board.memTotalMb)} GB` : NOT_REPORTED}</td>
                  <td>{board.maxTempC !== null ? `${Math.round(board.maxTempC)} C` : NOT_REPORTED}</td>
                  <td style={{ overflowWrap: "anywhere" }}>{board.loadedModels.length ? board.loadedModels.join(", ") : "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : boards ? (
        <p className="small muted">The fleet has no boards yet.</p>
      ) : null}
    </section>
  );
}
