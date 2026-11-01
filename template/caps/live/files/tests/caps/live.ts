// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
//   checkCaptions(page, { start, stop })      clicks your start button, waits for 2 caption pieces from the test browser's
//                                             fake microphone (fixtures/talk.wav), clicks stop, and checks their times and
//                                             that their words show. Takes the judge screenshot "10-captions". Call it
//                                             once: the smoke test may use at most 6 pieces.
//   checkLiveUpdate(page, { change, shows })  opens a second browser, runs `change` in the first, and needs `shows` in the
//                                             second within 5 seconds with no reload. Takes "11-second-browser-live".
//
// The microphone plays a made-up lecture about rivers, whatever the product is about. Never assert its words.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { recordCapCheck } from "./index";

const CAP = "live";
const NOTICE = /Muse Voice Transcribe/;
const STREAM = /\/live\/stream\?/;

interface PieceReply {
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionsCheck {
  /** The button that starts captions: its name, or a locator. */
  start: string | RegExp | Locator;
  /** The button that stops them. */
  stop: string | RegExp | Locator;
  /** Pieces to wait for. At least 2, at most 3. */
  pieces?: number;
  /** How long to wait for them. */
  timeoutMs?: number;
}

const control = (page: Page, c: string | RegExp | Locator): Locator => (typeof c === "string" || c instanceof RegExp ? page.getByRole("button", { name: c }) : c);

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? [];

/** The platform's check of captions. Call it once, with the page open where the start button is. */
export async function checkCaptions(page: Page, check: CaptionsCheck): Promise<void> {
  const want = Math.min(3, Math.max(2, check.pieces ?? 2));
  const fail = (id: string, detail: string) => {
    recordCapCheck(CAP, { id, ok: false, detail });
    throw new Error(`checkCaptions: ${detail}`);
  };
  try {
    await expect(page.getByText(NOTICE).first()).toBeVisible({ timeout: 15_000 });
  } catch {
    fail("notice", "the page doesn't say the audio goes to Muse Voice Transcribe before the microphone starts. Show CAPTIONS_NOTICE next to the button");
  }
  recordCapCheck(CAP, { id: "notice", ok: true, detail: "The page says the audio goes to Muse Voice Transcribe before the microphone starts" });

  const pieces: PieceReply[] = [];
  const problems: string[] = [];
  let enough: () => void = () => undefined;
  const gotEnough = new Promise<void>((resolve) => (enough = resolve));
  const onResponse = async (res: Awaited<ReturnType<Page["waitForResponse"]>>) => {
    if (!new URL(res.url()).pathname.endsWith("/api/musemuse/live-caption")) return;
    const reply = (await res.json().catch(() => null)) as (PieceReply & { error?: string; code?: string }) | null;
    if (!res.ok() || !reply || typeof reply.text !== "string") {
      problems.push(`${res.status()} ${reply?.code ?? reply?.error ?? ""}`.trim());
      return;
    }
    if (reply.text.trim()) pieces.push(reply);
    if (pieces.length >= want) enough();
  };
  page.on("response", onResponse);
  try {
    await control(page, check.start).click();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([gotEnough.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), check.timeoutMs ?? 30_000)))]);
    clearTimeout(timer);
    if (!waited) fail("chunks", `the fake microphone gave ${pieces.length} caption piece${pieces.length === 1 ? "" : "s"} in time, and needs ${want}${problems.length ? `. The route answered: ${problems.slice(0, 3).join(", ")}` : ""}`);
    await control(page, check.stop).click();
  } finally {
    page.off("response", onResponse);
  }

  const inOrder = pieces.every((p, i) => Number.isFinite(p.startMs) && p.endMs > p.startMs && (i === 0 || p.startMs >= pieces[i - 1]!.startMs));
  if (!inOrder) fail("chunks", `the caption pieces' times don't run in order: ${pieces.map((p) => `${p.startMs}-${p.endMs}`).join(", ")}`);
  recordCapCheck(CAP, { id: "chunks", ok: true, detail: `${pieces.length} caption pieces with times came from the fake microphone: ${pieces.map((p) => `${p.startMs}-${p.endMs} ms`).join(", ")}`, shot: "10-captions.png" });

  // Their own words, not a stand-in's: the overlap can take some out, so one long word of what came back is enough.
  const said = [...new Set(pieces.flatMap((p) => words(p.text)))];
  try {
    await expect(async () => {
      const shown = new Set(words(await page.locator("body").innerText()));
      expect(said.some((w) => shown.has(w))).toBe(true);
    }).toPass({ timeout: 10_000 });
  } catch {
    fail("shown", "the words the caption pieces came back with don't show on the page. Render captions or text from useCaptions");
  }
  recordCapCheck(CAP, { id: "shown", ok: true, detail: "The caption pieces' words show on the page", shot: "10-captions.png" });
  await judgeShot(page, "10-captions");
}

export interface LiveUpdateCheck {
  /** Makes the change in the first browser, like adding a point on the scoreboard. */
  change(first: Page): Promise<void>;
  /** Text the second browser must then show. It must not show it before the change. */
  shows: string;
  /** The page to open in the second browser. "/" by default. */
  path?: string;
  /** How soon it must show. The contract says 5 seconds, and this can't be longer. */
  withinMs?: number;
}

/** The platform's check of live updates. Call it once, with the first browser open and ready to make the change. */
export async function checkLiveUpdate(page: Page, check: LiveUpdateCheck): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("checkLiveUpdate needs the test's own browser.");
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), viewport: page.viewportSize() ?? { width: 390, height: 844 } });
  const fail = (detail: string) => {
    recordCapCheck(CAP, { id: "live-update", ok: false, detail });
    throw new Error(`checkLiveUpdate: ${detail}`);
  };
  try {
    const other = await context.newPage();
    const streaming = other.waitForResponse((res) => STREAM.test(res.url()) && res.ok(), { timeout: 30_000 }).catch(() => null);
    await other.goto(check.path ?? "/");
    if (!(await streaming)) fail("the second browser never opened a stream. Render from useLive");
    const before = await other.getByText(check.shows, { exact: false }).count();
    if (before) fail(`the second browser already shows "${check.shows}" before the change. Use text only this test's change makes`);

    // From here on, no navigation of the second browser's page may happen.
    let loads = 0;
    other.on("framenavigated", (frame) => {
      if (frame === other.mainFrame()) loads += 1;
    });
    await check.change(page);
    const started = Date.now();
    const within = Math.min(5_000, check.withinMs ?? 5_000);
    try {
      await expect(other.getByText(check.shows, { exact: false }).first()).toBeVisible({ timeout: within });
    } catch {
      fail(`the change didn't show in the second browser within ${within / 1000} seconds`);
    }
    const ms = Date.now() - started;
    if (loads) fail("the second browser's page reloaded, so this wasn't a live update");
    recordCapCheck(CAP, { id: "live-update", ok: true, detail: `The change showed in the second browser ${ms} ms later, with no reload`, shot: "11-second-browser-live.png" });
    await judgeShot(other, "11-second-browser-live");
  } finally {
    await context.close();
  }
}
