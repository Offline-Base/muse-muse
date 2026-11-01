"use client";
// Platform file (Muse Muse platform services). Don't edit: put it where the person follows their Muse Code task.
//
// One Muse Code run, the same way in every product: the steps as they happen, the files changed, the final answer, a
// Stop button, the download once it's done, and the cost so far. It polls the product's own routes in
// app/api/musemuse/muse-code/, never the gateway.
//   <CodeRun runId={id} />                          after starting a task with POST /api/musemuse/muse-code
//   <MuseCodeDisclosure />                          next to where the person types the task, word for word
import { useCallback, useEffect, useRef, useState } from "react";

export const MUSE_CODE_DISCLOSURE = "Runs Muse Code in a private temporary workspace. It's deleted after 15 minutes, and your task is sent to Meta.";

const BASE = "/api/musemuse/muse-code";
const POLL_MS = 2000;
const ENDED = ["completed", "failed", "stopped", "expired"];

interface Step {
  n: number;
  kind: string;
  text: string;
  itemId?: string;
  tool?: string;
  ok?: boolean;
  files?: number;
}

interface Result {
  status: string;
  done: boolean;
  finalText: string | null;
  worked: boolean | null;
  files?: Array<{ path: string; bytes: number }>;
  dropped?: Array<{ path: string; why: string }>;
  zipUrl?: string | null;
  costUsd: number;
  reason?: string | null;
  replay?: boolean;
}

export function MuseCodeDisclosure() {
  return (
    <p className="hint" data-musecode="disclosure">
      {MUSE_CODE_DISCLOSURE}
    </p>
  );
}

function money(usd: number): string {
  return usd < 0.01 ? "under 1 cent" : `$${usd.toFixed(2)}`;
}

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS_WORDS: Record<string, string> = {
  starting: "Starting a private workspace",
  running: "Working",
  completed: "Finished",
  failed: "Stopped with a problem",
  stopped: "Stopped",
  expired: "Ended",
};

/** Steps by item: a later line for the same item replaces the earlier one, as a tool call turns from running to done. */
function merge(steps: Step[], fresh: Step[]): Step[] {
  const out = [...steps];
  for (const s of fresh) {
    const at = s.itemId ? out.findIndex((o) => o.itemId === s.itemId) : -1;
    if (at >= 0) out[at] = s;
    else out.push(s);
  }
  return out.slice(-200);
}

export function CodeRun({ runId, onDone }: { runId: string; onDone?: (result: Result) => void }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [status, setStatus] = useState("starting");
  const [cost, setCost] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [replay, setReplay] = useState(false);
  const after = useRef(-1);
  const done = useRef(false);

  const finish = useCallback(
    (r: Result) => {
      if (done.current) return;
      done.current = true;
      setResult(r);
      setStatus(r.status);
      setCost(r.costUsd ?? 0);
      onDone?.(r);
    },
    [onDone],
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}?id=${encodeURIComponent(runId)}&after=${after.current}`, { cache: "no-store" });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(body?.error?.message ?? "Muse Code didn't answer.");
        setProblem(null);
        setReplay(Boolean(body.replay));
        if (Array.isArray(body.events) && body.events.length) setSteps((s) => merge(s, body.events));
        if (typeof body.next === "number") after.current = body.next;
        setStatus(body.status);
        setCost(body.costUsd ?? 0);
        if (ENDED.includes(body.status)) {
          const r = await fetch(`${BASE}/result?id=${encodeURIComponent(runId)}`, { cache: "no-store" }).then((x) => x.json());
          if (alive) finish(r as Result);
          return;
        }
      } catch (err) {
        if (alive) setProblem(err instanceof Error ? err.message : "Muse Code didn't answer.");
      }
      if (alive && !done.current) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, finish]);

  const stop = async () => {
    setStopping(true);
    try {
      const res = await fetch(`${BASE}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: runId }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "It couldn't be stopped. Try again.");
      finish(body as Result);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "It couldn't be stopped. Try again.");
    } finally {
      setStopping(false);
    }
  };

  const running = !ENDED.includes(status);
  const edits = steps.filter((s) => s.kind === "edit");
  const files = result?.files ?? [];
  return (
    <section className="stack" data-musecode="run" data-musecode-status={status} data-musecode-replay={replay ? "true" : "false"} aria-busy={running ? "true" : "false"} style={{ gap: "12px" }}>
      <div className="row" style={{ gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
        <strong data-musecode="status">{STATUS_WORDS[status] ?? status}</strong>
        <span className="hint" data-musecode="cost">
          Cost so far: {money(cost)}
        </span>
        {replay ? <span className="hint">A recorded sample run</span> : null}
        {running ? (
          <button type="button" onClick={stop} disabled={stopping} data-musecode="stop">
            {stopping ? "Stopping..." : "Stop"}
          </button>
        ) : null}
      </div>
      {problem ? (
        <p className="hint" role="alert" style={{ color: "var(--negative)" }}>
          {problem}
        </p>
      ) : null}
      <ol className="stack" data-musecode="steps" aria-live="polite" style={{ gap: "4px", margin: 0, paddingLeft: "20px" }}>
        {steps.map((s) => (
          <li key={s.itemId ?? s.n} data-kind={s.kind} style={{ overflowWrap: "anywhere", color: s.ok === false ? "var(--negative)" : undefined }}>
            {s.text}
          </li>
        ))}
        {!steps.length ? <li className="hint">Getting the workspace ready...</li> : null}
      </ol>
      {edits.length && !result ? <p className="hint">Files changed so far: {edits.reduce((n, e) => n + (e.files ?? 1), 0)}</p> : null}
      {result ? (
        <div className="stack" style={{ gap: "8px" }}>
          <h3 style={{ margin: 0 }}>The answer</h3>
          <p data-musecode="final" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>
            {result.finalText?.trim() || "Muse Code didn't say what it did."}
          </p>
          {result.worked === false ? (
            <p className="hint" data-musecode="not-worked">
              {files.length ? "It ended before finishing, so check the files." : "No files came back from this run."}
              {result.reason ? ` ${result.reason}` : ""}
            </p>
          ) : null}
          <h3 style={{ margin: 0 }}>Files</h3>
          <ul data-musecode="files" style={{ margin: 0, paddingLeft: "20px" }}>
            {files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> <span className="hint">{bytes(f.bytes)}</span>
              </li>
            ))}
            {!files.length ? <li className="hint">None</li> : null}
          </ul>
          {result.dropped?.length ? (
            <details>
              <summary>Left out of the download ({result.dropped.length})</summary>
              <ul style={{ margin: 0, paddingLeft: "20px" }}>
                {result.dropped.map((d) => (
                  <li key={d.path}>
                    <code>{d.path}</code>: {d.why}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {result.zipUrl ? (
            <a href={result.zipUrl} download data-musecode="download">
              Download the files (zip, kept for 24 hours)
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
