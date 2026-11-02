"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { PlanViewCard } from "@/components/build/PlanCard";
import { UPLOAD_STAYS_TEXT, uploadPlanText, type UploadVisibility } from "@/lib/train/tune/auto-publish";
import { TitleChip, UserBubble, WorkingStep } from "@/components/chat";
import { Composer, writeComposerDraft, type ComposerCopy, type Example } from "@/components/composer/Composer";
import { SetupPanel, type SetupRow } from "@/components/composer/SetupPanel";
import { Icon } from "@/components/icons";
import { BasePicker, type BaseChoice } from "@/components/train/BasePicker";
import { errorCode, roughMinutes, WRITER_NAME } from "@/components/train/format";
import { R30B_NAME } from "@/components/train/results";
import { planCostText, planViewFromTrainPlan, upperFirst } from "@/components/train/room/plan";
import { KEPT_PLAN_KEY } from "@/components/train/room/TrainRoom";
import { ExternalLink } from "@/components/ui";
import { usd } from "@/lib/format";
import { contributorSwitchOn } from "@/lib/meta/spark";
import { CONTRIBUTOR_TUNE_NOTICE, ContributorNotice } from "@/components/composer/ContributorNotice";
import { BUILT_WITH_SPARK_OPEN, R30B_URL } from "@/lib/train/base";
import { tuneBaseOf } from "@/lib/train/bases";
import { maxStepsFor, NOTE_MAX, NOTE_MIN, planCost, planMaxUsd, planSettings, TUNE_MAX_EXAMPLES, TUNE_MIN_EXAMPLES, TUNE_MIN_STEPS, TUNE_STEPS } from "@/lib/train/tune/cost";
import { EXAMPLE_ACCEPT, EXAMPLE_FILE_MAX_BYTES, EXAMPLE_ROWS_MAX, parseExamples, planRows, splitNote } from "@/lib/train/tune/examples";
import { TUNE_DRAFT_ID } from "@/lib/train/tune/from-build";
import { FolderDrop, type ReadyFolder } from "@/components/train/compose/FolderDrop";
import type { FireworksQuote } from "@/lib/train/fireworks/quote";
import type { ExampleRow, TrainPlan } from "@/lib/train/tune/types";

/** Keeps this composer's draft apart from the Make page's (the build room's "Its own model" fills it too). */
const DRAFT_ID = TUNE_DRAFT_ID;
/** The plan before Start, so a reload keeps the card (it's good for two hours, and the server checks that). */
const PLAN_KEY = "mm:tune-plan";
/** The folder a plan is for: Start sends it back. Too big for some browsers' storage, and then the folder is dropped again. */
const FOLDER_KEY = "mm:tune-folder";

const EXAMPLES: Example[] = [
  { label: "Bakery helper", note: "Answer questions for a small neighborhood bakery: opening hours, allergens, custom cake orders and pickup. Warm, short answers, like the counter staff." },
  { label: "Ticket sorter", note: "Read a customer support message for a made-up app and say which team should take it (billing, bugs, accounts or feedback) with one line on why." },
  { label: "Plant care coach", note: "Help beginners keep houseplants alive: watering, light, repotting and pests. Ask one short question when the plant or the problem isn't clear." },
];

const COPY: ComposerCopy = {
  form: "What your model should do",
  field: "What should your model do? Add examples if you have them",
  attach: "Add examples",
  attachTitle: "Add a CSV or JSONL of examples",
  hint: "Add a CSV or JSONL of examples, or paste a few Q: and A: lines under your note.",
  send: "Plan it",
  sending: "Planning",
  empty: "Say what the model should do first.",
};

/** A file the box takes for a run: a CSV, TSV, JSONL, JSON or text file under 512 KB, shown with the file icon. */
function acceptExampleFile(file: File): { kind: "pdf" } | { problem: string } {
  if (!/\.(csv|tsv|jsonl|json|txt)$/i.test(file.name)) {
    return { problem: `${file.name || "That file"} isn't a CSV, JSONL or text file of examples.` };
  }
  if (file.size > EXAMPLE_FILE_MAX_BYTES) return { problem: `${file.name} is over 512 KB. Use up to ${EXAMPLE_ROWS_MAX} rows.` };
  return { kind: "pdf" };
}

export type Phase =
  | { at: "compose" }
  | { at: "drafting"; note: string; files: string[] }
  | { at: "plan"; note: string; files: string[]; plan: TrainPlan }
  | { at: "problem"; note: string; files: string[]; text: string };

/** Whether Advanced's number is one a run may ask for (40 to 1000). */
function examplesOk(n: number, max: number = TUNE_MAX_EXAMPLES): boolean {
  return Number.isInteger(n) && n >= TUNE_MIN_EXAMPLES && n <= max;
}

/** Whether Advanced's training steps are ones the run may ask for: 10 to as many as fit in its time limit (maxStepsFor). */
function stepsOk(n: number, max: number): boolean {
  return Number.isInteger(n) && n >= TUNE_MIN_STEPS && n <= max;
}

/** What the composer says when a route refuses, from its status and code. */
export function tuneErrorText(status: number, body: unknown): string {
  const code = errorCode(body);
  const refusal = body && typeof body === "object" ? (body as { refusal?: unknown }).refusal : null;
  if (status === 422 && typeof refusal === "string" && refusal.trim()) return refusal.trim();
  // The visitor limits' and the start code's own sentences.
  const message = body && typeof body === "object" ? (body as { message?: unknown }).message : null;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (code === "folder_changed") return "This folder changed after the plan was drafted. Drop it again.";
  if (code === "folder_writer_off") return "Spark 1.3 Contributor isn't on here, so these files can't be written from. Rows with a prompt and an answer still work.";
  if (code === "rate_limited") {
    const s = Number((body as { retryAfterSeconds?: unknown }).retryAfterSeconds);
    return `That's 20 plans this hour. Try again in ${Number.isFinite(s) ? roughMinutes(Math.ceil(s / 60)) : "a little while"}.`;
  }
  if (code === "meta_not_configured") return `Meta's API isn't connected on this deployment, so ${WRITER_NAME} can't plan or write examples.`;
  if (code === "paused") return "The platform's daily spend cap on Meta's API is reached, so new runs can't start until midnight UTC.";
  if (code === "plan_failed") return `${WRITER_NAME} didn't come back with a plan. Try again.`;
  if (code === "plan_expired") return "This plan is more than two hours old. Change it and send it again.";
  if (code === "plan_invalid") return "This plan changed after it was drafted, so it can't start. Change it and send it again.";
  if (code === "already_started") return "This plan already started. Its run is in the fine-tuning lab.";
  if (code === "start_failed") return "The run couldn't start, so nothing was written. Try again in a moment.";
  if (code === "build_not_found") return "That build isn't there any more, or has no product yet.";
  if (code === "build_not_ready") return "That build needs to be live, with Muse Glimmer in its brief, before it can plan its own model.";
  if (code === "not_owner") return "Only the product's owner or an admin can plan its own model.";
  if (code === "product_daily") return "This product already started a run today. Try again tomorrow (UTC).";
  if (status === 413) return "Those examples are too long to send. Use shorter rows or fewer of them.";
  if (status === 401 || status === 403) return "Only admins can train models here.";
  if (status === 404) return "Fine-tuning from here isn't switched on.";
  if (status === 400 && code && /\s/.test(code)) return code;
  return "Something went wrong on our side. Try again in a moment.";
}

/** The person's rows from their files and their note, at most EXAMPLE_ROWS_MAX, or the first problem that stops them. */
async function readRows(files: File[], pasted: ExampleRow[]): Promise<{ rows: ExampleRow[] } | { problem: string }> {
  const rows = [...pasted];
  for (const file of files) {
    const parsed = parseExamples(await file.text(), file.name);
    if (!parsed.rows.length) return { problem: `${file.name} has no rows with a prompt and an answer.` };
    rows.push(...parsed.rows);
  }
  return { rows: planRows(rows) };
}

/**
 * Where it trains, with FIREWORKS_TUNE on. What it costs comes from Fireworks' live pages through the quote route, never
 * from this file: with no confirmed quote the choice is off and says why.
 */
function FireworksChoice({ on, onChange, disabled }: { on: boolean; onChange: (on: boolean) => void; disabled: boolean }) {
  const [quote, setQuote] = useState<FireworksQuote | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/train/fireworks/quote")
      .then((r) => r.json())
      .then((q: FireworksQuote) => {
        if (live) setQuote(q);
      })
      .catch(() => {
        if (live) setQuote({ ok: false, reason: "Fireworks' prices couldn't be checked." });
      });
    return () => {
      live = false;
    };
  }, []);
  const usable = quote?.ok === true;
  return (
    <fieldset className="field">
      <legend>Where it trains</legend>
      <label>
        <input type="radio" name="tune-trainer" checked={!on} onChange={() => onChange(false)} disabled={disabled} /> Lambda, on {R30B_NAME}
      </label>
      <label>
        <input type="radio" name="tune-trainer" checked={on} onChange={() => onChange(true)} disabled={disabled || !usable} /> Train on Fireworks, on plain Muse Glimmer 30B
      </label>
      {quote === null ? <span className="field-hint">Checking Fireworks&apos; prices.</span> : null}
      {quote && !quote.ok ? <span className="field-hint">{quote.reason}</span> : null}
      {quote?.ok ? (
        <span className="field-hint">
          Its base is plain Muse Glimmer 30B, not r30b, so it lacks the 2026 knowledge. Fireworks&apos; pricing page says, as of now: &quot;{quote.words}&quot;. Answering the kept-aside prompts is billed separately at about ${quote.ratePerMTokens.toFixed(2)} per million tokens or less, and counts against your limits. Scoring and any examples written still use Meta&apos;s API.
        </span>
      ) : null}
    </fieldset>
  );
}

/** The plan kept before a reload, while it can still start and is for the same build (or none) as this page. */
function readPlan(fromBuildId: string | null): Phase | null {
  try {
    const raw = window.sessionStorage.getItem(PLAN_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as { note: string; files: string[]; plan: TrainPlan };
    const source = kept.plan.source;
    const buildId = source?.kind === "build" ? source.buildId : null;
    if (buildId !== fromBuildId) return null;
    return Date.parse(kept.plan.exp) > Date.now() ? { at: "plan", ...kept } : null;
  } catch {
    return null;
  }
}

function keep(key: string, value: unknown) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be blocked. The plan stays on the page.
  }
}

/**
 * /fine-tuning/new (docs/TRAINING.md "Fine-tune like a build"): one box, "What should your model do?", with a CSV or
 * JSONL of examples or a few pasted pairs, and the Make page's look. Send turns the page into the room at once: the
 * person's words, Muse Wonder drafting the plan, then the plan card with the mascot presenting and Start, Change it and
 * Advanced. Start begins the run (POST /api/train/runs) and the page becomes its room at /fine-tuning/runs/{id}.
 */
export function TrainComposer({
  defaultExamples,
  ceilings,
  fromBuild = null,
  autoUpload = null,
  anyBase = false,
  visitor = null,
  folder = false,
  fireworks = false,
  codeUnset = false,
}: {
  /** OPEN_TRAIN: a non-admin, with their limits. Start asks for the start code. */
  visitor?: { maxExamples: number; maxSteps: number } | null;
  /** TUNE_FOLDER: offer the folder drop. */
  folder?: boolean;
  /** FIREWORKS_TUNE: offer Train on Fireworks beside Lambda. */
  fireworks?: boolean;
  /** OPEN_TRAIN with no start code set: non-admins can't start, so the page says so. */
  codeUnset?: boolean;
  /** TUNE_ANY_BASE: Advanced offers a base. */
  anyBase?: boolean;
  /** How this run's model uploads by itself (TUNE_AUTO_PUBLISH), or null when it doesn't. */
  autoUpload?: UploadVisibility | null;
  defaultExamples: number;
  ceilings: { maxMinutes: number; maxUsd: number };
  /** The build its own model is planned for (the build room's "Its own model"), or null. */
  fromBuild?: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ at: "compose" });
  const [examples, setExamples] = useState(defaultExamples);
  const [steps, setSteps] = useState(TUNE_STEPS);
  const [upload, setUpload] = useState(true);
  const [base, setBase] = useState<BaseChoice>({ state: "default" });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startCode, setStartCode] = useState("");
  const [onFireworks, setOnFireworks] = useState(false);
  const [ready, setReady] = useState<ReadyFolder | null>(null);

  // A plan drafted before a reload comes back, while it can still start.
  const fromBuildId = fromBuild?.id ?? null;
  useEffect(() => {
    const kept = readPlan(fromBuildId);
    let keptFolder: ReadyFolder | null = null;
    try {
      keptFolder = JSON.parse(window.sessionStorage.getItem(FOLDER_KEY) ?? "null") as ReadyFolder | null;
    } catch {
      // No folder kept: a folder plan below is left out.
    }
    if (kept?.at === "plan" && kept.plan.source.kind === "folder" && !keptFolder) return;
    if (kept?.at === "plan") {
      if (keptFolder) setReady(keptFolder);
      setPhase(kept);
      setExamples(kept.plan.settings.examples);
      setSteps(kept.plan.settings.steps);
    }
  }, [fromBuildId]);

  const examplesMax = visitor?.maxExamples ?? TUNE_MAX_EXAMPLES;
  const defaults = useMemo(() => planSettings(defaultExamples, ceilings), [defaultExamples, ceilings]);
  const defaultCost = useMemo(() => planCost(defaults), [defaults]);
  const rows: SetupRow[] = [
    ["Model", R30B_NAME, "Muse Muse's own Glimmer; a LoRA adapter on its 4-bit build"],
    ["Examples", `About ${defaults.examples}`, `${WRITER_NAME} writes them, and keeps some aside to score it`],
    ["Training steps", String(defaults.steps), `LoRA rank ${defaults.loraRank}, learning rate ${defaults.learningRate}`],
    ["GPU", "1x A100 SXM4 (40 GB)", "Another Muse Glimmer GPU when it isn't free"],
    ["Limits", `Up to ${defaults.maxMinutes} minutes and ${usd(defaults.maxUsd)}`, "The GPU always shuts down at either"],
    ["Scoring", "On", `${WRITER_NAME} judges the 2026 Glimmer it started from against the tuned model on the kept-aside prompts`],
    ["Publish", "Off", "Publish to Hugging Face later, from the job's page"],
  ];

  async function send({ note: raw, files }: { note: string; files: File[] }): Promise<string | null> {
    const split = splitNote(raw);
    const note = split.note;
    if (note.length < NOTE_MIN) return `Say what the model should do in at least ${NOTE_MIN} characters.`;
    if (note.length > NOTE_MAX) return `Keep it under ${NOTE_MAX} characters. Add the rest as examples.`;
    const read = ready ? { rows: [] } : await readRows(files, split.rows);
    if ("problem" in read) return read.problem;
    const names = ready ? ready.review.used.map((f) => f.path).slice(0, 5) : files.map((f) => f.name);
    setPhase({ at: "drafting", note: raw, files: names });
    setStartError(null);
    let res: Response;
    let data: unknown = null;
    try {
      res = await fetch("/api/train/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A cleared or out of range Advanced number is left out, so the plan takes the default.
        body: JSON.stringify({
          note,
          examples: read.rows,
          ...(examplesOk(examples, examplesMax) ? { settings: { examples: ready?.draft.mode === "rows" ? Math.max(TUNE_MIN_EXAMPLES, Math.min(examplesMax, ready.draft.rows.length)) : examples } } : {}),
          ...(fromBuildId ? { fromBuildId } : {}),
          ...(ready ? { folder: { hash: ready.hash, mode: ready.draft.mode, rows: ready.draft.rows.length } } : {}),
        }),
      });
      data = await res.json().catch(() => null);
    } catch {
      setPhase({ at: "problem", note: raw, files: names, text: "Couldn't reach Muse Muse. Check your connection and try again." });
      return null;
    }
    const plan = res.ok && data && typeof data === "object" ? (data as { plan?: TrainPlan }).plan : undefined;
    if (!plan) {
      setPhase({ at: "problem", note: raw, files: names, text: tuneErrorText(res.status, data) });
      return null;
    }
    keep(PLAN_KEY, { note: raw, files: names, plan });
    keep(FOLDER_KEY, ready);
    setExamples(plan.settings.examples);
    setSteps(plan.settings.steps);
    setPhase({ at: "plan", note: raw, files: names, plan });
    return null;
  }

  async function start(plan: TrainPlan) {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/train/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, ...(visitor ? { startCode } : {}), ...(ready && plan.source.kind === "folder" ? { folder: ready.draft } : {}), settings: { examples, steps, ...(onFireworks ? { trainer: "fireworks" } : {}), ...(autoUpload && !upload ? { autoPublish: false } : {}), ...(base.state === "ok" ? { base: { repo: base.base.repo, revision: base.base.revision } } : {}) } }),
      });
      const data = (await res.json().catch(() => null)) as { runId?: string; href?: string } | null;
      if (res.status === 201 && data?.runId && data.href) {
        keep(KEPT_PLAN_KEY(data.runId), { tagline: plan.tagline, samples: plan.samples, used: plan.examples.used });
        keep(PLAN_KEY, null);
        keep(FOLDER_KEY, null);
        writeComposerDraft(DRAFT_ID, "");
        // Stays starting until the room replaces this page.
        router.push(data.href);
        return;
      }
      setStartError(tuneErrorText(res.status, data));
    } catch {
      setStartError("Couldn't reach Muse Muse. Check your connection and try again.");
    }
    setStarting(false);
  }

  function changeIt() {
    keep(PLAN_KEY, null);
    keep(FOLDER_KEY, null);
    setStartError(null);
    setPhase({ at: "compose" });
  }

  return (
    <>
      {/* Kept mounted while the room shows, so Change it finds the note and the files as they were. */}
      <div className="play tune-compose" hidden={phase.at !== "compose"}>
        <div className="play-main">
          {contributorSwitchOn() ? <ContributorNotice text={CONTRIBUTOR_TUNE_NOTICE} /> : null}
          <div className="toolbar" aria-label="Page actions">
            <Link className="btn" href="/fine-tuning">
              <Icon name="history" />
              <span>Fine-tuning lab</span>
            </Link>
          </div>
          <div className="play-intro">
            <h1>What should your model do?</h1>
            {fromBuild ? <p className="muted">For {fromBuild.name}. It keeps answering with {WRITER_NAME} until this model passes and a serving window is open.</p> : null}
          </div>
          <Composer
            mode="new"
            signedIn
            draftId={DRAFT_ID}
            examples={EXAMPLES}
            examplesLabel="Try"
            placeholder="Describe the job, like answering questions for your bakery..."
            send={send}
            accept={EXAMPLE_ACCEPT}
            acceptFile={acceptExampleFile}
            keepFilesLocal
            copy={COPY}
          />
          {codeUnset ? (
            <p className="form-error" role="alert">
              <Icon name="alert" size={18} />
              <span>Starting a run isn&apos;t open right now.</span>
            </p>
          ) : null}
          {folder ? <FolderDrop ready={ready} onReady={setReady} /> : null}
          <p className="tune-intro-note muted">
            {WRITER_NAME} writes about {defaults.examples} examples, {R30B_NAME} trains on one GPU, and the tuned model is
            scored against the 2026 Glimmer it started from. {upperFirst(roughMinutes(defaultCost.minutes))}, up to about{" "}
            {usd(planMaxUsd(defaultCost))} in all (the GPU is a hard limit; Meta&apos;s part is an estimate). New fine-tunes start
            from <ExternalLink href={R30B_URL}>Muse Muse&apos;s 2026-knowledge Glimmer</ExternalLink>, so every tuned model is{" "}
            {BUILT_WITH_SPARK_OPEN}.
          </p>
        </div>
        <SetupPanel title="Training setup" rows={rows} note="Set by the platform for every run. Advanced on the plan changes the examples and the training steps." />
      </div>

      {phase.at !== "compose" ? (
        <PlanStep
          phase={phase}
          examples={examples}
          onExamples={setExamples}
          steps={steps}
          onSteps={setSteps}
          autoUpload={autoUpload}
          upload={upload}
          onUpload={setUpload}
          anyBase={anyBase}
          fireworks={fireworks}
          onFireworks={onFireworks}
          setOnFireworks={setOnFireworks}
          base={base}
          onBase={setBase}
          ceilings={ceilings}
          visitor={visitor}
          startCode={startCode}
          onStartCode={setStartCode}
          starting={starting}
          startError={startError}
          onStart={(plan) => void start(plan)}
          onChange={changeIt}
        />
      ) : null}
    </>
  );
}

/**
 * The plan step, in place of the box once it's sent: the room's title chip, the person's words as a bubble, then Muse
 * Wonder drafting the plan as the working step, the plan card with the mascot presenting and Start, Change it and
 * Advanced, or why there's no plan with Change it. Exported for the tests, which render each phase.
 */
export function PlanStep({
  fireworks = false,
  onFireworks = false,
  setOnFireworks = () => {},
  phase,
  examples,
  onExamples,
  steps = TUNE_STEPS,
  onSteps = () => {},
  autoUpload = null,
  upload = true,
  onUpload = () => {},
  anyBase = false,
  base = { state: "default" },
  onBase = () => {},
  ceilings,
  starting,
  startError,
  onStart,
  onChange,
  visitor = null,
  startCode = "",
  onStartCode = () => {},
  above = null,
  below = null,
  problemActions = null,
  startLabel = "Start",
  codeHint = "Runs use real GPUs, so starting one takes the code.",
}: {
  /** MAKE_CHAT_ALL's Dataset: Start only writes the examples, so it says so. */
  startLabel?: string;
  codeHint?: string;
  /** Rows before and after the plan in the conversation (MAKE_CHAT_ALL: the app, the folder, ask for a change). */
  above?: ReactNode;
  below?: ReactNode;
  /** Beside Change it when there's no plan (MAKE_CHAT_ALL: build just the app). */
  problemActions?: ReactNode;
  /** OPEN_TRAIN: a non-admin, with their limits. Start asks for the start code. */
  visitor?: { maxExamples: number; maxSteps: number } | null;
  startCode?: string;
  onStartCode?: (code: string) => void;
  phase: Exclude<Phase, { at: "compose" }>;
  /** Advanced's number of examples, which the card prices. */
  examples: number;
  onExamples: (n: number) => void;
  /** Advanced's training steps, which the card prices and times. */
  steps?: number;
  onSteps?: (n: number) => void;
  autoUpload?: UploadVisibility | null;
  /** Advanced's upload choice for this run. */
  upload?: boolean;
  onUpload?: (on: boolean) => void;
  fireworks?: boolean;
  onFireworks?: boolean;
  setOnFireworks?: (on: boolean) => void;
  anyBase?: boolean;
  base?: BaseChoice;
  onBase?: (next: BaseChoice) => void;
  ceilings: { maxMinutes: number; maxUsd: number };
  starting: boolean;
  startError: string | null;
  onStart: (plan: TrainPlan) => void;
  onChange: () => void;
}) {
  const countId = useId();
  const codeId = useId();
  const stepsId = useId();
  const baseSettings = base.state === "ok" ? { base: tuneBaseOf(base.base), gpu: base.base.gpus[0]! } : {};
  const baseWaits = base.state === "checking" || base.state === "refused";
  const stepsFit = maxStepsFor({ ...planSettings(examples, ceilings), ...baseSettings });
  const stepsMax = visitor ? Math.min(stepsFit, visitor.maxSteps) : stepsFit;
  const examplesMax = visitor?.maxExamples ?? TUNE_MAX_EXAMPLES;
  const isFolder = phase.at === "plan" && phase.plan.source.kind === "folder";
  const stepsGood = stepsOk(steps, stepsMax);
  const shown = phase.at === "plan" ? { ...phase.plan, settings: { ...planSettings(examples, ceilings, stepsGood ? steps : TUNE_STEPS), ...baseSettings } } : null;
  const canUpload = Boolean(autoUpload && shown && shown.examples.used === 0 && shown.source.kind !== "build" && !isFolder);
  const uploadText = !autoUpload || !shown ? null : !canUpload ? UPLOAD_STAYS_TEXT : upload ? uploadPlanText(autoUpload) : "It stays on Muse Muse. Publish on its page uploads it later if you want.";
  const rowsOnly = phase.at === "plan" && phase.plan.source.kind === "folder" && phase.plan.source.mode === "rows";
  const costOf = (s: Parameters<typeof planCost>[0]) => (rowsOnly ? { ...planCost(s), metaLowUsd: 0, metaHighUsd: 0 } : planCost(s));
  const shownView = shown ? planViewFromTrainPlan({ ...shown, cost: costOf(shown.settings) }, uploadText, visitor !== null, onFireworks) : null;
  const countOk = examplesOk(examples, examplesMax);
  return (
    <div className="room chat-split tune-room" data-settled="true">
      <div className="room-main">
        <div className="room-top">
          <TitleChip as="h1">{phase.at === "plan" ? planViewFromTrainPlan(phase.plan).name : "New fine-tune"}</TitleChip>
        </div>
        <ol className="convo" aria-label="Fine-tuning plan">
          <li className="turn-user">
            <UserBubble text={phase.note} attachments={phase.files.map((name) => ({ alt: name, icon: "file" as const }))} />
          </li>
          {phase.at === "drafting" ? (
            <li className="room-working" aria-live="polite">
              <WorkingStep title={`${WRITER_NAME} is drafting the plan`} description="Naming the model, checking the task, and pricing the run." />
            </li>
          ) : null}
          {phase.at === "problem" ? (
            <li className="room-answer">
              <p role="alert">{phase.text}</p>
              <div className="row-actions">
                <button type="button" className="btn btn-outline" onClick={onChange}>
                  <Icon name="edit" size={18} />
                  Change it
                </button>
                {problemActions}
              </div>
            </li>
          ) : null}
          {above}
          {phase.at === "plan" && shown && shownView ? (
            <li className="room-plan">
              <PlanViewCard
                view={shownView}
                art="present"
                running
                more={
                  shown.kind === "decision" ? (
                    // tg-decide's decision models train on a person's labeled rows, from their own card on the lab page.
                    <span className="muted">
                      It picks one of a few labels. Start trains it as a chat model; to train a decision model on your own labeled rows,{" "}
                      <Link href="/fine-tuning#new-decision-dataset">make a decision dataset</Link>.
                    </span>
                  ) : null
                }
                actions={
                  <div className="tune-plan-actions">
                    {startError ? (
                      <p className="form-error" role="alert">
                        <Icon name="alert" size={18} />
                        <span>{startError}</span>
                      </p>
                    ) : null}
                    {visitor ? (
                      <div className="field tune-start-code">
                        <label htmlFor={codeId}>Start code</label>
                        <input id={codeId} type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={startCode} onChange={(e) => onStartCode(e.target.value)} disabled={starting} />
                        <span className="field-hint">{codeHint}</span>
                      </div>
                    ) : null}
                    <div className="row-actions">
                      <button type="button" className="btn btn-primary" onClick={() => onStart(phase.plan)} disabled={starting || !countOk || !stepsGood || baseWaits || (visitor !== null && !startCode.trim())} aria-busy={starting}>
                        {starting ? <span className="spinner" aria-hidden /> : null}
                        {starting ? "Starting" : startLabel}
                      </button>
                      <button type="button" className="btn btn-outline" onClick={onChange} disabled={starting}>
                        Change it
                      </button>
                    </div>
                    {fireworks && base.state !== "ok" ? <FireworksChoice on={onFireworks} onChange={setOnFireworks} disabled={starting} /> : null}
                    <details className="tune-advanced">
                      <summary>
                        Advanced
                        <Icon name="chevronDown" size={16} />
                      </summary>
                      {anyBase && !visitor ? <BasePicker value={base} onChange={onBase} disabled={starting} /> : null}
                      {rowsOnly ? null : (
                      <div className="field">
                        <label htmlFor={countId}>Examples to write</label>
                        <input
                          id={countId}
                          type="number"
                          inputMode="numeric"
                          min={TUNE_MIN_EXAMPLES}
                          max={examplesMax}
                          step={10}
                          value={Number.isFinite(examples) ? examples : ""}
                          onChange={(e) => onExamples(Math.floor(Number(e.target.value)))}
                          disabled={starting}
                        />
                        <span className="field-hint">
                          {countOk ? planCostText(planCost(shown.settings)) : `Pick ${TUNE_MIN_EXAMPLES} to ${examplesMax} examples.`}
                        </span>
                      </div>
                      )}
                      <div className="field">
                        <label htmlFor={stepsId}>Training steps</label>
                        <input
                          id={stepsId}
                          type="number"
                          inputMode="numeric"
                          min={TUNE_MIN_STEPS}
                          max={stepsMax}
                          step={10}
                          value={Number.isFinite(steps) ? steps : ""}
                          onChange={(e) => onSteps(Math.floor(Number(e.target.value)))}
                          disabled={starting}
                        />
                        <span className="field-hint">
                          {stepsGood
                            ? `Each step trains on 4 examples. ${upperFirst(roughMinutes(planCost(shown.settings).trainMinutes))} on the GPU, within its ${shown.settings.maxMinutes}-minute limit.`
                            : `Pick ${TUNE_MIN_STEPS} to ${stepsMax} steps: more don't fit in the run's ${shown.settings.maxMinutes}-minute limit.`}
                        </span>
                      </div>
                      {canUpload ? (
                        <label className="train-help">
                          <input type="checkbox" checked={upload} onChange={(e) => onUpload(e.target.checked)} disabled={starting} /> Upload to Hugging Face when it is judged
                        </label>
                      ) : null}
                      {visitor ? null : <p className="muted small">
                        To change the GPU or the limits, use the full form once the examples are ready, or{" "}
                        <Link href="/fine-tuning#new-dataset">make the dataset on the full form</Link> now.
                      </p>}
                    </details>
                  </div>
                }
              />
            </li>
          ) : null}
          {below}
        </ol>
      </div>
    </div>
  );
}
