"use client";

import { useId, useRef, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { EffortSelect, TextArea, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { DocsResult, SseEvent } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import type { Effort } from "@/lib/docs/client/models";
import { responsesCollector, type Collected } from "@/lib/docs/client/stream";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { SandboxFrame, whenTabVisible, type SandboxHandle } from "@/components/docs/playgrounds/cookbook-use-cases/SandboxFrame";
import { extractHtml } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";
import { replyUsd } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { GAME_LOOP, SINGLE_FILE_OUTPUT, SITE_LOOP, checkText, reviewText, type LoopSpec } from "@/components/docs/playgrounds/cookbook-use-cases/lib/gamedev";
import { retryText, withRetries } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";

/**
 * iterative-game-dev and browser-verified-web-design: the build, browser check, fix loop. Round 1 writes the page.
 * The page then runs in a sandboxed frame where the harness plays the recipe's check (held keys to drive the kart,
 * or the mouse across the ASCII logo), takes screenshots, and reads the console and a page snapshot, the jobs the
 * Playwright MCP does in the recipes. Round 2 hands all of that back with previous_response_id: the model says what
 * it sees and returns the fixed file, which is loaded and screenshotted again. Refinement passes repeat the loop, each
 * ending in its own check. A reply cut off at the output cap before </html> is continued once on the same chain.
 */

export interface VerifyLoopProps {
  slug: string;
  kind: "game" | "site";
  effort?: Effort | null;
}

type Json = Record<string, unknown>;

interface Shot {
  label: string;
  url: string | null;
  note?: string | null;
}

interface Round {
  title: string;
  prompt: string;
  review: string;
  html: string | null;
  shots: Shot[];
  console: string[];
  usage: unknown;
  model: string | null;
  usd: number;
  cutOff: boolean;
  /** The reply reached the output cap mid-file and one Continue finished it. */
  continued?: boolean;
  body: Json;
}

/** What a round asks for when its reply stops at the output cap mid-file (the one-shot demo's Continue). */
const CONTINUE_FILE = "You hit the output limit. Continue the same index.html exactly where you stopped: no repeats, no fences, just the rest of the file.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two Responses usage objects added up, so a round that took a Continue shows what both calls used. */
function sumUsage(a: unknown, b: unknown): unknown {
  const u = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
  const n = (x: unknown, key: string) => (typeof u(x)[key] === "number" ? (u(x)[key] as number) : 0);
  const nested = (x: unknown, key: string, field: string) => n(u(x)[key], field);
  return {
    input_tokens: n(a, "input_tokens") + n(b, "input_tokens"),
    input_tokens_details: { cached_tokens: nested(a, "input_tokens_details", "cached_tokens") + nested(b, "input_tokens_details", "cached_tokens") },
    output_tokens: n(a, "output_tokens") + n(b, "output_tokens"),
    output_tokens_details: { reasoning_tokens: nested(a, "output_tokens_details", "reasoning_tokens") + nested(b, "output_tokens_details", "reasoning_tokens") },
  };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function VerifyLoop({ kind, effort: initialEffort = "medium" }: VerifyLoopProps) {
  const id = useId();
  const spec: LoopSpec = kind === "game" ? GAME_LOOP : SITE_LOOP;
  const runner = useDocsRun();
  const frame = useRef<SandboxHandle | null>(null);
  const [build, setBuild] = useState(spec.build);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>(initialEffort);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [html, setHtml] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [chars, setChars] = useState(0);
  const [refineText, setRefineText] = useState(spec.refine[0]?.prompt ?? "");
  const [showCode, setShowCode] = useState(false);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const lastId = useRef<string | null>(null);
  const htmlRef = useRef<string | null>(null);
  const stopped = useRef(false);
  const running = runner.state === "running" || phase !== null;

  const buildBody = (): Json => ({
    model,
    instructions: `You are a coding agent building a web page. ${SINGLE_FILE_OUTPUT}`,
    input: build,
    ...(effort ? { reasoning: { effort } } : {}),
    max_output_tokens: 16384,
    stream: true,
  });

  /** Streams one call, with retries for a transient error or the rate limit; `prefix` characters are already written. */
  const streamOnce = async (body: Json, prefix: number): Promise<{ res: DocsResult; r: Collected }> => {
    let collector = responsesCollector();
    const res = await withRetries(
      () => {
        collector = responsesCollector();
        const c = collector;
        const onEvent = (e: SseEvent) => {
          c.push(e);
          setChars(prefix + c.snapshot().text.length);
        };
        return runner.run("responses", { method: "POST", body, stream: true, onEvent });
      },
      { stopped: () => stopped.current, onRetry: (n) => setWaitNote(retryText(n)), onResume: () => setWaitNote(null) },
    );
    setWaitNote(null);
    return { res, r: collector.snapshot() };
  };

  /**
   * One model turn: the new file (or null) and the reply's review text. A reply that stops at the 16,384-token cap
   * before </html> gets one Continue on the same chain, and the two parts are joined, as the one-shot demo does: a
   * live build of the kart racer at medium effort stopped there (Oct 30, 2026).
   */
  const turn = async (body: Json, label: string): Promise<{ html: string | null; review: string; usage: unknown; model: string | null; usd: number; cutOff: boolean; continued: boolean } | null> => {
    setPhase(label);
    setChars(0);
    const first = await streamOnce(body, 0);
    if (!first.res.ok || stopped.current) {
      setPhase(null);
      return null;
    }
    const isCut = (r: Collected) => r.status === "incomplete" || r.finishReason === "max_output_tokens";
    const complete = (text: string) => {
      const page = extractHtml(text);
      return page && /<\/html>/i.test(page) ? page : null;
    };
    let last = first.r;
    let text = last.text;
    let usd = replyUsd(first.res.model ?? model, last.final);
    let continued = false;
    let usage: unknown = last.usage;
    lastId.current = last.id ?? lastId.current;
    if (isCut(last) && !complete(text) && last.id) {
      setPhase(`${label}: the reply hit the output limit, so it continues the same file`);
      const more = await streamOnce(
        { model, previous_response_id: last.id, input: CONTINUE_FILE, ...(effort ? { reasoning: { effort } } : {}), max_output_tokens: 16384, stream: true },
        text.length,
      );
      if (stopped.current) {
        setPhase(null);
        return null;
      }
      if (more.res.ok) {
        continued = true;
        text = text.replace(/```\s*$/, "") + more.r.text;
        usd += replyUsd(more.res.model ?? model, more.r.final);
        usage = sumUsage(usage, more.r.usage);
        last = more.r;
        lastId.current = last.id ?? lastId.current;
      }
    }
    return {
      html: complete(text),
      review: reviewText(first.r.text),
      usage,
      model: first.res.model,
      usd,
      cutOff: isCut(last),
      continued,
    };
  };

  /** Loads a file into the frame and plays the recipe's check on it (or a refinement pass's own check). */
  const check = async (page: string, probes = spec.probes, probeLabels = spec.probeLabels): Promise<{ shots: Shot[]; console: string[]; snapshot: string }> => {
    setChars(0);
    if (document.hidden) {
      // A page that starts up in a hidden tab gets no animation frames (and can lay out at zero size), so the check
      // would report bugs a visible browser doesn't have.
      setPhase("Waiting for this tab to be visible: the new page loads and runs in it.");
      await whenTabVisible();
    }
    htmlRef.current = page;
    setHtml(page);
    setPhase("Loading the page in the sandbox");
    await sleep(2500);
    const shots: Shot[] = [];
    let snapshot = "";
    for (let i = 0; i < probes.length; i++) {
      if (stopped.current) break;
      const label = `Browser check: ${probeLabels[i]}`;
      setPhase(label);
      const cap = (await frame.current?.capture(probes[i], { maxSide: 1024, onWait: (why) => setPhase(`${label}. ${why}`) })) ?? null;
      setPhase(label);
      shots.push({ label: probeLabels[i], url: cap?.screenshot ?? null, note: cap?.error });
      snapshot = cap?.snapshot || snapshot;
    }
    const logs = (frame.current?.logs() ?? []).map((l) => `[${l.level}] ${l.text}`);
    return { shots, console: logs, snapshot };
  };

  const addRound = (r: Round) => setRounds((cur) => [...cur, r]);

  const verifyRound = async (title: string): Promise<boolean> => {
    const page = htmlRef.current;
    if (!page || !lastId.current) return false;
    const seen = await check(page);
    if (stopped.current) return false;
    const content: Json[] = [{ type: "input_text", text: checkText(spec.check, seen.console, seen.snapshot) }];
    for (const s of seen.shots) if (s.url) content.push({ type: "input_image", image_url: s.url });
    const body: Json = {
      model,
      previous_response_id: lastId.current,
      input: [{ role: "user", content }],
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 16384,
      stream: true,
    };
    const t = await turn(body, `${title}: the model reviews the screenshots and fixes the code`);
    if (!t) return false;
    addRound({ title, prompt: spec.check, review: t.review, html: t.html, shots: seen.shots, console: seen.console, usage: t.usage, model: t.model, usd: t.usd, cutOff: t.cutOff, continued: t.continued, body });
    if (t.html) {
      const after = await check(t.html);
      setRounds((cur) => cur.map((r, i) => (i === cur.length - 1 ? { ...r, shots: [...r.shots, ...after.shots.map((s) => ({ ...s, label: `After the fix: ${s.label}` }))] } : r)));
    }
    setPhase(null);
    return true;
  };

  const runLoop = async () => {
    stopped.current = false;
    setRounds([]);
    setHtml(null);
    htmlRef.current = null;
    lastId.current = null;
    const body = buildBody();
    const t = await turn(body, "Round 1: writing the page");
    if (!t) return;
    addRound({ title: "Round 1: build", prompt: build, review: t.review, html: t.html, shots: [], console: [], usage: t.usage, model: t.model, usd: t.usd, cutOff: t.cutOff, continued: t.continued, body });
    if (!t.html) return setPhase(null);
    htmlRef.current = t.html;
    await verifyRound("Round 2: browser check and fix");
    setPhase(null);
  };

  const refine = async () => {
    if (!lastId.current || !refineText.trim()) return;
    stopped.current = false;
    // A preset pass brings its own check (Pass 3 drives both ways and looks from above; Pass 4 samples the camera).
    const pass = spec.refine.find((p) => p.prompt === refineText);
    const body: Json = {
      model,
      previous_response_id: lastId.current,
      input: `${refineText.trim()}\n\n${SINGLE_FILE_OUTPUT}`,
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 16384,
      stream: true,
    };
    const t = await turn(body, pass ? `Refining: ${pass.label}` : "Refining");
    if (!t) return;
    addRound({ title: pass ? `Refinement, ${pass.label}` : "Refinement pass", prompt: refineText.trim(), review: t.review, html: t.html, shots: [], console: [], usage: t.usage, model: t.model, usd: t.usd, cutOff: t.cutOff, continued: t.continued, body });
    if (t.html) {
      htmlRef.current = t.html;
      const after = await check(t.html, pass?.probes ?? spec.probes, pass?.probeLabels ?? spec.probeLabels);
      setRounds((cur) => cur.map((r, i) => (i === cur.length - 1 ? { ...r, shots: after.shots, console: after.console } : r)));
    }
    setPhase(null);
  };

  const stop = () => {
    stopped.current = true;
    runner.abort();
    setPhase(null);
  };

  const total = rounds.reduce((s, r) => s + r.usd, 0);

  return (
    <div className="pg">
      <label className="pg-label" htmlFor={`${id}-build`}>
        Build prompt
      </label>
      <TextArea id={`${id}-build`} rows={4} value={build} onChange={(e) => setBuild(e.target.value)} disabled={running} />
      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
      </div>
      <p className="pg-hint">
        Two model rounds, each up to 16,384 output tokens (a reply that reaches that limit mid-file gets one Continue), plus two screenshots sent back: a
        few minutes and well under a cent on Spark Contributor.{" "}
        {kind === "game" ? "No asset downloads here, so the kart is built from shapes." : ""}
      </p>
      <div className="pg-actions">
        <RunButton running={running} onRun={() => void runLoop()} onStop={stop} label="Build, check in the browser, fix" disabled={!build.trim()} />
        {phase ? (
          <span className="pg-hint" role="status">
            {phase}
            {chars ? `: ${chars.toLocaleString()} characters` : ""}
          </span>
        ) : total ? (
          <span className="pg-hint">{formatUsd(total)} est. so far</span>
        ) : null}
      </div>
      {waitNote ? (
        <div className="pg-hint" role="status">
          {waitNote}
        </div>
      ) : null}
      <ErrorBox error={waitNote ? null : runner.error} />

      {html ? (
        <div className={styles.stack}>
          <SandboxFrame ref={frame} html={html} title={spec.frameTitle} viewport={{ width: 1280, height: 800 }} />
          <div className={styles.row}>
            <span className="pg-hint">{kind === "game" ? "Click the game, then drive with WASD or the arrows." : "Move your cursor over the logo."} Sandboxed: scripts only.</span>
            <button type="button" className="btn btn-sm" onClick={() => html && download("index.html", html)}>
              Download index.html
            </button>
          </div>
        </div>
      ) : null}

      {rounds.map((r, i) => (
        <div key={i} className={styles.card}>
          <p className={styles.cardTitle}>{r.title}</p>
          <details className="pg-advanced">
            <summary className="pg-small">The prompt</summary>
            <p className="pg-small">{r.prompt}</p>
          </details>
          {r.shots.length ? (
            <div className={styles.shots}>
              {r.shots.map((s, j) => (
                <figure key={j} style={{ margin: 0 }}>
                  {s.url ? <img src={s.url} alt={`Screenshot: ${s.label}`} className={styles.shot} /> : <p className="pg-hint">No screenshot{s.note ? `: ${s.note}` : ""}</p>}
                  <figcaption className={styles.shotCaption}>{s.label}</figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          {r.console.length ? (
            <pre className="pg-pre pg-advanced" style={{ maxHeight: 120 }}>
              {r.console.slice(-12).join("\n")}
            </pre>
          ) : null}
          {r.review ? (
            <>
              <p className="pg-section-label">{i === 0 ? "The model's notes" : "What the model saw and fixed"}</p>
              <MarkdownText className={styles.answer} text={r.review} />
            </>
          ) : null}
          {r.continued && !r.cutOff ? <p className="pg-hint">The reply hit the 16,384-token output limit mid-file; one Continue on the same chain finished it.</p> : null}
          {r.cutOff ? <div className="pg-hint pg-bad">This reply hit the output limit before the file ended{r.continued ? ", even after one Continue" : ""}.</div> : null}
          {!r.html && !r.cutOff ? <div className="pg-hint pg-bad">No complete HTML file in this reply.</div> : null}
          <UsageLine model={r.model ?? model} usage={r.usage} />
        </div>
      ))}

      {rounds.length && !running ? (
        <div className={`${styles.card} pg-advanced`}>
          <p className={styles.cardTitle}>Refine, with the browser confirming the change</p>
          <div className="pg-presets" role="group" aria-label="Refinement passes">
            {spec.refine.map((p) => (
              <button key={p.label} type="button" className="pg-pill" aria-pressed={refineText === p.prompt} onClick={() => setRefineText(p.prompt)}>
                {p.label}
              </button>
            ))}
          </div>
          <TextArea rows={4} value={refineText} onChange={(e) => setRefineText(e.target.value)} aria-label="Refinement prompt" />
          <div className="pg-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void refine()} disabled={!refineText.trim()}>
              Run this pass
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void verifyRound("Check again")}>
              Check again and fix
            </button>
          </div>
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={rounds[rounds.length - 1]?.body ?? buildBody()} caption={rounds.length ? "The last request (screenshots as input_image)" : "Round 1"} /> : null}
    </div>
  );
}
