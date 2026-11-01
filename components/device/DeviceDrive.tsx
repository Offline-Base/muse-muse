"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Icon } from "@/components/icons";
import type { BoardDrive, BoardRun, ExportState, ExportStatus } from "@/lib/device/drive";
import { carryOn, carryOnBody } from "@/lib/device/drive-card";

const POLL_MS = 3000;
const ENDED: ReadonlySet<ExportState> = new Set(["done", "failed", "stopped"]);

const STATES: Record<ExportState, string> = {
  waiting_for_drive: "Waiting for a drive",
  checking: "Checking the drive",
  needs_erase: "Waiting for your OK to erase",
  read_only: "The drive is locked",
  too_small: "The drive is too small",
  writing: "Writing",
  needs_urls: "Waiting for a fresh link",
  verifying: "Reading every file back",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const ERRORS: Record<string, string> = {
  device_not_configured: "No board is set up. DEVICE_MCP_URL and DEVICE_MCP_TOKEN are missing.",
  device_unavailable: "Couldn't reach the board. Its server or tunnel may be down.",
  not_found: "Drive export is off on this site.",
  source_not_found: "That model isn't there any more.",
  plan_too_large: "This drive's plan is too big to send to the board.",
};

type Failure = { error?: string; message?: string };

interface Reply {
  drives: BoardDrive[];
  export: ExportStatus | null;
  runs: BoardRun[];
  kit: string | null;
}

const failureText = (data: Failure) => data.message ?? ERRORS[data.error ?? ""] ?? data.error ?? "That didn't work.";
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes < 10e9 ? 1 : 0)} GB`;

function driveText(d: BoardDrive): string {
  const fs = d.filesystem ? (d.filesystem === "vfat" ? "FAT32" : d.filesystem === "exfat" ? "exFAT" : d.filesystem.toUpperCase()) : "no filesystem";
  const free = typeof d.free === "number" ? `, ${gb(d.free)} free` : "";
  return `${d.title}, ${gb(d.bytes)} ${d.kind.toLowerCase()}, ${fs}${d.label ? ` "${d.label}"` : ""}${free}`;
}

function etaText(seconds: number | null | undefined): string {
  if (!seconds) return "";
  return seconds < 90 ? `, about ${Math.max(1, Math.round(seconds))} seconds left` : `, about ${Math.round(seconds / 60)} minutes left`;
}

/**
 * Admin only: puts a fine-tuned model onto a USB drive plugged into the board (docs/DRIVE_EXPORT.md). It lists the drives
 * the board sees and the models it can export, then writes, checks and powers the drive off. It never erases a drive unless
 * the person types its name here. `initialSource` is a model picked by a link: "board:<run>" or "lab:<jobId>:<build>".
 */
export function DeviceDrive({ initialSource = null }: { initialSource?: string | null }) {
  const id = useId();
  const [reply, setReply] = useState<Reply | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState(initialSource ?? "");
  const [driveName, setDriveName] = useState("");
  const [copies, setCopies] = useState("1");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const status = reply?.export ?? null;
  const active = status !== null && !ENDED.has(status.state);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/device/drive", { signal });
      const data = (await res.json().catch(() => ({}))) as Reply & Failure;
      if (signal?.aborted) return true;
      if (!res.ok) {
        setMessage(failureText(data));
        return res.status === 502;
      }
      setReply(data);
      return Boolean(data.export && !ENDED.has(data.export.state));
    } catch {
      if (!signal?.aborted) setMessage("Couldn't reach Muse Muse.");
      return false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const again = await load(controller.signal);
      // Every 3 seconds while an export is going; otherwise only when asked.
      if (again && !controller.signal.aborted) timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, active]);

  async function send(url: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
      const data = (await res.json().catch(() => ({}))) as Failure;
      if (!res.ok) {
        setMessage(failureText(data));
        return false;
      }
      await load();
      return true;
    } catch {
      setMessage("Couldn't reach Muse Muse.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const sources = [
    ...(reply?.runs ?? []).map((r) => ({ value: `board:${r.run}`, label: `${r.run}, tuned on this board on ${r.base}` })),
    ...(initialSource?.startsWith("lab:") ? [{ value: initialSource, label: `Lab model ${initialSource.split(":")[1].slice(0, 8)}, ${initialSource.split(":")[2]} build` }] : []),
  ];
  const usable = (reply?.drives ?? []).filter((d) => d.usable);
  const picked = usable.find((d) => d.name === driveName) ?? null;
  const eraseWord = status?.drive?.label || "ERASE";
  const resume = carryOn(status, reply?.drives ?? [], driveName);

  const exportNow = () =>
    send("/api/device/drive", { method: "POST", body: JSON.stringify({ source, mode: "now", drive: picked?.name, identity: picked?.identity }) });
  const arm = () => send("/api/device/drive", { method: "POST", body: JSON.stringify({ source, mode: "arm", copies: Number(copies) || 1 }) });
  const carryOnNow = () => {
    if (status && resume?.by === "card" && resume.drive) void send("/api/device/drive", { method: "POST", body: JSON.stringify(carryOnBody(status, resume.drive)) });
  };
  const stop = () => send(`/api/device/drive${status ? `?export=${encodeURIComponent(status.export)}` : ""}`, { method: "DELETE" });
  const erase = async () => {
    if (!status?.drive) return;
    if (await send("/api/device/drive/erase", { method: "POST", body: JSON.stringify({ drive: status.drive.name, identity: status.drive.identity, confirm }) })) setConfirm("");
  };

  return (
    <section className="card section-card">
      <h2>Flash drive</h2>
      <p className="muted small">
        Puts a fine-tuned model on a USB drive plugged into one of the board&apos;s blue USB ports, with what a Mac or a Windows PC needs to run it offline. It
        only adds a folder, and never erases a drive unless you type its name below.
      </p>
      {reply?.kit ? (
        <p className="note train-callout-warn" role="status">
          <Icon name="alert" size={16} /> <span>{reply.kit}</span>
        </p>
      ) : null}

      <label className="field-label" htmlFor={`${id}-model`}>
        Model
      </label>
      <select id={`${id}-model`} className="train-select" value={source} onChange={(event) => setSource(event.target.value)} disabled={!reply || active}>
        <option value="">{reply ? (sources.length ? "Choose a model" : "No finished runs on this board yet") : message ? "No models to show" : "Loading"}</option>
        {sources.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <fieldset disabled={active || busy}>
        <legend className="field-label">Drive</legend>
        {reply && !reply.drives.length ? <p className="small muted">No USB drive is plugged in. Plug one in, then refresh.</p> : null}
        {(reply?.drives ?? []).map((d) => (
          <div key={d.identity} className="small">
            <label>
              <input type="radio" name={`${id}-drive`} value={d.name} checked={driveName === d.name} onChange={() => setDriveName(d.name)} disabled={!d.usable} /> {driveText(d)}
            </label>
            {d.usable ? null : <span className="muted"> {d.why}</span>}
          </div>
        ))}
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={exportNow} disabled={!source || !picked || Boolean(reply?.kit)}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="download" size={16} />}
            <span>Export now</span>
          </button>
          <button type="button" className="btn btn-outline" onClick={arm} disabled={!source || Boolean(reply?.kit)}>
            <Icon name="plug" size={16} />
            <span>Export when a drive is plugged in</span>
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            <span>Refresh</span>
          </button>
        </div>
        <label className="field-label" htmlFor={`${id}-copies`}>
          Copies when waiting for drives
        </label>
        <input id={`${id}-copies`} className="train-input" type="number" min={1} max={10} step={1} value={copies} onChange={(event) => setCopies(event.target.value)} />
        <p className="field-hint">Only drives plugged in after you press it count, for up to 24 hours.</p>
      </fieldset>

      {message ? (
        <p className="note note-error" role="alert">
          {message}
        </p>
      ) : null}

      {status ? (
        <div aria-live="polite">
          <p>
            {active ? <span className="spinner" aria-hidden /> : <Icon name={status.result === "PASS" ? "checkCircle" : "info"} size={16} />}{" "}
            {STATES[status.state] ?? status.state}
            {status.drive ? `: ${status.drive.title}` : ""}
          </p>
          {status.message ? <p className="small">{status.message}</p> : null}
          {status.state === "writing" && status.total_bytes ? (
            <p className="muted small">
              {gb(status.done_bytes ?? 0)} of {gb(status.total_bytes)}
              {status.file ? `, ${status.file}` : ""}
              {status.mbps ? `, ${status.mbps} MB/s` : ""}
              {etaText(status.eta_s)}
            </p>
          ) : null}
          {(status.state === "needs_urls" && status.source === "url") || resume?.by === "script" ? (
            <p className="small">Its link can only be signed again on the owner&apos;s laptop: run scripts/drive-export.ts with --resume {status.export}.</p>
          ) : null}
          {status.problems?.length ? (
            <ul className="small">
              {status.problems.map((p) => (
                <li key={p} className="train-row-error">
                  {p}
                </li>
              ))}
            </ul>
          ) : null}
          {status.state === "needs_erase" && status.erasable && status.drive ? (
            <div>
              <label className="field-label" htmlFor={`${id}-erase`}>
                Type {eraseWord} to erase {status.drive.title}. This deletes everything on it.
              </label>
              <input id={`${id}-erase`} className="train-input" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" />
              <button type="button" className="btn btn-outline" onClick={erase} disabled={busy || confirm.trim() !== eraseWord}>
                <Icon name="alert" size={16} />
                <span>Erase as exFAT</span>
              </button>
            </div>
          ) : null}
          {resume?.by === "card" ? (
            <div>
              <button type="button" className="btn btn-primary" onClick={carryOnNow} disabled={busy || !resume.drive || Boolean(reply?.kit)}>
                <Icon name="play" size={16} />
                <span>Carry on</span>
              </button>
              <p className="field-hint">
                {resume.drive
                  ? `Keeps the files already written to ${resume.drive.title} and writes only what is missing or wrong, in the same folder.`
                  : "Plug the drive back in, or pick one above, to carry on."}
              </p>
            </div>
          ) : null}
          {active ? (
            <button type="button" className="btn btn-outline" onClick={stop} disabled={busy}>
              <Icon name="close" size={16} />
              <span>Stop</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
