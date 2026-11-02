"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";

/**
 * Admin only: POST /api/rebuilds with every catalog id (ids omitted) or just the given ones. `confirm` asks before a
 * named build starts, since each one spends model credits.
 */
export function RebuildButton({ ids, text, confirm }: { ids?: string[]; text: string; confirm?: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [started, setStarted] = useState<Array<{ id: string; buildId: string }>>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    if (!ids && !window.confirm("Start a build for every item that isn't built or building yet? Each one spends model credits.")) return;
    if (ids && confirm && !window.confirm(confirm)) return;
    setState("busy");
    setMessage(null);
    try {
      const res = await fetch("/api/rebuilds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ids ? { ids } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        started?: Array<{ id: string; buildId: string }>;
        error?: string;
      };
      if (!res.ok) {
        setState("error");
        setMessage(
          res.status === 403 || res.status === 401
            ? "Only admins can start rebuilds."
            : res.status === 503
              ? "Building is paused right now."
              : `Couldn't start the rebuild${data.error ? ` (${data.error})` : ""}.`,
        );
        return;
      }
      setStarted(data.started ?? []);
      setState("done");
      router.refresh();
    } catch {
      setState("error");
      setMessage("Couldn't reach Muse Muse.");
    }
  }

  return (
    <div className="rebuild-action">
      <button
        type="button"
        className={ids ? "btn btn-outline btn-sm" : "btn btn-primary"}
        onClick={run}
        disabled={state === "busy"}
      >
        <Icon name="rebuild" size={18} />
        <span>{state === "busy" ? "Starting" : text}</span>
      </button>
      <div aria-live="polite" className="small">
        {state === "done" ? (
          started.length ? (
            <span>
              Started {started.length === 1 ? "1 build" : `${started.length} builds`}
              {started.length <= 3
                ? started.map((s) => (
                    <span key={s.buildId}>
                      {" "}
                      <Link href={`/b/${s.buildId}`}>Watch {s.id}</Link>
                    </span>
                  ))
                : null}
              .
            </span>
          ) : (
            <span className="muted">Nothing new to start.</span>
          )
        ) : message ? (
          <span className="error-text">{message}</span>
        ) : null}
      </div>
    </div>
  );
}
