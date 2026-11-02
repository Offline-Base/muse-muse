"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { datasetOptionText } from "@/components/train/format";
import type { DeviceTrainingStart, DeviceTrainingState, DeviceTrainingStatus } from "@/lib/device/train";
import type { DatasetView } from "@/lib/train/types";

const POLL_MS = 5000;
const FINISHED: ReadonlySet<DeviceTrainingState> = new Set(["done", "failed", "stopped"]);

const STATES: Record<DeviceTrainingState, string> = {
  loading: "Loading the model",
  training: "Training",
  converting: "Converting the adapter",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const ERRORS: Record<string, string> = {
  device_not_configured: "No board is set up. DEVICE_MCP_URL and DEVICE_MCP_TOKEN are missing.",
  device_unavailable: "Couldn't reach the board. Its server or tunnel may be down.",
  dataset_not_found: "That dataset no longer exists.",
  dataset_not_ready: "That dataset isn't ready.",
};

type Failure = { error?: string; message?: string };

function failureText(data: Failure): string {
  return data.message ?? ERRORS[data.error ?? ""] ?? data.error ?? "That didn't work.";
}

const statusUrl = (run: string | null) => `/api/device/train${run ? `?run=${encodeURIComponent(run)}` : ""}`;

/**
 * Admin only: fine-tunes a model on the board's own GPU from a platform dataset, and follows the run until it ends. With
 * `driveExport` (DRIVE_EXPORT_ENABLED), a finished run links to the Flash drive card with it picked. Without `training`
 * (DEVICE_LLAMA_TRAINING), Start is off and says why, since a board trains only Llama 3.x, and a run already on the board
 * still shows with its Stop button.
 */
export function DeviceTrain({ driveExport = false, training = false }: { driveExport?: boolean; training?: boolean }) {
  const id = useId();
  const [datasets, setDatasets] = useState<DatasetView[] | null>(null);
  const [datasetId, setDatasetId] = useState("");
  const [name, setName] = useState("");
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Kept apart from `message`, since the next good poll clears this but must not clear why a Start was refused.
  const [pollMessage, setPollMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<DeviceTrainingStatus | null>(null);
  // The run being followed, as a new object for each start so that a name used twice is followed again. A null run is the
  // board's newest, which the page starts on so that a reload picks up a run already going.
  const [watching, setWatching] = useState<{ run: string | null } | null>({ run: null });

  const active = status !== null && !FINISHED.has(status.state);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/train/datasets", { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ datasets: DatasetView[] }>) : { datasets: [] }))
      .then((data) => setDatasets(data.datasets.filter((d) => d.status === "ready" && d.trainCount > 0)))
      .catch(() => {
        if (!controller.signal.aborted) setDatasets([]);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Looking for the newest run finds nothing on a new board, or one that's off. That's no error until a run has been seen.
    let seen = watching.run !== null;

    async function poll() {
      let again = true;
      try {
        const res = await fetch(statusUrl(watching!.run), { signal: controller.signal });
        const data = (await res.json().catch(() => ({}))) as DeviceTrainingStatus & Failure;
        if (controller.signal.aborted) return;
        if (res.ok) {
          seen = true;
          setStatus(data);
          setPollMessage(null);
          again = !FINISHED.has(data.state);
        } else {
          // A board that can't be reached may be back in a moment. Anything else won't change by asking again.
          again = seen && (res.status === 502 || res.status === 504);
          if (seen) setPollMessage(failureText(data));
        }
      } catch {
        if (controller.signal.aborted) return;
        again = seen;
        if (seen) setPollMessage("Couldn't reach Muse Muse.");
      }
      if (again) timer = setTimeout(poll, POLL_MS);
    }

    void poll();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [watching]);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setPollMessage(null);
    setStatus(null);
    setWatching(null);
    try {
      const res = await fetch("/api/device/train", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasetId, name, ...(steps.trim() ? { steps: Number(steps) } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as DeviceTrainingStart & Failure;
      if (res.ok) {
        setStatus({ state: data.state });
        setWatching({ run: data.run });
      } else {
        setMessage(failureText(data));
        // The usual refusal is another run going on the board, so show that one, with its Stop button.
        setWatching({ run: null });
      }
    } catch {
      setMessage("Couldn't reach Muse Muse.");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setStopping(true);
    setMessage(null);
    try {
      const res = await fetch(statusUrl(watching?.run ?? null), { method: "DELETE" });
      if (!res.ok) setMessage(failureText((await res.json().catch(() => ({}))) as Failure));
    } catch {
      setMessage("Couldn't reach Muse Muse.");
    } finally {
      setStopping(false);
    }
  }

  return (
    <section className="card section-card">
      <h2>Fine-tune on this board</h2>
      {training ? null : (
        <p className="muted small">
          Off for now. A board can only train Llama 3.x, which isn&apos;t a Meta model for this project, and no Meta model is
          small enough to train on one yet. A run already on the board still shows here.
        </p>
      )}
      <form onSubmit={start}>
        <label className="field-label" htmlFor={`${id}-dataset`}>
          Dataset
        </label>
        <select
          id={`${id}-dataset`}
          className="train-select"
          value={datasetId}
          onChange={(event) => setDatasetId(event.target.value)}
          disabled={!datasets}
          required
        >
          <option value="">{datasets ? (datasets.length ? "Choose a dataset" : "No datasets are ready") : "Loading"}</option>
          {datasets?.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {datasetOptionText(dataset)}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          className="train-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
          title="Letters, digits, dots, dashes and underscores, starting with a letter or digit."
          placeholder="bakery-helper"
          autoComplete="off"
          required
        />
        <label className="field-label" htmlFor={`${id}-steps`}>
          Steps
        </label>
        <input
          id={`${id}-steps`}
          className="train-input"
          type="number"
          min={1}
          step={1}
          value={steps}
          onChange={(event) => setSteps(event.target.value)}
          placeholder="60"
        />
        <button type="submit" className="btn btn-primary" disabled={!training || busy || active || !datasetId || !name}>
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={16} />}
          <span>{busy ? "Sending the dataset" : "Start"}</span>
        </button>
      </form>
      {message || pollMessage ? (
        <p className="small" role="alert">
          {message ?? pollMessage}
        </p>
      ) : null}
      {status ? (
        <div aria-live="polite">
          <p>
            {active ? <span className="spinner" aria-hidden /> : null} {STATES[status.state] ?? status.state}
          </p>
          {status.steps ? (
            <p className="muted small">
              Step {status.step ?? 0} of {status.steps}
              {typeof status.loss === "number" ? `, loss ${status.loss}` : ""}
            </p>
          ) : null}
          {status.skipped ? <p className="small">Left out {status.skipped} examples that were too long.</p> : null}
          {status.error ? <p className="small">{status.error}</p> : null}
          {status.adapter ? <p className="small">Adapter: {status.adapter}</p> : null}
          {driveExport && status.state === "done" && watching?.run ? (
            <a className="btn btn-outline btn-sm" href={`/device?export=${encodeURIComponent(`board:${watching.run}`)}`}>
              <Icon name="download" size={16} />
              <span>Export to a drive</span>
            </a>
          ) : null}
          {active ? (
            <button type="button" className="btn btn-outline" onClick={stop} disabled={stopping}>
              {stopping ? <span className="spinner" aria-hidden /> : <Icon name="close" size={16} />}
              <span>Stop</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
