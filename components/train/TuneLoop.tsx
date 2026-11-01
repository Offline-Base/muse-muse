"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LOOP_DEFAULT_EXAMPLES, LOOP_DEFAULT_ROUNDS, LOOP_MAX_EXAMPLES, LOOP_MAX_ROUNDS, LOOP_MIN_EXAMPLES } from "@/lib/train/tune/loop";

async function errorOf(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (res.status === 409) return "A loop is already running on this model.";
  return typeof data?.error === "string" && data.error.includes(" ") ? data.error : "That didn't work. Try again.";
}

/** The run room's form: a target score and a spend cap. Only rendered with TUNE_LOOP on, for a judged run. */
export function TuneLoopCard({ datasetId, loops }: { datasetId: string; loops: { id: string; running: boolean; startedAt: string }[] }) {
  const router = useRouter();
  const [target, setTarget] = useState("8");
  const [cap, setCap] = useState("");
  const [rounds, setRounds] = useState(String(LOOP_DEFAULT_ROUNDS));
  const [examples, setExamples] = useState(String(LOOP_DEFAULT_EXAMPLES));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/train/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId, targetScore: Number(target), maxUsd: Number(cap), maxRounds: Number(rounds), examples: Number(examples) }),
    }).catch(() => null);
    if (res?.ok) {
      const { href } = (await res.json()) as { href: string };
      router.push(href);
      return;
    }
    setError(res ? await errorOf(res) : "That didn't reach the server. Try again.");
    setBusy(false);
  }

  return (
    <section className="card train-new" aria-labelledby="tune-loop-title">
      <h2 id="tune-loop-title">Keep improving it</h2>
      <p className="muted small">
        Each round writes more examples for what it did worst on, trains a new model from the base and judges it. It stops at your target, your cap or the round limit. The target is checked on kept-aside prompts the writer never sees, and the model must also clearly beat the base.
      </p>
      <form onSubmit={submit}>
        <label>
          Target score (1 to 10)
          <input type="number" min={1} max={10} step={0.1} required value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label>
          Spend cap in dollars
          <input type="number" min={0.01} step={0.01} required value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label>
          Rounds at most
          <input type="number" min={1} max={LOOP_MAX_ROUNDS} required value={rounds} onChange={(e) => setRounds(e.target.value)} />
        </label>
        <label>
          New examples a round
          <input type="number" min={LOOP_MIN_EXAMPLES} max={LOOP_MAX_EXAMPLES} required value={examples} onChange={(e) => setExamples(e.target.value)} />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Starting..." : "Start the loop"}
        </button>
      </form>
      {loops.length ? (
        <ul className="small">
          {loops.map((l) => (
            <li key={l.id}>
              <a href={`/fine-tuning/loops/${l.id}`}>
                Loop from {l.startedAt.slice(0, 10)}
                {l.running ? " (running)" : ""}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Stops the loop for good. */
export function StopLoopButton({ loopId }: { loopId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function stop() {
    if (!window.confirm("Stop this loop? Nothing more will be written or trained.")) return;
    setBusy(true);
    const res = await fetch(`/api/train/loops/${loopId}/stop`, { method: "POST" }).catch(() => null);
    setError(!res?.ok);
    setBusy(false);
    router.refresh();
  }
  return (
    <>
      <button type="button" className="btn btn-outline" onClick={stop} disabled={busy}>
        {busy ? "Stopping..." : "Stop the loop"}
      </button>
      {error ? <span role="alert"> That didn't work. Try again.</span> : null}
    </>
  );
}
