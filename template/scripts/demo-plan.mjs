// Pure planning for the demo video. See docs/DEMO_STUDIO.md in the Muse Muse repo. Don't edit this file.
//
// Everything here is a deterministic function of the recorder's timeline.json (test-results/demo/timeline.json):
// which stretches play at real speed and how much each wait is sped up, where the camera looks, when each caption and
// wait badge shows, and the poster frame. scripts/demo-studio.mjs does the rendering. No I/O here, so
// scripts/__tests__/demo-plan.test.mjs can check it without Chromium or ffmpeg.
//
// Times are seconds. "Source" time is the recording's clock. "Output" time is the main part of the video, the screen
// recording between the intro and outro cards. Rects are CSS pixels in the recorded viewport, and may run past it. As
// tests/demo-fixtures.ts records them, an action's t0 is when the cursor starts moving to it (after any wait for the
// element), its ready is when the cursor is there and Playwright's own action starts, the rect of anything that
// appeared is measured once the page has stopped scrolling, and a result's rect once the recorder brought it in view.

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ file: string, t: number }} Frame
 * @typedef {{ title: string, t0: number, t1: number, depth: number }} Step
 * @typedef {{
 *   kind: string, t0: number, ready: number, t1: number, rect: Rect | null, label: string, fileName?: string,
 *   typed?: number, noop?: boolean, heads?: Rect[]
 * }} Action
 *   noop: the element already had the value or state, so the cursor stayed put. heads: headings, labels and the app
 *   bar on screen when the element was measured.
 * @typedef {{ t: number, added: number, changed: number, text: number, rect: Rect | null }} Activity
 * @typedef {{ t: number, on: boolean, rect: Rect | null }} Busy
 * @typedef {{ t: number, y: number }} Scroll
 * @typedef {{
 *   t: number, at: number, rect: Rect | null, scrollY: number | null, waited: number | null, busy: boolean | null,
 *   media: number, heads: Rect[], blanks: Rect[], pressed: Rect | null
 * }} Result
 *   A result the recorder held, appeared at `at`. waited is how long the viewer waited for it, and busy whether it
 *   came from an aria-busy section (null in older timelines). heads, blanks and pressed are boxes on screen while it
 *   was held, in the same coordinates as rect: headings, labels and the app bar, empty text fields, the control
 *   pressed last.
 * @typedef {{ t: number, width: number, height: number }} ViewportChange
 * @typedef {{
 *   version: number, viewport: { width: number, height: number }, dpr: number, status: string, duration: number,
 *   frames: Frame[], steps: Step[], actions: Action[], activity: Activity[], busy: Busy[], scrolls: Scroll[],
 *   results: Result[], viewports: ViewportChange[], column: { x: number, w: number } | null
 * }} Timeline
 *
 * @typedef {{
 *   t: number, rect: Rect | null, scrollY: number | null, weight: number, busyOff: boolean, result: boolean,
 *   loading: boolean, echo: boolean, frame: boolean, held: Result | null
 * }} Reveal
 *   Something appeared at source time t. weight is the added plus changed node count. result says the recorder brought
 *   it on screen and held it (its rect is measured in view, at scrollY), and held is that result. loading says it came
 *   with aria-busy turning on, and echo that it is a small change right by the action that just happened, like a file
 *   name by its picker. frame says whether the camera may frame it: not the field echoing keys while typing, not a
 *   loading state or an echo, not something mostly off screen, and not where a result appeared that the recorder
 *   brought on screen later (its held reveal frames it).
 * @typedef {{ src0: number, src1: number, out0: number, out1: number, speed: number }} Segment
 *   speed is source seconds per output second: 1 for real time, more for a sped-up wait, 0 for the held last frame.
 * @typedef {{ out0: number, out1: number, show0: number, show1: number, seconds: number, text: string }} Badge
 *   out0..out1 is the sped-up stretch; show0..show1 is when the badge is on screen.
 * @typedef {{ frame: number, file: string, start: number, count: number }} FrameRun
 *   Output frames start..start+count-1 all show source frame `frame`.
 * @typedef {{
 *   segments: Segment[], seconds: number, frames: number, sourceSeconds: number, compressedSeconds: number,
 *   capped: boolean, tailHold: number, badges: Badge[], reveals: Reveal[], runs: FrameRun[]
 * }} Edit
 *   seconds is exactly frames / FPS. compressedSeconds is the source time that plays sped up.
 * @typedef {{ t: number, z: number, cx: number, cy: number }} CameraKey
 *   Zoom and the view's center as a fraction of the viewport. Neighbouring keys are joined with smoothstep, so two
 *   equal keys are a hold and two different ones are a move.
 * @typedef {{
 *   kind: string, in0: number, hold0: number, hold1: number, z: number, cx: number, cy: number,
 *   weight: number, result: boolean, cut: boolean, cutBy: string | null
 * }} Shot
 *   cutBy says what ended the hold early: "action" (one outside the view), "scroll", "end", or null.
 * @typedef {{ keys: CameraKey[], shots: Shot[], poster: number }} Camera
 * @typedef {{ index: number, count: number, text: string, out0: number, out1: number }} Caption
 */

export const FPS = 30;

/** The editing, camera and caption rules from docs/DEMO_STUDIO.md. */
export const RULES = Object.freeze({
  // Protected time plays at 1x: around every action, the start of every step, every reveal, and the ends.
  actionBefore: 0.4,
  actionAfter: 0.8,
  // An action that waits inside Playwright longer than idleMin (a button that only enables with the answer) keeps its
  // approach, up to readyAfter past its ready, and the moment it acts, from doneBefore before its end, at 1x. The wait
  // between them is idle time.
  readyAfter: 0.3,
  doneBefore: 0.3,
  stepBefore: 0.2,
  stepAfter: 1.0,
  revealBefore: 0.2,
  revealAfter: 2.4,
  // A loading state or an echo only needs a second at real speed to read; the wait after it is sped up.
  loadingAfter: 1.0,
  head: 1.0,
  tail: 2.5,
  // A reveal is a burst of DOM activity with this many added or changed nodes, or this many characters of added text
  // (a one-line result), or aria-busy turning off, or a result the recorder held. Activity records and busy-offs less
  // than burstGap apart are one burst.
  revealAdded: 3,
  revealChanged: 5,
  revealText: 20,
  burstGap: 0.4,
  // A reveal that starts while an action runs or up to echoAfter seconds after it, covers less than echoMaxCover of
  // the viewport and sits within echoNear CSS px of the action's element is the page answering that action (a file
  // name, a checked box, a button saying it is working). It plays at 1x for loadingAfter but isn't framed.
  echoAfter: 1.0,
  echoMaxCover: 0.03,
  echoNear: 80,
  // A reveal is framed only when at least this share of it (or of the screen, for one taller than the screen) shows.
  minVisible: 0.5,
  // Idle stretches longer than idleMin play in min(1.4, 0.5 + 0.1 * idle) seconds, at most maxSpeed times faster.
  // Past maxMain seconds, stretches longer than idleMinCapped are sped up too.
  idleMin: 1.6,
  idleMinCapped: 1.0,
  maxSpeed: 16,
  maxMain: 70,
  // Waits of badgeMin seconds or more get a badge, left up badgeLinger seconds after the wait so it can be read. The
  // badge gives the wait's whole span when at most badgeSpanExtra seconds of it played at real speed.
  badgeMin: 3,
  badgeLinger: 0.5,
  badgeSpanExtra: 3,
  // Camera: smoothstep moves of `ease` seconds, holds of at least minHold, targets closer than mergeGap share a shot,
  // and the last endRest seconds are at zoom 1. Between shots the camera rests at zoom 1 only if it can stay there
  // restMin seconds; otherwise it moves straight to the next shot.
  ease: 0.7,
  minHold: 1.2,
  mergeGap: 1.5,
  restMin: 0.8,
  endRest: 0.7,
  typePad: 120,
  typeZoom: Object.freeze([1.25, 1.8]),
  typeAfter: 0.6,
  // A result gets less room above it, where the button that asked for it usually sits. Its zoom keeps the content
  // column and revealPad either side of it in view when it can.
  revealPad: 64,
  revealPadTop: 28,
  revealZoom: Object.freeze([1.15, 1.6]),
  revealHold: 2.5,
  revealMaxCover: 0.6,
  // Poster: a result the viewer waited at least modelWait seconds for came from a model. Of the held results, the ones
  // waited at least posterMain of the longest wait count as the main output.
  modelWait: 1.5,
  posterMain: 0.75,
  // The recorder measures a reveal's rect once window scrolling stops, at most this long after it.
  revealSettle: 1.2,
  // A page scroll of more than scrollCut CSS px during a shot ends it, since the framed content has moved.
  scrollCut: 40,
  // When the last result appears too close to the end for its shot, the last frame is held up to this long.
  tailHoldMax: 2,
  // Captions shorter than captionMin seconds are dropped, and the last one ends captionEnd seconds before the main
  // part does, so it is gone before the cut to the outro. Text is cut to captionChars, about one line. Where one
  // caption follows another, the old text fades out over captionCut seconds, then the new text fades in.
  captionMin: 1.0,
  captionEnd: 0.6,
  captionChars: 60,
  captionCut: 0.15,
});

// Actions that move the cursor somewhere the viewer should see, so a shot that doesn't show them ends.
const CUT_KINDS = new Set(["click", "type", "upload", "select", "check", "hover"]);
// Actions whose small, immediate answer on the page is an echo rather than a result (RULES.echoAfter).
const ECHO_KINDS = new Set(["click", "upload", "select", "check", "press"]);

const EPS = 1e-6;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, digits) => Number(v.toFixed(digits));

// ---------------------------------------------------------------------------------------------------------------
// Timeline

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const time = (v) => (num(v) === null ? null : Math.max(0, v));
const list = (v) => (Array.isArray(v) ? v : []);

/** @returns {Rect | null} */
function cleanRect(r) {
  const [x, y, w, h] = [num(r?.x), num(r?.y), num(r?.w), num(r?.h)];
  return x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * Checks and tidies a parsed timeline.json: drops entries with missing or bad numbers, sorts everything by time and
 * fills in defaults, so the planners can trust what they get. An action without `ready` (an older recorder's) was
 * ready when it ended, and a result without `at` appeared when it came on screen. Never throws.
 * @param {any} raw
 * @returns {Timeline}
 */
export function normalizeTimeline(raw) {
  const width = num(raw?.viewport?.width) > 0 ? raw.viewport.width : 1280;
  const height = num(raw?.viewport?.height) > 0 ? raw.viewport.height : 720;
  const byTime = (a, b) => (a.t ?? a.t0) - (b.t ?? b.t0);
  const rects = (v) => list(v).map(cleanRect).filter(Boolean).slice(0, 32);
  const frames = list(raw?.frames)
    .filter((f) => typeof f?.file === "string" && f.file && time(f.t) !== null)
    .map((f) => ({ file: f.file, t: time(f.t) }))
    .sort(byTime);
  const steps = list(raw?.steps)
    .filter((s) => typeof s?.title === "string" && time(s.t0) !== null)
    .map((s) => ({ title: s.title, t0: time(s.t0), t1: Math.max(time(s.t0), time(s.t1) ?? 0), depth: num(s.depth) ?? 0 }))
    .sort(byTime);
  const actions = list(raw?.actions)
    .filter((a) => typeof a?.kind === "string" && time(a.t0) !== null)
    .map((a) => {
      const t0 = time(a.t0);
      const t1 = Math.max(t0, time(a.t1) ?? 0);
      return {
        kind: a.kind,
        t0,
        ready: clamp(time(a.ready) ?? t1, t0, t1),
        t1,
        rect: cleanRect(a.rect),
        label: typeof a.label === "string" ? a.label : "",
        ...(typeof a.fileName === "string" ? { fileName: a.fileName } : {}),
        ...(num(a.typed) !== null ? { typed: a.typed } : {}),
        ...(a.noop === true ? { noop: true } : {}),
        ...(Array.isArray(a.heads) ? { heads: rects(a.heads) } : {}),
      };
    })
    .sort(byTime);
  const activity = list(raw?.activity)
    .filter((a) => time(a?.t) !== null)
    .map((a) => ({
      t: time(a.t),
      added: Math.max(0, num(a.added) ?? 0),
      changed: Math.max(0, num(a.changed) ?? 0),
      text: Math.max(0, num(a.text) ?? 0),
      rect: cleanRect(a.rect),
    }))
    .sort(byTime);
  const busy = list(raw?.busy)
    .filter((b) => time(b?.t) !== null && typeof b.on === "boolean")
    .map((b) => ({ t: time(b.t), on: b.on, rect: cleanRect(b.rect) }))
    .sort(byTime);
  const scrolls = list(raw?.scrolls)
    .filter((s) => time(s?.t) !== null && num(s.y) !== null)
    .map((s) => ({ t: time(s.t), y: s.y }))
    .sort(byTime);
  const results = list(raw?.results)
    .filter((r) => time(r?.t) !== null)
    .map((r) => ({
      t: time(r.t),
      at: Math.min(time(r.at) ?? time(r.t), time(r.t)),
      rect: cleanRect(r.rect),
      scrollY: num(r.scrollY),
      waited: num(r.waited) === null ? null : Math.max(0, r.waited),
      busy: typeof r.busy === "boolean" ? r.busy : null,
      media: Math.max(0, num(r.media) ?? 0),
      heads: rects(r.heads),
      blanks: rects(r.blanks),
      pressed: cleanRect(r.pressed),
    }))
    .sort(byTime);
  const viewports = list(raw?.viewports)
    .filter((v) => time(v?.t) !== null && num(v.width) > 0 && num(v.height) > 0)
    .map((v) => ({ t: time(v.t), width: v.width, height: v.height }))
    .sort(byTime);
  const column = num(raw?.column?.x) !== null && num(raw?.column?.w) > 0 ? { x: raw.column.x, w: raw.column.w } : null;
  const lastFrame = frames.length ? frames[frames.length - 1].t : 0;
  return {
    version: num(raw?.version) ?? 1,
    viewport: { width, height },
    dpr: num(raw?.dpr) > 0 ? raw.dpr : 1,
    status: typeof raw?.status === "string" ? raw.status : "unknown",
    duration: Math.max(time(raw?.duration) ?? 0, lastFrame),
    frames,
    steps,
    actions,
    activity,
    busy,
    scrolls,
    results,
    viewports,
    column,
  };
}

/**
 * A recording that isn't 16:9, like a test that sets a phone-sized viewport, is shown whole in the 16:9 screen with a
 * margin around it. Returns the timeline as if it were recorded in that 16:9 canvas, with every rect moved by the
 * margin, and where the recording sits in the canvas, in CSS px. A 16:9 recording comes back as it is.
 * @param {Timeline} tl
 * @param {number} [aspect]
 * @returns {{ tl: Timeline, box: Rect }}
 */
export function letterbox(tl, aspect = 16 / 9) {
  const { width, height } = tl.viewport;
  if (Math.abs(width / height - aspect) / aspect < 0.01) return { tl, box: { x: 0, y: 0, w: width, h: height } };
  const w = Math.max(width, height * aspect);
  const h = Math.max(height, width / aspect);
  const dx = (w - width) / 2;
  const dy = (h - height) / 2;
  const move = (r) => (r ? { ...r, x: r.x + dx, y: r.y + dy } : r);
  return {
    tl: {
      ...tl,
      viewport: { width: w, height: h },
      actions: tl.actions.map((a) => ({ ...a, rect: move(a.rect), ...(a.heads ? { heads: a.heads.map(move) } : {}) })),
      activity: tl.activity.map((a) => ({ ...a, rect: move(a.rect) })),
      busy: tl.busy.map((b) => ({ ...b, rect: move(b.rect) })),
      results: tl.results.map((r) => ({
        ...r,
        rect: move(r.rect),
        heads: r.heads.map(move),
        blanks: r.blanks.map(move),
        pressed: move(r.pressed),
      })),
      column: tl.column ? { ...tl.column, x: tl.column.x + dx } : null,
    },
    box: { x: dx, y: dy, w: width, h: height },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rects

/** @returns {Rect} */
const union = (a, b) => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const pad = (r, p, top = p) => ({ x: r.x - p, y: r.y - top, w: r.w + 2 * p, h: r.h + p + top });

/** True when rect a lies inside rect b, give or take a pixel. */
const inside = (a, b) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;

/** How far apart two rects are: 0 when they touch or overlap, else the larger of the horizontal and vertical gaps. */
const gap = (a, b) => Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h));

/** The part of a rect inside the viewport, or null when none of it is. */
function clipRect(r, vw, vh) {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(vw, r.x + r.w);
  const y1 = Math.min(vh, r.y + r.h);
  return x1 - x0 > EPS && y1 - y0 > EPS ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** The page's scroll position at source time s: the last recorded scroll at or before it. */
function scrollAt(tl, s) {
  let y = 0;
  for (const e of tl.scrolls) {
    if (e.t > s + EPS) break;
    y = e.y;
  }
  return y;
}

/**
 * When the page stops scrolling after a reveal at source time t, within revealSettle: the recorder measures what
 * appeared then, so the camera moves in then.
 */
function stillAfter(tl, t) {
  const scrolling = tl.scrolls.filter((e) => e.t >= t && e.t <= t + RULES.revealSettle);
  return scrolling.length ? scrolling[scrolling.length - 1].t : t;
}

// ---------------------------------------------------------------------------------------------------------------
// Reveals

/**
 * Moments where something appeared: bursts of DOM activity with at least revealAdded added or revealChanged changed
 * nodes or revealText characters of new text, aria-busy turning off, and the results the recorder held. Records less
 * than burstGap apart are one reveal, with the union of their rects, or a held result's rect, which is measured in
 * view. Typing echoes, loading states, echoes of an action, reveals mostly off screen and where a held result appeared
 * before the recorder brought it on screen are kept (they play at real speed) but not framed.
 * @param {Timeline} tl
 * @returns {Reveal[]}
 */
export function findReveals(tl) {
  const { width: vw, height: vh } = tl.viewport;
  /** @type {Array<{ t: number, last: number, added: number, changed: number, text: number, rect: Rect | null }>} */
  const bursts = [];
  for (const a of tl.activity) {
    const b = bursts[bursts.length - 1];
    if (b && a.t - b.last <= RULES.burstGap) {
      b.last = a.t;
      b.added += a.added;
      b.changed += a.changed;
      b.text += a.text;
      b.rect = b.rect && a.rect ? union(b.rect, a.rect) : (b.rect ?? a.rect);
    } else {
      bursts.push({ t: a.t, last: a.t, added: a.added, changed: a.changed, text: a.text, rect: a.rect });
    }
  }
  const plain = { scrollY: null, busyOff: false, result: false, held: null };
  const found = [
    ...bursts
      .filter((b) => b.added >= RULES.revealAdded || b.changed >= RULES.revealChanged || b.text >= RULES.revealText)
      .map((b) => ({ ...plain, t: b.t, rect: b.rect, weight: b.added + b.changed })),
    ...tl.busy.filter((b) => !b.on).map((b) => ({ ...plain, t: b.t, rect: b.rect, weight: 0, busyOff: true })),
    ...tl.results.map((r) => ({ ...plain, t: r.t, rect: r.rect, scrollY: r.scrollY, weight: 1, result: true, held: r })),
  ].sort((a, b) => a.t - b.t);

  /** @type {Reveal[]} */
  const reveals = [];
  for (const r of found) {
    const last = reveals[reveals.length - 1];
    if (last && r.t - last.t <= RULES.burstGap) {
      last.weight += r.weight;
      last.busyOff ||= r.busyOff;
      // A held result's box was measured in view, so it stands for the whole burst.
      if (r.result) Object.assign(last, { rect: r.rect ?? last.rect, scrollY: r.scrollY, result: true, held: r.held });
      else if (!last.result) last.rect = last.rect && r.rect ? union(last.rect, r.rect) : (last.rect ?? r.rect);
    } else {
      reveals.push({ ...r, loading: false, echo: false, frame: true });
    }
  }
  for (const r of reveals) {
    const typing = tl.actions.some((a) => a.kind === "type" && r.t >= a.t0 - 0.1 && r.t <= a.t1 + 0.3);
    r.loading = !r.busyOff && !r.result && tl.busy.some((b) => b.on && Math.abs(b.t - r.t) <= 0.3);
    const visible = r.rect ? clipRect(r.rect, vw, vh) : null;
    const shownArea = visible ? visible.w * visible.h : 0;
    const small = shownArea / (vw * vh) < RULES.echoMaxCover;
    r.echo =
      !r.busyOff &&
      !r.result &&
      small &&
      tl.actions.some(
        (a) => ECHO_KINDS.has(a.kind) && r.t >= a.t0 && r.t <= a.t1 + RULES.echoAfter && (!r.rect || !a.rect || gap(r.rect, a.rect) <= RULES.echoNear),
      );
    // A held result counts against as much of it as the screen could show, so one taller than the screen, brought on
    // screen with its top in view, is framed. A burst's box can be a union that spans the page, so it counts whole.
    const most = (b) => (r.result ? Math.min(b.w, vw) * Math.min(b.h, vh) : Math.min(b.w * b.h, vw * vh));
    const share = r.rect ? shownArea / most(r.rect) : 1;
    // Where a result appeared that the recorder brought on screen later: the held reveal frames it, measured in view.
    const later = !r.result && tl.results.some((h) => h.t - h.at > RULES.burstGap && Math.abs(r.t - h.at) <= RULES.burstGap);
    r.frame = !typing && !r.loading && !r.echo && !later && share >= RULES.minVisible - EPS;
  }
  return reveals;
}

// ---------------------------------------------------------------------------------------------------------------
// Edit

/** Sorted, merged [start, end] intervals. */
function mergeIntervals(intervals) {
  const sorted = intervals.filter(([a, b]) => b - a > EPS).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The source intervals that must play at 1x. */
function protectedIntervals(tl, reveals) {
  const D = tl.duration;
  const r = RULES;
  const keep = [
    [0, Math.min(D, r.head)],
    [Math.max(0, D - r.tail), D],
    ...tl.actions.flatMap((a) =>
      a.t1 - a.ready > r.idleMin
        ? [
            [a.t0 - r.actionBefore, a.ready + r.readyAfter],
            [a.t1 - r.doneBefore, a.t1 + r.actionAfter],
          ]
        : [[a.t0 - r.actionBefore, a.t1 + r.actionAfter]],
    ),
    // From just before each step starts to a second in, so every new caption arrives at real speed.
    ...tl.steps.map((s) => [s.t0 - r.stepBefore, s.t0 + r.stepAfter]),
    ...reveals.map((v) => [v.t - r.revealBefore, v.t + (v.loading || v.echo ? r.loadingAfter : r.revealAfter)]),
  ].map(([a, b]) => [clamp(a, 0, D), clamp(b, 0, D)]);
  return mergeIntervals(keep);
}

/** How long an idle stretch of `idle` seconds plays: min(1.4, 0.5 + 0.1 * idle), but never faster than maxSpeed. */
export function idleOutputSeconds(idle) {
  return Math.max(Math.min(1.4, 0.5 + 0.1 * idle), idle / RULES.maxSpeed);
}

/** Segments for [0, D] given the protected intervals: protected and short idle time at 1x, longer idle sped up. */
function buildSegments(keep, D, idleMin) {
  /** @type {Segment[]} */
  const segments = [];
  let out = 0;
  const push = (src0, src1, outLen) => {
    if (src1 - src0 <= EPS) return;
    const last = segments[segments.length - 1];
    const speed = (src1 - src0) / outLen;
    if (last && Math.abs(last.speed - 1) < EPS && Math.abs(speed - 1) < EPS) {
      last.src1 = src1;
      last.out1 = out + outLen;
    } else {
      segments.push({ src0, src1, out0: out, out1: out + outLen, speed });
    }
    out += outLen;
  };
  let t = 0;
  for (const [a, b] of [...keep, [D, D]]) {
    if (a - t > EPS) {
      const idle = a - t;
      push(t, a, idle > idleMin + EPS ? idleOutputSeconds(idle) : idle);
    }
    if (b > a) push(a, b, b - a);
    t = Math.max(t, b);
  }
  if (!segments.length) segments.push({ src0: 0, src1: D, out0: 0, out1: D, speed: 1 });
  return segments;
}

/**
 * Output time for source time s. In a held segment (speed 0) this is the time the source reached its end.
 * @param {{ segments: Segment[] }} edit
 * @param {number} s
 */
export function outAt(edit, s) {
  const segs = edit.segments;
  if (s <= segs[0].src0) return segs[0].out0;
  for (const g of segs) {
    if (g.speed > 0 && s <= g.src1 + EPS) return g.out0 + (Math.min(s, g.src1) - g.src0) / g.speed;
  }
  const moving = segs.filter((g) => g.speed > 0);
  return moving.length ? moving[moving.length - 1].out1 : 0;
}

/**
 * Source time shown at output time o.
 * @param {{ segments: Segment[] }} edit
 * @param {number} o
 */
export function srcAt(edit, o) {
  const segs = edit.segments;
  for (const g of segs) {
    if (o < g.out1 - EPS) return g.speed > 0 ? g.src0 + (Math.max(o, g.out0) - g.out0) * g.speed : g.src0;
  }
  return segs[segs.length - 1].src1;
}

/**
 * For every output frame n at FPS, the source time it shows and the source frame index: the last frame whose t is
 * at or before that time (the first frame before any).
 * @param {Frame[]} frames
 * @param {{ segments: Segment[] }} edit
 * @param {number} count
 * @returns {Array<{ n: number, src: number, frame: number }>}
 */
export function planFrames(frames, edit, count) {
  const plan = [];
  let j = 0;
  for (let n = 0; n < count; n++) {
    const src = srcAt(edit, n / FPS);
    while (j + 1 < frames.length && frames[j + 1].t <= src + EPS) j++;
    plan.push({ n, src, frame: j });
  }
  return plan;
}

/**
 * Consecutive output frames that show the same source frame, for the ffconcat list.
 * @param {Array<{ n: number, frame: number }>} plan
 * @param {Frame[]} frames
 * @returns {FrameRun[]}
 */
export function frameRuns(plan, frames) {
  /** @type {FrameRun[]} */
  const runs = [];
  for (const p of plan) {
    const last = runs[runs.length - 1];
    if (last && last.frame === p.frame) last.count += 1;
    else runs.push({ frame: p.frame, file: frames[p.frame].file, start: p.n, count: 1 });
  }
  return runs;
}

/**
 * Seconds to hold the last frame so the last result gets its full shot (and is on screen long enough to read) before
 * the camera must be back at zoom 1 for the last endRest seconds.
 */
function tailHoldFor(tl, reveals, edit) {
  const last = reveals.filter((r) => r.frame).pop();
  if (!last) return 0;
  const { width: vw, height: vh } = tl.viewport;
  const r = RULES;
  const visible = last.rect ? clipRect(last.rect, vw, vh) : null;
  const zooms = visible && (visible.w * visible.h) / (vw * vh) < r.revealMaxCover;
  const need = zooms ? r.ease + r.revealHold + r.ease + r.endRest : r.revealAfter + 0.6;
  const after = edit.segments[edit.segments.length - 1].out1 - outAt(edit, zooms ? stillAfter(tl, last.t) : last.t);
  return round(clamp(need - after, 0, r.tailHoldMax), 3);
}

/**
 * The span a badge reports for the sped-up stretch g, in source seconds: the aria-busy span around it (the model
 * call, a little longer than the stretch), or with no aria-busy the time from the end of the action before it to the
 * reveal or action that ends it (the click to the answer). Only when no more than badgeSpanExtra seconds of the span
 * played at real speed and no other badged stretch shares it. Null when no span qualifies.
 */
function waitSpan(tl, reveals, g, waits) {
  const mid = (h) => (h.src0 + h.src1) / 2;
  const covers = (s, h) => s.t0 <= mid(h) && s.t1 >= mid(h);
  const fits = (s) => covers(s, g) && s.t1 - s.t0 - (g.src1 - g.src0) <= RULES.badgeSpanExtra + EPS && waits.every((h) => h === g || !covers(s, h));
  for (const on of tl.busy.filter((b) => b.on)) {
    const span = { t0: on.t, t1: tl.busy.find((b) => !b.on && b.t > on.t)?.t ?? on.t };
    if (fits(span)) return span;
  }
  const ended = tl.actions.map((a) => a.t1).filter((t) => t <= g.src0 + EPS);
  const next = [...reveals.map((v) => v.t), ...tl.actions.flatMap((a) => [a.t0, a.t1])].filter((t) => t >= g.src1 - EPS);
  if (!ended.length || !next.length) return null;
  const span = { t0: Math.max(...ended), t1: Math.min(...next) };
  return fits(span) ? span : null;
}

/**
 * The edit decision list (docs/DEMO_STUDIO.md, editing rules): protected time at 1x, idle stretches sped up, wait
 * badges, the last frame held when the final result needs it, and the frame plan at FPS. With speedUp false
 * everything plays at 1x and there are no badges.
 * @param {Timeline} tl normalized timeline
 * @param {{ speedUp?: boolean, maxSeconds?: number }} [opts]
 * @returns {Edit}
 */
export function planEdit(tl, opts = {}) {
  const speedUp = opts.speedUp !== false;
  const maxSeconds = opts.maxSeconds ?? RULES.maxMain;
  const D = tl.duration;
  const reveals = findReveals(tl);

  let segments;
  let capped = false;
  if (!speedUp) {
    segments = [{ src0: 0, src1: D, out0: 0, out1: D, speed: 1 }];
  } else {
    const keep = protectedIntervals(tl, reveals);
    segments = buildSegments(keep, D, RULES.idleMin);
    if (segments[segments.length - 1].out1 > maxSeconds + EPS) {
      segments = buildSegments(keep, D, RULES.idleMinCapped);
      capped = true;
    }
  }
  const tailHold = speedUp ? tailHoldFor(tl, reveals, { segments }) : 0;
  if (tailHold > 0) {
    const end = segments[segments.length - 1].out1;
    segments.push({ src0: D, src1: D, out0: end, out1: end + tailHold, speed: 0 });
  }

  const frames = Math.max(1, Math.round(segments[segments.length - 1].out1 * FPS));
  const seconds = frames / FPS;
  const sped = segments.filter((g) => g.speed > 1 + EPS);
  const compressed = sped.reduce((sum, g) => sum + g.src1 - g.src0, 0);

  // A badge gives the wait's real length (waitSpan), or else the stretch itself, rounded up to whole seconds ignoring
  // the last tenth, so 7.006 s reads "7 s".
  const waits = sped.filter((g) => g.src1 - g.src0 >= RULES.badgeMin - EPS);
  /** @type {Badge[]} */
  const badges = waits.map((g) => {
    const span = waitSpan(tl, reveals, g, waits);
    const waited = Math.ceil(Math.max(g.src1 - g.src0, span ? span.t1 - span.t0 : 0) - 0.1);
    return { out0: g.out0, out1: g.out1, show0: g.out0, show1: g.out1, seconds: waited, text: `Waited ${waited} s, sped up` };
  });
  badges.forEach((b, i) => {
    const next = badges[i + 1];
    b.show1 = Math.min(b.out1 + RULES.badgeLinger, next ? next.out0 - 0.1 : seconds, seconds);
  });

  const runs = frameRuns(planFrames(tl.frames, { segments }, frames), tl.frames);
  return {
    segments,
    seconds,
    frames,
    sourceSeconds: D,
    compressedSeconds: round(compressed, 3),
    capped,
    tailHold,
    badges,
    reveals,
    runs,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Camera

/**
 * Zoom and center that frame a viewport rect: as close as the zoom range allows with the whole rect in view, then
 * moved so the crop stays inside the frame. A rect taller than the crop shows its top. For a result, `column` (the
 * content column's x-range) keeps the crop on the column's middle, with the zoom low enough to show the whole column
 * and revealPad either side when the range allows, and a result shorter than the crop gets the spare room above it,
 * where what led to it is.
 */
function frameView(rect, zoom, vw, vh, column = null) {
  const most = column ? Math.max(zoom[0], Math.min(zoom[1], vw / (column.w + 2 * RULES.revealPad))) : zoom[1];
  const z = clamp(Math.min(vw / rect.w, vh / rect.h), zoom[0], most);
  const halfW = vw / (2 * z);
  const halfH = vh / (2 * z);
  const cy = rect.h > 2 * halfH ? rect.y + halfH : column ? rect.y + rect.h - halfH : rect.y + rect.h / 2;
  // The column's middle, as long as the rect stays in view.
  const cx = column && rect.w <= 2 * halfW ? clamp(column.x + column.w / 2, rect.x + rect.w - halfW, rect.x + halfW) : rect.x + rect.w / 2;
  return {
    z: round(z, 3),
    cx: round(clamp(cx, halfW, vw - halfW) / vw, 5),
    cy: round(clamp(cy, halfH, vh - halfH) / vh, 5),
  };
}

/**
 * The content column's x-range: the recorder's (main's content box), or for an older timeline the span of its held
 * results and the actions' boxes narrower than the screen. Null when there is nothing to go on.
 * @param {Timeline} tl
 */
function contentColumn(tl) {
  if (tl.column) return tl.column;
  const vw = tl.viewport.width;
  const narrow = (r) => r && r.w < 0.9 * vw;
  const results = tl.results.map((r) => r.rect).filter(narrow);
  const rects = [...results, ...tl.actions.map((a) => a.rect).filter(narrow)];
  if (!results.length || rects.length < 2) return null;
  const x0 = Math.min(...rects.map((r) => r.x));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  return x1 - x0 < 0.9 * vw ? { x: x0, w: x1 - x0 } : null;
}

/** The part of the viewport a view shows. */
const viewBox = (view, vw, vh) => ({
  x: view.cx * vw - vw / (2 * view.z),
  y: view.cy * vh - vh / (2 * view.z),
  w: vw / view.z,
  h: vh / view.z,
});

/**
 * Moves a view up or down so its top and bottom edges cut through as few blockers as they can: the controls the test
 * used (the button that asked for a result, a field above it), headings, labels and the app bar. Each edge can move
 * just past a blocker, away from it, or out to take it in whole, as long as the target stays in view (its top, for one
 * taller than the crop, with the crop no more than a fifth of its height above it) and the crop inside the frame. Of
 * the places that cut the fewest, the nearest wins.
 */
function clearOfControls(view, target, blockers, vw, vh) {
  const b = viewBox(view, vw, vh);
  const tall = target.h > b.h;
  const fits = (top) =>
    top >= -EPS &&
    top + b.h <= vh + EPS &&
    top <= target.y + EPS &&
    (tall ? top >= target.y - 0.2 * b.h - EPS : top + b.h >= target.y + target.h - EPS);
  const across = blockers.filter((c) => c.x + c.w > b.x && c.x < b.x + b.w);
  const through = (c, y) => c.y < y - 2 && c.y + c.h > y + 2;
  const cuts = (top) => across.filter((c) => through(c, top) || through(c, top + b.h)).length;
  let best = b.y;
  let fewest = cuts(b.y);
  for (const top of across.flatMap((c) => [c.y + c.h + 6, c.y - 12, c.y - 6 - b.h, c.y + c.h + 12 - b.h])) {
    if (!fits(top)) continue;
    const n = cuts(top);
    if (n < fewest || (n === fewest && Math.abs(top - b.y) < Math.abs(best - b.y))) {
      best = top;
      fewest = n;
    }
  }
  return best === b.y ? view : { ...view, cy: round((best + b.h / 2) / vh, 5) };
}

/**
 * Camera keyframes in output time (docs/DEMO_STUDIO.md, camera rules): zoom in on a field while text is typed into it
 * and on a result when it appears, hold each shot at least minHold, and be back at zoom 1 for the last endRest seconds.
 * A result is framed on the content column with the room above it, a target taller than the crop shows its top, and
 * crop edges keep clear of used controls, headings, labels and the app bar. Targets closer than mergeGap share a shot
 * of their union when it still fits at the lowest zoom; when it doesn't, the later one follows the earlier with a
 * straight move. A shot holds through actions inside its view, ends early when the page scrolls under it, and starts
 * to leave when a click or typing is coming outside its view (one that changes nothing doesn't count, since the cursor
 * stays put). Nothing is framed after the test changes the viewport. Also picks the poster time.
 * @param {Timeline} tl
 * @param {Edit} edit
 * @returns {Camera}
 */
export function planCamera(tl, edit) {
  const r = RULES;
  const { width: vw, height: vh } = tl.viewport;
  const end = edit.seconds;
  // Rects are recorded in viewport coordinates, so they are kept in page coordinates (adding the scroll position at
  // the time they were measured) until a shot is framed. The recorder measures an action's rect after scrolling it
  // into view and gliding the cursor there, so about a second after t0, and a held result's rect at its scrollY.
  const toPage = (rect, s) => ({ ...rect, y: rect.y + scrollAt(tl, s) });
  const measured = (a) => Math.min(a.t1, a.t0 + 1);
  const resized = tl.viewports.length ? tl.viewports[0].t : Infinity;
  const column = contentColumn(tl);

  // Targets move in from in0 and hold from hold0 to want1 at best. `rect` is what must stay in view, `page` that
  // with its padding.
  const targets = [];
  for (const a of tl.actions) {
    // A field the recorder couldn't measure comes as the whole viewport, which is nothing to zoom in on, and a fill
    // that drew no text (the field already said it) has nothing to show.
    if (a.kind !== "type" || !a.rect || a.rect.w * a.rect.h >= 0.9 * vw * vh || a.typed === 0 || a.t0 >= resized) continue;
    // t0 is when the cursor starts gliding to the field, so the camera moves in with it and is there when typing starts.
    const in0 = outAt(edit, a.t0);
    const hold0 = in0 + r.ease;
    const want1 = Math.max(outAt(edit, a.t1 + r.typeAfter), hold0 + r.minHold);
    const rect = toPage(a.rect, measured(a));
    targets.push({ kind: "type", in0, hold0, want1, rect, page: pad(rect, r.typePad), zoom: r.typeZoom, weight: 0, result: false });
  }
  for (const v of edit.reveals) {
    if (!v.frame || !v.rect || v.t >= resized) continue;
    // The recorder measures what appeared once the page stops scrolling (up to revealSettle later), so the rect is
    // where it ended up, and the camera moves in when that scroll is over.
    const visible = clipRect(v.rect, vw, vh);
    if (!visible || (visible.w * visible.h) / (vw * vh) >= r.revealMaxCover) continue;
    const in0 = outAt(edit, stillAfter(tl, v.t));
    const rect = v.scrollY === null ? toPage(visible, v.t + r.revealSettle) : { ...visible, y: visible.y + v.scrollY };
    targets.push({
      kind: "reveal",
      in0,
      hold0: in0 + r.ease,
      want1: in0 + r.ease + r.revealHold,
      rect,
      page: pad(rect, r.revealPad, r.revealPadTop),
      zoom: r.revealZoom,
      weight: Math.max(1, v.weight),
      result: v.result,
    });
  }
  targets.sort((a, b) => a.hold0 - b.hold0);

  // Controls the test used near a shot's time, in page coordinates, which a crop edge shouldn't cut through.
  const controls = tl.actions
    .filter((a) => CUT_KINDS.has(a.kind) && a.rect && a.rect.w * a.rect.h < 0.25 * vw * vh)
    .map((a) => ({ t: a.t0, rect: toPage(a.rect, measured(a)) }));
  // Headings, labels and the app bar in page coordinates, as the recorder saw them with each action and each held
  // result. A shot keeps clear of the set measured closest to it, within 10 s, since the page's layout changes.
  const headSets = [
    ...tl.actions.filter((a) => a.heads?.length).map((a) => ({ t: measured(a), rects: a.heads.map((h) => toPage(h, measured(a))) })),
    ...tl.results
      .filter((x) => x.heads.length && x.scrollY !== null)
      .map((x) => ({ t: x.t, rects: x.heads.map((h) => ({ ...h, y: h.y + x.scrollY })) })),
  ];
  const headsNear = (s) => {
    const sets = headSets.filter((h) => Math.abs(h.t - s) <= 10).sort((a, b) => Math.abs(a.t - s) - Math.abs(b.t - s));
    return sets.length ? sets[0].rects : [];
  };

  // Frames a target as the page is when its hold starts. The hold lasts through actions inside the view that start
  // before it would end (the file chip landing on a picker next to the field), and ends early when the page scrolls
  // under it, when an action is coming outside its view (as the cursor heads there, so the viewer sees it) or before
  // the last endRest seconds. An action outside the view that starts before the shot could hold its minimum is taken
  // into the shot when both still fit at the lowest zoom, like a picker next to a field; otherwise there is no shot,
  // so the camera never holds a close-up while the cursor works off screen. Null too when less than minHold is left
  // or none of it is in view.
  const latest = end - r.endRest - r.ease;
  const frame = (m) => {
    const srcIn = srcAt(edit, m.in0);
    const src0 = srcAt(edit, m.hold0);
    const y0 = scrollAt(tl, src0);
    const shift = (rect) => ({ ...rect, y: rect.y - y0 });
    const rect = shift(m.page);
    if (!clipRect(rect, vw, vh)) return null;
    const near = [...controls.filter((c) => c.t > src0 - 30 && c.t < src0 + 10).map((c) => c.rect), ...headsNear(src0)].map(shift);
    const view = clearOfControls(frameView(rect, m.zoom, vw, vh, m.kind === "reveal" ? column : null), shift(m.rect), near, vw, vh);
    const box = viewBox(view, vw, vh);
    const inView = (a) => inside(shift(toPage(a.rect, measured(a))), box);
    const coming = tl.actions.filter((a) => CUT_KINDS.has(a.kind) && !a.noop && a.rect && a.t0 > srcIn + EPS);
    let want1 = m.want1;
    for (const a of coming) {
      if (a.t0 - r.actionBefore >= srcAt(edit, want1)) break;
      if (inView(a)) want1 = Math.max(want1, outAt(edit, a.t1 + r.typeAfter));
    }
    const src1 = srcAt(edit, want1);
    let hold1 = Math.min(want1, latest);
    let cutBy = hold1 < want1 - EPS ? "end" : null;
    const moved = tl.scrolls.find((e) => e.t > src0 + EPS && e.t < src1 && Math.abs(e.y - y0) > r.scrollCut);
    if (moved && outAt(edit, moved.t) < hold1) {
      hold1 = outAt(edit, moved.t);
      cutBy = "scroll";
    }
    // From the move in on: an action that starts while the camera is still moving in counts too.
    const elsewhere = coming.find((a) => a.t0 - r.actionBefore < src1 && !inView(a));
    if (elsewhere) {
      const leave = outAt(edit, elsewhere.t0 - r.actionBefore);
      if (leave < m.hold0 + r.minHold - EPS) {
        if (m.widened) return null;
        const theirs = toPage(elsewhere.rect, measured(elsewhere));
        const wider = union(m.page, pad(theirs, r.revealPad));
        const both = { ...m, page: wider, rect: union(m.rect, theirs), widened: true };
        return Math.min(vw / wider.w, vh / wider.h) >= m.zoom[0] ? frame(both) : null;
      }
      if (leave < hold1) {
        hold1 = leave;
        cutBy = "action";
      }
    }
    if (hold1 - m.hold0 < r.minHold - EPS) return null;
    return { ...m, ...view, want1, hold1, cut: hold1 < want1 - EPS, cutBy };
  };

  const framed = [];
  for (const t of targets) {
    const last = framed[framed.length - 1];
    if (!last || t.hold0 - last.hold1 >= r.mergeGap) {
      const shot = frame(t);
      if (shot) framed.push(shot);
      continue;
    }
    const page = union(last.page, t.page);
    const zoom = [Math.min(last.zoom[0], t.zoom[0]), Math.max(last.zoom[1], t.zoom[1])];
    if (Math.min(vw / page.w, vh / page.h) >= zoom[0]) {
      const kind = last.kind === t.kind ? last.kind : "mixed";
      const merged = {
        ...last,
        kind,
        want1: Math.max(last.want1, t.want1),
        rect: union(last.rect, t.rect),
        page,
        zoom,
        weight: last.weight + t.weight,
        result: last.result || t.result,
      };
      const both = frame(merged);
      if (both && both.hold1 > t.hold0 + EPS) {
        framed[framed.length - 1] = both;
        continue;
      }
    }
    // Too far apart to frame together: this shot follows the last one, which keeps at least its minimum hold. If
    // this one doesn't make it, the last one keeps its whole hold.
    const lastEnd = Math.max(last.hold0 + r.minHold, Math.min(last.hold1, t.in0));
    const in0 = Math.max(t.in0, lastEnd);
    const hold0 = Math.max(t.hold0, in0 + r.ease);
    const next = frame({ ...t, in0, hold0, want1: Math.max(t.want1, hold0 + r.minHold) });
    if (!next) continue;
    const cutBy = lastEnd < last.hold1 - EPS ? "action" : last.cutBy;
    framed[framed.length - 1] = { ...last, hold1: lastEnd, cut: lastEnd < last.want1 - EPS, cutBy };
    framed.push(next);
  }
  /** @type {Shot[]} */
  const shots = framed.map((s) => ({
    kind: s.kind,
    in0: Math.max(0, s.in0),
    hold0: s.hold0,
    hold1: s.hold1,
    z: s.z,
    cx: s.cx,
    cy: s.cy,
    weight: s.weight,
    result: s.result,
    cut: s.cut,
    cutBy: s.cutBy,
  }));

  /** @type {CameraKey[]} */
  const keys = [];
  const rest = { z: 1, cx: 0.5, cy: 0.5 };
  const key = (t, v) => {
    const k = { t: round(t, 4), z: v.z, cx: v.cx, cy: v.cy };
    const last = keys[keys.length - 1];
    if (last && k.t <= last.t + EPS) keys[keys.length - 1] = { ...k, t: last.t };
    else keys.push(k);
  };
  key(0, rest);
  shots.forEach((s, i) => {
    const prev = shots[i - 1];
    if (!prev) {
      key(s.in0, rest);
    } else if (s.hold0 - prev.hold1 >= 2 * r.ease + r.restMin) {
      // Time to rest at zoom 1 in between.
      key(prev.hold1, prev);
      key(prev.hold1 + r.ease, rest);
      key(s.in0, rest);
    } else if (prev.cutBy === "action" || prev.cutBy === "scroll") {
      // Straight to the next shot as soon as the last one has to go, arriving early if there is time.
      key(prev.hold1, prev);
      key(Math.min(s.hold0, prev.hold1 + r.ease), s);
    } else {
      // Straight to the next shot, holding the last one until the move, so every move takes `ease`.
      key(Math.max(prev.hold1, s.hold0 - r.ease), prev);
    }
    key(s.hold0, s);
  });
  const last = shots[shots.length - 1];
  if (last) {
    key(last.hold1, last);
    key(last.hold1 + r.ease, rest);
  }
  return { keys, shots, poster: posterTime(tl, edit, shots) };
}

/**
 * How long the viewer waited for held result `v`, in seconds, and whether it came from an aria-busy section: what the
 * recorder measured, or for an older timeline the longest aria-busy span or sped-up wait that ended after the result
 * held before it (at `prev`) and no later than this one.
 * @param {Timeline} tl
 * @param {Edit} edit
 * @param {Reveal} v
 * @param {number} prev
 */
function waitFor(tl, edit, v, prev) {
  const until = v.t + 0.3;
  let wait = 0;
  let busy = false;
  for (const on of tl.busy.filter((b) => b.on)) {
    const off = tl.busy.find((b) => !b.on && b.t > on.t);
    if (!off || off.t <= prev || off.t > until) continue;
    wait = Math.max(wait, off.t - on.t);
    busy = true;
  }
  for (const g of edit.segments) {
    if (g.speed > 1 + EPS && g.src1 > prev && g.src1 <= until + RULES.revealBefore) wait = Math.max(wait, g.src1 - g.src0);
  }
  return { wait: v.held?.waited ?? wait, busy: v.held?.busy ?? busy };
}

/**
 * The poster frame's time: the best held result as the camera shows it. A result is passed over, while there is
 * another, when its frame holds an empty text field, or when it is the form the test just pressed something in and no
 * model made it. Of the rest it takes the one the viewer waited at least posterMain as long for as the longest, then
 * one from an aria-busy section, then one with pictures, then the biggest, then the latest: its shot 1.5 s into the
 * hold (halfway when shorter) and at least a second after it is in view, or that second when it got no shot, or the
 * last frame for the last one. A recording without held results falls back to the biggest reveal while the camera
 * frames it, or just after it appears when it got no shot, or 60% of the way through when nothing appeared. The page
 * loading in the first seconds doesn't count.
 * @param {Timeline} tl
 * @param {Edit} edit
 * @param {Shot[]} shots
 */
export function posterTime(tl, edit, shots) {
  const end = edit.seconds;
  const { width: vw, height: vh } = tl.viewport;
  const into = (s) => s.hold0 + Math.min(1.5, (s.hold1 - s.hold0) / 2);
  const bigger = (a, x) => (!a || x.weight >= a.weight ? x : a);
  let t = end * 0.6;
  const held = edit.reveals.filter((v) => v.result);
  if (held.length) {
    const options = held.map((v, i) => {
      const at = outAt(edit, v.t);
      const shot = shots.filter((s) => s.result && s.in0 <= at + RULES.revealSettle + EPS && s.hold1 >= at).pop() ?? null;
      const { wait, busy } = waitFor(tl, edit, v, i ? held[i - 1].t : -Infinity);
      const shown = outAt(edit, stillAfter(tl, v.t));
      // What the frame shows, in the viewport as it was while the result was held (at its scrollY).
      const y0 = v.scrollY ?? 0;
      const box = shot ? viewBox(shot, vw, vh) : { x: 0, y: 0, w: vw, h: vh };
      if (shot) box.y += scrollAt(tl, srcAt(edit, shot.hold0)) - y0;
      const shows = (b) => {
        const part = clipRect({ ...b, x: b.x - box.x, y: b.y - box.y }, box.w, box.h);
        return !!part && part.w * part.h >= 0.5 * b.w * b.h;
      };
      // The control pressed last: as the recorder saw it while holding the result, or for an older timeline the box
      // of the last click before it, where it was then.
      const click = tl.actions.filter((a) => (a.kind === "click" || a.kind === "check") && a.rect && a.t1 <= v.t + 0.1).pop();
      const pressed = v.held?.pressed ?? (click ? { ...click.rect, y: click.rect.y + scrollAt(tl, Math.min(click.t1, click.t0 + 1)) - y0 } : null);
      const form = !!pressed && !!v.rect && inside(pressed, v.rect) && wait < RULES.modelWait;
      const visible = v.rect ? clipRect(v.rect, vw, vh) : null;
      return {
        // A shot that began before the result, like one shot over a form and the notes it adds, shows it a second in.
        time: shot ? Math.min(shot.hold1, Math.max(into(shot), shown + 1)) : i === held.length - 1 ? end : shown + 1,
        wait,
        busy,
        media: v.held?.media ?? 0,
        area: visible ? visible.w * visible.h : 0,
        skip: form || (v.held?.blanks ?? []).some(shows),
      };
    });
    const kept = options.some((o) => !o.skip) ? options.filter((o) => !o.skip) : options;
    const most = Math.max(...kept.map((o) => o.wait));
    const score = (o) => [most < RULES.modelWait || o.wait >= RULES.posterMain * most ? 1 : 0, o.busy ? 1 : 0, o.media ? 1 : 0, o.area];
    const beats = (a, b) => {
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
      return true;
    };
    let best = kept[0];
    for (const o of kept) if (beats(score(o), score(best))) best = o;
    t = best.time;
  } else {
    const best = shots.filter((s) => s.weight > 0).reduce(bigger, null);
    if (best) {
      t = into(best);
    } else {
      const reveal = edit.reveals.filter((v) => v.frame && v.t > RULES.head + 1).reduce(bigger, null);
      if (reveal) t = outAt(edit, reveal.t) + 1.2;
    }
  }
  return round(clamp(t, Math.min(0.6, end / 2), Math.max(end / 2, end - 1 / FPS)), 3);
}

// ---------------------------------------------------------------------------------------------------------------
// Camera as ffmpeg expressions, and their JavaScript twin

/**
 * Splits keys into pieces [t0, t1] going from v0 to v1, skipping empty pieces and joining holds at the same value.
 * @param {Array<[number, number]>} points [t, v] sorted by t
 */
function pieces(points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [t0, v0] = points[i];
    const [t1, v1] = points[i + 1];
    if (t1 - t0 <= EPS) continue;
    const last = out[out.length - 1];
    if (last && last.v0 === last.v1 && v0 === v1 && last.v1 === v0) last.t1 = t1;
    else out.push({ t0, t1, v0, v1 });
  }
  return out;
}

const smoothstep = (u) => u * u * (3 - 2 * u);

/**
 * Value at time t of the piecewise function through points: constant before the first and after the last, smoothstep
 * between neighbours. This is the JavaScript twin of piecewiseExpr.
 * @param {Array<[number, number]>} points
 * @param {number} t
 */
export function piecewiseAt(points, t) {
  const ps = pieces(points);
  if (!ps.length) return points.length ? points[points.length - 1][1] : 0;
  let p = ps[ps.length - 1];
  for (let i = 0; i + 1 < ps.length; i++) {
    if (t < ps[i + 1].t0) {
      p = ps[i];
      break;
    }
  }
  if (p.v0 === p.v1) return p.v0;
  return p.v0 + (p.v1 - p.v0) * smoothstep(clamp((t - p.t0) / (p.t1 - p.t0), 0, 1));
}

/** A number for an ffmpeg expression: fixed decimals, no exponent, no trailing zeros. */
function exprNum(v, digits = 5) {
  const s = (Math.abs(v) < 10 ** -digits ? 0 : v).toFixed(digits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * ffmpeg expression for piecewiseAt(points, T), as nested if() over a balanced tree of the pieces so it stays shallow
 * however many shots there are. T is an expression for the time, like "on/30".
 * @param {Array<[number, number]>} points
 * @param {string} T
 */
export function piecewiseExpr(points, T) {
  const ps = pieces(points);
  if (!ps.length) return exprNum(points.length ? points[points.length - 1][1] : 0);
  const piece = (p) => {
    if (p.v0 === p.v1) return exprNum(p.v0);
    const u = `clip((${T}-${exprNum(p.t0)})/${exprNum(p.t1 - p.t0)},0,1)`;
    const dv = p.v1 - p.v0;
    return `${exprNum(p.v0)}${dv < 0 ? "-" : "+"}${exprNum(Math.abs(dv))}*${u}*${u}*(3-2*${u})`;
  };
  const tree = (lo, hi) => {
    if (lo === hi) return piece(ps[lo]);
    const mid = (lo + hi) >> 1;
    return `if(lt(${T},${exprNum(ps[mid + 1].t0)}),${tree(lo, mid)},${tree(mid + 1, hi)})`;
  };
  return tree(0, ps.length - 1);
}

/**
 * zoompan's z, x and y for the camera. The zoom is a piecewise smoothstep of the output time on/FPS. x and y are the
 * crop's top-left corner in input pixels: the view's center (also a piecewise smoothstep) minus half the crop, clamped
 * to [0, iw - iw/zoom] so the crop never leaves the frame. zoompan evaluates x and y after z, so `zoom` is this frame's.
 * @param {CameraKey[]} keys
 * @param {number} [fps]
 */
export function zoompanExpressions(keys, fps = FPS) {
  const T = `on/${fps}`;
  const track = (field) => keys.map((k) => [k.t, k[field]]);
  return {
    z: piecewiseExpr(track("z"), T),
    x: `clip(${piecewiseExpr(track("cx"), T)}*iw-iw/zoom/2,0,iw-iw/zoom)`,
    y: `clip(${piecewiseExpr(track("cy"), T)}*ih-ih/zoom/2,0,ih-ih/zoom)`,
  };
}

/**
 * The camera at output time t, as zoompan will compute it for an iw x ih input: zoom, then the crop's top-left.
 * @param {CameraKey[]} keys
 * @param {number} t
 * @param {number} iw
 * @param {number} ih
 */
export function cameraAt(keys, t, iw, ih) {
  const track = (field) => keys.map((k) => [k.t, k[field]]);
  const z = piecewiseAt(track("z"), t);
  const cx = piecewiseAt(track("cx"), t);
  const cy = piecewiseAt(track("cy"), t);
  return {
    z,
    cx,
    cy,
    x: clamp(cx * iw - iw / z / 2, 0, iw - iw / z),
    y: clamp(cy * ih - ih / z / 2, 0, ih - ih / z),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Captions

/**
 * Text for the screen: whitespace collapsed, em dashes turned into commas, and cut at a word with an ellipsis when it
 * is longer than `max` characters.
 * @param {unknown} value
 * @param {number} max
 */
export function plainText(value, max) {
  let text = String(value ?? "")
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) {
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    text = `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
  }
  return text;
}

/** One caption's text: plainText cut to about one line. */
export const captionText = (title) => plainText(title, RULES.captionChars);

/**
 * The owner's shared keys this build has (the platform's docs/BUILD_KEYS.md): the values of the names .env.local lists
 * in MUSEMUSE_SHARED_KEYS, longest first. Read in memory only, so a caption can never show one, and never printed.
 * Empty without them, which leaves every caption as it was.
 * @param {string | null | undefined} envText the text of .env.local
 * @returns {string[]}
 */
export function sharedKeyValues(envText) {
  if (!envText) return [];
  /** @type {Map<string, string>} */
  const vars = new Map();
  for (const line of envText.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) vars.set(m[1], m[2].trim());
  }
  const names = (vars.get("MUSEMUSE_SHARED_KEYS") ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  return [...new Set(names.map((n) => vars.get(n) ?? "").filter((v) => v.length >= 12))].sort((a, b) => b.length - a.length);
}

/**
 * `text` with each value replaced by [redacted].
 * @param {string} text
 * @param {readonly string[]} values
 */
export function redactValues(text, values) {
  let out = String(text ?? "");
  for (const v of values) if (v && out.includes(v)) out = out.split(v).join("[redacted]");
  return out;
}

/**
 * Step captions in output time: one per top-level step with a title, identical neighbours merged, each up until the
 * next one starts (the last until captionEnd before the main part ends), and any too short to read dropped in favour
 * of the one before.
 * @param {Timeline} tl
 * @param {Edit} edit
 * @returns {Caption[]}
 */
export function planCaptions(tl, edit) {
  const end = Math.max(0, edit.seconds - RULES.captionEnd);
  /** @type {Array<{ text: string, out0: number, out1: number }>} */
  let caps = [];
  for (const s of tl.steps) {
    if (s.depth !== 0) continue;
    const text = captionText(s.title);
    if (!text) continue;
    if (caps.length && caps[caps.length - 1].text === text) continue;
    caps.push({ text, out0: Math.min(outAt(edit, s.t0), end), out1: end });
  }
  const tile = () => caps.forEach((c, i) => (c.out1 = i + 1 < caps.length ? caps[i + 1].out0 : end));
  tile();
  for (;;) {
    const i = caps.findIndex((c) => c.out1 - c.out0 < RULES.captionMin - EPS);
    if (i < 0) break;
    caps.splice(i, 1);
    caps = caps.filter((c, k) => k === 0 || c.text !== caps[k - 1].text);
    tile();
  }
  return caps.map((c, i) => ({ index: i + 1, count: caps.length, text: c.text, out0: round(c.out0, 3), out1: round(c.out1, 3) }));
}

/**
 * The caption pictures in the order they are laid over the video, bottom to top: every caption's white pill, then
 * every caption's text (the step count and title, on no background), so a pill never covers a text. Where one caption
 * follows another, the old text fades out over the last captionCut seconds while the new pill fades in, then the old
 * pill fades out while the new text fades in. Of two pills that meet, the wider is laid on top, so the narrower one
 * shows only as the wider one fades: the pill changes width without blinking or showing one pill inside another, and
 * two captions' texts are never on screen together. Elsewhere a caption fades in and out over `fade` seconds.
 * @param {Array<{ out0: number, out1: number, w?: number }>} captions in order, as planCaptions gives them, with each
 *   pill's width when it is known (pills of unknown width keep their order, the later on top)
 * @param {number} fade
 * @returns {Array<{ index: number, part: "pill" | "text", from: number, to: number, fadeIn: number, fadeOut: number }>}
 */
export function captionLayers(captions, fade) {
  const cut = RULES.captionCut;
  const parts = captions.map((c, i) => {
    const before = i > 0 && Math.abs(captions[i - 1].out1 - c.out0) < 0.05;
    const after = i + 1 < captions.length && Math.abs(captions[i + 1].out0 - c.out1) < 0.05;
    const fadeIn = before ? cut : fade;
    const fadeOut = after ? cut : fade;
    return {
      pill: { index: i, part: "pill", from: before ? c.out0 - cut : c.out0, to: after ? c.out1 + cut : c.out1, fadeIn, fadeOut },
      text: { index: i, part: "text", from: c.out0, to: c.out1, fadeIn, fadeOut },
    };
  });
  const width = (i) => num(captions[i].w) ?? 0;
  const pills = parts.map((p) => p.pill).sort((a, b) => width(a.index) - width(b.index) || a.index - b.index);
  return [...pills, ...parts.map((p) => p.text)];
}
