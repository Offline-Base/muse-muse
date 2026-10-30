"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { EffortSelect, PresetPills, TextArea, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import type { SseEvent } from "@/lib/docs/client/api";
import type { Effort } from "@/lib/docs/client/models";
import { responsesCollector, type Collected } from "@/lib/docs/client/stream";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { SandboxFrame } from "@/components/docs/playgrounds/cookbook-use-cases/SandboxFrame";
import { extractHtml } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";
import { retryText, withRetries } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";
import { replyUsd } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { formatUsd } from "@/lib/docs/client/cost";
import {
  CANVAS_AGENTS_MD,
  CANVAS_SECTIONS,
  CROSSY_AGENTS_MD,
  CROSSY_SECTIONS,
  agentsInstructions,
  buildProgress,
  sectionsText,
  type PromptSection,
} from "@/components/docs/playgrounds/cookbook-use-cases/lib/gamedev";

/**
 * cookbook/one-shot-game-dev: ground the model with an AGENTS.md (sent as the instructions, the way OpenCode loads it
 * every turn) and one structured prompt in the recipe's fixed shape, at a high reasoning effort, and get a whole game
 * in a single pass. The game runs in a sandboxed frame (scripts only, no access to this page). No build-and-fix loop:
 * if the output cap cuts it off, Continue asks for the rest of the same file. The 3D default at high effort usually
 * does stop at the proxy's 16,384-token cap (a live run on Oct 30, 2026 spent 8,521 of them reasoning and wrote 23,826
 * characters with no </html>), so the demo continues once on its own and offers Continue after that.
 */

export interface OneShotGameProps {
  slug: string;
  /** "crossy" (the recipe's Three.js game) or "canvas" (a smaller 2D spec). */
  preset?: "crossy" | "canvas";
  effort?: Effort | null;
}

type Json = Record<string, unknown>;

const PRESETS = [
  { id: "crossy", label: "The recipe: 3D Crossy Road (Three.js)", sections: CROSSY_SECTIONS, agents: CROSSY_AGENTS_MD },
  { id: "canvas", label: "Quicker: 2D canvas, no libraries", sections: CANVAS_SECTIONS, agents: CANVAS_AGENTS_MD },
] as const;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function OneShotGame({ preset: initialPreset = "crossy", effort: initialEffort = "high" }: OneShotGameProps) {
  const id = useId();
  const runner = useDocsRun();
  const start = PRESETS.find((p) => p.id === initialPreset) ?? PRESETS[0];
  const [presetIdx, setPresetIdx] = useState<number>(PRESETS.indexOf(start));
  const [sections, setSections] = useState<PromptSection[]>(start.sections.map((s) => ({ ...s })));
  const [agentsMd, setAgentsMd] = useState<string>(start.agents);
  const [useAgents, setUseAgents] = useState(true);
  const [noAssets, setNoAssets] = useState(true);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(initialEffort);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Collected | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [cutOff, setCutOff] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true);
  const [continued, setContinued] = useState(0);
  const [spent, setSpent] = useState(0);
  /** Characters in the current call's reply: 0 while the model is still thinking. */
  const [callChars, setCallChars] = useState(0);
  /** Time spent in calls that have ended. The runner's own clock starts over with each call. */
  const [doneMs, setDoneMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const stopped = useRef(false);
  const [showCode, setShowCode] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const running = busy || runner.state === "running";

  const body: Json = useMemo(
    () => ({
      model,
      instructions: agentsInstructions(useAgents ? agentsMd : ""),
      input: sectionsText(sections, noAssets),
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 16384,
      stream: true,
    }),
    [model, useAgents, agentsMd, sections, noAssets, effort],
  );

  /**
   * Streams one call (with retries for a transient error or the rate limit) and returns the reply when it was cut off
   * at the output limit, so the caller can continue it; null when it finished or failed.
   */
  const stream = async (b: Json, prefix: string): Promise<Collected | null> => {
    setCallChars(0);
    let collector = responsesCollector();
    const res = await withRetries(
      () => {
        collector = responsesCollector();
        const c = collector;
        const onEvent = (e: SseEvent) => {
          c.push(e);
          const now = c.snapshot().text;
          setCallChars(now.length);
          setText(prefix + now);
        };
        return runner.run("responses", { method: "POST", body: b, stream: true, onEvent });
      },
      { stopped: () => stopped.current, onRetry: (r) => setWaitNote(retryText(r)), onResume: () => setWaitNote(null) },
    );
    setWaitNote(null);
    setDoneMs((ms) => ms + res.elapsedMs);
    const r = collector.snapshot();
    setReply(r);
    if (res.ok) setSpent((usd) => usd + replyUsd(res.model ?? model, r.final));
    const all = prefix + r.text;
    setText(all);
    if (!res.ok || stopped.current) return null;
    const incomplete = r.status === "incomplete" || r.finishReason === "max_output_tokens";
    setCutOff(incomplete);
    const page = extractHtml(all);
    if (page && (!incomplete || /<\/html>/i.test(page))) setHtml(page);
    return incomplete ? r : null;
  };

  const continueBody = (prev: string): Json => ({
    model,
    previous_response_id: prev,
    input: "You hit the output limit. Continue the same index.html exactly where you stopped: no repeats, no fences, just the rest of the file.",
    ...(effort ? { reasoning: { effort } } : {}),
    max_output_tokens: 16384,
    stream: true,
  });

  /** Runs a step with the busy flag and Stop wired up. */
  const guarded = async (work: () => Promise<void>) => {
    stopped.current = false;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
      setWaitNote(null);
    }
  };

  const generate = () =>
    guarded(async () => {
      setHtml(null);
      setText("");
      setReply(null);
      setCutOff(false);
      setContinued(0);
      setSpent(0);
      setDoneMs(0);
      const cut = await stream(body, "");
      // The 3D build usually stops at the cap: continue once on its own, the way you'd type "continue".
      if (cut?.id && autoContinue && !stopped.current) {
        setContinued(1);
        await stream(continueBody(cut.id), (cut.text ?? "").replace(/```\s*$/, ""));
      }
    });

  const proceed = () =>
    guarded(async () => {
      const prev = reply?.id;
      if (!prev) return;
      setContinued((n) => n + 1);
      await stream(continueBody(prev), text.replace(/```\s*$/, ""));
    });

  const stop = () => {
    stopped.current = true;
    runner.abort();
  };

  const pick = (i: number) => {
    setPresetIdx(i);
    setSections(PRESETS[i].sections.map((s) => ({ ...s })));
    setAgentsMd(PRESETS[i].agents);
    runner.reset();
    setHtml(null);
    setText("");
    setReply(null);
    setDoneMs(0);
  };

  const elapsedMs = doneMs + (runner.state === "running" ? runner.elapsedMs : 0);
  const tail = text.split("\n").slice(-10).join("\n");

  return (
    <div className="pg">
      <PresetPills presets={PRESETS.map((p) => ({ label: p.label }))} active={presetIdx} onPick={pick} disabled={running} />

      <details className={`${styles.card} pg-advanced`} open>
        <summary className={styles.cardTitle}>AGENTS.md: the rules that prevent invisible bugs</summary>
        <Toggle id={`${id}-agents`} label="Load AGENTS.md (sent as the instructions)" checked={useAgents} onChange={setUseAgents} disabled={running} />
        <label className="sr-only" htmlFor={`${id}-agentsmd`}>
          AGENTS.md
        </label>
        <TextArea id={`${id}-agentsmd`} rows={8} className="pg-code-input" value={agentsMd} onChange={(e) => setAgentsMd(e.target.value)} disabled={running || !useAgents} />
      </details>

      <details className={`${styles.card} pg-advanced`}>
        <summary className={styles.cardTitle}>The one structured prompt ({sections.length} sections)</summary>
        {sections.map((s, i) => (
          <div key={s.id} className="pg-field">
            <label className="pg-label" htmlFor={`${id}-s-${s.id}`}>
              {s.label}
              {s.id === "assets" && noAssets ? " (swapped for procedural shapes)" : ""}
            </label>
            <TextArea
              id={`${id}-s-${s.id}`}
              rows={s.text.split("\n").length > 2 ? 5 : 2}
              value={s.text}
              onChange={(e) => setSections((cur) => cur.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              disabled={running || (s.id === "assets" && noAssets)}
            />
          </div>
        ))}
      </details>

      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
        {sections.some((s) => s.id === "assets") ? (
          <span className="pg-advanced">
            <Toggle id={`${id}-assets`} label="No Kenney files here: build models from shapes" checked={noAssets} onChange={setNoAssets} disabled={running} />
          </span>
        ) : null}
        <span className="pg-advanced">
          <Toggle id={`${id}-auto`} label="Continue once on its own if the output limit cuts the file" checked={autoContinue} onChange={setAutoContinue} disabled={running} />
        </span>
      </div>
      <p className="pg-hint">
        The recipe maxes out reasoning (high, or the equivalent xhigh) so the model works the constraints through before it writes. Each call takes up to 16,384
        output tokens, much of it reasoning at high effort, so the 3D build usually stops at that limit and needs one Continue to finish the file: four to six
        minutes in all, under a cent on Spark Contributor. The 2D preset usually fits in one call.
      </p>

      <div className="pg-actions">
        <RunButton running={running} onRun={() => void generate()} onStop={stop} label="Build the game in one shot" />
        {cutOff && !running ? (
          <button type="button" className="btn btn-sm" onClick={() => void proceed()}>
            Continue the file
          </button>
        ) : null}
        {running || text ? (
          <span className="pg-hint" role="status">
            {running
              ? buildProgress({ total: text.length, callChars, continued, elapsed: elapsedMs ? latencyLabel(elapsedMs) : "", usual: PRESETS[presetIdx].id === "crossy" && effort === "high" ? "usually four to six minutes in all" : "" })
              : `Wrote ${text.length.toLocaleString()} characters${continued ? ` (${continued === 1 ? "one Continue" : `${continued} Continues`})` : ""}${elapsedMs ? `, ${latencyLabel(elapsedMs)}` : ""}`}
          </span>
        ) : null}
        {reply?.usage ? <UsageLine model={runner.result?.model ?? model} usage={reply.usage} /> : null}
        {continued && spent ? <span className="pg-hint">{formatUsd(spent)} est. for all {continued + 1} calls</span> : null}
      </div>
      {waitNote ? (
        <div className="pg-hint" role="status">
          {waitNote}
        </div>
      ) : null}
      <ErrorBox error={waitNote ? null : runner.error} />
      {running && tail ? <pre className="pg-pre" aria-hidden style={{ maxHeight: 180 }}>{tail}</pre> : null}
      {cutOff && !running ? (
        <div className="pg-hint pg-bad">The reply stopped at the output limit before the file ended. Continue asks for the rest of the same file, or lower the effort and build again.</div>
      ) : null}
      {!running && text && !html && !cutOff ? <div className="pg-hint pg-bad">No complete HTML file in the reply.</div> : null}

      {html ? (
        <div className={styles.stack}>
          <SandboxFrame html={html} title="index.html" viewport={{ width: 1280, height: 800 }} />
          <div className={styles.row}>
            <span className="pg-hint">Click the game, then use the arrow keys or WASD. It runs sandboxed: scripts only, no access to this site.</span>
            <button type="button" className="btn btn-sm" onClick={() => download("index.html", html)}>
              Download index.html
            </button>
            <Toggle id={`${id}-src`} label="Show the source" checked={showSource} onChange={setShowSource} />
          </div>
          {showSource ? <pre className="pg-pre" style={{ maxHeight: 420 }}>{html}</pre> : null}
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={body} /> : null}
    </div>
  );
}
