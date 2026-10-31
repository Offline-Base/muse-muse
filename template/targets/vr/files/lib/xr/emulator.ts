// Platform file: don't edit. ensureXR() decides where the product runs: a real headset, a simulated Meta Quest 3 from IWER
// on a computer, or a plain 3D preview on a phone. Everything a test needs goes through window.__musemuseXR.
import { useSyncExternalStore } from "react";
import { watchSessions } from "@/lib/xr/sessions";
import { listTargets, targetResolver, type XRTarget } from "@/lib/xr/targets";

export type XRMode = "native" | "emulated" | "preview";

export interface MuseXR {
  mode: XRMode;
  /** What the renderer reports: renderer, antialias, drawCalls, triangles, buffer. scripts/xr-peek.mjs prints them. */
  info: Record<string, unknown>;
  /** How many of the scene's own objects are in view right now, leaving out the floor and controllers. XRStage sets this. */
  sceneObjects?(): number | null;
  /** How many times three.js has drawn the scene. Unlike frames(), this stops when the scene crashes. XRStage sets this. */
  drawn?(): number;
  inSession(): boolean;
  frames(): number;
  waitFrames(n: number, timeoutMs?: number): Promise<number>;
  remote(method: string, params?: unknown): Promise<unknown>;
  targets(): XRTarget[];
}

declare global {
  interface Window {
    __musemuseXR?: MuseXR;
  }
}

/**
 * The simulated view's height in radians. IWER's default is 90 degrees, which across a 16:9 window is 121: objects a person
 * reads easily in a headset come out small and stretched at the edges, in screenshots and the demo too. A real headset
 * brings its own.
 */
const SIMULATED_FOVY = Math.PI / 3;

let ensured: Promise<MuseXR> | null = null;

export function ensureXR(): Promise<MuseXR> {
  ensured ??= install();
  return ensured;
}

async function install(): Promise<MuseXR> {
  const native = (await navigator.xr?.isSessionSupported("immersive-vr").catch(() => false)) ?? false;
  if (native) return expose("native", null);
  // A simulated headset is no use on a touch screen, so a phone gets a 3D preview and downloads none of it.
  if (matchMedia("(pointer: coarse)").matches) return expose("preview", null);

  const { XRDevice, metaQuest3 } = await import("iwer");
  const device = new XRDevice(metaQuest3, { stereoEnabled: false, fovy: SIMULATED_FOVY });
  // Without forceInstall IWER skips itself wherever navigator.xr exists, which includes desktop Chrome and headless Chromium.
  device.installRuntime({ forceInstall: true });
  device.position.set(0, 1.6, 0);
  fillViewport(device.canvasContainer);
  oneView();
  device.remote.setTargetResolver(targetResolver as never);
  // People get the handles and play mode. Tests don't, and neither does a headset, so neither downloads it.
  if (!navigator.webdriver) {
    const { DevUI } = await import("@iwer/devui");
    device.installDevUI(DevUI);
    addSimulatedChip(device.canvasContainer);
  }
  return expose("emulated", device);
}

/**
 * During a session IWER moves the canvas into a full-screen container, but only its drawing size follows, not its CSS
 * size. R3F writes the size of the canvas's old box in px on the canvas's style, so without this a 1280x720 view shows
 * squeezed into that box, centered, with the page around it. The rule stops applying when IWER moves the canvas back.
 */
function fillViewport(container: HTMLElement): void {
  container.id = "musemuse-xr-view";
  container.style.background = "#000";
  const style = document.createElement("style");
  style.textContent = "#musemuse-xr-view > canvas { width: 100% !important; height: 100% !important; }";
  document.head.appendChild(style);
}

/**
 * With stereo off IWER still reports two views and gives the right one a zero-width viewport, and three.js draws every
 * object for it anyway. So all the vertex work happens twice with nothing to show for it. Reporting one view fixes that.
 */
function oneView(): void {
  const proto = (window as unknown as { XRFrame: { prototype: XRFrame } }).XRFrame.prototype;
  const original = proto.getViewerPose;
  proto.getViewerPose = function (this: XRFrame, space: XRReferenceSpace) {
    const pose = original.call(this, space);
    if (!pose) return pose;
    return { transform: pose.transform, emulatedPosition: pose.emulatedPosition, views: [pose.views[0]] } as unknown as XRViewerPose;
  };
}

/** For people on a computer: says the headset is simulated, and gives them a way out of it. */
function addSimulatedChip(container: HTMLElement): void {
  const bar = document.createElement("div");
  bar.style.cssText = "position:absolute;top:12px;left:12px;z-index:1000;display:flex;gap:8px;align-items:center;font:600 14px/1 Inter,system-ui,sans-serif";
  const chip = document.createElement("span");
  chip.textContent = "Simulated Meta Quest 3";
  chip.style.cssText = "padding:10px 14px;border-radius:999px;background:rgba(255,255,255,.92);color:#1c2b33";
  const exit = document.createElement("button");
  exit.type = "button";
  exit.textContent = "Exit VR";
  exit.style.cssText = "padding:10px 14px;border:0;border-radius:999px;background:#0064e0;color:#fff;font:inherit;cursor:pointer";
  exit.addEventListener("click", () => void current?.end());
  bar.append(chip, exit);
  container.appendChild(bar);
}

let current: XRSession | null = null;
const listeners = new Set<() => void>();

function setSession(session: XRSession | null): void {
  current = session;
  for (const listener of listeners) listener();
}

/** True while a VR session runs, for the 2D page around it. */
export function useInVR(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current !== null,
    () => false,
  );
}

function expose(mode: XRMode, device: { remote: { dispatch(m: string, p?: unknown): Promise<unknown> } } | null): MuseXR {
  let frames = 0;
  if (navigator.xr) {
    watchSessions(navigator.xr, (started) => {
      setSession(started);
      started.addEventListener("end", () => {
        if (current === started) setSession(null);
      });
      const count: XRFrameRequestCallback = () => {
        frames++;
        if (current === started) started.requestAnimationFrame(count);
      };
      started.requestAnimationFrame(count);
    });
  }
  const handle: MuseXR = {
    mode,
    info: {},
    inSession: () => current !== null,
    frames: () => frames,
    waitFrames: (n, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const goal = frames + n;
        const started = performance.now();
        const check = () => {
          if (frames >= goal) resolve(frames);
          else if (performance.now() - started > timeoutMs) reject(new Error(`only ${n - (goal - frames)} of ${n} frames in ${timeoutMs} ms`));
          else setTimeout(check, 20);
        };
        check();
      }),
    remote: (method, params) => {
      if (!device) return Promise.reject(new Error("Only a simulated headset can be scripted."));
      return device.remote.dispatch(method, params);
    },
    targets: listTargets,
  };
  window.__musemuseXR = handle;
  return handle;
}
