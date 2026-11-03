"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icons";
import type { RoverReport, RoverSetupState } from "@/lib/device/rover";
import { DRIVE_SPEED, LOOK_DEGREES, ROVER_TOOL_NAMES, type DriveDirection, type RangeSide, type RoverDriveReply, type RoverRanges } from "@/lib/device/rover-tools";

const POLL_MS = 3000;
/** Each drive while a button is held. The rover stops when one runs out, so letting go, or losing the page, stops it soon. */
const HOLD_MS = 400;
/** Never sooner than this between drives, however fast the rover answers. */
const HOLD_GAP_MS = 250;

const ERRORS: Record<string, string> = {
  fleet_not_configured: "The fleet isn't set up. It takes BOARD_FLEET_URL, which must be https and include /admin, and BOARD_FLEET_TOKEN.",
  setup_running: "A setup is already going on the rover.",
  rover_unavailable: "Couldn't reach the rover through the fleet.",
  not_found: "The rover is off on this site. It takes ROVER_ENABLED.",
};

interface Status {
  board: string;
  report: RoverReport | null;
  reportAt: string | null;
  setup: string | null;
  answers: boolean;
  tools: string[];
  why: string | null;
}

type Failure = { error?: string; message?: string; job?: string; step?: string | null };

const failureText = (data: Failure) => data.message ?? ERRORS[data.error ?? ""] ?? data.error ?? "That didn't work.";

type Setup =
  | { phase: "sending"; started: number }
  | { phase: "running"; started: number; job: string; step: string | null }
  | { phase: "done"; report: RoverReport }
  | { phase: "failed"; message: string };

const PAD: Array<{ direction: DriveDirection; label: string; icon: "arrowUp" | "arrowDown" | "chevronLeft" | "chevronRight"; area: string }> = [
  { direction: "forward", label: "Forward", icon: "arrowUp", area: "1 / 2" },
  { direction: "left", label: "Left", icon: "chevronLeft", area: "2 / 1" },
  { direction: "right", label: "Right", icon: "chevronRight", area: "2 / 3" },
  { direction: "back", label: "Back", icon: "arrowDown", area: "3 / 2" },
];

/** One side's range in words: millimetres, nothing in reach, or a sensor that didn't answer. */
function rangeText(ranges: RoverRanges, side: RangeSide): string {
  const mm = ranges[side];
  if (mm !== null) return `${mm} mm`;
  return ranges.clear.includes(side) ? "Clear" : "No reading";
}

const PART: Record<RoverReport["checks"][number]["part"], string> = { setup: "Setup", test: "Test" };

function Report({ report }: { report: RoverReport }) {
  return (
    <div aria-live="polite">
      <p>{report.ok ? "The setup and its self-test passed." : "The setup or its self-test found a problem."}</p>
      {report.checks.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check, i) => (
                <tr key={`${check.part}-${check.name}-${i}`}>
                  <td>
                    {check.name.replace(/_/g, " ")}
                    <div className="muted small">{PART[check.part]}</div>
                  </td>
                  <td>
                    {check.ok ? "Passed" : "Failed"}
                    {check.detail ? (
                      <div className="muted small" style={{ overflowWrap: "anywhere" }}>
                        {check.detail}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {report.ranges ? (
        <p className="small muted">
          Ranges at the test: front {rangeText(report.ranges, "front")}, left {rangeText(report.ranges, "left")}, right {rangeText(report.ranges, "right")}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Admin only, with ROVER_ENABLED: sets up the demo rover through the fleet in one go, shows its self-test, and drives it.
 * Holding a direction sends short drives one after another, and letting go sends a stop, then another once the last drive on
 * its way has answered. The rover's token stays on the server.
 */
export function DeviceRover() {
  const id = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [speed, setSpeed] = useState(DRIVE_SPEED.default);
  const [pan, setPan] = useState(0);
  const [tilt, setTilt] = useState(0);
  const [ranges, setRanges] = useState<RoverRanges | null>(null);
  const [photo, setPhoto] = useState<RoverDriveReply["image"]>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // One object per press, so a hold that ended can't carry on as the next press in the same direction.
  const held = useRef<{ direction: DriveDirection } | null>(null);
  // Drives from the pad that haven't answered yet.
  const driving = useRef(0);
  // A hold reads the speed on each drive, so moving the slider while holding takes effect at once.
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/device/rover", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Status & Failure;
      if (!res.ok) {
        setStatusMessage(failureText(data));
        return;
      }
      setStatus(data);
      setStatusMessage(null);
      if (data.setup) setSetup((current) => (current?.phase === "running" ? current : { phase: "running", started: Date.now(), job: data.setup!, step: null }));
    } catch {
      setStatusMessage("Couldn't reach Muse Muse.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once from the server.
    void load();
  }, [load]);

  const following = setup?.phase === "running" ? setup.job : null;
  const settled = useCallback(
    (state: RoverSetupState) => {
      if (state.state === "done") setSetup({ phase: "done", report: state.report });
      else if (state.state === "failed") setSetup({ phase: "failed", message: state.message });
      if (state.state !== "running") void load();
    },
    [load],
  );

  useEffect(() => {
    if (!following) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const res = await fetch(`/api/device/rover?job=${encodeURIComponent(following!)}`, { cache: "no-store", signal: controller.signal });
        const data = (await res.json().catch(() => ({}))) as RoverSetupState & Failure;
        if (controller.signal.aborted) return;
        if (res.ok && data.state === "running") setSetup((current) => (current?.phase === "running" ? { ...current, step: data.step } : current));
        else if (res.ok) return settled(data);
        // Anything else may pass, since the tunnel or the fleet can blink while the board keeps working.
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(poll, POLL_MS);
    }
    timer = setTimeout(poll, POLL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [following, settled]);

  const ticking = setup?.phase === "sending" || setup?.phase === "running";
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  async function setUp() {
    const started = Date.now();
    setNow(started);
    setSetup({ phase: "sending", started });
    try {
      const res = await fetch("/api/device/rover", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await res.json().catch(() => ({}))) as RoverSetupState & Failure;
      if (data.job && (res.status === 202 || res.status === 409)) setSetup({ phase: "running", started, job: data.job, step: data.step ?? null });
      else if (res.ok && data.state) settled(data);
      else setSetup({ phase: "failed", message: failureText(data) });
    } catch {
      setSetup({ phase: "failed", message: "Couldn't reach Muse Muse. The setup may still be going on the board, so reload in a minute." });
    }
  }

  /** One call to the rover. Null when it couldn't be made, with why in `said`. */
  const act = useCallback(async (body: Record<string, unknown>): Promise<RoverDriveReply | null> => {
    try {
      const res = await fetch("/api/device/rover/drive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as RoverDriveReply & Failure;
      if (!res.ok) {
        setSaid(failureText(data));
        return null;
      }
      if (data.ranges) setRanges(data.ranges);
      if (data.image) setPhoto(data.image);
      setSaid(data.ok ? data.text : (data.text ?? "The rover said no."));
      return data;
    } catch {
      setSaid("Couldn't reach Muse Muse.");
      return null;
    }
  }, []);

  /**
   * One drive from the pad. Each request goes its own way through the tunnel and the fleet, so a stop sent on letting go can
   * reach the rover before a drive sent just before it, and the rover would run that drive after stopping. An answer means
   * the rover has had the drive, so once the last one on its way answers, with nothing holding the pad, it stops again.
   */
  async function drive(body: Record<string, unknown>) {
    driving.current += 1;
    try {
      return await act(body);
    } finally {
      driving.current -= 1;
      if (driving.current === 0 && !held.current) void act({ action: "stop" });
    }
  }

  async function hold(direction: DriveDirection) {
    if (held.current) return;
    const press = { direction };
    held.current = press;
    while (held.current === press) {
      const sent = Date.now();
      const reply = await drive({ action: "drive", direction, ms: HOLD_MS, speed: speedRef.current });
      if (!reply?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, HOLD_GAP_MS - (Date.now() - sent))));
    }
  }

  const release = useCallback(() => {
    if (!held.current) return;
    held.current = null;
    void act({ action: "stop" });
  }, [act]);

  useEffect(() => {
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [release]);

  async function once(label: string, body: Record<string, unknown>) {
    setBusy(label);
    await act(body);
    setBusy(null);
  }

  const keyHold = (direction: DriveDirection) => (event: KeyboardEvent) => {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
      event.preventDefault();
      void hold(direction);
    }
  };
  const keyRelease = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") release();
  };

  const seconds = setup && "started" in setup ? Math.max(0, Math.round((now - setup.started) / 1000)) : 0;
  const ready = status?.answers === true;
  const missing = status ? [...ROVER_TOOL_NAMES].filter((name) => !status.tools.includes(name)) : [];
  const report = setup?.phase === "done" ? setup.report : (status?.report ?? null);

  return (
    <section className="card section-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Rover</h2>
      <p className="muted small">
        Sets up {status?.board ?? "the rover"} through the fleet in one go: its tool server, the motor and sensor sketch, and a self-test. Muse Wonder can then use the rover for a
        question above. Nothing on the rover runs a model, and it stops by itself for anything close in front.
      </p>
      {statusMessage ? (
        <p className="note train-callout-warn" role="alert">
          {statusMessage}
        </p>
      ) : null}
      <div className="row-actions">
        <button type="button" className="btn btn-primary" onClick={() => void setUp()} disabled={ticking}>
          {ticking ? <span className="spinner" aria-hidden /> : <Icon name="rocket" size={16} />}
          <span>Set up the rover</span>
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>
          <Icon name="refresh" size={16} />
          <span>Check again</span>
        </button>
      </div>
      <div aria-live="polite">
        {setup?.phase === "sending" ? <p className="small">Sending the kit to the board and starting the install. {seconds} s</p> : null}
        {setup?.phase === "running" ? (
          <p className="small">
            Installing and testing on the board. {seconds} s.{setup.step ? ` Last step: ${setup.step}.` : ""} The first install builds the sketch, which takes several minutes, and
            the test turns each wheel for a moment, so give the rover room.
          </p>
        ) : null}
        {setup?.phase === "failed" ? (
          <p className="note train-callout-warn" role="alert" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {setup.message}
          </p>
        ) : null}
      </div>
      {report ? <Report report={report} /> : null}
      {status ? (
        <p className="small muted">
          {ready
            ? missing.length
              ? `The rover is answering, without ${missing.join(", ")}. Set it up again.`
              : "The rover is answering."
            : `The rover isn't answering yet${status.why ? `: ${status.why}` : "."}`}
        </p>
      ) : null}

      <h3>Drive</h3>
      <label className="field-label" htmlFor={`${id}-speed`}>
        Speed: {speed}%
      </label>
      <input id={`${id}-speed`} type="range" min={20} max={DRIVE_SPEED.max} step={5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 4.5rem))", gap: "0.5rem", margin: "0.75rem 0" }} role="group" aria-label="Drive pad. Hold a direction to drive.">
        {PAD.map(({ direction, label, icon, area }) => (
          <button
            key={direction}
            type="button"
            className="btn btn-outline"
            style={{ gridArea: area, touchAction: "none", justifyContent: "center" }}
            disabled={!ready}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              void hold(direction);
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onKeyDown={keyHold(direction)}
            onKeyUp={keyRelease}
            onBlur={release}
            onContextMenu={(e) => e.preventDefault()}
            aria-label={`Drive ${label.toLowerCase()} while held`}
          >
            <Icon name={icon} size={18} />
          </button>
        ))}
        <button
          type="button"
          className="btn btn-primary"
          style={{ gridArea: "2 / 2", justifyContent: "center" }}
          disabled={!ready}
          onClick={() => {
            held.current = null;
            void act({ action: "stop" });
          }}
        >
          <span>Stop</span>
        </button>
      </div>

      <h3>Camera</h3>
      <label className="field-label" htmlFor={`${id}-pan`}>
        Pan: {pan} degrees
      </label>
      <input id={`${id}-pan`} type="range" min={LOOK_DEGREES.min} max={LOOK_DEGREES.max} step={5} value={pan} onChange={(e) => setPan(Number(e.target.value))} />
      <label className="field-label" htmlFor={`${id}-tilt`}>
        Tilt: {tilt} degrees
      </label>
      <input id={`${id}-tilt`} type="range" min={LOOK_DEGREES.min} max={LOOK_DEGREES.max} step={5} value={tilt} onChange={(e) => setTilt(Number(e.target.value))} />
      <div className="row-actions">
        <button type="button" className="btn btn-outline btn-sm" disabled={!ready || busy !== null} onClick={() => void once("look", { action: "look", pan, tilt })}>
          {busy === "look" ? <span className="spinner" aria-hidden /> : <Icon name="camera" size={16} />}
          <span>Point the camera</span>
        </button>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={!ready || busy !== null}
          onClick={() => {
            setPan(0);
            setTilt(0);
            void once("look", { action: "look", pan: 0, tilt: 0 });
          }}
        >
          <span>Straight ahead</span>
        </button>
        <button type="button" className="btn btn-outline btn-sm" disabled={!ready || busy !== null} onClick={() => void once("photo", { action: "photo" })}>
          {busy === "photo" ? <span className="spinner" aria-hidden /> : <Icon name="image" size={16} />}
          <span>Take a photo</span>
        </button>
        <button type="button" className="btn btn-outline btn-sm" disabled={!ready || busy !== null} onClick={() => void once("ranges", { action: "ranges" })}>
          {busy === "ranges" ? <span className="spinner" aria-hidden /> : <Icon name="chart" size={16} />}
          <span>Read the ranges</span>
        </button>
      </div>

      {said ? (
        <p className="small" role="status" style={{ overflowWrap: "anywhere" }}>
          {said}
        </p>
      ) : null}
      {ranges ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Front</th>
                <th scope="col">Left</th>
                <th scope="col">Right</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{rangeText(ranges, "front")}</td>
                <td>{rangeText(ranges, "left")}</td>
                <td>{rangeText(ranges, "right")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`data:${photo.mimeType};base64,${photo.data}`} alt="The rover's latest photo" style={{ maxWidth: "100%", height: "auto" }} />
      ) : null}
    </section>
  );
}
