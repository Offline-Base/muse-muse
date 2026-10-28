// Platform file: don't edit. The demo video's recorder.
// The platform copies tests/smoke.spec.ts to tests/smoke.demo.spec.ts with its `@playwright/test` imports pointed here
// and runs the copy in the "studio" project. There the page fixture records the test for the platform's Demo Studio:
// JPEG frames from a CDP screencast (2560x1440, at most 30 fps), a cursor that glides to each control, text that
// appears key by key, a file chip on uploads, and a timeline of steps, actions, page activity, aria-busy changes,
// scrolls and results. Each new result is brought on screen and held a moment before the test moves on, and a passing
// test ends on its latest result. Frames are left out while the test takes a page screenshot. It writes
// test-results/demo/timeline.json (version 1) and test-results/demo/frames/*.jpg. In every other project this module
// is plain @playwright/test. The choreography never changes what an action does: an error in it is swallowed, the
// typing is only drawn (the app sees the action's own events and nothing else), and the original action always runs
// with the arguments the test gave it. The time the choreography adds is added to the test's timeout.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  test as base,
  type CDPSession,
  type Frame,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
  type TestStepInfo,
} from "@playwright/test";

export * from "@playwright/test";

/** The Playwright project that records. "demo" is the old recorder (Playwright's own video), kept for older platforms. */
const DEMO_PROJECT = "studio";
/** The most frames a second the screencast may send. Acks are held back to keep to it. */
const MAX_FPS = 30;
/** How long a new result stays on screen, counted from when it is in view, before the test moves on. */
const RESULT_HOLD_MS = 2800;
/** How long the final state stays on screen after the last result's hold, so the video can end on it. */
const HOLD_MS = 800;
/** How long an action's choreography waits for its element when neither the action nor the test sets a timeout. */
const WAIT_MS = 120_000;
/** How long one call into the page may take before the recorder goes on without it, for a page whose clock is paused. */
const PAGE_CALL_MS = 4000;
/** The file chip's drop: the upload happens when it lands, and the next action waits for it to fade. */
const CHIP_MS = 900;
const CHIP_LAND_MS = 550;
/** Names the recorder adds to the page: the binding the page reports through and the cursor's own API. */
const BINDING = "__musemuseDemoReport";
const API = "__musemuseDemo";

interface Point {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type ActionKind = "goto" | "click" | "type" | "upload" | "select" | "check" | "press" | "hover";
type ActionMethod = "click" | "dblclick" | "check" | "uncheck" | "selectOption" | "setInputFiles" | "fill" | "hover" | "press";

/** The Locator methods the recorder choreographs, and the timeline kind each one records. */
const ACTIONS: Record<ActionMethod, ActionKind> = {
  click: "click",
  dblclick: "click",
  check: "check",
  uncheck: "check",
  selectOption: "select",
  setInputFiles: "upload",
  fill: "type",
  hover: "hover",
  press: "press",
};
/** Methods whose options come first. The rest take a value (text, key, files, options to select) and then options. */
const OPTIONS_FIRST = new Set<ActionMethod>(["click", "dblclick", "check", "uncheck", "hover"]);

interface ActionOptions {
  force?: boolean;
  timeout?: number;
  trial?: boolean;
  position?: Point;
}
interface ActionEntry {
  kind: ActionKind;
  /** When the cursor starts moving to the element. Waiting for the element to appear comes before it. */
  t0: number;
  /** When the cursor is there and Playwright's own action starts. It may still wait, say for a button to be enabled. */
  ready: number;
  t1: number;
  label: string;
  rect?: Rect | undefined;
  fileName?: string;
  /** Characters drawn into the field key by key, for fills. */
  typed?: number;
  /** How long the choreography waited for the element, which the action itself would have waited too. */
  waited: number;
}
/** What prepareTarget measures in the page, in viewport CSS px. */
interface Target {
  /** The element's first box, where Playwright points the mouse for a click, even when it is tiny or transparent. */
  own: Rect | null;
  /** What a viewer sees of the element: itself, or for something hidden its picker button, its label or a parent. */
  seen: Rect | null;
  label: string;
  /** An enabled text field whose value the fill changes: the recorder draws the new text into it key by key. */
  typeable: boolean;
  /** A visible native file input, whose "Choose file" button sits at its left end. */
  picker: boolean;
  /** The element is <html> or <body>, so there is nothing to point at. */
  whole: boolean;
  /** Where the cursor overlay last saw the mouse in this document. */
  mouse: Point | null;
}
/** A result the page brought on screen for the recorder (demoPageScript settle). Times are the page's Date.now(). */
interface Settled {
  /** When it appeared, which also says which result it is. */
  at: number;
  /** When it came on screen: when the scroll to it started, or when it appeared if it was already in view. */
  t: number;
  /** When it was all in view: when that scroll ended, or when it appeared. */
  since: number;
  /** Its box once in view, and the page's scroll position then. */
  rect: Rect;
  scrollY: number;
}
/** What a page sends a few times a second. Times are the page's Date.now(). */
interface PageReport {
  activity?: Array<{ t: number; added: number; changed: number; text: number; rect: Rect }>;
  busy?: Array<{ t: number; on: boolean; rect: Rect }>;
  scrolls?: Array<{ t: number; y: number }>;
}
/** The overlay's API in the page, from demoPageScript. */
interface DemoApi {
  ripple(x: number, y: number): void;
  chip(x: number, y: number, text: string): void;
  where(): Point | null;
  scroll(to: number): Promise<boolean>;
  type(el: Element, text: string, delay: number): Promise<number>;
  settle(after: number, final: boolean): Promise<Settled | null>;
}
type DemoWindow = Record<string, DemoApi | undefined>;

/** Slow start, slow finish (easeInOutCubic). */
export function easeInOut(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

/** How long the cursor takes to glide a distance in CSS px: 450 ms for a short hop, up to 750 ms across the screen. */
export function glideMs(distance: number): number {
  return Math.round(450 + 300 * Math.min(1, Math.max(0, distance) / 900));
}

/**
 * What the recorder draws for a fill, at most about 1.6 s of keys. Text over 160 characters shows its first 60 and the
 * fill puts in the rest. The drawing stops before a line break or a tab, which a one-line field can't show.
 */
export function typingPlan(value: string): { text: string; delay: number } {
  const chars = Array.from(value);
  let typed = chars.length > 160 ? chars.slice(0, 60) : chars;
  const stop = typed.findIndex((c) => c === "\n" || c === "\r" || c === "\t");
  if (stop >= 0) typed = typed.slice(0, stop);
  return { text: typed.join(""), delay: typed.length ? Math.min(45, Math.max(8, 1600 / typed.length)) : 0 };
}

/** The file names in setInputFiles' first argument: a path, a file payload, or a list of either. */
export function uploadNames(files: unknown): string[] {
  return (Array.isArray(files) ? files : [files])
    .map((f) => (typeof f === "string" ? path.basename(f) : f && typeof f === "object" && "name" in f ? String(f.name) : ""))
    .filter(Boolean);
}

/** Width and height of a JPEG, from its start-of-frame marker. Null when the bytes don't say. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const at = (i: number) => bytes[i] ?? 0;
  const u16 = (i: number) => (at(i) << 8) | at(i + 1);
  for (let i = 2; i + 9 < bytes.length && at(i) === 0xff; i += 2 + u16(i + 2)) {
    const marker = at(i + 1);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16(i + 7), height: u16(i + 5) };
    }
  }
  return null;
}

/** A rect cut to the viewport and rounded, or undefined when none of it is on screen. */
export function clampRect(r: Rect, viewport: { width: number; height: number }): Rect | undefined {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(viewport.width, r.x + r.w);
  const y1 = Math.min(viewport.height, r.y + r.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return undefined;
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

/**
 * Where the cursor aims in a box: its middle, or for a native file input its "Choose file" button at the left end.
 * The box is cut to the viewport first, so the cursor never aims off screen.
 */
export function aimPoint(box: Rect, viewport: { width: number; height: number }, picker = false): Point {
  const part = clampRect(box, viewport) ?? box;
  return { x: picker ? part.x + Math.min(part.w / 2, 48) : part.x + part.w / 2, y: part.y + part.h / 2 };
}

type LocatorAction = (...args: unknown[]) => Promise<unknown>;

/**
 * Calls an original Locator method as a method of the locator itself. Playwright names an action in its errors from
 * the stack ("locator.click: Timeout ..."), and calling it through .apply or .call would show there instead.
 */
function callAsMethod(locator: Locator, method: ActionMethod, original: LocatorAction, args: unknown[]): Promise<unknown> {
  const own = locator as unknown as Record<ActionMethod, LocatorAction>;
  Object.defineProperty(locator, method, { value: original, configurable: true, writable: true });
  try {
    return own[method](...args);
  } finally {
    Reflect.deleteProperty(locator, method);
  }
}

/** Takes this file's lines out of an action's error stack, so Playwright points at the test's own line. */
function withoutOwnFrames(err: unknown): unknown {
  if (err instanceof Error && err.stack) err.stack = err.stack.split("\n").filter((line) => !/[\\/]demo-fixtures\.ts:\d/.test(line)).join("\n");
  return err;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const firstLine = (err: unknown) => ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").slice(0, 300);
const shortName = (s: string) => (s.length > 36 ? `${s.slice(0, 33)}...` : s);
const urlLabel = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
};

/**
 * A page call that gives up after `ms`. A page whose clock is paused (page.clock) or that is stuck in a long task
 * would otherwise hang the test. The call itself goes on in the page, and its late result or error is ignored.
 */
function within<T>(work: Promise<T>, what: string, ms = PAGE_CALL_MS): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${Math.round(ms / 100) / 10} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The recording in progress, if any. The patched Locator methods and test.step check it. */
let current: DemoRecorder | null = null;
/** Only the first test a worker runs is recorded, so a spec with more than one test gives the first test's video. */
let recordedOnce = false;

/** One test's recording: the screencast, the cursor choreography and the timeline. */
class DemoRecorder {
  readonly page: Page;
  readonly dir: string;
  readonly steps: Array<{ title: string; t0: number; t1: number; depth: number }> = [];
  // Every time below is epoch ms until the timeline is written.
  private readonly actions: ActionEntry[] = [];
  private readonly activity: Array<{ t: number; added: number; changed: number; text: number; rect: Rect }> = [];
  private readonly busy: Array<{ t: number; on: boolean; rect: Rect }> = [];
  private readonly scrolls: Array<{ t: number; y: number }> = [];
  private readonly results: Array<{ t: number; rect: Rect; scrollY: number }> = [];
  private readonly viewports: Array<{ t: number; width: number; height: number }> = [];
  private readonly frames: Array<{ file: string; at: number }> = [];
  private readonly writes = new Set<Promise<void>>();
  private readonly problems: string[] = [];
  private readonly restores: Array<() => void> = [];
  private readonly testInfo: TestInfo;
  /** The test's actionTimeout, 0 when it has none. */
  private readonly actionTimeout: number;
  /** Inter for the file chip (scripts/demo-inter.woff2) as base64, when the product has it. */
  private readonly font: string | null;
  /** The viewport the recording started with, which the timeline's rects are measured in. */
  private viewport = { width: 1280, height: 720 };
  /** The viewport now, after any page.setViewportSize. */
  private screen = { width: 1280, height: 720 };
  private dpr = 1;
  private cdp: CDPSession | null = null;
  private starting: Promise<void> | null = null;
  /** Capture time of the first frame: time zero of the timeline. */
  private origin: number | null = null;
  private startedAt = 0;
  private endedAt: number | null = null;
  private stopping = false;
  private lastData = "";
  private acks: Promise<void> = Promise.resolve();
  private lastAck = 0;
  private throttled = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | null = null;
  private firstFrame: (() => void) | null = null;
  private mouse: Point | null = null;
  private acting = false;
  private navigating = 0;
  /** Page screenshots and viewport changes running now. Frames that arrive meanwhile are dropped. */
  private blackout = 0;
  /** When the last result the recorder held appeared, so each one is held once. */
  private settled = 0;

  constructor(page: Page, root: string, dpr: number, testInfo: TestInfo, actionTimeout: number) {
    this.page = page;
    this.dir = path.join(root, "test-results", "demo");
    this.dpr = dpr;
    this.testInfo = testInfo;
    this.actionTimeout = actionTimeout;
    let font: string | null = null;
    try {
      font = readFileSync(path.join(root, "scripts", "demo-inter.woff2")).toString("base64");
    } catch {
      // The chip uses the system's fonts.
    }
    this.font = font;
  }

  /** Sets everything up before the test opens the product. The screencast starts once the app is on screen. */
  async install(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(path.join(this.dir, "frames"), { recursive: true });
    this.viewport = this.page.viewportSize() ?? this.viewport;
    this.screen = { ...this.viewport };
    this.patchLocators();
    this.patchGoto();
    this.patchScreenshot();
    this.patchViewport();
    await this.page.exposeBinding(BINDING, (_source, json: string) => this.onPageReport(json));
    await this.page.addInitScript(demoPageScript, { binding: BINDING, api: API, font: this.font });
  }

  note(problem: string): void {
    if (this.problems.length < 100) this.problems.push(problem);
  }

  /** Gives the test back the time the recorder added, unless it runs with no timeout at all. */
  private extendTimeout(ms: number): void {
    const info = this.testInfo;
    if (ms > 0 && info.timeout > 0) info.setTimeout(info.timeout + Math.ceil(ms));
  }

  /** Starts the screencast once and waits for its first frame. The cursor appears at its resting place. */
  start(): Promise<void> {
    this.starting ??= (async () => {
      try {
        const cdp = await this.page.context().newCDPSession(this.page);
        this.cdp = cdp;
        cdp.on("Page.screencastFrame", (frame) => this.onFrame(frame));
        const first = new Promise<void>((resolve) => {
          this.firstFrame = resolve;
          setTimeout(resolve, 1500);
        });
        this.startedAt = Date.now();
        await this.screencast();
        await first;
        await this.moveTo(this.restPoint());
      } catch (err) {
        this.note(`start: ${firstLine(err)}`);
      }
    })();
    return this.starting;
  }

  /** Ends the recording: restores Playwright, holds the final state, stops the screencast and writes the timeline. */
  async finish(testInfo: TestInfo): Promise<void> {
    for (const restore of this.restores.splice(0)) restore();
    try {
      if (!this.page.isClosed()) {
        await this.start();
        // A passing test ends on its latest result, however small, held like every other one.
        if (testInfo.status === "passed") await this.settleResult(true);
        this.extendTimeout(HOLD_MS);
        await sleep(HOLD_MS);
      }
      await this.stop();
    } catch (err) {
      this.note(`stop: ${firstLine(err)}`);
    }
    try {
      const timeline = this.timeline(testInfo.status ?? "passed");
      writeFileSync(path.join(this.dir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
      if (this.problems.length) writeFileSync(path.join(this.dir, "recorder.log"), `${this.problems.join("\n")}\n`);
      const problems = this.problems.length ? `, ${this.problems.length} problem(s) in test-results/demo/recorder.log` : "";
      console.log(
        `musemuse demo: ${timeline.frames.length} frames, ${timeline.steps.length} steps, ${timeline.actions.length} actions, ` +
          `${timeline.results.length} results, ${timeline.duration} s${problems}`,
      );
    } catch (err) {
      console.log(`musemuse demo: could not write the timeline: ${firstLine(err)}`);
    }
  }

  /**
   * Holds a new result on screen before the test moves on, as a person would read it: the page scrolls it into view
   * when the test left most of it off screen (demoPageScript settle), then the recorder waits until it has been in
   * view RESULT_HOLD_MS. A result is a section that stopped being busy, or a burst that added content. Each one is
   * held once, and the timeline gets it with its box once it is in view, for the camera. Small changes (under 2% of
   * the screen) are left alone, except at the end of the test (`final`). The test gets the time back. Returns the ms it
   * took, and never throws.
   */
  async settleResult(final = false): Promise<number> {
    if (!this.starting || this.page.isClosed()) return 0;
    const started = Date.now();
    try {
      const after = this.settled;
      const shown = await within(
        this.page.evaluate(({ api, after, final }) => (window as unknown as DemoWindow)[api]?.settle(after, final) ?? null, { api: API, after, final }),
        "bringing the result on screen",
      );
      if (!shown) return Date.now() - started;
      this.settled = shown.at;
      // Page times come from the browser's own clock, which the recorder saved before a test could fake it.
      const at = (t: number) => (Math.abs(t - Date.now()) < 60_000 ? t : Date.now());
      this.results.push({ t: at(shown.t), rect: shown.rect, scrollY: shown.scrollY });
      const wait = at(shown.since) + RESULT_HOLD_MS - Date.now();
      if (wait > 0) await sleep(wait);
    } catch (err) {
      this.note(`result: ${firstLine(err)}`);
    }
    const took = Date.now() - started;
    this.extendTimeout(took);
    return took;
  }

  /** Runs one patched Locator action: the choreography, then the original action, recorded in the timeline. */
  async perform(locator: Locator, method: ActionMethod, args: unknown[], run: () => Promise<unknown>): Promise<unknown> {
    const options = (args[OPTIONS_FIRST.has(method) ? 0 : 1] ?? {}) as ActionOptions;
    // A trial run doesn't act, and an action started while another one runs (Promise.all) just runs.
    if (this.acting || options.trial) return run();
    this.acting = true;
    const started = Date.now();
    const entry: ActionEntry = { kind: ACTIONS[method], t0: started, ready: started, t1: 0, label: "", waited: 0 };
    // Clearing a file input (setInputFiles([])) is an upload with no file name.
    if (entry.kind === "upload") entry.fileName = uploadNames(args[0])[0] ?? "";
    let holdAfter = 0;
    let held = 0;
    try {
      await this.start();
      // The last result gets its moment before the cursor heads somewhere else.
      held = await this.settleResult();
      holdAfter = await this.choreograph(locator, method, args, options, entry);
    } catch (err) {
      this.note(`${method}: ${firstLine(err)}`);
    }
    entry.ready = Date.now();
    // Waiting for the element is the action's own wait, and a result's hold gave its time back already. The rest is
    // the choreography's, so the test gets it back too.
    this.extendTimeout(entry.ready - started - held - entry.waited);
    let result: unknown;
    try {
      result = await run();
    } finally {
      entry.t1 = Date.now();
      this.actions.push(entry);
      this.acting = false;
    }
    if (holdAfter > 0) {
      this.extendTimeout(holdAfter);
      await sleep(holdAfter);
    }
    return result;
  }

  /**
   * What a person would do before the action: wait for the element, read a result that came with it, bring the
   * element on screen, glide the cursor to it and pause. Fields get a click ripple and their new text drawn key by
   * key, selects a ripple, uploads a ripple and the file chip. Returns ms to hold after the action. Throws on anything
   * unexpected, and perform swallows it.
   */
  private async choreograph(locator: Locator, method: ActionMethod, args: unknown[], options: ActionOptions, entry: ActionEntry): Promise<number> {
    const kind = ACTIONS[method];
    // Clicks, checks and hovers move the real mouse to the center of the element's own box (the part on screen), so
    // the cursor aims there even when it is tiny or transparent. The other actions don't move the mouse, so the cursor
    // goes to what a viewer sees, like the FilePicker button for its hidden input.
    const pointer = kind === "click" || kind === "check" || kind === "hover";
    const value = kind === "type" ? String(args[0] ?? "") : null;
    const aim = (t: Target): { box: Rect; at: Point } | null => {
      const box = pointer ? (t.own ?? t.seen) : (t.seen ?? t.own);
      if (!box) return null;
      if (options.position && box === t.own) return { box, at: { x: box.x + options.position.x, y: box.y + options.position.y } };
      return { box, at: aimPoint(box, this.screen, t.picker && !pointer) };
    };
    const measure = (scroll: boolean) =>
      within(locator.evaluate(prepareTarget, { scroll, pointer, value, api: API }, { timeout: 5000 }), "measuring the element");

    // Wait the way the action would, so the cursor moves once the element is there: visible for most actions, only in
    // the page for a hidden file input, a key press and a forced action. Never longer than the action itself may wait.
    const waitFrom = Date.now();
    const attached = kind === "upload" || kind === "press" || options.force;
    await locator.waitFor({ state: attached ? "attached" : "visible", timeout: options.timeout || this.actionTimeout || WAIT_MS });
    // An element that came with a result, like a follow-up field under an answer, lets the answer be read first.
    if (Date.now() - waitFrom > 500) await this.settleResult();
    // Neither wait is the choreography's: the element's is the action's own, and settleResult gave its hold back.
    entry.waited = Date.now() - waitFrom;
    entry.t0 = Date.now();
    let target = await measure(true).catch((err: unknown) => {
      this.note(`scroll: ${firstLine(err)}`);
      return measure(false);
    });
    let aimed = aim(target);
    if (aimed && kind !== "upload" && !clampRect(aimed.box, this.screen)) {
      // Inside a scrolling box the page's scroll isn't enough: Playwright scrolls the box, then measure again.
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
      target = await measure(false);
      aimed = aim(target);
    }
    // A press is labelled with its key, like "Enter in Search", or just "Escape" when pressed on the page.
    entry.label = kind === "press" ? (target.whole ? String(args[0]) : `${String(args[0])} in ${target.label}`) : target.label;
    // The timeline gets what a viewer sees, even when the cursor aims at a tiny or transparent input.
    if (aimed) entry.rect = clampRect(target.seen ?? aimed.box, this.screen);
    if (kind === "type") entry.typed = 0;
    if (!aimed || (kind === "press" && target.whole)) return 0;

    // Start from where the overlay last saw the mouse: an action this file doesn't patch may have moved it.
    if (target.mouse && this.mouse && Math.hypot(target.mouse.x - this.mouse.x, target.mouse.y - this.mouse.y) > 2) this.mouse = target.mouse;
    let point = aimed.at;
    await this.glide(point);
    // Something still moving, like a card sliding in, gets a short second glide so the action doesn't jump the cursor.
    const settled = await measure(false).catch(() => null);
    const again = settled && aim(settled);
    if (settled && again) {
      if (Math.hypot(again.at.x - point.x, again.at.y - point.y) > 3) {
        point = again.at;
        await this.glide(point, 220);
      }
      entry.rect = clampRect(settled.seen ?? again.box, this.screen) ?? entry.rect;
    }
    await sleep(120);

    // Clicks, checks and hovers show their ripple from the real mousedown. These actions don't press the mouse.
    if (kind === "type" || kind === "select" || kind === "upload") await this.callPage("ripple", point);
    if (value !== null && target.typeable) {
      const plan = typingPlan(value);
      if (plan.text) {
        await sleep(140);
        // Drawn only: the page gets no key or input events, and the fill that runs next sets the exact value with its
        // own, as it would without the recorder.
        const draw = locator.evaluate((el, a) => (window as unknown as DemoWindow)[a.api]?.type(el, a.text, a.delay) ?? 0, {
          api: API,
          text: plan.text,
          delay: plan.delay,
        });
        entry.typed = await within(draw, "typing", PAGE_CALL_MS + plan.text.length * plan.delay * 2);
      }
    }
    const names = kind === "upload" ? uploadNames(args[0]) : [];
    const first = names[0];
    if (first) {
      await this.callPage("chip", point, names.length > 1 ? `${shortName(first)} and ${names.length - 1} more` : shortName(first));
      await sleep(CHIP_LAND_MS);
      return CHIP_MS - CHIP_LAND_MS;
    }
    return 0;
  }

  /** Eased glide with a slight arc, in small page.mouse.move steps, so the app sees real mouse moves. */
  private async glide(to: Point, ms?: number): Promise<void> {
    const from = this.mouse ?? this.restPoint();
    if (!this.mouse) await this.moveTo(from);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 2) return;
    const duration = ms ?? glideMs(distance);
    const bend = Math.min(36, distance * 0.08);
    const t0 = Date.now();
    for (let p = 0; p < 1; ) {
      await sleep(12);
      p = Math.min(1, (Date.now() - t0) / duration);
      const e = easeInOut(p);
      const arc = Math.sin(Math.PI * e) * bend;
      await this.moveTo({ x: from.x + dx * e - (dy / distance) * arc, y: from.y + dy * e + (dx / distance) * arc });
    }
  }

  private async moveTo(p: Point): Promise<void> {
    await this.page.mouse.move(p.x, p.y);
    this.mouse = p;
  }

  /** Where the cursor waits before the first action: the right edge, outside the 960 px column products use. */
  private restPoint(): Point {
    return { x: this.screen.width - 100, y: Math.round(this.screen.height * 0.72) };
  }

  private async callPage(name: "ripple" | "chip", at: Point, text = ""): Promise<void> {
    const call = this.page.evaluate(
      ({ api, name, x, y, text }) => {
        const demo = (window as unknown as DemoWindow)[api];
        if (name === "chip") demo?.chip(x, y, text);
        else demo?.ripple(x, y);
      },
      { api: API, name, x: at.x, y: at.y, text },
    );
    await within(call, name);
  }

  /** Patches the actions on Locator.prototype for this recording. finish puts the originals back. */
  private patchLocators(): void {
    const proto = Object.getPrototypeOf(this.page.locator("body")) as Record<ActionMethod, LocatorAction>;
    for (const method of Object.keys(ACTIONS) as ActionMethod[]) {
      const original = proto[method];
      const recorder = this;
      proto[method] = function (this: Locator, ...args: unknown[]) {
        const run = () => callAsMethod(this, method, original, args);
        const result = current === recorder && this.page() === recorder.page ? recorder.perform(this, method, args, run) : run();
        return result.catch((err: unknown) => {
          throw withoutOwnFrames(err);
        });
      };
      this.restores.push(() => {
        proto[method] = original;
      });
    }
  }

  /** page.goto records a goto action, and the first one starts the screencast once the page has loaded. */
  private patchGoto(): void {
    const page = this.page;
    const goto = page.goto.bind(page);
    page.goto = async (url: string, options?: Parameters<Page["goto"]>[1]): Promise<Response | null> => {
      // A result on the page being left gets its moment first.
      await this.settleResult();
      const t0 = Date.now();
      this.navigating++;
      try {
        return await goto(url, options);
      } finally {
        this.navigating--;
        this.actions.push({ kind: "goto", t0, ready: t0, t1: Date.now(), label: url, waited: 0 });
        await this.start();
        // A new document starts without the cursor. Show it where it was.
        if (this.mouse) await page.mouse.move(this.mouse.x, this.mouse.y).catch(() => {});
      }
    };
    // Navigations the test didn't make with goto: a link, a form, a client-side route.
    const onNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame() || this.navigating) return;
      const now = Date.now();
      this.actions.push({ kind: "goto", t0: now, ready: now, t1: now, label: urlLabel(frame.url()), waited: 0 });
    };
    page.on("framenavigated", onNavigated);
    this.restores.push(() => {
      Reflect.deleteProperty(page, "goto");
      page.off("framenavigated", onNavigated);
    });
  }

  /**
   * page.screenshot draws the page at another size while it works (fullPage makes the page as tall as its content),
   * and the screencast would show that as the whole page squeezed into the frame. Frames that arrive while any page
   * screenshot runs are dropped, so the video holds the screen as it was, then the screencast restarts to send the
   * screen as it is. The screenshot itself is taken as the test asked.
   */
  private patchScreenshot(): void {
    const page = this.page;
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options?: Parameters<Page["screenshot"]>[0]): Promise<Buffer> => {
      this.blackout++;
      try {
        return await screenshot(options);
      } finally {
        // Frames of the resized page can still be on their way.
        await sleep(250);
        if (--this.blackout === 0) await this.refresh();
      }
    };
    this.restores.push(() => {
      Reflect.deleteProperty(page, "screenshot");
    });
  }

  /**
   * page.setViewportSize changes the frames' shape. The resize itself is left out like a screenshot, and the timeline
   * notes the new size, since rects measured after it are in the new viewport (Demo Studio frames nothing after it).
   */
  private patchViewport(): void {
    const page = this.page;
    const setViewportSize = page.setViewportSize.bind(page);
    page.setViewportSize = async (size: { width: number; height: number }): Promise<void> => {
      this.blackout++;
      try {
        await setViewportSize(size);
      } finally {
        this.screen = page.viewportSize() ?? this.screen;
        this.viewports.push({ t: Date.now(), ...this.screen });
        await sleep(150);
        if (--this.blackout === 0) await this.refresh();
      }
    };
    this.restores.push(() => {
      Reflect.deleteProperty(page, "setViewportSize");
    });
  }

  private screencast(): Promise<unknown> {
    if (!this.cdp) return Promise.resolve();
    return this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });
  }

  private onFrame(frame: { data: string; metadata: { timestamp?: number }; sessionId: number }): void {
    let written: Promise<void> = Promise.resolve();
    // Chrome sends a frame only when the screen changes, and an identical one after a refresh, which is dropped.
    if (this.endedAt === null && this.blackout === 0 && frame.data !== this.lastData) {
      this.lastData = frame.data;
      const received = Date.now();
      // metadata.timestamp is the browser's wall clock, the same clock as Date.now().
      const captured = (frame.metadata.timestamp ?? 0) * 1000;
      const at = Math.abs(captured - received) < 2000 ? captured : received;
      this.origin ??= at;
      const file = `frames/${String(this.frames.length + 1).padStart(6, "0")}.jpg`;
      this.frames.push({ file, at });
      const bytes = Buffer.from(frame.data, "base64");
      if (this.frames.length === 1) this.checkScale(bytes);
      written = writeFile(path.join(this.dir, file), bytes).catch((err) => this.note(`${file}: ${firstLine(err)}`));
      this.writes.add(written);
      void written.then(() => this.writes.delete(written));
      this.firstFrame?.();
      this.firstFrame = null;
    }
    // Acks pace the screencast: at most MAX_FPS a second, each after its frame is on disk or 250 ms, whichever comes
    // first, so a slow disk slows the frames down but never stops them.
    this.acks = this.acks.then(async () => {
      await Promise.race([written, sleep(250)]);
      const wait = this.lastAck + 1000 / MAX_FPS - Date.now();
      if (wait > 0) {
        this.throttled = true;
        await sleep(wait);
      }
      this.lastAck = Date.now();
      await this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    this.scheduleRefresh();
  }

  /**
   * Chrome drops frames while an ack is held back, so the last state of an animation (the last typed letter, a card
   * at full opacity) can go unsent. When frames stop coming after a throttled burst, stopping and starting the
   * screencast makes Chrome send the screen as it is now. Measured: 6 of 20 animations lost their last state without it.
   */
  private scheduleRefresh(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (!this.throttled || this.stopping || this.refreshing) return;
      this.throttled = false;
      void this.refresh();
    }, 150);
  }

  /** Stops and starts the screencast, which makes Chrome send the screen as it is now. Joins one already running. */
  private refresh(): Promise<void> {
    if (this.stopping || !this.cdp) return Promise.resolve();
    this.refreshing ??= (async () => {
      await this.cdp?.send("Page.stopScreencast").catch(() => {});
      for (let tries = 0; !this.stopping; tries++) {
        try {
          await this.screencast();
          return;
        } catch (err) {
          if (tries >= 4) return this.note(`refresh: ${firstLine(err)}`);
          await sleep(100);
        }
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * The frames' real scale. The screencast keeps to 2560x1440, so a viewport taller than 16:9 comes smaller than 2x,
   * and Chromium sends 1x frames unless it was launched with --force-device-scale-factor=2.
   */
  private checkScale(bytes: Uint8Array): void {
    const size = jpegSize(bytes);
    if (!size) return;
    this.dpr = Math.round((size.width / this.viewport.width) * 100) / 100;
    const fits = Math.min(2560 / this.viewport.width, 1440 / this.viewport.height);
    if (this.dpr < Math.min(2, fits) - 0.05) {
      this.note(`frames are ${size.width}x${size.height}: launch Chromium with --force-device-scale-factor=2 for sharp text`);
    }
  }

  /** Stops the screencast and waits for the frames to reach the disk. */
  private async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.idle);
    await this.refreshing;
    if (this.cdp) await Promise.race([this.cdp.send("Page.stopScreencast").catch(() => {}), sleep(3000)]);
    this.endedAt = Date.now();
    await Promise.race([Promise.allSettled([...this.writes]), sleep(15_000)]);
    await this.cdp?.detach().catch(() => {});
  }

  private onPageReport(json: string): void {
    try {
      const report = JSON.parse(json) as PageReport;
      // Page times come from the browser's clock as it was before a test could fake it (page.clock), the same clock
      // as Date.now(). A time far off it is replaced by the arrival time.
      const now = Date.now();
      const at = (t: number) => (Math.abs(t - now) < 5000 ? t : now);
      const room = (list: unknown[]) => list.length < 5000;
      for (const a of report.activity ?? []) if (room(this.activity)) this.activity.push({ ...a, t: at(a.t) });
      for (const b of report.busy ?? []) if (room(this.busy)) this.busy.push({ ...b, t: at(b.t) });
      for (const s of report.scrolls ?? []) if (room(this.scrolls)) this.scrolls.push({ ...s, t: at(s.t) });
    } catch (err) {
      this.note(`page report: ${firstLine(err)}`);
    }
  }

  /**
   * The version 1 timeline: seconds since the first frame. Steps, actions and busy changes from before it (the first
   * page load) count as time zero; activity, scrolls and results from before it are left out. A rect that couldn't
   * be measured is the whole viewport.
   */
  private timeline(status: string) {
    const origin = this.origin ?? (this.startedAt || Date.now());
    const end = Math.max(origin, this.endedAt ?? Date.now());
    const sec = (ms: number) => Math.round(Math.min(end, Math.max(origin, ms)) - origin) / 1000;
    const recorded = (t: number) => t >= origin && t <= end;
    const whole: Rect = { x: 0, y: 0, w: this.viewport.width, h: this.viewport.height };
    return {
      version: 1,
      viewport: this.viewport,
      dpr: this.dpr,
      status,
      duration: sec(end),
      frames: this.frames.map((f) => ({ file: f.file, t: sec(f.at) })),
      steps: this.steps.map((s) => ({ title: s.title, t0: sec(s.t0), t1: sec(s.t1 || end), depth: s.depth })),
      actions: [...this.actions]
        .sort((a, b) => a.t0 - b.t0)
        .map((a) => ({
          kind: a.kind,
          t0: sec(a.t0),
          ready: sec(Math.max(a.t0, a.ready)),
          t1: sec(a.t1),
          rect: a.rect ?? whole,
          label: a.label,
          ...(a.kind === "upload" ? { fileName: a.fileName ?? "" } : {}),
          ...(a.kind === "type" && a.typed !== undefined ? { typed: a.typed } : {}),
        })),
      activity: this.activity
        .filter((a) => recorded(a.t))
        .map((a) => ({ t: sec(a.t), added: a.added, changed: a.changed, text: a.text, rect: a.rect })),
      busy: this.busy.filter((b) => b.t <= end).map((b) => ({ t: sec(b.t), on: b.on, rect: b.rect })),
      scrolls: this.scrolls.filter((s) => recorded(s.t)).map((s) => ({ t: sec(s.t), y: s.y })),
      results: this.results.filter((r) => recorded(r.t)).map((r) => ({ t: sec(r.t), rect: r.rect, scrollY: r.scrollY })),
      viewports: this.viewports.filter((v) => v.t <= end).map((v) => ({ t: sec(v.t), width: v.width, height: v.height })),
    };
  }
}

/**
 * Runs in the browser on an action's element. Measures its own first box (where Playwright clicks) and what a viewer
 * sees of it: the element, or for something hidden (a file input, a styled checkbox) its picker button, its label or
 * the closest visible parent. When asked, first scrolls the one the cursor will aim at into view with the overlay's
 * eased scroll. Self-contained, since Playwright sends it to the page as text.
 */
async function prepareTarget(el: Element, opts: { scroll: boolean; pointer: boolean; value: string | null; api: string }): Promise<Target> {
  const shown = (e: Element | null | undefined): e is Element => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width >= 6 && r.height >= 6 && e.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const rect = (r: DOMRect | undefined) => (r && r.width * r.height > 0.99 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  let visual: Element | null = shown(el) ? el : null;
  if (!visual) {
    const label = el.closest("label") ?? (el instanceof HTMLInputElement ? el.labels?.[0] : null) ?? null;
    visual = [label?.querySelector(".file-picker-button, button, [role='button']"), label].find(shown) ?? null;
    for (let up = el.parentElement; !visual && up && up !== document.body; up = up.parentElement) {
      if (shown(up)) visual = [up.querySelector(".file-picker-button")].find(shown) ?? up;
    }
  }
  // An element in a frame is measured in that frame's viewport, which the cursor can't use: no glide for it.
  const framed = window.top !== window;
  const whole = el === document.body || el === document.documentElement;
  const aimAt = opts.pointer && rect(el.getClientRects()[0]) ? el : visual;
  const demo = (window as unknown as Record<string, { where?: () => Point | null; scroll?: (to: number) => Promise<boolean> } | undefined>)[opts.api];

  // The page itself (a key pressed on <body>) is already on screen.
  if (aimAt && opts.scroll && !framed && !whole) {
    const r = aimAt.getBoundingClientRect();
    const se = document.scrollingElement ?? document.documentElement;
    const vh = window.innerHeight;
    if (r.top < 8 || r.bottom > vh - 8) {
      // Center it, or show its top when it is taller than the screen.
      const want = r.height > vh * 0.8 ? r.top - vh * 0.12 : r.top + r.height / 2 - vh / 2;
      const to = Math.max(0, Math.min(se.scrollHeight - se.clientHeight, se.scrollTop + want));
      // The overlay's scroll runs on the page's own timers, saved before a test could pause them (page.clock).
      if (demo?.scroll) await demo.scroll(to);
      else se.scrollTo({ top: to, behavior: "instant" });
    }
  }

  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  const byIds = (ids: string | null) =>
    clean((ids ?? "").split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent : "")).join(" "));
  // Inputs, selects, textareas and buttons all have .labels.
  const labels = (el as Element & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  const label =
    (whole ? "page" : "") ||
    clean(el.getAttribute("aria-label")) ||
    byIds(el.getAttribute("aria-labelledby")) ||
    clean(labels?.[0]?.innerText) ||
    clean(field?.placeholder) ||
    clean(el instanceof HTMLElement ? el.innerText : el.textContent) ||
    clean(el.getAttribute("title")) ||
    (el instanceof HTMLInputElement && /^(button|submit|reset)$/.test(el.type) ? clean(el.value) : "") ||
    el.tagName.toLowerCase();
  const textField =
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|email|url|tel|password)$/.test(el.type));
  return {
    own: framed ? null : rect(el.getClientRects()[0]),
    seen: framed || !visual ? null : rect(visual.getBoundingClientRect()),
    label: label.slice(0, 80),
    typeable: visual === el && textField && !!field && !field.disabled && !field.readOnly && opts.value !== null && field.value !== opts.value,
    picker: visual === el && el instanceof HTMLInputElement && el.type === "file",
    whole,
    mouse: demo?.where?.() ?? null,
  };
}

/**
 * Runs in every document of the recorded page, main frame only. Draws the cursor, click ripples and the file chip in a
 * closed shadow root on <html>, shown in the top layer so modals don't cover it, with no text in the DOM, so app CSS
 * and the test's locators never see them. The cursor fades out while the mouse rests. Scrolls the page smoothly, so a
 * product's own jump to its result reads as a move. Reports page activity, aria-busy changes and scrolls to the
 * recorder a few times a second, and keeps the latest result for settle. Its timers and clocks are the page's own,
 * saved before a test could fake them (page.clock). Self-contained, since Playwright sends it to the page as text, and
 * it never throws into the page.
 */
function demoPageScript({ binding, api, font }: { binding: string; api: string; font: string | null }): void {
  if (window.top !== window) return;
  type Box = { x: number; y: number; w: number; h: number };
  const now = Date.now.bind(Date);
  const clock = performance.now.bind(performance);
  const every = window.setInterval.bind(window);
  const later = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  const frame = window.requestAnimationFrame.bind(window);
  const NS = "http://www.w3.org/2000/svg";
  const svg = (tag: string, attrs: Record<string, string | number>, ...children: Element[]) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    node.append(...children);
    return node;
  };
  const viewport = (): Box => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  // Boxes are reported whole, even where they run past the screen, so Demo Studio knows how much of them it shows.
  const box = (el: Element): Box | null => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };

  // A product that jumps to its result (scrollIntoView, scrollTo) glides there instead. The selector has no weight,
  // so a product's own scroll-behavior wins, and the recorder's scrolls say "instant".
  try {
    const smooth = new CSSStyleSheet();
    smooth.replaceSync(":where(:root) { scroll-behavior: smooth; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, smooth];
  } catch {
    // An older document API: the page keeps its own scrolling.
  }

  // Inter for the file chip, under a name of its own, so the product's own text never picks it up.
  if (font) {
    try {
      const face = new FontFace("musemuse-demo-inter", Uint8Array.from(atob(font), (c) => c.charCodeAt(0)), { weight: "100 900" });
      document.fonts.add(face);
      face.load().catch(() => {});
    } catch {
      // The chip uses the system's fonts.
    }
  }

  // The overlay. Its styles go through the CSSOM, which a page's content security policy doesn't block.
  const host = document.createElement("musemuse-demo");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("popover", "manual");
  const hostStyle: Record<string, string> = {
    position: "fixed", inset: "0 auto auto 0", width: "0", height: "0", margin: "0", padding: "0", border: "0",
    background: "transparent", overflow: "visible", "z-index": "2147483647", "pointer-events": "none", display: "block",
    visibility: "visible", opacity: "1", transform: "none", filter: "none", "clip-path": "none", contain: "none",
  };
  for (const [k, v] of Object.entries(hostStyle)) host.style.setProperty(k, v, "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    * { pointer-events: none; }
    .cursor { position: fixed; left: 0; top: 0; width: 24px; height: 30px; opacity: 0; transition: opacity .45s ease-in;
      transform-origin: 3px 2.5px; filter: drop-shadow(0 2px 2.5px rgba(0,0,0,.32)); will-change: translate, scale; }
    .cursor.on { opacity: 1; transition: opacity .15s ease-out; }
    .cursor svg, .chip svg { display: block; flex: none; }
    .ripple { position: fixed; width: 56px; height: 56px; margin: -28px 0 0 -28px; box-sizing: border-box; border-radius: 50%;
      border: 3px solid #0064E0; background: rgba(0,130,251,.22); box-shadow: 0 0 0 2px rgba(255,255,255,.75); }
    .chip { position: fixed; display: flex; align-items: center; gap: 8px; padding: 8px 14px 8px 10px; background: #fff;
      color: #1C2B33; border-radius: 14px; white-space: nowrap; font: 600 14px/1.25 "musemuse-demo-inter", "Inter", "Noto Sans",
      "Liberation Sans", "DejaVu Sans", system-ui, sans-serif; box-shadow: 0 12px 28px rgba(28,43,51,.24), 0 2px 6px rgba(28,43,51,.16); }
    .name::after { content: attr(data-name); }
  `);
  shadow.adoptedStyleSheets = [sheet];
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.append(
    svg(
      "svg",
      { width: 24, height: 30, viewBox: "0 0 24 30" },
      svg("path", {
        d: "M3 2.5V23.7L8.3 18.8L11.9 27.2L15.8 25.5L12.2 17.3H19.6Z",
        fill: "#FFFFFF",
        stroke: "#1C2B33",
        "stroke-width": 1.6,
        "stroke-linejoin": "round",
      }),
    ),
  );
  shadow.append(cursor);

  // <html> rather than <body>, so app CSS on the body can't hide it. Raised again when a modal opens above it.
  let layers = -1;
  const mount = () => {
    if (!host.isConnected) {
      if (!document.documentElement) return false;
      document.documentElement.appendChild(host);
      layers = -1;
    }
    try {
      const open = document.querySelectorAll(":modal, :popover-open").length;
      if (open !== layers || !host.matches(":popover-open")) {
        if (host.matches(":popover-open")) host.hidePopover();
        host.showPopover();
        layers = document.querySelectorAll(":modal, :popover-open").length;
      }
    } catch {
      // No top layer here: the fixed overlay at the highest z-index still draws over the app.
    }
    return true;
  };

  // The cursor shows while the mouse moves and fades out after it rests 2.4 s, like a person's hand leaving the mouse
  // during a wait, so results and the last frame are clean.
  let shown = false;
  let px = 0;
  let py = 0;
  let resting = 0;
  const wake = () => {
    cursor.classList.add("on");
    cancel(resting);
    resting = later(() => cursor.classList.remove("on"), 2400);
  };
  addEventListener(
    "pointermove",
    (e) => {
      try {
        if (e.pointerType !== "mouse" || !mount()) return;
        px = e.clientX;
        py = e.clientY;
        // The translate property, not transform: the press animation's scale must not scale the position too.
        cursor.style.translate = `${px - 3}px ${py - 2.5}px`;
        shown = true;
        wake();
      } catch {
        // never break the page
      }
    },
    { capture: true, passive: true },
  );

  const ripple = (x: number, y: number) => {
    if (!mount()) return;
    const ring = document.createElement("div");
    ring.className = "ripple";
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    shadow.insertBefore(ring, cursor);
    ring.animate([{ transform: "scale(.2)", opacity: 1 }, { transform: "scale(1)", opacity: 0 }], {
      duration: 600,
      easing: "cubic-bezier(.2,.7,.3,1)",
      fill: "forwards",
    });
    later(() => ring.remove(), 800);
  };
  addEventListener(
    "pointerdown",
    (e) => {
      try {
        if (e.pointerType !== "mouse") return;
        ripple(e.clientX, e.clientY);
        wake();
        cursor.animate([{ scale: "1" }, { scale: "0.86" }, { scale: "1" }], { duration: 240, easing: "ease-out" });
      } catch {
        // never break the page
      }
    },
    { capture: true, passive: true },
  );

  // The file chip drops onto the picker, settles, then shrinks away as the picker takes the file.
  const chip = (x: number, y: number, text: string) => {
    if (!mount()) return;
    const card = document.createElement("div");
    card.className = "chip";
    const image = /\.(png|jpe?g|webp|gif|heic|avif|bmp)\b/i.test(text);
    card.append(
      svg(
        "svg",
        { width: 22, height: 26, viewBox: "0 0 22 26" },
        svg("path", {
          d: "M4 1.5H13.5L19.5 7.5V23A1.5 1.5 0 0 1 18 24.5H4A1.5 1.5 0 0 1 2.5 23V3A1.5 1.5 0 0 1 4 1.5Z",
          fill: "#E7F0FD",
          stroke: "#0064E0",
          "stroke-width": 1.5,
        }),
        svg("path", { d: "M13.5 1.6V6A1.5 1.5 0 0 0 15 7.5H19.4", fill: "none", stroke: "#0064E0", "stroke-width": 1.5 }),
        image
          ? svg("path", { d: "M5.5 21L9.5 15.5L12.5 19L14.5 16.5L17 21Z", fill: "#0064E0" })
          : svg("path", { d: "M6 12.5H16M6 16H16M6 19.5H12.5", fill: "none", stroke: "#0064E0", "stroke-width": 1.4, "stroke-linecap": "round" }),
        ...(image ? [svg("circle", { cx: 8.5, cy: 11.5, r: 1.7, fill: "#0082FB" })] : []),
      ),
    );
    const name = document.createElement("span");
    name.className = "name";
    name.setAttribute("data-name", text);
    card.append(name);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    shadow.insertBefore(card, cursor);
    const at = (dy: number, scale: number) => `translate(-50%, -50%) translateY(${dy}px) scale(${scale})`;
    card.animate(
      [
        { transform: at(-76, 0.92), opacity: 0, offset: 0, easing: "ease-out" },
        { transform: at(-76, 1), opacity: 1, offset: 0.14, easing: "cubic-bezier(.3,1.35,.55,1)" },
        { transform: at(0, 1), opacity: 1, offset: 0.6 },
        { transform: at(0, 1), opacity: 1, offset: 0.78, easing: "ease-in" },
        { transform: at(0, 0.84), opacity: 0, offset: 1 },
      ],
      { duration: 900, fill: "forwards" },
    );
    later(() => card.remove(), 1000);
  };

  // An eased scroll of the page to `to`, on the page's own timers. Resolves true when the page moved.
  const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const scroll = (to: number) =>
    new Promise<boolean>((resolve) => {
      const se = document.scrollingElement ?? document.documentElement;
      const from = se.scrollTop;
      if (Math.abs(to - from) < 2) return resolve(false);
      const ms = Math.min(900, Math.max(350, Math.abs(to - from) * 0.7));
      const t0 = clock();
      // rAF stops in a hidden page, so a timer finishes the scroll if frames don't.
      const done = later(() => {
        se.scrollTo({ top: to, behavior: "instant" });
        resolve(true);
      }, ms + 400);
      const step = () => {
        const p = Math.min(1, (clock() - t0) / ms);
        se.scrollTo({ top: from + (to - from) * ease(p), behavior: "instant" });
        if (p < 1) frame(step);
        else {
          cancel(done);
          resolve(true);
        }
      };
      frame(step);
    });

  // The new text of a fill, drawn into the field a character at a time with the value setter the browser itself has,
  // which fires no events: the page gets only the fill's own change after it. Stops when anything else sets the value.
  const type = async (el: Element, text: string, delay: number) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return 0;
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!set) return 0;
    el.focus({ preventScroll: true });
    const chars = Array.from(text);
    let last = el.value;
    let drawn = 0;
    for (let i = 1; i <= chars.length; i++) {
      if (el.value !== last) break;
      last = chars.slice(0, i).join("");
      set.call(el, last);
      drawn = i;
      await new Promise((r) => later(r, delay));
    }
    return drawn;
  };

  // The latest result is the section that last stopped being busy, or the biggest element of a later burst that
  // added content, for products that show a result without aria-busy. When both come within half a second, the bigger
  // counts. A result is known by when it appeared.
  let lastDone: Element | null = null;
  let lastDoneAt = 0;
  let lastAdded: Element | null = null;
  let lastAddedAt = 0;
  const area = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  const noteDone = (el: Element, t: number) => {
    if (!lastDone?.isConnected || t - lastDoneAt > 50 || area(el) > area(lastDone)) lastDone = el;
    lastDoneAt = t;
  };
  const noteAdded = (els: Set<Element>, t: number) => {
    let biggest: Element | null = null;
    for (const el of els) if (el.isConnected && (!biggest || area(el) > area(biggest))) biggest = el;
    if (biggest && area(biggest) > 0) {
      lastAdded = biggest;
      lastAddedAt = t;
    }
  };
  const latestResult = (): { el: Element; at: number } | null => {
    const done = lastDone?.isConnected ? { el: lastDone, at: lastDoneAt } : null;
    const added = lastAdded?.isConnected ? { el: lastAdded, at: lastAddedAt } : null;
    if (!done || !added) return done ?? added;
    if (Math.abs(added.at - done.at) <= 500) return area(added.el) > area(done.el) ? added : done;
    return added.at > done.at ? added : done;
  };
  // For the recorder: the latest result if it appeared after `after`, brought on screen with an eased scroll when most
  // of it is off screen (centered, or its top shown when it is taller than the screen). Small ones are left out
  // unless `final`, and so is one still marked busy, like a loading skeleton, which isn't a result yet.
  const settle = async (after: number, final: boolean) => {
    const latest = latestResult();
    if (!latest || latest.at <= after || latest.el.closest('[aria-busy="true"]')) return null;
    const vh = window.innerHeight;
    const r = latest.el.getBoundingClientRect();
    if (!final && r.width * r.height < 0.02 * window.innerWidth * vh) return null;
    const start = now();
    let moved = false;
    if (Math.min(r.bottom, vh) - Math.max(r.top, 0) < 0.9 * Math.min(r.height, vh * 0.8)) {
      const se = document.scrollingElement ?? document.documentElement;
      const want = r.height > vh * 0.8 ? r.top - vh * 0.12 : r.top + r.height / 2 - vh / 2;
      moved = await scroll(Math.max(0, Math.min(se.scrollHeight - se.clientHeight, se.scrollTop + want)));
    }
    return {
      at: latest.at,
      t: moved ? start : latest.at,
      since: moved ? now() : latest.at,
      rect: box(latest.el) ?? viewport(),
      scrollY: Math.round(window.scrollY),
    };
  };
  Object.defineProperty(window, api, {
    configurable: true,
    value: { ripple, chip, where: () => (shown ? { x: px, y: py } : null), scroll, type, settle },
  });

  // Activity: elements added and text or attributes changed, summed over windows of at least 200 ms, with how much
  // text was added and the box of what appeared. Boxes are measured once the page stops scrolling (within 1.2 s),
  // since a product often scrolls a new result into view right after it renders, and the box should be where the
  // result ends up.
  type BusyChange = { t: number; on: boolean; el: Element; rect: Box };
  const queue: {
    activity: Array<{ t: number; added: number; changed: number; text: number; rect: Box }>;
    busy: Array<{ t: number; on: boolean; rect: Box }>;
    scrolls: Array<{ t: number; y: number }>;
  } = { activity: [], busy: [], scrolls: [] };
  let firstAt = 0;
  let added = 0;
  let changed = 0;
  let text = 0;
  let scrolledAt = 0;
  const addedEls = new Set<Element>();
  const changedEls = new Set<Element>();
  const busyEls = new Map<Element, Box>();
  let busyChanges: BusyChange[] = [];
  const skip = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);
  // Keystrokes in the focused field change it on every key. That is the typing, not something appearing.
  const inFocus = (n: Node | null) => {
    const a = document.activeElement;
    return !!n && !!a && a !== document.body && a.contains(n);
  };
  const count = (t: number, kind: "added" | "changed", n: number, el: Element | null, chars = 0) => {
    firstAt ||= t;
    if (kind === "added") added += n;
    else changed += n;
    text = Math.min(100_000, text + chars);
    const set = kind === "added" ? addedEls : changedEls;
    if (el && set.size < 200) set.add(el);
  };
  const chars = (n: Node) => Math.min(2000, (n.textContent ?? "").trim().length);
  const union = (els: Set<Element>): Box | null => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const el of els) {
      if (!el.isConnected || !el.checkVisibility({ visibilityProperty: true })) continue;
      const b = box(el);
      if (!b) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  // The time of a busy change is exact. Its box, like activity's, is measured again when it is sent.
  const checkBusy = (t: number) => {
    const live = new Set(document.querySelectorAll('[aria-busy="true"]'));
    for (const el of live) {
      if (busyEls.has(el)) continue;
      const rect = box(el) ?? viewport();
      busyEls.set(el, rect);
      busyChanges.push({ t, on: true, el, rect });
    }
    for (const [el, last] of busyEls) {
      if (live.has(el)) continue;
      busyEls.delete(el);
      busyChanges.push({ t, on: false, el, rect: (el.isConnected && box(el)) || last });
      noteDone(el, t);
    }
  };
  const observer = new MutationObserver((records) => {
    try {
      const t = now();
      let structure = false;
      for (const r of records) {
        if (r.type === "childList") {
          structure = true;
          for (const n of r.addedNodes) {
            if (n === host) continue;
            if (n instanceof Element) {
              if (!skip.has(n.tagName)) count(t, "added", 1 + Math.min(500, n.getElementsByTagName("*").length), n, chars(n));
            } else if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim() && !inFocus(n)) {
              count(t, "changed", 1, n.parentElement, chars(n));
            }
          }
        } else if (r.type === "characterData") {
          if (!inFocus(r.target)) count(t, "changed", 1, r.target.parentElement);
        } else if (r.attributeName === "aria-busy") {
          structure = true;
        } else if (r.attributeName !== "style" && r.target !== host && !inFocus(r.target)) {
          count(t, "changed", 1, r.target instanceof Element ? r.target : null);
        }
      }
      if (structure) checkBusy(t);
    } catch {
      // never break the page
    }
  });
  // From DOMContentLoaded on, so the parser building the first screen isn't counted as activity.
  const watch = () => {
    try {
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      checkBusy(now());
    } catch {
      // never break the page
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();

  let lastY = -1;
  let lastScrollAt = 0;
  let scrollEnd = 0;
  const recordScroll = () => {
    const y = Math.round(window.scrollY);
    if (y === lastY) return;
    lastY = y;
    lastScrollAt = now();
    queue.scrolls.push({ t: lastScrollAt, y });
  };
  addEventListener(
    "scroll",
    () => {
      try {
        scrolledAt = now();
        if (scrolledAt - lastScrollAt >= 100) recordScroll();
        cancel(scrollEnd);
        scrollEnd = later(recordScroll, 120);
      } catch {
        // never break the page
      }
    },
    { passive: true },
  );

  every(() => {
    try {
      const t = now();
      const due = (since: number) => (t - scrolledAt > 150 && t - since >= 200) || t - since >= 1200;
      if ((added || changed) && due(firstAt)) {
        queue.activity.push({ t: firstAt, added, changed, text, rect: union(addedEls) ?? union(changedEls) ?? viewport() });
        if (added >= 3 || text >= 20) noteAdded(addedEls, firstAt);
        firstAt = 0;
        added = 0;
        changed = 0;
        text = 0;
        addedEls.clear();
        changedEls.clear();
      }
      const firstChange = busyChanges[0];
      if (firstChange && due(firstChange.t)) {
        for (const c of busyChanges) queue.busy.push({ t: c.t, on: c.on, rect: (c.el.isConnected && box(c.el)) || c.rect });
        busyChanges = [];
      }
      // A busy section grows as its content arrives. Keep its latest box for when it is removed while busy.
      for (const el of busyEls.keys()) {
        const b = el.isConnected ? box(el) : null;
        if (b) busyEls.set(el, b);
      }
      const send = (window as unknown as Record<string, unknown>)[binding];
      if (typeof send !== "function" || !(queue.activity.length || queue.busy.length || queue.scrolls.length)) return;
      const payload = JSON.stringify(queue);
      queue.activity = [];
      queue.busy = [];
      queue.scrolls = [];
      Promise.resolve(send(payload)).catch(() => {});
    } catch {
      // never break the page
    }
  }, 100);
}

/** The recording runs only in the studio project, and only for the first test a worker runs. */
export const test = base.extend({
  // The recorder hangs off the page fixture instead of an auto fixture of its own, so a test that never opens a page
  // never launches a browser for it. Outside the studio project the page is handed on untouched.
  page: async ({ page, actionTimeout }, use, testInfo) => {
    if (testInfo.project.name !== DEMO_PROJECT || recordedOnce) return use(page);
    recordedOnce = true;
    const root = testInfo.config.configFile ? path.dirname(testInfo.config.configFile) : process.cwd();
    const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
    const recorder = new DemoRecorder(page, root, dpr, testInfo, actionTimeout || 0);
    try {
      await recorder.install();
      current = recorder;
    } catch (err) {
      recorder.note(`install: ${firstLine(err)}`);
    }
    try {
      await use(page);
    } finally {
      current = null;
      await recorder.finish(testInfo);
    }
  },
});

// test.step as usual. While recording, each step's title and times also go in the timeline, for the captions, and a
// step that passes holds its new result on screen before it ends, so the result plays under its own caption.
const stepDepth = new AsyncLocalStorage<number>();
const plainStep = test.step;
function recordedStep(title: string, body: (step: TestStepInfo) => unknown, options?: Parameters<typeof plainStep>[2]) {
  const recorder = current;
  if (!recorder) return plainStep(title, body, options);
  const depth = stepDepth.getStore() ?? 0;
  return plainStep(
    title,
    (step) =>
      stepDepth.run(depth + 1, async () => {
        const entry = { title, t0: Date.now(), t1: 0, depth };
        recorder.steps.push(entry);
        try {
          const result = await body(step);
          if (current === recorder) await recorder.settleResult();
          return result;
        } finally {
          entry.t1 = Date.now();
        }
      }),
    options,
  );
}
test.step = Object.assign(recordedStep, { skip: plainStep.skip }) as unknown as typeof test.step;

export default test;
