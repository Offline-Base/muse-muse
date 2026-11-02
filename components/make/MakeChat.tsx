"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import "@/components/build/plan-card.css";
import "@/components/make/make.css";
import "@/components/train/tune.css";
import { BUILD_AS_USUAL, Composer, errorMessage, writeMakeDraft, type ComposerCopy } from "@/components/composer/Composer";
import type { StarterTab } from "@/components/composer/Starters";
import { Icon } from "@/components/icons";
import type { BaseChoice } from "@/components/train/BasePicker";
import { FolderDrop, type ReadyFolder } from "@/components/train/compose/FolderDrop";
import { PlanStep, tuneErrorText, type Phase } from "@/components/train/compose/TrainComposer";
import { askedText, KEPT_PLAN_KEY } from "@/components/train/room/TrainRoom";
import type { TargetId } from "@/lib/brief/schema";
import { connectWords, WHILE_TRAINING, type ConnectMode } from "@/lib/make/connect";
import type { MakeKind } from "@/lib/make/intent";
import type { MakeWant } from "@/lib/make/want";
import type { MakeTrain } from "@/lib/make/page-props";
import { SKIP_WORDS } from "@/lib/train/tune/folder";
import { planRows, splitNote } from "@/lib/train/tune/examples";
import { NOTE_MIN, TUNE_MIN_EXAMPLES, TUNE_STEPS } from "@/lib/train/tune/settings";
import type { TrainPlan } from "@/lib/train/tune/types";
import type { Reference } from "@/lib/types";

const COPY: ComposerCopy = {
  form: "What to make",
  field: "Ask for a product, a tuned model, or both",
};

interface Asked {
  raw: string;
  references: Reference[];
  targets: TargetId[];
  want: MakeWant;
}

interface Intent {
  kind: Exclude<MakeKind, "product">;
  appNote: string | null;
  modelNote: string;
  connect: ConnectMode;
  appBlock: string | null;
}

const keep = (key: string, value: unknown) => {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be blocked. The room does without it.
  }
};

/**
 * The Make page's box with MAKE_CHAT_ALL on (docs/TRAINING.md "One box for everything"): one sentence asks for a product,
 * a tuned model, or both. A product goes on exactly as it always did. A model or both shows the same plan card as
 * /fine-tuning/new, and nothing starts until Start, with the start code for a non-admin. Everything is the existing
 * routes, so every limit stays on the server: POST /api/make/intent decides, POST /api/train/plan drafts,
 * POST /api/train/runs starts the run, POST /api/inspirations the build, and POST /api/make/pair keeps them together.
 */
export function MakeChat({
  signedIn,
  starters,
  targetOptions,
  contributorNotice,
  train,
  toolbar,
  setup,
}: {
  signedIn: boolean;
  starters: StarterTab[];
  targetOptions: readonly TargetId[];
  contributorNotice: boolean;
  /** Null when this person can't plan a run. */
  train: MakeTrain | null;
  toolbar: ReactNode;
  setup: ReactNode;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ at: "compose" });
  const [intent, setIntent] = useState<Intent | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [ready, setReady] = useState<ReadyFolder | null>(null);
  const [examples, setExamples] = useState(train?.defaultExamples ?? 200);
  const [steps, setSteps] = useState(TUNE_STEPS);
  const [upload, setUpload] = useState(true);
  const [base, setBase] = useState<BaseChoice>({ state: "default" });
  const [onFireworks, setOnFireworks] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startCode, setStartCode] = useState("");
  const [appOnly, setAppOnly] = useState(false);
  const [change, setChange] = useState("");
  /** The model started and the app didn't: says so, with a way to try the app again. */
  const [half, setHalf] = useState<{ runId: string; href: string; text: string } | null>(null);

  const ceilings = train?.ceilings ?? { maxMinutes: 90, maxUsd: 5 };
  const examplesMax = train?.visitor?.maxExamples ?? 1000;

  function fail(raw: string, text: string, offerApp: boolean) {
    setAppOnly(offerApp);
    setPhase({ at: "problem", note: raw, files: [], text });
  }

  async function draft(input: Asked): Promise<string | typeof BUILD_AS_USUAL | null> {
    const split = splitNote(input.raw);
    setAsked(input);
    setStartError(null);
    setAppOnly(false);
    // The menu said exactly what it wants: nothing to work out, so no model call.
    if (input.want === "app") return BUILD_AS_USUAL;
    let said: Record<string, unknown> | null = null;
    if (input.want === "model" || input.want === "dataset") {
      said = { kind: input.want, modelNote: split.note || input.raw };
    } else {
      let res: Response;
      try {
        res = await fetch("/api/make/intent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: split.note || input.raw, hasFolder: Boolean(ready), ...(input.want === "both" ? { want: "both" } : {}) }),
        });
        said = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      } catch {
        return "Couldn't reach Muse Muse. Check your connection and try again.";
      }
      if (!res.ok) {
        if (res.status === 400 && typeof said?.error === "string" && /\s/.test(said.error)) return said.error;
        fail(input.raw, res.status === 502 ? "Muse Muse couldn't tell what this asks for. Try saying it another way, or build it as an app." : tuneErrorText(res.status, said), res.status !== 422);
        return null;
      }
      if (said?.modelOff) {
        fail(input.raw, "Tuning a model isn't open on this account. If you only want an app, build it as one.", true);
        return null;
      }
      if (said?.kind === "product") return BUILD_AS_USUAL;
    }
    const next: Intent = {
      kind: said?.kind === "both" ? "both" : said?.kind === "dataset" ? "dataset" : "model",
      appNote: typeof said?.appNote === "string" ? said.appNote : null,
      modelNote: String(said?.modelNote ?? split.note),
      connect: said?.connect === "window" ? "window" : "none",
      appBlock: typeof said?.appBlock === "string" ? said.appBlock : null,
    };
    if (next.modelNote.trim().length < NOTE_MIN) return `Say what the model should do in at least ${NOTE_MIN} characters.`;
    if (next.kind === "both" && next.appBlock === "sign_in") {
      writeMakeDraft(input.raw);
      router.push(`/sign-in?next=${encodeURIComponent("/")}`);
      return null;
    }
    setIntent(next);
    const names = ready ? ready.review.used.map((f) => f.path).slice(0, 5) : [];
    setPhase({ at: "drafting", note: input.raw, files: names });
    try {
      const count = ready?.draft.mode === "rows" ? Math.max(TUNE_MIN_EXAMPLES, Math.min(examplesMax, ready.draft.rows.length)) : examples;
      const planned = await fetch("/api/train/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          note: next.modelNote,
          examples: planRows(split.rows),
          settings: { examples: count },
          ...(ready ? { folder: { hash: ready.hash, mode: ready.draft.mode, rows: ready.draft.rows.length } } : {}),
        }),
      });
      const data = (await planned.json().catch(() => null)) as { plan?: TrainPlan } | null;
      if (!planned.ok || !data?.plan) {
        fail(input.raw, tuneErrorText(planned.status, data), false);
        return null;
      }
      setExamples(data.plan.settings.examples);
      setSteps(data.plan.settings.steps);
      setPhase({ at: "plan", note: input.raw, files: names, plan: data.plan });
    } catch {
      fail(input.raw, "Couldn't reach Muse Muse. Check your connection and try again.", false);
    }
    return null;
  }

  /** The build, through the same route as any build. Answers its id, or says why not. */
  async function startApp(note: string): Promise<{ buildId: string } | { problem: string }> {
    try {
      const res = await fetch("/api/inspirations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note, references: asked?.references ?? [], ...(asked?.targets.length ? { targets: ["web", ...asked.targets] } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { buildId?: string; error?: string };
      if (res.status === 201 && data.buildId) return { buildId: data.buildId };
      if (res.status === 401) return { problem: "Sign in to build the app." };
      return { problem: errorMessage(res.status, data.error, false) };
    } catch {
      return { problem: "Couldn't reach Muse Muse. Check your connection and try again." };
    }
  }

  async function appThenPair(runId: string, href: string): Promise<void> {
    const app = await startApp(intent?.appNote ?? asked?.raw ?? "");
    if ("problem" in app) {
      setHalf({ runId, href, text: app.problem });
      setStarting(false);
      return;
    }
    const paired = await fetch("/api/make/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buildId: app.buildId, runId }) }).catch(() => null);
    writeMakeDraft("");
    if (!paired?.ok) console.error("[make] the app and the model weren't kept together");
    router.push(paired?.ok ? `/b/${app.buildId}` : href);
  }

  async function start(plan: TrainPlan) {
    if (starting) return;
    const both = intent?.kind === "both";
    // Never pay for half of a request that can't finish: the model would run with no app beside it.
    if (both && intent?.appBlock) {
      setStartError(`Nothing has started, because the app can't start right now: ${errorMessage(intent.appBlock === "paused" || intent.appBlock === "no_storage" ? 503 : 429, intent.appBlock, false)}`);
      return;
    }
    const dataOnly = intent?.kind === "dataset";
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/train/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan,
          ...(train?.visitor ? { startCode } : {}),
          ...(ready && plan.source.kind === "folder" ? { folder: ready.draft } : {}),
          settings: {
            examples,
            steps,
            ...(onFireworks ? { trainer: "fireworks" } : {}),
            // A run for a product never uploads by itself (the pair route holds it to that too).
            ...(both || dataOnly || (train?.autoUpload && !upload) ? { autoPublish: false } : {}),
            ...(dataOnly ? { datasetOnly: true } : {}),
            ...(base.state === "ok" ? { base: { repo: base.base.repo, revision: base.base.revision } } : {}),
          },
        }),
      });
      const data = (await res.json().catch(() => null)) as { runId?: string; href?: string } | null;
      if (res.status !== 201 || !data?.runId || !data.href) {
        setStartError(tuneErrorText(res.status, data));
        setStarting(false);
        return;
      }
      keep(KEPT_PLAN_KEY(data.runId), { tagline: plan.tagline, samples: plan.samples, used: plan.examples.used });
      if (both) return await appThenPair(data.runId, data.href);
      writeMakeDraft("");
      router.push(data.href);
    } catch {
      setStartError("Couldn't reach Muse Muse. Check your connection and try again.");
      setStarting(false);
    }
  }

  async function buildJustTheApp() {
    if (!asked) return;
    setStarting(true);
    const app = await startApp(asked.raw);
    if ("buildId" in app) {
      writeMakeDraft("");
      router.push(`/b/${app.buildId}`);
      return;
    }
    setStarting(false);
    setPhase({ at: "problem", note: asked.raw, files: [], text: app.problem });
  }

  function backToBox() {
    setStartError(null);
    setHalf(null);
    setPhase({ at: "compose" });
  }

  const plan = phase.at === "plan" ? phase.plan : null;
  const review = ready?.review;
  const above = plan ? (
    <>
      <li className="room-answer make-row">
        <p>
          <strong>The task.</strong> {askedText(plan.task)}
        </p>
      </li>
      {intent?.kind === "dataset" ? (
        <li className="room-answer make-row">
          <p>
            <strong>Just the dataset.</strong> Start writes the examples and stops. No GPU starts and nothing trains. You can download them, or tune a model on them later. The training numbers on this card only apply if you do.
          </p>
        </li>
      ) : null}
      {intent?.kind === "both" ? (
        <li className="room-answer make-row">
          <p>
            <strong>The app.</strong> Muse Code builds this on Start, as any build, and it counts toward your builds: {intent.appNote}
          </p>
          <p>{WHILE_TRAINING}</p>
          <p>
            <strong>How they connect.</strong> {connectWords(intent.connect)}
          </p>
          {intent.appBlock ? (
            <p className="form-error" role="alert">
              <Icon name="alert" size={18} />
              <span>The app can&apos;t start right now: {errorMessage(intent.appBlock === "paused" || intent.appBlock === "no_storage" ? 503 : 429, intent.appBlock, false)}</span>
            </p>
          ) : null}
        </li>
      ) : null}
      {plan.source.kind === "folder" && review ? (
        <li className="room-answer make-row">
          <p>
            <strong>Your folder.</strong> {review.used.length} used, {review.skipped.length} skipped.
          </p>
          <ul className="tune-folder-list">
            {review.used.map((f) => (
              <li key={f.path}>{f.path}{f.rows ? ` (${f.rows} rows)` : ""}</li>
            ))}
            {review.skipped.map((f) => (
              <li key={f.path} className="muted">
                {f.path}: skipped, {SKIP_WORDS[f.reason]}
              </li>
            ))}
          </ul>
          {review.samples.length ? (
            <ul className="tune-folder-list">
              {review.samples.map((r) => (
                <li key={r.prompt}>
                  <strong>{r.prompt.slice(0, 200)}</strong> {r.answer.slice(0, 200)}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ) : null}
    </>
  ) : null;

  const below = plan ? (
    <li className="room-answer make-row">
      <form
        className="make-change"
        aria-label="Ask for a change to this plan"
        onSubmit={(e) => {
          e.preventDefault();
          const text = change.trim();
          if (!text || !asked) return;
          setChange("");
          void draft({ ...asked, raw: `${asked.raw}\n\nA change: ${text}` });
        }}
      >
        <input type="text" className="input" value={change} maxLength={400} placeholder="Ask for a change, like use fewer examples" aria-label="Ask for a change" onChange={(e) => setChange(e.target.value)} disabled={starting} />
        <button type="submit" className="btn btn-outline" disabled={starting || !change.trim()}>
          Ask
        </button>
      </form>
      <p className="muted small">Nothing has started. This drafts the plan again. To change the folder, use Change it.</p>
    </li>
  ) : null;

  return (
    <>
      <div className="play" hidden={phase.at !== "compose"}>
        <div className="play-main">
          {toolbar}
          <div className="play-intro">
            <h1>{"What’s your muse?"}</h1>
          </div>
          <Composer
            mode="new"
            signedIn={signedIn}
            starters={starters}
            layout="playground"
            targetOptions={targetOptions}
            contributorNotice={contributorNotice}
            placeholder="Ask for a product, a tuned model, or both..."
            send={({ note, references, targets, want }) => draft({ raw: note, references, targets, want })}
            offerWants={Boolean(train)}
            signedOutMaySend={Boolean(train?.visitor)}
            ignoreHandledDrops
            copy={COPY}
          />
          {train?.codeUnset ? (
            <p className="form-error" role="alert">
              <Icon name="alert" size={18} />
              <span>Starting a model run isn&apos;t open right now. Products still build.</span>
            </p>
          ) : null}
          {train?.folder ? (
            <details className="make-folder" open={Boolean(ready)}>
              <summary>Add a folder of data for a model</summary>
              <FolderDrop ready={ready} onReady={setReady} canLeaveOut />
            </details>
          ) : null}
        </div>
        {setup}
      </div>

      {half ? (
        <div className="room chat-split tune-room" data-settled="true">
          <div className="room-main">
            <ol className="convo" aria-label="What started">
              <li className="room-answer make-row">
                <p role="alert">The model&apos;s run started, but the app didn&apos;t: {half.text}</p>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={starting}
                    onClick={() => {
                      setStarting(true);
                      void appThenPair(half.runId, half.href);
                    }}
                  >
                    Try the app again
                  </button>
                  <Link className="btn btn-outline" href={half.href}>
                    Open the model&apos;s run
                  </Link>
                </div>
              </li>
            </ol>
          </div>
        </div>
      ) : phase.at !== "compose" ? (
        <PlanStep
          phase={phase}
          examples={examples}
          onExamples={setExamples}
          steps={steps}
          onSteps={setSteps}
          autoUpload={intent?.kind === "both" || intent?.kind === "dataset" ? null : (train?.autoUpload ?? null)}
          startLabel={intent?.kind === "dataset" ? "Write the examples" : "Start"}
          codeHint={intent?.kind === "dataset" ? "Writing examples costs real money, so starting takes the code." : undefined}
          upload={upload}
          onUpload={setUpload}
          anyBase={train?.anyBase ?? false}
          fireworks={train?.fireworks ?? false}
          onFireworks={onFireworks}
          setOnFireworks={setOnFireworks}
          base={base}
          onBase={setBase}
          ceilings={ceilings}
          visitor={train?.visitor ?? null}
          startCode={startCode}
          onStartCode={setStartCode}
          starting={starting}
          startError={startError}
          onStart={(p) => void start(p)}
          onChange={backToBox}
          above={above}
          below={below}
          problemActions={
            appOnly ? (
              <button type="button" className="btn btn-primary" disabled={starting} onClick={() => void buildJustTheApp()}>
                Build it as an app
              </button>
            ) : null
          }
        />
      ) : null}
    </>
  );
}
