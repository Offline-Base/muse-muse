"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import {
  NOT_PUBLIC_TEXT,
  adapterOptionText,
  autoCostGpu,
  autoGpu,
  autoTimeGpu,
  datasetOptionText,
  datasetsForMode,
  errorCode,
  formMode,
  gpuErrorText,
  gpuRowText,
  gpuRows,
  limitBounds,
  limitDefaults,
  maxCostUsd,
  MODE_LABELS,
  paramShown,
  pricePerHour,
  runTimeHint,
  serveTimeHint,
  startErrorText,
  sweepOffText,
  type GpuRow,
} from "@/components/train/format";
import { usd } from "@/lib/format";
import { decideRunSize } from "@/lib/train/decision-datasets";
import {
  CHAT_MODE,
  DECIDE_MODE,
  isServeRecipe,
  MIN_MAX_MINUTES,
  MIN_MAX_USD,
  MODE_PARAM,
  recipeDefaults,
  SERVE_MINUTES_PARAM,
  type JobMode,
} from "@/lib/train/logic";
import type { AdapterOption, DatasetView, GpuOption, RecipeParamField, RecipeView, TrainLimits } from "@/lib/train/types";

export interface NewJobCardProps {
  recipes: RecipeView[];
  /** TRAIN_JOB_MAX_MINUTES and TRAIN_JOB_MAX_USD. */
  ceilings: TrainLimits;
  /** TRAIN_MAX_ACTIVE and TRAIN_DAILY_USD, for the error sentences. */
  maxActive: number;
  dailyUsd: number;
  /** False on a local run: the GPU couldn't reach the platform, so the route would refuse. */
  platformPublic: boolean;
  /**
   * Why the 5-minute sweep can't run on this deployment (app/api/train/shared.ts sweepOffReason), "sweep_not_running"
   * when it can but hasn't run lately (sweepRunning), or null when it runs. The route refuses jobs without it, so the
   * card does too.
   */
  sweepOff?: string | null;
  /**
   * Datasets for a recipe param of kind "dataset", newest first: ready ones can be picked, ones still being written
   * show as disabled. Null when they couldn't be loaded.
   */
  datasets?: DatasetView[] | null;
  /** A dataset to start with (/fine-tuning?dataset=<id>): the first recipe that takes a dataset is picked with it. */
  initialDatasetId?: string | null;
  /**
   * Trained adapters for a recipe param of kind "adapter" (glimmer-serve), newest first (listAdapterOptions). Null when
   * they couldn't be loaded.
   */
  adapters?: AdapterOption[] | null;
}

type GpuState =
  | { state: "loading" }
  | { state: "ready"; options: GpuOption[] }
  | { state: "error"; message: string; blocking: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isGpuOption(o: unknown): o is GpuOption {
  if (!o || typeof o !== "object") return false;
  const g = o as Record<string, unknown>;
  return (
    typeof g.instanceType === "string" &&
    typeof g.priceCentsPerHour === "number" &&
    Array.isArray(g.regions) &&
    (g.description === undefined || typeof g.description === "string")
  );
}

function gpuOptionsFrom(data: unknown): GpuOption[] {
  const list = data && typeof data === "object" ? (data as { options?: unknown }).options : null;
  return Array.isArray(list) ? list.filter(isGpuOption) : [];
}

/**
 * The form's starting values in `mode`: each param's default, for a dataset param `prefer` when it is ready and fits
 * the mode, else the newest ready one that does (decision datasets in decide mode, chat ones otherwise), for an adapter
 * param the newest trained adapter, and the mode param itself.
 */
function paramDefaults(
  recipe: RecipeView | undefined,
  ready: DatasetView[],
  adapters: AdapterOption[],
  prefer?: string | null,
  mode: JobMode = CHAT_MODE,
): Record<string, string> {
  const out: Record<string, string> = {};
  const fits = datasetsForMode(ready, mode);
  for (const f of recipe?.params ?? []) {
    if (f.kind === "dataset") out[f.key] = (prefer && fits.some((d) => d.id === prefer) ? prefer : fits[0]?.id) ?? "";
    else if (f.kind === "adapter") out[f.key] = adapters[0]?.jobId ?? "";
    else if (f.key === MODE_PARAM && f.choices) out[f.key] = mode;
    else out[f.key] = f.default === undefined ? "" : String(f.default);
  }
  return out;
}

const takesDataset = (r: RecipeView | undefined) => Boolean(r?.params.some((f) => f.kind === "dataset"));
const takesAdapter = (r: RecipeView | undefined) => Boolean(r?.params.some((f) => f.kind === "adapter"));
/** A recipe with a mode select (glimmer-lora): chat, or decide on a decision dataset. */
const takesMode = (r: RecipeView | undefined) => Boolean(r?.params.some((f) => f.key === MODE_PARAM && f.choices));

/**
 * The limits a job of this recipe gets when it asks for none, under the ceilings. A glimmer-serve job's follow its
 * minutes param (recipeDefaults), as the jobs route works them out.
 */
function startLimits(recipe: RecipeView, values: Record<string, string>, ceilings: TrainLimits): TrainLimits {
  return limitDefaults(recipeDefaults(recipe, paramsBody(recipe.params, values)), ceilings);
}

/**
 * Form values as POST /api/train/jobs takes them. Blank params are left out so the recipe's default applies, and so are
 * the params the form's mode doesn't use (paramShown). Chat mode leaves the mode param out too, so a chat job's
 * params are what they were before decide mode existed.
 */
function paramsBody(fields: RecipeParamField[], values: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const mode = formMode(values);
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (!raw || !paramShown(f, mode)) continue;
    if (f.key === MODE_PARAM && mode === CHAT_MODE) continue;
    const n = Number(raw);
    out[f.key] = f.kind === "number" && Number.isFinite(n) ? n : raw;
  }
  return out;
}

/**
 * The New job card on /fine-tuning: recipe, its params (a dataset param is a select of ready datasets), a GPU from
 * GET /api/train/gpus with live price and capacity, and the job's time and dollar limits. Start posts to
 * /api/train/jobs and opens the new job's page.
 */
export function NewJobCard({
  recipes,
  ceilings,
  maxActive,
  dailyUsd,
  platformPublic,
  sweepOff = null,
  datasets = [],
  initialDatasetId = null,
  adapters = [],
}: NewJobCardProps) {
  const router = useRouter();
  const id = useId();
  const [recipeId, setRecipeId] = useState(
    () => (initialDatasetId ? recipes.find(takesDataset)?.id : undefined) ?? recipes[0]?.id ?? "",
  );
  const recipe = recipes.find((r) => r.id === recipeId) ?? recipes[0];
  // A decision dataset to start with starts the card in decide mode.
  const initialMode: JobMode =
    takesMode(recipe) && (datasets ?? []).some((d) => d.id === initialDatasetId && d.kind === "decision") ? DECIDE_MODE : CHAT_MODE;
  // An admin may ask for up to the platform ceilings; the form starts at the recipe's defaults under them.
  const bounds = useMemo(() => limitBounds(ceilings), [ceilings]);

  const ready = useMemo(() => (datasets ?? []).filter((d) => d.status === "ready"), [datasets]);
  const writing = useMemo(() => (datasets ?? []).filter((d) => d.status === "generating"), [datasets]);
  const trained = useMemo(() => adapters ?? [], [adapters]);
  const needsDataset = takesDataset(recipe);
  const needsAdapter = takesAdapter(recipe);
  const usesCache = Boolean(recipe?.usesCache);

  const [title, setTitle] = useState("");
  const [params, setParams] = useState<Record<string, string>>(() =>
    paramDefaults(recipe, ready, trained, initialDatasetId, initialMode),
  );
  const mode: JobMode = takesMode(recipe) ? formMode(params) : CHAT_MODE;
  const readyForMode = useMemo(() => datasetsForMode(ready, mode), [ready, mode]);
  const writingForMode = useMemo(() => datasetsForMode(writing, mode), [writing, mode]);
  const shownParams = (recipe?.params ?? []).filter((f) => paramShown(f, mode));
  const start0 = useMemo(
    () => (recipe ? startLimits(recipe, params, ceilings) : { maxMinutes: MIN_MAX_MINUTES, maxUsd: MIN_MAX_USD }),
    [recipe, params, ceilings],
  );
  // A glimmer-serve job launches only in its adapter's region, so only GPUs free there count.
  const adapterKey = recipe?.params.find((f) => f.kind === "adapter")?.key;
  const pinnedRegion = adapterKey ? (trained.find((a) => a.jobId === params[adapterKey])?.region ?? null) : null;
  const [gpu, setGpu] = useState("");
  const [minutes, setMinutes] = useState(String(start0.maxMinutes));
  const [dollars, setDollars] = useState(start0.maxUsd.toFixed(2));
  const [gpus, setGpus] = useState<GpuState>({ state: "loading" });
  const [gpuNote, setGpuNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});

  const fetchGpus = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/train/gpus", { cache: "no-store", signal });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGpus({
          state: "error",
          message: gpuErrorText(res.status, data),
          blocking: errorCode(data) === "lambda_not_configured",
        });
        return;
      }
      setGpus({ state: "ready", options: gpuOptionsFrom(data) });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setGpus({ state: "error", message: "Couldn't reach Muse Muse to check the GPUs.", blocking: false });
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void fetchGpus(ac.signal);
    return () => ac.abort();
  }, [fetchGpus]);

  const rows = useMemo(
    () => (recipe && gpus.state === "ready" ? gpuRows(recipe, gpus.options, pinnedRegion) : []),
    [recipe, gpus, pinnedRegion],
  );
  const auto = autoGpu(rows);
  const chosen = gpu ? (rows.find((r) => r.instanceType === gpu) ?? null) : auto;
  // A recipe with the model cache may launch any free GPU on Auto, so its estimate uses the priciest one.
  const costRow = gpu ? chosen : autoCostGpu(rows, usesCache);
  const named = gpu || !usesCache ? chosen : null;

  // A dataset that turns ready while the card is open fills an empty dataset field.
  useEffect(() => {
    const first = readyForMode[0]?.id;
    const keys = (recipe?.params ?? []).filter((f) => f.kind === "dataset").map((f) => f.key);
    if (!first || !keys.length) return;
    setParams((p) => {
      const empty = keys.filter((k) => !p[k]);
      return empty.length ? { ...p, ...Object.fromEntries(empty.map((k) => [k, first])) } : p;
    });
  }, [readyForMode, recipe]);

  // A refresh can take a picked GPU's capacity away. Go back to Auto and say so, rather than launch something else.
  useEffect(() => {
    if (!gpu || gpus.state !== "ready") return;
    const row = rows.find((r) => r.instanceType === gpu);
    if (row && !row.free) {
      setGpu("");
      setGpuNote(`${row.label} has no capacity now, so the GPU is back on Auto.`);
    }
  }, [gpu, gpus.state, rows]);

  function pickRecipe(next: string) {
    const r = recipes.find((x) => x.id === next);
    if (!r) return;
    const values = paramDefaults(r, ready, trained);
    const b = startLimits(r, values, ceilings);
    setRecipeId(r.id);
    setParams(values);
    setGpu("");
    setGpuNote(null);
    setMinutes(String(b.maxMinutes));
    setDollars(b.maxUsd.toFixed(2));
    setInvalid({});
    setError(null);
  }

  /** Switches chat and decide mode: the params start over at that mode's defaults, with a dataset that fits it. */
  function pickMode(next: string) {
    if (!recipe) return;
    const m: JobMode = next === DECIDE_MODE ? DECIDE_MODE : CHAT_MODE;
    const values = paramDefaults(recipe, ready, trained, null, m);
    const b = startLimits(recipe, values, ceilings);
    setParams(values);
    setMinutes(String(b.maxMinutes));
    setDollars(b.maxUsd.toFixed(2));
    setInvalid({});
    setError(null);
  }

  function refreshGpus() {
    setGpuNote(null);
    setGpus((g) => (g.state === "ready" ? g : { state: "loading" }));
    void fetchGpus();
  }

  const minutesNum = Number(minutes);
  const dollarsNum = Number(dollars);
  const limitsOk =
    Number.isInteger(minutesNum) &&
    minutesNum >= MIN_MAX_MINUTES &&
    minutesNum <= bounds.maxMinutes &&
    Number.isFinite(dollarsNum) &&
    dollarsNum >= MIN_MAX_USD &&
    dollarsNum <= bounds.maxUsd + 1e-9;
  const limits: TrainLimits = limitsOk ? { maxMinutes: minutesNum, maxUsd: dollarsNum } : start0;
  const price = costRow?.priceCentsPerHour ?? null;
  const cost = price === null ? null : maxCostUsd(price, limits);
  // How long the run takes and whether it fits, as the jobs route checks it. On Auto, the slowest GPU it may take.
  // Until Lambda's prices load, the recipe's own GPU list stands in, with the time limit alone.
  const timeRows: GpuRow[] = rows.length
    ? rows
    : (recipe?.gpus ?? []).map((g) => ({ instanceType: g.instanceType, label: g.label, priceCentsPerHour: null, free: true }));
  const timeRow = !recipe
    ? null
    : gpu
      ? (timeRows.find((r) => r.instanceType === gpu) ?? null)
      : autoTimeGpu(recipe, timeRows, usesCache);
  const serving = Boolean(recipe && isServeRecipe(recipe.id));
  // A decide job's estimate comes from its dataset: the renderings it trains on and the prompts it scores.
  const datasetKey = recipe?.params.find((f) => f.kind === "dataset")?.key;
  const spec = mode === DECIDE_MODE && datasetKey ? (readyForMode.find((d) => d.id === params[datasetKey])?.decision ?? null) : null;
  const decideSize = useMemo(() => (spec ? decideRunSize(spec, params) : null), [spec, params]);
  // A demo's time on the GPU is its minutes plus the boot, so the priciest GPU it may get leaves it the least.
  const runHint = !recipe
    ? null
    : serving
      ? serveTimeHint(recipe, params, costRow, limits, !gpu)
      : runTimeHint(recipe, params, timeRow, limits, !gpu && usesCache, decideSize);

  /** Sets a param; a demo's minutes also move the limits to what that many minutes need. */
  function setParam(key: string, value: string) {
    const next = { ...params, [key]: value };
    setParams(next);
    if (recipe && serving && key === SERVE_MINUTES_PARAM) {
      const b = startLimits(recipe, next, ceilings);
      setMinutes(String(b.maxMinutes));
      setDollars(b.maxUsd.toFixed(2));
    }
  }

  const noneFree = gpus.state === "ready" && rows.length > 0 && !auto;
  const blocked = !platformPublic
    ? NOT_PUBLIC_TEXT
    : sweepOff
      ? sweepOffText(sweepOff)
      : needsDataset && !readyForMode.length
        ? datasets === null
          ? "Couldn't load the datasets, so this recipe can't start. Reload the page to try again."
          : mode === DECIDE_MODE
            ? "Decide mode trains on a decision dataset, and there isn't one yet. Make one under New decision dataset first."
            : "This recipe trains on a dataset, and none is ready yet. Make one under Datasets first."
        : needsAdapter && !trained.length
          ? adapters === null
            ? "Couldn't load the trained adapters, so this recipe can't start. Reload the page to try again."
            : "This recipe serves a trained adapter, and none is on a model cache yet. Train one with Muse Glimmer LoRA first."
          : gpus.state === "error" && gpus.blocking
            ? gpus.message
            : noneFree
              ? pinnedRegion
                ? `None of this recipe's GPUs is free in ${pinnedRegion}, where the adapter's model cache is, so a demo can't start. Check again in a few minutes.`
                : "None of this recipe's GPUs is free right now, so a job can't start. Check again in a few minutes."
              : null;

  function check(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!Number.isInteger(minutesNum) || minutesNum < MIN_MAX_MINUTES || minutesNum > bounds.maxMinutes) {
      out.minutes = `Enter whole minutes from ${MIN_MAX_MINUTES} to ${bounds.maxMinutes}.`;
    }
    if (!Number.isFinite(dollarsNum) || dollarsNum < MIN_MAX_USD || dollarsNum > bounds.maxUsd + 1e-9) {
      out.dollars = `Enter an amount from ${usd(MIN_MAX_USD)} to ${usd(bounds.maxUsd)}.`;
    }
    for (const f of shownParams) {
      const raw = (params[f.key] ?? "").trim();
      if (f.kind === "dataset") {
        if (!raw) {
          if (f.required) out[`p:${f.key}`] = "Pick a dataset. Make one under Datasets if none is ready.";
        } else if (!readyForMode.some((d) => d.id === raw)) {
          out[`p:${f.key}`] =
            mode === DECIDE_MODE ? "Decide mode trains on a decision dataset. Pick one of those." : "That dataset isn't ready. Pick another one.";
        }
        continue;
      }
      if (f.kind === "adapter") {
        if (!raw) {
          if (f.required) out[`p:${f.key}`] = "Pick a trained adapter. Train one with Muse Glimmer LoRA if none is listed.";
        } else if (!trained.some((a) => a.jobId === raw)) {
          out[`p:${f.key}`] = "That adapter can't be served. Pick another one.";
        }
        continue;
      }
      if (!raw) {
        if (f.required && f.default === undefined) out[`p:${f.key}`] = `${f.label} is required.`;
        continue;
      }
      if (f.choices && !f.choices.includes(raw.toLowerCase())) {
        out[`p:${f.key}`] = `${f.label} must be ${f.choices.join(" or ")}.`;
        continue;
      }
      if (f.kind === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) out[`p:${f.key}`] = `${f.label} must be a number.`;
        else if (f.whole && !Number.isInteger(n)) out[`p:${f.key}`] = `${f.label} must be a whole number.`;
        else if (f.min !== undefined && n < f.min) out[`p:${f.key}`] = `${f.label} must be at least ${f.min}.`;
        else if (f.max !== undefined && n > f.max) out[`p:${f.key}`] = `${f.label} must be at most ${f.max}.`;
      } else if (f.kind === "url" && !/^https:\/\/[^\s/]+/i.test(raw)) {
        out[`p:${f.key}`] = `${f.label} must be an https link.`;
      }
    }
    return out;
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    if (!recipe || busy || blocked) return;
    const problems = check();
    setInvalid(problems);
    if (Object.keys(problems).length) {
      setError("Fix the fields marked above, then start the job.");
      return;
    }
    const gpuText = named ? named.label : "a GPU";
    const ask =
      cost === null
        ? `Start ${gpuText} on Lambda? The job stops at ${limits.maxMinutes} minutes or ${usd(limits.maxUsd)}, whichever comes first.`
        : `Start ${gpuText} on Lambda? This job can cost up to ${usd(cost)}.`;
    if (!window.confirm(ask)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/train/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipe: recipe.id,
          ...(title.trim() ? { title: title.trim() } : {}),
          params: paramsBody(recipe.params, params),
          ...(gpu ? { instanceType: gpu } : {}),
          maxMinutes: limits.maxMinutes,
          maxUsd: limits.maxUsd,
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(startErrorText(res.status, data, { maxActive, dailyUsd }));
        if (errorCode(data) === "no_capacity" && gpuOptionsFrom(data).length) {
          setGpus({ state: "ready", options: gpuOptionsFrom(data) });
        }
        setBusy(false);
        return;
      }
      const jobId = (data as { job?: { id?: unknown } } | null)?.job?.id;
      if (typeof jobId !== "string" || !UUID.test(jobId)) {
        setError("The job started, but its link didn't come back. It's in the jobs list below.");
        setBusy(false);
        router.refresh();
        return;
      }
      router.push(`/fine-tuning/${jobId}`);
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
      setBusy(false);
    }
  }

  if (!recipe) {
    return (
      <section className="card train-new" id="new-job" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`}>New job</h2>
        <p className="muted">There are no recipes to run yet.</p>
      </section>
    );
  }

  const gpuHelp =
    gpus.state === "loading"
      ? "Checking Lambda's prices and capacity."
      : gpus.state === "error"
        ? gpus.message
        : noneFree
          ? pinnedRegion
            ? `None of these GPUs is free in ${pinnedRegion} right now.`
            : "None of these GPUs is free right now."
          : pinnedRegion
            ? `Lambda's prices per hour. A live demo runs only in ${pinnedRegion}, where its adapter's model cache is, so Auto takes the first GPU free there in the recipe's order.`
            : usesCache
              ? "Lambda's prices per hour. Auto takes the first free GPU in the recipe's order, in a region that already holds the model cache when one has room, so the model doesn't download again."
              : "Lambda's prices per hour. Auto takes the first free GPU in the recipe's order.";

  const fieldProps = (key: string, helpId?: string) => ({
    "aria-invalid": invalid[key] ? true : undefined,
    "aria-describedby": [helpId, invalid[key] ? `${id}-${key}-err` : null].filter(Boolean).join(" ") || undefined,
  });
  const fieldError = (key: string) =>
    invalid[key] ? (
      <p className="train-field-error" id={`${id}-${key}-err`}>
        {invalid[key]}
      </p>
    ) : null;

  return (
    <section className="card train-new" id="new-job" aria-labelledby={`${id}-title`}>
      <div className="train-new-head">
        <h2 id={`${id}-title`}>New job</h2>
        <p className="muted small">One job is one GPU on Lambda. The platform always shuts it down at the end.</p>
      </div>

      {!platformPublic || sweepOff ? (
        <div className="callout train-callout-warn" role="note">
          <Icon name="alert" size={18} />
          <p>{!platformPublic ? NOT_PUBLIC_TEXT : sweepOffText(sweepOff)}</p>
        </div>
      ) : null}

      <form className="train-form" onSubmit={start} noValidate>
        <div className="train-grid">
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-recipe`}>
              Recipe
            </label>
            <select
              id={`${id}-recipe`}
              className="train-select"
              value={recipe.id}
              onChange={(e) => pickRecipe(e.target.value)}
              aria-describedby={`${id}-recipe-help`}
              disabled={busy}
            >
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
            <p className="train-help" id={`${id}-recipe-help`}>
              {recipe.description}
            </p>
          </div>

          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-title-input`}>
              Name <span className="muted">(optional)</span>
            </label>
            <input
              id={`${id}-title-input`}
              className="train-input"
              type="text"
              value={title}
              maxLength={200}
              placeholder={recipe.title}
              autoComplete="off"
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
            <p className="train-help">Shown in the jobs list.</p>
          </div>

          {shownParams.map((f) => {
            const key = `p:${f.key}`;
            const inputId = `${id}-param-${f.key}`;
            if (f.choices) {
              const helpId = `${inputId}-help`;
              const isMode = f.key === MODE_PARAM;
              return (
                <div className="train-field" key={f.key}>
                  <label className="train-label" htmlFor={inputId}>
                    {f.label}
                  </label>
                  <select
                    id={inputId}
                    className="train-select"
                    value={(params[f.key] ?? "").trim().toLowerCase() || f.choices[0]}
                    onChange={(e) => (isMode ? pickMode(e.target.value) : setParam(f.key, e.target.value))}
                    disabled={busy}
                    {...fieldProps(key, helpId)}
                  >
                    {f.choices.map((c) => (
                      <option key={c} value={c}>
                        {isMode && (c === CHAT_MODE || c === DECIDE_MODE) ? MODE_LABELS[c] : c}
                      </option>
                    ))}
                  </select>
                  <p className="train-help" id={helpId}>
                    {isMode && mode === DECIDE_MODE
                      ? "Trains Glimmer to answer with one label's letter, then scores base and tuned Glimmer on the dataset's held-out test rows: no judge and no Meta call. A decision model stays on Muse Muse: Publish to Hugging Face is off in decide mode, and a person's rows are never published."
                      : f.help}
                  </p>
                  {fieldError(key)}
                </div>
              );
            }
            if (f.kind === "dataset") {
              const helpId = `${inputId}-help`;
              return (
                <div className="train-field" key={f.key}>
                  <label className="train-label" htmlFor={inputId}>
                    {f.label}
                  </label>
                  <select
                    id={inputId}
                    className="train-select"
                    value={params[f.key] ?? ""}
                    onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}
                    required={Boolean(f.required)}
                    disabled={busy || !readyForMode.length}
                    {...fieldProps(key, helpId)}
                  >
                    {readyForMode.length ? null : (
                      <option value="">
                        {datasets === null
                          ? "Couldn't load datasets"
                          : mode === DECIDE_MODE
                            ? "No decision dataset yet"
                            : "No dataset is ready yet"}
                      </option>
                    )}
                    {readyForMode.map((d) => (
                      <option key={d.id} value={d.id}>
                        {datasetOptionText(d)}
                      </option>
                    ))}
                    {writingForMode.map((d) => (
                      <option key={d.id} value={d.id} disabled>
                        {datasetOptionText(d)}
                      </option>
                    ))}
                  </select>
                  <p className="train-help" id={helpId}>
                    {readyForMode.length ? (
                      mode === DECIDE_MODE ? (
                        "A decision dataset. It trains on the train rows; the dev rows set its confidence and the test rows score base and tuned Glimmer."
                      ) : (
                        f.help
                      )
                    ) : mode === DECIDE_MODE ? (
                      <>
                        None yet. <a href="#new-decision-dataset">Make a decision dataset</a> from your own labeled rows first.
                      </>
                    ) : (
                      <>
                        None is ready yet. <a href="#new-dataset">Make a dataset</a>
                        {writingForMode.length ? ", or wait for the one being written to finish." : " first."}
                      </>
                    )}
                  </p>
                  {fieldError(key)}
                </div>
              );
            }
            if (f.kind === "adapter") {
              const helpId = `${inputId}-help`;
              return (
                <div className="train-field" key={f.key}>
                  <label className="train-label" htmlFor={inputId}>
                    {f.label}
                  </label>
                  <select
                    id={inputId}
                    className="train-select"
                    value={params[f.key] ?? ""}
                    onChange={(e) => setParam(f.key, e.target.value)}
                    required={Boolean(f.required)}
                    disabled={busy || !trained.length}
                    {...fieldProps(key, helpId)}
                  >
                    {trained.length ? null : (
                      <option value="">{adapters === null ? "Couldn't load the adapters" : "No trained adapter yet"}</option>
                    )}
                    {trained.map((a) => (
                      <option key={a.jobId} value={a.jobId}>
                        {adapterOptionText(a)}
                      </option>
                    ))}
                  </select>
                  <p className="train-help" id={helpId}>
                    {trained.length
                      ? f.help
                      : "None yet. A Muse Glimmer LoRA job that succeeds saves its adapter on the model cache, and shows up here."}
                  </p>
                  {fieldError(key)}
                </div>
              );
            }
            const helpId = f.help ? `${inputId}-help` : undefined;
            return (
              <div className="train-field" key={f.key}>
                <label className="train-label" htmlFor={inputId}>
                  {f.label}
                  {f.required && f.default === undefined ? null : <span className="muted"> (optional)</span>}
                </label>
                <input
                  id={inputId}
                  className="train-input"
                  type={f.kind === "number" ? "number" : f.kind === "url" ? "url" : "text"}
                  inputMode={f.kind === "number" ? "decimal" : f.kind === "url" ? "url" : undefined}
                  min={f.kind === "number" ? f.min : undefined}
                  max={f.kind === "number" ? f.max : undefined}
                  step={f.kind === "number" ? "any" : undefined}
                  value={params[f.key] ?? ""}
                  placeholder={f.default === undefined ? undefined : String(f.default)}
                  required={Boolean(f.required && f.default === undefined)}
                  autoComplete="off"
                  spellCheck={f.kind === "text" ? undefined : false}
                  onChange={(e) => setParam(f.key, e.target.value)}
                  disabled={busy}
                  {...fieldProps(key, helpId)}
                />
                {f.help ? (
                  <p className="train-help" id={helpId}>
                    {f.help}
                  </p>
                ) : null}
                {fieldError(key)}
              </div>
            );
          })}

          <div className="train-field">
            <div className="train-label-row">
              <label className="train-label" htmlFor={`${id}-gpu`}>
                GPU
              </label>
              <button
                type="button"
                className="round-btn"
                onClick={refreshGpus}
                aria-label="Check GPU prices and capacity again"
                title="Check again"
                disabled={busy || gpus.state === "loading"}
              >
                <Icon name="refresh" size={18} />
              </button>
            </div>
            <select
              id={`${id}-gpu`}
              className="train-select"
              value={gpu}
              onChange={(e) => {
                setGpu(e.target.value);
                setGpuNote(null);
              }}
              aria-describedby={`${id}-gpu-help`}
              disabled={busy}
            >
              <option value="">
                {pinnedRegion
                  ? `Auto: a free GPU in ${pinnedRegion}, with the adapter`
                  : usesCache
                    ? "Auto: a free GPU near the model cache"
                    : auto && auto.priceCentsPerHour !== null
                      ? `Auto: ${auto.label} · ${pricePerHour(auto.priceCentsPerHour)}`
                      : "Auto: the first free GPU"}
              </option>
              {gpus.state === "ready"
                ? rows.map((r) => (
                    <option key={r.instanceType} value={r.instanceType} disabled={!r.free}>
                      {gpuRowText(r)}
                    </option>
                  ))
                : recipe.gpus.map((g) => (
                    <option key={g.instanceType} value={g.instanceType}>
                      {g.label}
                    </option>
                  ))}
            </select>
            <p className="train-help" id={`${id}-gpu-help`} aria-live="polite">
              {gpuNote ? `${gpuNote} ` : ""}
              {gpuHelp}
            </p>
          </div>

          <fieldset className="train-field train-limits" disabled={busy}>
            <legend className="train-label">Limits</legend>
            <div className="train-pair">
              <div className="train-field">
                <label className="train-sublabel" htmlFor={`${id}-minutes`}>
                  Time limit (minutes)
                </label>
                <input
                  id={`${id}-minutes`}
                  className="train-input"
                  type="number"
                  inputMode="numeric"
                  min={MIN_MAX_MINUTES}
                  max={bounds.maxMinutes}
                  step={1}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  {...fieldProps("minutes", `${id}-limits-help`)}
                />
                {fieldError("minutes")}
              </div>
              <div className="train-field">
                <label className="train-sublabel" htmlFor={`${id}-dollars`}>
                  Dollar limit (USD)
                </label>
                <input
                  id={`${id}-dollars`}
                  className="train-input"
                  type="number"
                  inputMode="decimal"
                  min={MIN_MAX_USD}
                  max={bounds.maxUsd}
                  step={0.01}
                  value={dollars}
                  onChange={(e) => setDollars(e.target.value)}
                  {...fieldProps("dollars", `${id}-limits-help`)}
                />
                {fieldError("dollars")}
              </div>
            </div>
            <p className="train-help" id={`${id}-limits-help`}>
              This recipe starts at {start0.maxMinutes} minutes and {usd(start0.maxUsd)}, and a job can ask for up to{" "}
              {bounds.maxMinutes} minutes and {usd(bounds.maxUsd)}. The GPU shuts down at whichever comes first.
            </p>
            {runHint ? (
              <div aria-live="polite">
                {runHint.warn ? (
                  <div className="callout train-callout-warn" role="note">
                    <Icon name="alert" size={18} />
                    <p>{runHint.text}</p>
                  </div>
                ) : (
                  <p className="train-help">{runHint.text}</p>
                )}
              </div>
            ) : null}
          </fieldset>
        </div>

        <div className="train-foot">
          <p className="train-cost" id={`${id}-cost`} aria-live="polite">
            {blocked ? (
              blocked
            ) : cost !== null && costRow && price !== null ? (
              <>
                <strong>Up to {usd(cost)}.</strong>{" "}
                {named
                  ? `${named.label} costs ${usd(price / 100)} an hour`
                  : `Auto may take any free GPU here, at up to ${usd(price / 100)} an hour`}
                , and the job ends at {limits.maxMinutes} minutes or {usd(limits.maxUsd)}, whichever comes first. This is
                an estimate: Lambda bills from launch until the GPU shuts down, and a check every 5 minutes shuts down any
                GPU past its limit.
              </>
            ) : (
              <>
                The job ends at {limits.maxMinutes} minutes or {usd(limits.maxUsd)}, whichever comes first. The cost
                estimate shows once Lambda&apos;s prices load.
              </>
            )}
          </p>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || Boolean(blocked)}
            aria-describedby={`${id}-cost`}
          >
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={16} />}
            <span>{busy ? "Starting" : "Start job"}</span>
          </button>
        </div>

        {error ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        ) : null}
      </form>
    </section>
  );
}
