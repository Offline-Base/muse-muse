// Platform file (Muse Muse platform services). Don't edit: use this helper in tests/smoke.spec.ts.
//
// expectGameResponds checks the game's canvas the way a player first sees it: it has drawn something (it isn't one flat
// color), and it changes after one key press. It compares screenshots of the canvas element, read here in Node, so it
// works for 2D and WebGL canvases alike and never touches the game's page. It records both checks for verify's caps
// step. Screenshots come from software rendering.
import { inflateSync } from "node:zlib";
import { expect, type Locator, type Page } from "@playwright/test";
import { recordCapCheck } from "./index";
import { judgeShot } from "../judge-shot";

export interface GameRespondsOptions {
  /** The game's canvas: a selector or a locator. The first <canvas> on the page by default. */
  canvas?: string | Locator;
  /** The key to press, as Playwright names it: "ArrowRight", "Space", "KeyW". */
  key?: string;
  /** How long to hold the key, in ms. Long enough for a few frames. */
  holdMs?: number;
  /** Judge screenshots to take before and after the key press, like ["02-game", "03-game-moved"]. */
  shots?: [string, string];
}

interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel. */
  data: Uint8Array;
}

/** Reads an 8-bit, non-interlaced RGB or RGBA PNG, which is what Playwright's screenshots are. */
export function readPng(png: Buffer): Pixels {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || body[12] !== 0) throw new Error("only 8-bit RGB or RGBA PNGs are read here");
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const x = line[i]!;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const o = (y * width + px) * 4;
      out[o] = cur[px * channels]!;
      out[o + 1] = cur[px * channels + 1]!;
      out[o + 2] = cur[px * channels + 2]!;
      out[o + 3] = channels === 4 ? cur[px * channels + 3]! : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** How varied a screenshot is: distinct colors (up to 64) and the spread of its brightness, sampling every 4th pixel. */
export function variety(img: Pixels): { colors: number; spread: number } {
  const colors = new Set<number>();
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 16) {
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    if (colors.size < 64) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  return { colors: colors.size, spread: n ? Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2)) : 0 };
}

/** The share of sampled pixels that clearly differ between two screenshots. 1 when their sizes differ. */
export function changedShare(a: Pixels, b: Pixels): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let diff = 0;
  let total = 0;
  for (let i = 0; i < a.data.length; i += 16) {
    total++;
    if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 24) diff++;
  }
  return total ? diff / total : 0;
}

/** The share of the canvas that must change after the key press: about one small sprite on a phone-sized canvas. */
export const MIN_CHANGED = 0.002;
/**
 * For a game that also moves on its own: how many times the most it changes with no key pressed the key press must
 * change, plus MIN_CHANGED. A sprite drifting on its own changes about as much in each window, key or not.
 */
export const DRIFT_MARGIN = 2;

/** What the key press must change, given the most the canvas changed in a window with no key pressed. */
export function neededChange(drift: number): number {
  return drift >= MIN_CHANGED ? drift * DRIFT_MARGIN + MIN_CHANGED : MIN_CHANGED;
}

/**
 * Expects the game's canvas to show something and to change after one key press. Start the game first (press its
 * start button), so the key reaches a running game. Records the checks "canvas" and "key-press".
 */
export async function expectGameResponds(page: Page, opts: GameRespondsOptions = {}): Promise<void> {
  const canvas = typeof opts.canvas === "object" ? opts.canvas : page.locator(opts.canvas ?? "canvas").first();
  const key = opts.key ?? "ArrowRight";
  const holdMs = Math.min(Math.max(opts.holdMs ?? 400, 100), 3_000);
  await expect(canvas, "the game has no canvas on the page").toBeVisible({ timeout: 30_000 });
  // A few frames to draw the first scene.
  await page.waitForTimeout(800);
  if (opts.shots) await judgeShot(page, opts.shots[0]);
  const first = readPng(await canvas.screenshot());
  const drawn = variety(first);
  const notBlank = drawn.colors >= 3 && drawn.spread >= 2;
  recordCapCheck("games", {
    id: "canvas",
    ok: notBlank,
    detail: notBlank ? `The canvas shows ${drawn.colors >= 64 ? "64 or more" : drawn.colors} colors` : "The canvas is one flat color: the game drew nothing",
    ...(opts.shots ? { shot: `${opts.shots[0]}.png` } : {}),
  });
  expect(notBlank, "the game's canvas is blank: it drew nothing").toBeTruthy();

  // What it does with no key pressed, over two windows as long as the key press, so a game that moves on its own is
  // told apart from one that answers the key: the key press must change clearly more than either window did.
  await page.waitForTimeout(holdMs + 250);
  const between = readPng(await canvas.screenshot());
  await page.waitForTimeout(holdMs + 250);
  const idle = readPng(await canvas.screenshot());
  const drift = Math.max(changedShare(first, between), changedShare(between, idle));
  await canvas.focus().catch(() => undefined);
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
  await page.waitForTimeout(250);
  const after = readPng(await canvas.screenshot());
  const moved = changedShare(idle, after);
  const drifts = drift >= MIN_CHANGED;
  const ok = moved >= neededChange(drift);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  recordCapCheck("games", {
    id: "key-press",
    ok,
    detail: ok
      ? `${pct(moved)} of the canvas changed after ${key}${drifts ? ` (with no key pressed, up to ${pct(drift)} changes)` : ""}`
      : drifts
        ? `${pct(moved)} of the canvas changed after ${key}, but up to ${pct(drift)} changes with no key pressed, so the key made no clear difference. Keep the scene still until a key is pressed, or make the key's move bigger`
        : `Nothing on the canvas changed after ${key}`,
    ...(opts.shots ? { shot: `${opts.shots[1]}.png` } : {}),
  });
  if (opts.shots) await judgeShot(page, opts.shots[1]);
  expect(ok || drifts, `nothing on the game's canvas changed after pressing ${key}`).toBeTruthy();
  expect(ok, `the game's canvas changes about as much with no key pressed as after pressing ${key}`).toBeTruthy();
}
