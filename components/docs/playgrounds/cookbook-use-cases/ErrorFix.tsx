"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { EffortSelect, TextArea, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import type { Effort } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { Diff } from "@/components/docs/playgrounds/cookbook-use-cases/SandboxExec";
import { RunBar, Timeline } from "@/components/docs/playgrounds/cookbook-use-cases/Timeline";
import { useAgentRun, type ToolEntry, type ToolExecutor } from "@/components/docs/playgrounds/cookbook-use-cases/useAgentRun";
import { agentBase, type AgentDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { parseArguments, responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { REPO_TOOL_DEFS, runRepoTool } from "@/components/docs/playgrounds/cookbook-use-cases/lib/repo-tools";
import { BUILD_SYSTEM, PLAN_PROMPT, PLAN_PROMPT_TWO, PLAN_SYSTEM, QUESTION_TOOL, SHOP_FILES, SMOKE_PROMPT, cartSurfaces } from "@/components/docs/playgrounds/cookbook-use-cases/lib/error-fix";
import { CART_SHOT, CART_SHOT_ALT, drawCartShot } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cart-shot";
import { treeDiff } from "@/components/docs/playgrounds/cookbook-use-cases/lib/vfs";

/**
 * cookbook/perception-error-screenshot-fix: OpenCode's Plan then Build over a small Next.js repo, driven by two
 * screenshots of one bug class, as in the recipe's step 4: the checkout crash (a dev overlay that names the file) and
 * the cart page (drawn in the page by lib/cart-shot.ts), which shows only its own UI text, so the model has to find
 * that code from what's on screen. The smoke test checks the image reaches the model. Plan reads the pixels first,
 * searches the repo with read, grep, glob and list, and asks you the fix scope with its question tool; Build applies
 * the plan with exact-once edits. The diff and the list of every place that reads cart.items come last.
 */

/** The cart page screenshot as a picked file, drawn on a canvas. */
async function cartShotFile(): Promise<PickedMedia> {
  const canvas = document.createElement("canvas");
  canvas.width = CART_SHOT.width;
  canvas.height = CART_SHOT.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the sample screenshot.");
  drawCartShot(ctx);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The sample screenshot couldn't be drawn."))), "image/png"));
  return { blob, name: CART_SHOT.name, mime: "image/png", bytes: blob.size, kind: "image", source: "sample", sampleId: "cart-page", description: CART_SHOT_ALT, width: CART_SHOT.width, height: CART_SHOT.height, problems: [] };
}

export interface ErrorFixProps {
  slug: string;
  sampleId?: string;
  prompt?: string;
}

type Json = Record<string, unknown>;

export function ErrorFix({ sampleId = "error-screenshot", prompt: initialPrompt }: ErrorFixProps) {
  const id = useId();
  const run = useAgentRun();
  const smoke = useDocsRun();
  const [shot, setShot] = useState<PickedMedia | null>(null);
  const [shot2, setShot2] = useState<PickedMedia | null>(null);
  const [shot2Error, setShot2Error] = useState<string | null>(null);
  // The prompt follows the screenshots (one or two) until the reader edits it.
  const [edited, setEdited] = useState<string | null>(initialPrompt ?? null);
  const prompt = edited ?? (shot2 ? PLAN_PROMPT_TWO : PLAN_PROMPT);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [files, setFiles] = useState<Record<string, string>>(SHOP_FILES);
  const [planId, setPlanId] = useState<string | null>(null);
  const planHistory = useRef<Record<string, unknown>[] | null>(null);
  const [showCode, setShowCode] = useState(false);
  const filesRef = useRef<Record<string, string>>(SHOP_FILES);
  const diffs = useRef(new Map<string, string>());

  const loadCartShot = () => {
    setShot2Error(null);
    cartShotFile().then(setShot2, (err: unknown) => setShot2Error(err instanceof Error ? err.message : String(err)));
  };
  // Both screenshots by default, as in the recipe's plan step; clear the second to see what one does alone.
  useEffect(() => {
    loadCartShot();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const planAgent: AgentDef = useMemo(
    () => ({
      name: "plan",
      model,
      instructions: PLAN_SYSTEM,
      tools: [REPO_TOOL_DEFS.read, REPO_TOOL_DEFS.grep, REPO_TOOL_DEFS.glob, REPO_TOOL_DEFS.list, QUESTION_TOOL],
      effort,
      maxOutputTokens: 4000,
      // Two screenshots send it down two search paths (the overlay's file name, the cart page's URL and text), so a
      // full plan takes 15 to 18 calls before it asks the scope question.
      maxCalls: 22,
      parallelToolCalls: false,
      state: "replay",
    }),
    [model, effort],
  );
  const buildAgent: AgentDef = useMemo(
    () => ({
      name: "build",
      model,
      instructions: BUILD_SYSTEM,
      tools: [REPO_TOOL_DEFS.read, REPO_TOOL_DEFS.grep, REPO_TOOL_DEFS.edit, REPO_TOOL_DEFS.write],
      effort,
      maxOutputTokens: 6000,
      maxCalls: 16,
      parallelToolCalls: false,
      state: "replay",
    }),
    [model, effort],
  );

  const exec: ToolExecutor = async (agent, call, rt) => {
    const { value, error } = parseArguments(call.arguments);
    if (error) return { output: error, status: "error" };
    if (call.name === "question") {
      const options = Array.isArray(value.options) ? (value.options as Json[]).slice(0, 4) : [];
      const answer = await rt.ask(
        agent.name,
        String(value.question ?? "Which way should I go?"),
        options.map((o, i) => ({ value: String(o.label ?? `Option ${i + 1}`), label: String(o.label ?? `Option ${i + 1}`), hint: typeof o.description === "string" ? o.description : undefined })),
        { title: "Question for you", allowText: true },
      );
      return answer === null ? { output: "The developer didn't answer.", status: "error" } : { output: `The developer picked: ${answer}`, note: "your answer" };
    }
    const r = runRepoTool(call.name, value, filesRef.current);
    if (!r) return { output: `Unknown tool ${call.name}.`, status: "error" };
    if (r.diff) {
      filesRef.current = r.files;
      setFiles(r.files);
      diffs.current.set(call.callId, r.diff);
    }
    return { output: r.output, status: r.ok ? "done" : "error" };
  };

  const firstInput = async (): Promise<Json[]> => {
    const content: Json[] = [{ type: "input_text", text: prompt.trim() }];
    if (shot) content.push({ type: "input_image", image_url: await fileToDataUrl(shot.blob, shot.mime) });
    if (shot2) content.push({ type: "input_image", image_url: await fileToDataUrl(shot2.blob, shot2.mime) });
    return [{ role: "user", content }];
  };

  const startPlan = () => {
    filesRef.current = SHOP_FILES;
    setFiles(SHOP_FILES);
    diffs.current.clear();
    setPlanId(null);
    void run.start(async (rt) => {
      rt.note(`Plan agent (read-only) on the plantwise-shop repo, ${Object.keys(SHOP_FILES).length} files, with ${shot2 ? "two screenshots" : "the screenshot"} attached.`);
      const r = await rt.run(planAgent, await firstInput());
      const last = r.response?.id;
      if (r.stoppedBy === "answer" && typeof last === "string") {
        planHistory.current = r.history ?? null;
        setPlanId(last);
        rt.note("The plan is ready. Switch to Build to apply it.", "good");
      } else if (r.stoppedBy === "limit") rt.note("Guard: the Plan agent hit its call limit.", "warn");
    }, exec);
  };

  const startBuild = () => {
    if (!planId) return;
    void run.start(async (rt) => {
      rt.note("Switched OpenCode from Plan to Build. Same session: the plan, the screenshot and the files it read stay in context.");
      // The build agent continues the plan's response chain, with its own instructions and edit tools.
      const r = await rt.run(buildAgent, "ok build it", 0, planHistory.current ? { history: planHistory.current } : { previousResponseId: planId });
      if (r.stoppedBy === "answer") rt.note("Build finished. The diff and the surfaces to spot-check are below.", "good");
      else if (r.stoppedBy === "limit") rt.note("Guard: the Build agent hit its call limit.", "warn");
    }, exec);
  };

  const runSmoke = async () => {
    if (!shot) return;
    await smoke.run("responses", {
      method: "POST",
      body: {
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: SMOKE_PROMPT }, { type: "input_image", image_url: await fileToDataUrl(shot.blob, shot.mime) }] }],
        reasoning: { effort: "low" },
        max_output_tokens: 2000,
      },
    });
  };

  const patch = treeDiff(SHOP_FILES, files);
  const check = cartSurfaces(files);
  const renderTool = (e: ToolEntry): ReactNode => {
    const d = diffs.current.get(e.callId);
    return d ? <Diff patch={d} /> : undefined;
  };
  const smokeText = smoke.result?.ok ? responseText(smoke.result.json) : "";

  return (
    <div className="pg">
      <div className={styles.grid2}>
        <FilePicker accept="image/*" value={shot} onChange={setShot} samples={["error-screenshot"]} defaultSampleId={sampleId} preview="compact" label="The bug screenshot" disabled={run.busy} />
        <div className={shot2Error ? styles.stack : `${styles.stack} pg-advanced`}>
          <FilePicker
            accept="image/*"
            value={shot2}
            onChange={setShot2}
            samples={false}
            preview="compact"
            label="A second instance (optional)"
            hint="Two screenshots of the same bug class push the model toward the shared root cause."
            disabled={run.busy}
          />
          <div className={styles.row}>
            <button type="button" className="pg-pill" aria-pressed={shot2?.sampleId === "cart-page"} onClick={loadCartShot} disabled={run.busy}>
              Sample: the cart page
            </button>
            {shot2 ? (
              <button type="button" className="btn btn-sm" onClick={() => setShot2(null)} disabled={run.busy}>
                One screenshot only
              </button>
            ) : null}
          </div>
          <p className="pg-hint">
            The sample is the same bug in a production build: the cart page with an empty cart, where only the order summary&apos;s fallback text shows. No file
            names or stack, so the model has to find the code from what&apos;s on screen.
          </p>
          {shot2Error ? <div className="pg-hint pg-bad">{shot2Error}</div> : null}
        </div>
      </div>

      <div className={smoke.error ? styles.card : `${styles.card} pg-advanced`}>
        <p className={styles.cardTitle}>Step 0: verify image input works</p>
        <div className="pg-actions">
          <button type="button" className="btn btn-sm" onClick={() => void runSmoke()} disabled={!shot || smoke.state === "running"}>
            {smoke.state === "running" ? "Asking..." : `Ask "${SMOKE_PROMPT}"`}
          </button>
          {smoke.result?.json ? <UsageLine model={smoke.result.model ?? model} usage={(smoke.result.json as Json).usage} /> : null}
        </div>
        {smokeText ? <MarkdownText className={styles.answer} text={smokeText} /> : null}
        <ErrorBox error={smoke.error} />
      </div>

      <label className="pg-label pg-advanced" htmlFor={`${id}-prompt`}>
        Your message to the Plan agent
      </label>
      <TextArea id={`${id}-prompt`} className="pg-advanced" rows={3} value={prompt} onChange={(e) => setEdited(e.target.value)} disabled={run.busy} />
      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} disabled={run.busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={run.busy} />
        <Toggle id={`${id}-step`} label="Pause after each step" checked={run.stepMode} onChange={run.setStepMode} />
      </div>
      <div className="pg-actions">
        <RunButton running={run.busy} onRun={startPlan} onStop={run.stop} label="Plan the fix" disabled={!shot || !prompt.trim()} />
        <button type="button" className={`btn btn-sm btn-primary${planId ? "" : " pg-advanced"}`} onClick={startBuild} disabled={run.busy || !planId}>
          ok build it
        </button>
        <span className="pg-hint pg-advanced">Plan and Build together are usually 15 to 30 short calls, under half a cent on Spark Contributor; Muse Wonder costs 40 to 100 times as much per token.</span>
      </div>
      <RunBar busy={run.busy} modelCalls={run.modelCalls} totalUsd={run.totalUsd} waitingStep={run.waitingStep} onAdvance={run.advance} />
      <ErrorBox error={run.error} />
      <Timeline entries={run.entries} onAnswer={run.answer} renderTool={renderTool} order={["plan", "build"]} label="OpenCode session" />

      {patch ? (
        <div className={styles.card}>
          <p className={styles.cardTitle}>Resulting diff</p>
          <Diff patch={patch} />
        </div>
      ) : null}
      <div className={patch ? styles.card : `${styles.card} pg-advanced`}>
        <p className={styles.cardTitle}>Surfaces that read cart.items</p>
        <p className="pg-hint">
          {check.loaderNormalizes || check.apiAlwaysItems
            ? "The cart now always carries items at the source, so every caller is covered."
            : "The API still leaves items out for an empty cart, so each caller needs its own guard."}
        </p>
        <ul className="pg-checks">
          {check.surfaces.map((s) => (
            <li key={`${s.path}:${s.line}`} className={s.guarded ? "pg-check-ok" : ""}>
              <span className="pg-check-mark">{s.guarded ? "✓" : "✗"}</span> <span className={styles.mono}>{`${s.path}:${s.line}`}</span> {s.text}
            </li>
          ))}
        </ul>
      </div>

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <CodeView
          method="POST"
          path="responses"
          body={{ ...agentBase(planAgent), input: [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: "data:image/png;base64,<BASE64>" }] }] }}
          caption="The Plan agent's first call: read-only tools, the question tool, and the screenshot"
        />
      ) : null}
    </div>
  );
}
