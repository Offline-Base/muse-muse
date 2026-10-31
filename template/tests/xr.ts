// Platform file: don't edit. Drives the simulated headset from a test, through window.__musemuseXR (lib/xr/emulator.ts).
// Doesn't import iwer, so it typechecks in any product. In the demo recording each move is also an action on the timeline.
// Aim at names from useXRTarget, never at raw coordinates: they are the 3D version of getByRole.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { holdUnheldXr, holdXrResult, recordXrAction } from "./demo-fixtures";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface Target {
  name: string;
  position: Vec3;
  size?: Vec3;
}
interface Handle {
  mode: string;
  info: Record<string, unknown>;
  inSession(): boolean;
  frames(): number;
  waitFrames(n: number, timeoutMs?: number): Promise<number>;
  remote(method: string, params?: unknown): Promise<unknown>;
  targets(): Target[];
}
export type Hand = "left" | "right";
/** The controller's buttons. On the left hand "a-button" is its X and "b-button" its Y. */
export type XRButton = "trigger" | "squeeze" | "thumbstick" | "a-button" | "b-button";
declare const window: Window & { __musemuseXR: Handle };

/** Numbers as get_gamepad_state lists them, which skips the gaps in the WebXR gamepad's own lists. */
const BUTTONS: Record<XRButton, number> = { trigger: 0, squeeze: 1, thumbstick: 2, "a-button": 3, "b-button": 4 };
const STICK_X = 0;
const STICK_Y = 1;

export interface ViewStats {
  spread: number;
  colors: number;
  top: number;
  blank: boolean;
}

/**
 * Runs in the browser, from a viewport screenshot. Blank: a brightness spread under 6, under 12 colors, or one color over
 * 95% of the view. scripts/xr-peek.mjs has its own copy, which a template test keeps the same.
 */
export async function measureView(png: string): Promise<ViewStats> {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(320, 180);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.imageSmoothingEnabled = false;
  context.drawImage(bitmap, 0, 0, 320, 180);
  const { data } = context.getImageData(0, 0, 320, 180);
  const lumas: number[] = [];
  const bins = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    lumas.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    const bin = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  lumas.sort((a, b) => a - b);
  const spread = lumas[Math.floor(lumas.length * 0.95)] - lumas[Math.floor(lumas.length * 0.05)];
  const top = Math.max(...bins.values()) / lumas.length;
  return { spread: Number(spread.toFixed(1)), colors: bins.size, top: Number(top.toFixed(3)), blank: spread < 6 || bins.size < 12 || top > 0.95 };
}

const recording = () => test.info().project.name === "studio";
/** How long a judge screenshot waits for a model to finish. */
const BUSY_MS = 90_000;

function remote(page: Page, method: string, params?: unknown): Promise<unknown> {
  return page.evaluate(([m, p]) => window.__musemuseXR.remote(m as string, p), [method, params] as const);
}

const waitFrames = (page: Page, n = 3) => page.evaluate((count) => window.__musemuseXR.waitFrames(count, 15_000), n);

/** Yaw and pitch in degrees that face from one point to another. -z is straight ahead. */
export function facing(from: Vec3, to: Vec3): { pitch: number; yaw: number; roll: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const deg = 180 / Math.PI;
  return { pitch: Math.atan2(dy, Math.hypot(dx, dz)) * deg, yaw: Math.atan2(-dx, -dz) * deg, roll: 0 };
}

async function where(page: Page, target: Vec3 | string): Promise<Vec3> {
  if (typeof target !== "string") return target;
  const list = await xr.targets(page);
  const found = list.find((t) => t.name === target);
  if (!found) throw new Error(`No VR object is named "${target}". Named: ${list.map((t) => t.name).join(", ") || "none"}. Name it with useXRTarget.`);
  return found.position;
}

const labelOf = (target: Vec3 | string) => (typeof target === "string" ? target : "a point");

export const xr = {
  targets: (page: Page): Promise<Target[]> => page.evaluate(() => window.__musemuseXR.targets()),
  remote,

  /** The viewport as a person sees it. IWER's canvas covers the viewport, so a full-page screenshot would be wrong. */
  async viewStats(page: Page): Promise<{ stats: ViewStats; png: Buffer }> {
    const png = await page.screenshot({ type: "png" });
    return { stats: await page.evaluate(measureView, png.toString("base64")), png };
  },

  /** Presses Enter VR, waits for the session to draw, and fails on a blank view. */
  async enter(page: Page): Promise<void> {
    await page.getByRole("button", { name: /^Enter VR/ }).click();
    // Recorded as a VR move, so the demo's cursor is gone by the time the session draws.
    await recordXrAction(page, "Step into VR", async () => {
      await page.waitForFunction(() => window.__musemuseXR?.inSession(), null, { timeout: 15_000 });
      await waitFrames(page, 5);
    });
    if (recording()) return; // A screenshot would leave a gap in the recording.
    const { stats } = await xr.viewStats(page);
    expect(stats.blank, `The VR view is blank: ${JSON.stringify(stats)}`).toBe(false);
  },

  /** Ends the session, back to the 2D page. */
  async exit(page: Page): Promise<void> {
    await holdUnheldXr(page);
    await remote(page, "end_session");
    await page.waitForFunction(() => !window.__musemuseXR.inSession(), null, { timeout: 15_000 });
  },

  /** Turns the head to face a point or a named object, over `seconds`, with an optional step to a new spot. */
  look(page: Page, { from, to }: { from?: Vec3; to: Vec3 | string }, seconds = 1.2): Promise<unknown> {
    return recordXrAction(page, `Look at ${labelOf(to)}`, async () => {
      const now = (await remote(page, "get_transform", { device: "headset" })) as { position: Vec3 };
      const position = from ?? now.position;
      const orientation = facing(position, await where(page, to));
      return remote(page, "animate_to", { device: "headset", position, orientation, duration: seconds, easing: "minimum-jerk" });
    });
  },

  /** Points a controller at a point or a named object. */
  async aim(page: Page, hand: Hand, target: Vec3 | string): Promise<void> {
    await remote(page, "look_at", { device: `controller-${hand}`, target: await where(page, target) });
    await waitFrames(page);
  },

  /** Points a controller at a point or a named object and pulls the trigger. */
  select(page: Page, hand: Hand, target: Vec3 | string): Promise<void> {
    return recordXrAction(page, `Select ${labelOf(target)}`, async () => {
      await xr.aim(page, hand, target);
      await remote(page, "select", { device: `controller-${hand}` });
      await waitFrames(page);
    });
  },

  /** Holds a controller button down. */
  async press(page: Page, hand: Hand, button: XRButton, value = 1): Promise<void> {
    await remote(page, "set_gamepad_state", { device: `controller-${hand}`, buttons: [{ index: BUTTONS[button], value, touched: value > 0 }] });
    await waitFrames(page);
  },

  /** Lets a controller button go. */
  release: (page: Page, hand: Hand, button: XRButton): Promise<void> => xr.press(page, hand, button, 0),

  /** Reaches a controller to `from`, squeezes, carries it to `to` over `seconds`, and lets go. */
  grab(page: Page, hand: Hand, from: Vec3 | string, to: Vec3 | string, seconds = 1.2): Promise<void> {
    return recordXrAction(page, `Grab ${labelOf(from)}`, async () => {
      const device = `controller-${hand}`;
      await remote(page, "animate_to", { device, position: await where(page, from), duration: 0.5, easing: "minimum-jerk" });
      await waitFrames(page);
      await xr.press(page, hand, "squeeze");
      await remote(page, "animate_to", { device, position: await where(page, to), duration: seconds, easing: "minimum-jerk" });
      await waitFrames(page);
      await xr.release(page, hand, "squeeze");
    });
  },

  /** Holds the thumbstick at x and y (each -1 to 1, y -1 is forward) for `seconds`, then lets it spring back. */
  stick(page: Page, hand: Hand, x: number, y: number, seconds = 0.8): Promise<void> {
    return recordXrAction(page, "Move the thumbstick", async () => {
      const device = `controller-${hand}`;
      await remote(page, "set_gamepad_state", { device, axes: [{ index: STICK_X, value: x }, { index: STICK_Y, value: y }] });
      await page.waitForTimeout(seconds * 1000);
      await remote(page, "set_gamepad_state", { device, axes: [{ index: STICK_X, value: 0 }, { index: STICK_Y, value: 0 }] });
      await waitFrames(page);
    });
  },

  /** Switches to hands, and presses a named object with a fingertip. Back to controllers with xr.controllers(page). */
  touch(page: Page, hand: Hand, name: string): Promise<void> {
    return recordXrAction(page, `Touch ${name}`, async () => {
      await remote(page, "set_input_mode", { mode: "hand" });
      await runHand(page, hand, [{ target: name, approach: { distance: 0.1 }, press: { depth: 0.01, hold: 0.1, retract: 0.08 } }]);
    });
  },

  /** Switches to hands, points a hand at a point or a named object and pinches: the hand's way to press from afar. */
  pinch(page: Page, hand: Hand, target: Vec3 | string): Promise<void> {
    return recordXrAction(page, `Pinch ${labelOf(target)}`, async () => {
      const device = `hand-${hand}`;
      await remote(page, "set_input_mode", { mode: "hand" });
      await waitFrames(page);
      await remote(page, "look_at", { device, target: await where(page, target) });
      await waitFrames(page);
      await remote(page, "select", { device });
      await waitFrames(page);
    });
  },

  /** Back to controllers after xr.touch or xr.pinch. */
  async controllers(page: Page): Promise<void> {
    await remote(page, "set_input_mode", { mode: "controller" });
    await waitFrames(page);
  },

  /** Holds a result that fills the view in the demo video. A step that ran in VR holds one anyway when it ends. */
  hold: holdXrResult,
};

async function runHand(page: Page, hand: Hand, steps: unknown[]): Promise<void> {
  const result = (await remote(page, "run_sequence", { device: `hand-${hand}`, steps })) as { completed: boolean; reason?: string };
  if (!result.completed) throw new Error(`The ${hand} hand didn't finish: ${result.reason ?? "no reason given"}.`);
}

/** True when the page is in a VR session right now. */
export function inVRSession(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__musemuseXR?.inSession() === true);
}

/**
 * judgeShot's VR branch. The view must keep drawing and show something: a frozen or blank view fails here, even when screen
 * checks only warn, and the 2D layout checks don't apply. It leaves `xr: true` and what it measured in <name>.checked, and
 * verify's xrShotProblems reads those.
 */
export async function xrJudgeShot(page: Page, name: string): Promise<void> {
  // setXRStatus(text, true) says a model is still working, and a shot of that isn't the result.
  await page.locator('[data-xr-status][aria-busy="true"]').waitFor({ state: "detached", timeout: BUSY_MS }).catch(() => {
    throw new Error(`${name}: the VR view still says it is working after ${BUSY_MS / 1000} s. Wait for the result, then take the shot.`);
  });
  await page.evaluate(() => window.__musemuseXR.waitFrames(3, 10_000)).catch(() => {
    throw new Error(`${name}: The VR view stopped drawing.`);
  });
  const before = await page.evaluate(() => ({ f: window.__musemuseXR.frames(), t: performance.now() }));
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => ({ f: window.__musemuseXR.frames(), t: performance.now() }));
  const fps = Number((((after.f - before.f) * 1000) / (after.t - before.t)).toFixed(1));
  const { stats, png } = await xr.viewStats(page);
  expect(stats.blank, `${name}: the VR view is blank: ${JSON.stringify(stats)}. Light the scene and put something in front of the person.`).toBe(false);
  const xrAlerts = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"], .error')].map((el) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)).filter(Boolean).slice(0, 5),
  );
  mkdirSync("test-results/judge", { recursive: true });
  writeFileSync(`test-results/judge/${name}.png`, png);
  writeFileSync(`test-results/judge/${name}.checked`, `${JSON.stringify({ xr: true, canvas: { ...stats, fps }, xrAlerts, resultTop: null, pageHeight: null })}\n`);
}
