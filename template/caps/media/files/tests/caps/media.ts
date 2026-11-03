// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
// Checks for media made in the page. Each one does what a user does (clicks the button), then reads what the page
// really made, records one check for verify's caps step, and saves the file itself to test-results/caps/media/ so the
// platform's check (scripts/caps/media.mjs) reads its bytes too:
//   expectVideoPlays  the <video> has a duration over 0 and plays; the file is saved as video.mp4 (or .webm)
//   expectMidi        the downloaded MIDI file starts with MThd and has notes; saved as tune.mid
//   expectTiles       the last findAll ran on more than one tile and merged its boxes
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { recordCapCheck } from "./index";
import { judgeShot } from "../judge-shot";

const CAP = "media";
const DIR = path.join(process.cwd(), "test-results", "caps", "media");

type Target = string | Locator;
const locate = (page: Page, t: Target) => (typeof t === "string" ? page.locator(t) : t);

function save(name: string, bytes: Buffer): string {
  mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  writeFileSync(file, bytes);
  return file;
}

async function fail(id: string, detail: string): Promise<never> {
  recordCapCheck(CAP, { id, ok: false, detail });
  throw new Error(detail);
}

/**
 * Runs in the page on the <video>: waits for its metadata, reads its duration (a recorded WebM can say Infinity until it
 * is read to the end), plays it muted for a moment, and reads its bytes as base64. A string, so no test runner's
 * transform can add helpers the page doesn't have.
 */
const VIDEO_PROBE = `async (el) => {
  const wait = (ev, ms) => new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    el.addEventListener(ev, () => { clearTimeout(t); res(true); }, { once: true });
  });
  if (el.readyState < 1 && !(await wait("loadedmetadata", 15000))) return { error: "the video never loaded" };
  let duration = el.duration;
  if (!Number.isFinite(duration)) {
    el.currentTime = 1e9;
    await wait("timeupdate", 5000);
    duration = el.duration;
    el.currentTime = 0;
  }
  el.muted = true;
  const start = el.currentTime;
  const played = await el.play().then(() => true, () => false);
  await new Promise((r) => setTimeout(r, 700));
  const moved = el.currentTime > start || el.ended;
  el.pause();
  let bytes = null;
  let type = "";
  try {
    const blob = await (await fetch(el.currentSrc || el.src)).blob();
    type = blob.type;
    bytes = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.onerror = () => rej(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    bytes = null;
  }
  return { duration, played: played && moved, width: el.videoWidth, height: el.videoHeight, bytes, type, error: el.error ? "the video failed (" + el.error.code + ")" : null };
}`;

export interface VideoPlaysOptions {
  /** The button that makes the video. Left out when the video is already on the page. */
  make?: Target;
  /** The <video>, the first one on the page by default. */
  video?: Target;
  /** A judge screenshot name for the made video, like "03-video". */
  shot?: string;
  timeoutMs?: number;
}

/** The made video loads, has a duration over 0 and plays. */
export async function expectVideoPlays(page: Page, opts: VideoPlaysOptions = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 60_000;
  if (opts.make) await locate(page, opts.make).click();
  const video = locate(page, opts.video ?? "video").first();
  await expect(video, "a <video> with the made video").toHaveAttribute("src", /\S/, { timeout }).catch(() => fail("video", "No <video> with the made video showed up."));
  // The probe is evaluated from its text in the page, then called on the element.
  const seen = (await video.evaluate((el, probe) => (0, eval)(probe)(el), VIDEO_PROBE)) as { error?: string | null; duration: number; played: boolean; width: number; height: number; bytes: string | null; type: string };
  if (seen.error) await fail("video", `The made video didn't play: ${seen.error}.`);
  const s = seen;
  if (s.bytes) save(s.type.includes("webm") ? "video.webm" : "video.mp4", Buffer.from(s.bytes, "base64"));
  const ok = s.duration > 0 && Number.isFinite(s.duration) && s.played && s.width > 0;
  const detail = ok
    ? `The made video is ${s.duration.toFixed(1)} seconds at ${s.width}x${s.height} and played`
    : `The made video ${!(s.duration > 0) ? "has no duration" : !s.played ? "didn't play" : "has no picture"}`;
  if (opts.shot) await judgeShot(page, opts.shot);
  recordCapCheck(CAP, { id: "video", ok, detail, ...(opts.shot ? { shot: opts.shot } : {}) });
  if (!ok) throw new Error(detail);
}

export interface MidiOptions {
  /** The button or link that saves the MIDI file. */
  click: Target;
  shot?: string;
  timeoutMs?: number;
}

function midiNotes(bytes: Buffer): number {
  // Counts note-on events with a velocity over 0 by walking each track's events.
  if (bytes.toString("latin1", 0, 4) !== "MThd") return -1;
  let at = 8 + bytes.readUInt32BE(4);
  let notes = 0;
  while (at + 8 <= bytes.length && bytes.toString("latin1", at, at + 4) === "MTrk") {
    const end = Math.min(bytes.length, at + 8 + bytes.readUInt32BE(at + 4));
    let p = at + 8;
    let status = 0;
    const varLen = () => {
      let v = 0;
      for (let i = 0; i < 4 && p < end; i++) {
        const b = bytes[p++]!;
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (p < end) {
      varLen();
      if (bytes[p]! & 0x80) status = bytes[p++]!;
      if (status === 0xff) {
        p++;
        const len = varLen();
        p += len;
        status = 0;
      } else if (status === 0xf0 || status === 0xf7) {
        const len = varLen();
        p += len;
        status = 0;
      } else if (status) {
        const kind = status & 0xf0;
        const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[p + 1]!;
        if (kind === 0x90 && d2 > 0) notes++;
        p += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      } else break;
    }
    at = end;
  }
  return notes;
}

/** Clicking `click` downloads a MIDI file with notes in it. */
export async function expectMidi(page: Page, opts: MidiOptions): Promise<void> {
  const download = page.waitForEvent("download", { timeout: opts.timeoutMs ?? 30_000 });
  await locate(page, opts.click).click();
  const file = await download.catch(() => null);
  if (!file) return fail("music", "Clicking the save button didn't download a MIDI file.");
  const where = await file.path().catch(() => null);
  const bytes = where ? readFileSync(where) : null;
  if (!bytes) return fail("music", "The MIDI file couldn't be read.");
  save("tune.mid", bytes);
  const notes = midiNotes(bytes);
  const ok = notes > 0;
  const detail = notes < 0 ? "The saved file isn't MIDI: it doesn't start with MThd" : ok ? `The saved MIDI file has ${notes} notes` : "The saved MIDI file has no notes";
  if (opts.shot) await judgeShot(page, opts.shot);
  recordCapCheck(CAP, { id: "music", ok, detail, ...(opts.shot ? { shot: opts.shot } : {}) });
  if (!ok) throw new Error(detail);
}

type Record_ = { tiles?: { tiles: number; rawBoxes: number; boxes: number; saturated: number; capped: boolean; at: number } };

export interface TilesOptions {
  shot?: string;
  /** How long to wait for findAll to finish, after the product started it. */
  timeoutMs?: number;
}

/** The last findAll ran on more than one tile and merged without adding boxes. */
export async function expectTiles(page: Page, opts: TilesOptions = {}): Promise<void> {
  const got = await page
    .waitForFunction(() => (window as unknown as { __musemuseMedia?: Record_ }).__musemuseMedia?.tiles ?? null, undefined, { timeout: opts.timeoutMs ?? 120_000 })
    .then((h) => h.jsonValue() as Promise<NonNullable<Record_["tiles"]>>)
    .catch(() => null);
  if (!got) return fail("tiles", "findAll from lib/platform/sam-tiles.ts never ran.");
  const ok = got.tiles > 1 && got.boxes <= got.rawBoxes;
  const detail = `tiles=${got.tiles} raw=${got.rawBoxes} merged=${got.boxes} saturated=${got.saturated} capped=${got.capped ? 1 : 0}`;
  if (opts.shot) await judgeShot(page, opts.shot);
  recordCapCheck(CAP, { id: "tiles", ok, detail, ...(opts.shot ? { shot: opts.shot } : {}) });
  if (!ok) throw new Error(got.tiles <= 1 ? "findAll ran on one tile only: pass { tiles: 4 }." : "findAll's merge kept more boxes than the tiles found.");
}
