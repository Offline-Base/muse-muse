"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import {
  NOT_PUBLIC_TEXT,
  autoCostGpu,
  autoGpu,
  datasetOptionText,
  errorCode,
  gpuErrorText,
  gpuRowText,
  gpuRows,
  limitBounds,
  maxCostUsd,
  pricePerHour,
  startErrorText,
  sweepOffText,
} from "@/components/train/format";
import { usd } from "@/lib/format";
import { MIN_MAX_MINUTES, MIN_MAX_USD } from "@/lib/train/logic";
import type { DatasetView, GpuOption, RecipeParamField, RecipeView, TrainLimits } from "@/lib/train/types";

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

/** The form's starting values: each param's default, and for a dataset param `prefer` when it is ready, else the newest ready one. */
function paramDefaults(recipe: RecipeView | undefined, ready: DatasetView[], prefer?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of recipe?.params ?? []) {
    if (f.kind === "dataset") out[f.key] = (prefer && ready.some((d) => d.id === prefer) ? prefer : ready[0]?.id) ?? "";
    else out[f.key] = f.default === undefined ? "" : String(f.default);
  }
  return out;
}

const takesDataset = (r: RecipeView | undefined) => Boolean(r?.params.some((f) => f.kind === "dataset"));

/** Form values as POST /api/train/jobs takes them. Blank params are left out so the recipe's default applies. */
function paramsBody(fields: RecipeParamField[], values: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (!raw) continue;
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
}: NewJobCardProps) {
  const router = useRouter();
  const id = useId();
  const [recipeId, setRecipeId] = useState(
    () => (initialDatasetId ? recipes.find(takesDataset)?.id : undefined) ?? recipes[0]?.id ?? "",
  );
  const recipe = recipes.find((r) => r.id === recipeId) ?? recipes[0];
  const bounds = useMemo(
    () => (recipe ? limitBounds(recipe, ceilings) : { maxMinutes: MIN_MAX_MINUTES, maxUsd: MIN_MAX_USD }),
    [recipe, ceilings],
  );

  const ready = useMemo(() => (datasets ?? []).filter((d) => d.status === "ready"), [datasets]);
  const writing = useMemo(() => (datasets ?? []).filter((d) => d.status === "generating"), [datasets]);
  const needsDataset = takesDataset(recipe);
  const usesCache = Boolean(recipe?.usesCache);

  const [title, setTitle] = useState("");
  const [params, setParams] = useState<Record<string, string>>(() => paramDefaults(recipe, ready, initialDatasetId));
  const [gpu, setGpu] = useState("");
  const [minutes, setMinutes] = useState(String(bounds.maxMinutes));
  const [dollars, setDollars] = useState(bounds.maxUsd.toFixed(2));
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
    () => (recipe && gpus.state === "ready" ? gpuRows(recipe, gpus.options) : []),
    [recipe, gpus],
  );
  const auto = autoGpu(rows);
  const chosen = gpu ? (rows.find((r) => r.instanceType === gpu) ?? null) : auto;
  // A recipe with the model cache may launch any free GPU on Auto, so its estimate uses the priciest one.
  const costRow = gpu ? chosen : autoCostGpu(rows, usesCache);
  const named = gpu || !usesCache ? chosen : null;

  // A dataset that turns ready while the card is open fills an empty dataset field.
  useEffect(() => {
    const first = ready[0]?.id;
    const keys = (recipe?.params ?? []).filter((f) => f.kind === "dataset").map((f) => f.key);
    if (!first || !keys.length) return;
    setParams((p) => {
      const empty = keys.filter((k) => !p[k]);
      return empty.length ? { ...p, ...Object.fromEntries(empty.map((k) => [k, first])) } : p;
    });
  }, [ready, recipe]);

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
    const b = limitBounds(r, ceilings);
    setRecipeId(r.id);
    setParams(paramDefaults(r, ready));
    setGpu("");
    setGpuNote(null);
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
  const limits: TrainLimits = limitsOk ? { maxMinutes: minutesNum, maxUsd: dollarsNum } : bounds;
  const price = costRow?.priceCentsPerHour ?? null;
  const cost = price === null ? null : maxCostUsd(price, limits);

  const noneFree = gpus.state === "ready" && rows.length > 0 && !auto;
  const blocked = !platformPublic
    ? NOT_PUBLIC_TEXT
    : sweepOff
      ? sweepOffText(sweepOff)
      : needsDataset && !ready.length
        ? datasets === null
          ? "Couldn't load the datasets, so this recipe can't start. Reload the page to try again."
          : "This recipe trains on a dataset, and none is ready yet. Make one under Datasets first."
        : gpus.state === "error" && gpus.blocking
          ? gpus.message
          : noneFree
            ? "None of this recipe's GPUs is free right now, so a job can't start. Check again in a few minutes."
            : null;

  function check(): Record<string, string> {
    const out: Record<string, string> = {};
    if (!Number.isInteger(minutesNum) || minutesNum < MIN_MAX_MINUTES || minutesNum > bounds.maxMinutes) {
      out.minutes = `Enter whole minutes from ${MIN_MAX_MINUTES} to ${bounds.maxMinutes}.`;
    }
    if (!Number.isFinite(dollarsNum) || dollarsNum < MIN_MAX_USD || dollarsNum > bounds.maxUsd + 1e-9) {
      out.dollars = `Enter an amount from ${usd(MIN_MAX_USD)} to ${usd(bounds.maxUsd)}.`;
    }
    for (const f of recipe?.params ?? []) {
      const raw = (params[f.key] ?? "").trim();
      if (f.kind === "dataset") {
        if (!raw) {
          if (f.required) out[`p:${f.key}`] = "Pick a dataset. Make one under Datasets if none is ready.";
        } else if (!ready.some((d) => d.id === raw)) {
          out[`p:${f.key}`] = "That dataset isn't ready. Pick another one.";
        }
        continue;
      }
      if (!raw) {
        if (f.required && f.default === undefined) out[`p:${f.key}`] = `${f.label} is required.`;
        continue;
      }
      if (f.kind === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) out[`p:${f.key}`] = `${f.label} must be a number.`;
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
          ? "None of these GPUs is free right now."
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

          {recipe.params.map((f) => {
            const key = `p:${f.key}`;
            const inputId = `${id}-param-${f.key}`;
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
                    disabled={busy || !ready.length}
                    {...fieldProps(key, helpId)}
                  >
                    {ready.length ? null : (
                      <option value="">{datasets === null ? "Couldn't load datasets" : "No dataset is ready yet"}</option>
                    )}
                    {ready.map((d) => (
                      <option key={d.id} value={d.id}>
                        {datasetOptionText(d)}
                      </option>
                    ))}
                    {writing.map((d) => (
                      <option key={d.id} value={d.id} disabled>
                        {datasetOptionText(d)}
                      </option>
                    ))}
                  </select>
                  <p className="train-help" id={helpId}>
                    {ready.length ? (
                      f.help
                    ) : (
                      <>
                        None is ready yet. <a href="#new-dataset">Make a dataset</a>
                        {writing.length ? ", or wait for the one being written to finish." : " first."}
                      </>
                    )}
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
                  onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}
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
                {usesCache
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
              Up to {bounds.maxMinutes} minutes and {usd(bounds.maxUsd)} for this recipe. The GPU shuts down at
              whichever comes first.
            </p>
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
