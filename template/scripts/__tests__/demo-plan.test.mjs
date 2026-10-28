// Unit tests for scripts/demo-plan.mjs, the demo video's planning. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FPS,
  RULES,
  cameraAt,
  captionLayers,
  captionText,
  findReveals,
  idleOutputSeconds,
  letterbox,
  normalizeTimeline,
  outAt,
  piecewiseAt,
  piecewiseExpr,
  planCamera,
  planCaptions,
  planEdit,
  srcAt,
  zoompanExpressions,
} from "../demo-plan.mjs";

/** A timeline.json with frames every `frameEvery` seconds over `duration`, plus whatever the test adds. */
function timeline({ duration, frameEvery = 0.5, ...rest }) {
  const frames = [];
  for (let t = 0, i = 1; t <= duration + 1e-9; t += frameEvery, i++) frames.push({ file: `frames/${String(i).padStart(6, "0")}.jpg`, t });
  return normalizeTimeline({ version: 1, viewport: { width: 1280, height: 720 }, dpr: 2, status: "passed", duration, frames, ...rest });
}

const click = (t, rect = { x: 600, y: 400, w: 120, h: 44 }) => ({ kind: "click", t0: t, t1: t + 0.05, rect, label: "Go" });
const type = (t0, t1, rect = { x: 200, y: 300, w: 400, h: 44 }) => ({ kind: "type", t0, t1, rect, label: "Name" });
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// A tiny evaluator for the ffmpeg expressions zoompanExpressions builds: numbers, variables, + - * /, unary minus,
// parentheses, if(), lt() and clip().
function evaluate(expr, vars) {
  let i = 0;
  const peek = () => expr[i];
  const eat = (c) => {
    assert.equal(expr[i], c, `expected "${c}" at ${i} in ${expr.slice(Math.max(0, i - 20), i + 20)}`);
    i++;
  };
  const primary = () => {
    if (peek() === "-") return i++, -primary();
    if (peek() === "(") {
      eat("(");
      const v = sum();
      eat(")");
      return v;
    }
    const m = /^[0-9.]+|^[a-z_]+/.exec(expr.slice(i));
    assert.ok(m, `unexpected "${expr.slice(i, i + 10)}"`);
    i += m[0].length;
    if (/^[0-9.]/.test(m[0])) return Number(m[0]);
    if (peek() !== "(") {
      assert.ok(m[0] in vars, `unknown variable ${m[0]}`);
      return vars[m[0]];
    }
    eat("(");
    const args = [sum()];
    while (peek() === ",") eat(","), args.push(sum());
    eat(")");
    if (m[0] === "if") return args[0] ? args[1] : args[2];
    if (m[0] === "lt") return args[0] < args[1] ? 1 : 0;
    if (m[0] === "clip") return Math.min(args[2], Math.max(args[1], args[0]));
    throw new Error(`unknown function ${m[0]}`);
  };
  const product = () => {
    let v = primary();
    while (peek() === "*" || peek() === "/") v = expr[i++] === "*" ? v * primary() : v / primary();
    return v;
  };
  const sum = () => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = expr[i++] === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  assert.equal(i, expr.length, `trailing input in ${expr.slice(i, i + 20)}`);
  return v;
}

/** What zoompan computes for output frame `on`: zoom first, then x and y with `zoom` set. */
function zoompanAt(exprs, on, iw, ih) {
  const zoom = evaluate(exprs.z, { on });
  return { zoom, x: evaluate(exprs.x, { on, iw, ih, zoom }), y: evaluate(exprs.y, { on, iw, ih, zoom }) };
}

test("normalizeTimeline drops bad entries, sorts by time and fills defaults", () => {
  const tl = normalizeTimeline({
    viewport: { width: 0 },
    duration: 2,
    frames: [{ file: "b.jpg", t: 3 }, { file: "a.jpg", t: 1 }, { file: "", t: 2 }, { t: 1 }, { file: "c.jpg", t: Number.NaN }],
    steps: [{ title: "Later", t0: 5, t1: 4 }, { title: "First", t0: 1 }, { t0: 2 }],
    actions: [{ kind: "click", t0: 2, rect: { x: 0, y: 0, w: 0, h: 10 } }],
    busy: [{ t: 1, on: "yes" }, { t: 2, on: false, rect: { x: 1, y: 2, w: 3, h: 4 } }],
  });
  assert.deepEqual(tl.viewport, { width: 1280, height: 720 });
  assert.deepEqual(tl.frames.map((f) => f.file), ["a.jpg", "b.jpg"]);
  assert.equal(tl.duration, 3, "the duration covers the last frame");
  assert.deepEqual(tl.steps.map((s) => [s.title, s.t0, s.t1, s.depth]), [["First", 1, 1, 0], ["Later", 5, 5, 0]]);
  assert.equal(tl.actions[0].rect, null, "a rect with no area is dropped");
  assert.deepEqual(tl.busy, [{ t: 2, on: false, rect: { x: 1, y: 2, w: 3, h: 4 } }]);
  assert.deepEqual(tl.activity, []);
});

test("with no idle time the edit is the recording at 1x", () => {
  const tl = timeline({ duration: 6, actions: [click(1.2), click(2.4), click(3.6), click(4.6)] });
  const edit = planEdit(tl);
  assert.equal(edit.segments.length, 1);
  assert.deepEqual([edit.segments[0].src0, edit.segments[0].src1, edit.segments[0].speed], [0, 6, 1]);
  assert.equal(edit.frames, 180);
  assert.equal(edit.seconds, 6);
  assert.equal(edit.compressedSeconds, 0);
  assert.deepEqual(edit.badges, []);
  assert.equal(srcAt(edit, 2.5), 2.5);
  assert.equal(outAt(edit, 2.5), 2.5);
});

test("a long model wait is sped up with an honest badge, and actions and results stay at 1x", () => {
  // Click at 2 s, the result appears at 16.5 s, the test ends at 20 s.
  const tl = timeline({
    duration: 20,
    actions: [click(2)],
    busy: [{ t: 2.1, on: true, rect: { x: 100, y: 100, w: 500, h: 300 } }, { t: 16.5, on: false, rect: { x: 100, y: 100, w: 500, h: 300 } }],
  });
  const edit = planEdit(tl);
  // Protected: 0-1 head, 1.6-2.85 the click, 16.3-18.9 the reveal, 17.5-20 tail. Idle: 1-1.6 (short) and 2.85-16.3.
  const sped = edit.segments.filter((g) => g.speed > 1);
  assert.equal(sped.length, 1);
  const idle = 16.3 - 2.85;
  assert.ok(close(sped[0].src0, 2.85) && close(sped[0].src1, 16.3));
  assert.ok(close(sped[0].out1 - sped[0].out0, 1.4), "min(1.4, 0.5 + 0.1 * 13.45) = 1.4 s");
  assert.ok(close(edit.compressedSeconds, idle, 1e-3));
  assert.equal(edit.badges.length, 1);
  // The model was busy from 2.1 s to 16.5 s: the badge gives that real wait, 14.4 s, rounded up.
  assert.equal(edit.badges[0].seconds, 15);
  assert.equal(edit.badges[0].text, "Waited 15 s, sped up");
  assert.ok(close(edit.badges[0].show1, edit.badges[0].out1 + RULES.badgeLinger));
  // With no aria-busy around it, the badge gives the time from the end of the click to the result: 14.45 s is 15.
  const quiet = planEdit(timeline({ duration: 20, actions: [click(2)], busy: [{ t: 16.5, on: false, rect: null }] }));
  assert.equal(quiet.badges[0].text, "Waited 15 s, sped up");
  // With nothing before it to start the wait, the badge gives the sped-up stretch itself.
  const alone = planEdit(timeline({ duration: 20, busy: [{ t: 16.5, on: false, rect: null }] }));
  assert.deepEqual(alone.badges.map((b) => b.text), ["Waited 16 s, sped up"], "1 s to 16.3 s is 15.3 s, rounded up");
  // Every protected moment plays at real speed.
  for (const s of [0.5, 2, 2.8, 16.4, 18, 19.9]) {
    const seg = edit.segments.find((g) => s >= g.src0 && s <= g.src1 && g.speed > 0);
    assert.equal(seg.speed, 1, `source ${s} s plays at 1x`);
  }
  assert.ok(edit.seconds < 20 - idle + 1.4 + 3.01, "about 13 s shorter, plus at most the held last frame");
});

test("a loading state plays for a second at real speed, and the badge gives the whole wait", () => {
  // As recorded in the sandbox demo: the click ends at 5.32 s, the button and the result section show they are
  // working (aria-busy on), and the result arrives 7 s later.
  const busyRect = { x: 176, y: 570, w: 928, h: 71 };
  const tl = timeline({
    duration: 14.5,
    actions: [click(1.5), click(3), { kind: "click", t0: 4.58, t1: 5.32, rect: { x: 201, y: 483, w: 183, h: 47 }, label: "Count" }],
    activity: [
      { t: 5.322, added: 1, changed: 5, rect: { x: 201, y: 595, w: 878, h: 21 } },
      { t: 12.327, added: 39, changed: 7, rect: { x: 201, y: 120, w: 878, h: 458 } },
    ],
    busy: [{ t: 5.322, on: true, rect: busyRect }, { t: 12.327, on: false, rect: { x: 176, y: 95, w: 928, h: 507 } }],
  });
  const reveals = findReveals(tl);
  assert.deepEqual(reveals.map((r) => [r.t, r.loading, r.frame]), [[5.322, true, false], [12.327, false, true]]);
  const edit = planEdit(tl);
  const sped = edit.segments.filter((g) => g.speed > 1);
  assert.equal(sped.length, 1);
  // The click is protected to 6.12 s and the loading state to 6.322 s, not 7.722 s. The last 2.5 s start at 12 s.
  assert.ok(close(sped[0].src0, 5.322 + RULES.loadingAfter) && close(sped[0].src1, 12));
  // The sped-up stretch is 5.7 s, but the model was busy for 7.005 s, and only 1.3 s of that played at 1x.
  assert.equal(edit.badges.length, 1);
  assert.equal(edit.badges[0].text, "Waited 7 s, sped up");
});

test("a busy span that mostly played at real speed, or holds two waits, isn't the badge's number", () => {
  // Busy from 2 s to 30 s, with a burst of activity at 12 s that keeps 11.8 to 14.4 s at real speed.
  const tl = timeline({
    duration: 34,
    actions: [click(1.9)],
    activity: [{ t: 12, added: 6, changed: 0, rect: { x: 100, y: 100, w: 400, h: 200 } }],
    busy: [{ t: 2, on: true, rect: null }, { t: 30, on: false, rect: null }],
  });
  const edit = planEdit(tl);
  assert.equal(edit.badges.length, 2);
  // The busy span holds both waits, so neither badge gives it. The first gives the click to the first activity, 1.95 to
  // 12 s. The second has only that same click before it, too long ago, so it gives its own stretch, 14.4 to 29.8 s.
  assert.deepEqual(edit.badges.map((b) => b.text), ["Waited 10 s, sped up", "Waited 16 s, sped up"]);
});

test("a small change right after an action is the page answering it, not a result to frame", () => {
  const upload = { kind: "upload", t0: 2.2, t1: 3.5, rect: { x: 214, y: 302, w: 145, h: 44 }, label: "Photo", fileName: "a.png" };
  const tl = timeline({
    duration: 12,
    actions: [upload],
    activity: [
      // The file name next to the picker.
      { t: 3.52, added: 0, changed: 7, rect: { x: 373, y: 313, w: 74, h: 22 } },
      // A preview card that appears later.
      { t: 6, added: 5, changed: 0, rect: { x: 600, y: 200, w: 300, h: 200 } },
    ],
  });
  const reveals = findReveals(tl);
  assert.deepEqual(reveals.map((r) => [r.t, r.frame]), [[3.52, false], [6, true]]);
  // A big result that appears as soon as a button is clicked is still framed.
  const instant = timeline({
    duration: 12,
    actions: [click(2)],
    activity: [{ t: 2.06, added: 12, changed: 0, rect: { x: 200, y: 150, w: 700, h: 400 } }],
  });
  assert.equal(findReveals(instant)[0].frame, true);
});

test("idle time is never sped up more than 16x, and short gaps stay at 1x", () => {
  assert.ok(close(idleOutputSeconds(40), 2.5), "40 s at 16x");
  assert.ok(close(idleOutputSeconds(10), 1.4));
  assert.ok(close(idleOutputSeconds(5), 1.0));
  const tl = timeline({ duration: 60, actions: [click(2), click(4.05), click(56)] });
  const edit = planEdit(tl);
  // 2.85-3.65 is a 0.8 s gap between two protected clicks: it stays at 1x.
  assert.equal(edit.segments.find((g) => g.src0 <= 3.2 && g.src1 >= 3.2).speed, 1);
  const long = edit.segments.find((g) => g.speed > 1);
  assert.ok(long.speed <= RULES.maxSpeed + 1e-9);
  assert.ok(close(long.speed, RULES.maxSpeed), `a ${(long.src1 - long.src0).toFixed(1)} s wait hits the 16x limit`);
});

test("past 70 s the 1.0 to 1.6 s gaps are sped up too", () => {
  // Each click is protected from 0.4 s before to 0.85 s after, so clicks every 2.5 s leave 1.25 s gaps, which only
  // the length cap speeds up.
  const actions = [];
  for (let t = 1; t < 100; t += 2.5) actions.push(click(t));
  const tl = timeline({ duration: 101, actions });
  const loose = planEdit(tl, { maxSeconds: 1000 });
  assert.equal(loose.capped, false);
  assert.ok(loose.seconds > 70);
  assert.ok(loose.segments.every((g) => g.speed <= 1), "1.25 s gaps are under the 1.6 s threshold");
  const capped = planEdit(tl);
  assert.equal(capped.capped, true);
  assert.ok(capped.seconds < loose.seconds - 20, `${capped.seconds} s after the cap`);
  const gap = capped.segments.find((g) => g.speed > 1);
  assert.ok(close(gap.src1 - gap.src0, 1.25) && close(gap.out1 - gap.out0, 0.625), "a 1.25 s gap plays in 0.625 s");
  assert.deepEqual(capped.badges, [], "gaps under 3 s get no badge");
});

test("the frame plan shows, for each output frame, the last source frame at or before its time", () => {
  const tl = timeline({ duration: 20, frameEvery: 0.25, actions: [click(2)], busy: [{ t: 16.5, on: false, rect: null }] });
  const edit = planEdit(tl);
  const total = edit.runs.reduce((n, r) => n + r.count, 0);
  assert.equal(total, edit.frames);
  let n = 0;
  for (const r of edit.runs) {
    assert.equal(r.start, n);
    for (let k = 0; k < r.count; k++, n++) {
      const src = srcAt(edit, n / FPS);
      const expected = tl.frames.findLastIndex((f) => f.t <= src + 1e-6);
      assert.equal(r.frame, Math.max(0, expected), `output frame ${n}`);
    }
    assert.equal(r.file, tl.frames[r.frame].file);
  }
  for (let i = 1; i < edit.runs.length; i++) assert.notEqual(edit.runs[i].frame, edit.runs[i - 1].frame, "runs are merged");
});

test("the basic cut plays everything at 1x with no badges", () => {
  const tl = timeline({ duration: 20, actions: [click(2)], busy: [{ t: 16.5, on: false, rect: null }] });
  const edit = planEdit(tl, { speedUp: false });
  assert.equal(edit.seconds, 20);
  assert.deepEqual(edit.badges, []);
  assert.equal(edit.tailHold, 0);
});

test("reveals are activity bursts or aria-busy turning off, and loading states and typing echoes aren't framed", () => {
  const tl = timeline({
    duration: 20,
    actions: [type(2, 3.5)],
    activity: [
      { t: 2.5, added: 0, changed: 6, rect: { x: 200, y: 300, w: 400, h: 44 } },
      { t: 5, added: 2, changed: 0, rect: { x: 0, y: 0, w: 10, h: 10 } },
      { t: 6, added: 4, changed: 0, rect: { x: 100, y: 100, w: 50, h: 50 } },
      { t: 9, added: 2, changed: 0, rect: { x: 100, y: 100, w: 50, h: 50 } },
      { t: 9.3, added: 2, changed: 0, rect: { x: 300, y: 300, w: 50, h: 50 } },
    ],
    busy: [{ t: 6.1, on: true, rect: null }, { t: 12, on: false, rect: { x: 10, y: 20, w: 30, h: 40 } }],
  });
  const reveals = findReveals(tl);
  assert.deepEqual(
    reveals.map((r) => [r.t, r.frame]),
    [[2.5, false], [6, false], [9, true], [12, true]],
  );
  assert.deepEqual(reveals[2].rect, { x: 100, y: 100, w: 250, h: 250 }, "records less than 0.4 s apart are one burst");
  assert.equal(reveals[3].weight, 0);
});

test("the camera moves in as the cursor heads to a field and frames it until 0.6 s after typing", () => {
  const tl = timeline({ duration: 12, actions: [type(3, 5, { x: 200, y: 300, w: 400, h: 44 })] });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 1);
  const [s] = cam.shots;
  assert.equal(s.kind, "type");
  // 400x44 padded by 120 is 640x284: min(1280 / 640, 720 / 284) = 2, held to 1.8.
  assert.equal(s.z, 1.8);
  // t0 is when the cursor starts gliding there, so the camera arrives as typing starts.
  assert.ok(close(s.in0, outAt(edit, 3)) && close(s.hold0, s.in0 + RULES.ease) && close(s.hold1, outAt(edit, 5.6)));
  assert.ok(close(s.cx, 400 / 1280, 1e-4) && close(s.cy, 322 / 720, 1e-4));
  assert.deepEqual(cameraAt(cam.keys, s.in0 - 0.01, 1280, 720).z, 1);
  assert.ok(close(cameraAt(cam.keys, s.hold0, 1280, 720).z, 1.8));
  assert.ok(close(cameraAt(cam.keys, (s.in0 + s.hold0) / 2, 1280, 720).z, 1.4), "halfway through the smoothstep");
  assert.ok(close(cameraAt(cam.keys, s.hold1 + RULES.ease, 1280, 720).z, 1));
  // A wide field gets the lowest typing zoom.
  const wide = timeline({ duration: 12, actions: [type(3, 5, { x: 40, y: 300, w: 1200, h: 200 })] });
  assert.equal(planCamera(wide, planEdit(wide)).shots[0].z, 1.25);
  // A field the recorder couldn't measure comes as the whole viewport: no shot.
  const unmeasured = timeline({ duration: 12, actions: [type(3, 5, { x: 0, y: 0, w: 1280, h: 720 })] });
  assert.deepEqual(planCamera(unmeasured, planEdit(unmeasured)).shots, []);
});

test("the camera frames what appeared, unless it covers most of the screen", () => {
  const busy = (rect) => [{ t: 3, on: true, rect }, { t: 14, on: false, rect }];
  const small = timeline({ duration: 20, actions: [click(2)], busy: busy({ x: 700, y: 200, w: 400, h: 300 }) });
  const edit = planEdit(small);
  const cam = planCamera(small, edit);
  assert.equal(cam.shots.length, 1);
  const [s] = cam.shots;
  assert.equal(s.kind, "reveal");
  // 400x300 padded by 64 is 528x428: min(1280 / 528, 720 / 428) = 1.68, held to 1.6.
  assert.equal(s.z, 1.6);
  assert.ok(close(s.in0, outAt(edit, 14)));
  assert.ok(close(s.hold1 - s.hold0, RULES.revealHold));
  assert.ok(close(cam.poster, s.hold0 + 1.25), "the poster is the result, framed");

  const big = timeline({ duration: 20, actions: [click(2)], busy: busy({ x: 0, y: 0, w: 1200, h: 600 }) });
  const bigCam = planCamera(big, planEdit(big));
  assert.deepEqual(bigCam.shots, []);
  assert.ok(close(bigCam.poster, outAt(planEdit(big), 14) + 1.2), "no shot: just after it appears");
});

test("the poster is 60% of the way through when nothing appeared", () => {
  const tl = timeline({ duration: 10, actions: [click(2), click(5)] });
  const edit = planEdit(tl);
  assert.ok(close(planCamera(tl, edit).poster, edit.seconds * 0.6, 1e-3));
});

test("targets less than 1.5 s apart share one shot of their union", () => {
  // Clicks between the fields keep everything at 1x, so output time is source time.
  const tl = timeline({
    duration: 16,
    actions: [
      type(2, 3, { x: 100, y: 100, w: 300, h: 40 }),
      type(4, 5, { x: 100, y: 200, w: 300, h: 40 }),
      click(6.5),
      click(8),
      type(10, 11, { x: 800, y: 500, w: 300, h: 40 }),
      click(12.5),
    ],
  });
  const edit = planEdit(tl);
  assert.equal(edit.segments.length, 1);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 2, "the first two merge, the third is 4.8 s later");
  const [a, b] = cam.shots;
  assert.ok(close(a.hold0, 2.7) && close(a.hold1, 5.9), "from the first field's typing to the minimum hold after the second");
  // The union of the padded fields is x -20..520, y -20..360: 540x380, so min(1280 / 540, 720 / 380) = 1.89 -> 1.8.
  assert.equal(a.z, 1.8);
  // Its center, 250, 170, is moved in to 355.6, 200 so the 711x400 crop stays inside the frame.
  assert.ok(close(a.cx, 1 / 3.6, 1e-4) && close(a.cy, 1 / 3.6, 1e-4), "centered on the union, then kept in the frame");
  assert.equal(b.kind, "type");
  // Between them the camera returns to zoom 1, since there is time to rest there.
  assert.equal(cameraAt(cam.keys, (a.hold1 + RULES.ease + b.in0) / 2, 1280, 720).z, 1);
});

test("every shot holds at least 1.2 s and the last 1.5 s are at zoom 1", () => {
  const tl = timeline({ duration: 9, actions: [type(2, 2.1), type(6.6, 7.2)] });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  for (const s of cam.shots) assert.ok(s.hold1 - s.hold0 >= RULES.minHold - 1e-9);
  const end = edit.seconds;
  for (let t = end - RULES.endRest; t <= end; t += 1 / FPS) assert.equal(cameraAt(cam.keys, t, 1280, 720).z, 1);
});

test("the crop stays inside the frame near the edges, in the plan and in zoompan's expressions", () => {
  // Two fields in opposite corners, less than 1.5 s apart: their union doesn't fit, so the second shot follows.
  const tl = timeline({
    duration: 14,
    actions: [type(2, 4, { x: 1180, y: 680, w: 100, h: 40 }), type(4.5, 6, { x: 0, y: 0, w: 80, h: 30 })],
  });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 2, "close in time, but too far apart to frame together");
  const [br, tl0] = cam.shots;
  assert.ok(close(br.hold1, 4.1), "the first leaves as the cursor heads to the second field");
  assert.ok(close(br.cx, 1 - 1 / (2 * br.z), 1e-4) && close(br.cy, 1 - 1 / (2 * br.z), 1e-4), "bottom-right corner");
  assert.ok(close(tl0.cx, 1 / (2 * tl0.z), 1e-4) && close(tl0.cy, 1 / (2 * tl0.z), 1e-4), "top-left corner");
  assert.ok(tl0.hold0 - br.hold1 < 2 * RULES.ease + RULES.restMin);
  for (let t = br.hold0; t <= tl0.hold0; t += 0.05) assert.ok(cameraAt(cam.keys, t, 1280, 720).z > 1.2, "it moves straight across");
  const exprs = zoompanExpressions(cam.keys);
  const [iw, ih] = [2560, 1440];
  for (let on = 0; on < edit.frames; on++) {
    const c = cameraAt(cam.keys, on / FPS, iw, ih);
    assert.ok(c.x >= 0 && c.x <= iw - iw / c.z + 1e-6 && c.y >= 0 && c.y <= ih - ih / c.z + 1e-6, `frame ${on}`);
    const z = zoompanAt(exprs, on, iw, ih);
    assert.ok(z.x >= 0 && z.x <= iw - iw / z.zoom + 1e-6 && z.y >= 0 && z.y <= ih - ih / z.zoom + 1e-6, `expression, frame ${on}`);
  }
});

test("a scroll during a shot ends it, and a click outside the view starts the zoom out", () => {
  const field = { x: 200, y: 300, w: 400, h: 44 };
  const scrolled = timeline({ duration: 12, actions: [type(2, 4.5, field)], scrolls: [{ t: 4, y: 300 }] });
  const s1 = planCamera(scrolled, planEdit(scrolled)).shots[0];
  assert.ok(s1.cut && close(s1.hold1, 4), "ends when the page scrolls under it");

  const clicked = timeline({ duration: 12, actions: [type(2, 4.5, field), click(4.8, { x: 1100, y: 650, w: 100, h: 40 })] });
  const s2 = planCamera(clicked, planEdit(clicked)).shots[0];
  assert.ok(close(s2.hold1, 4.4), "leaves 0.4 s before the click, as the cursor heads there");

  const near = timeline({ duration: 12, actions: [type(2, 4.5, field), click(4.8, { x: 220, y: 380, w: 120, h: 40 })] });
  const s3 = planCamera(near, planEdit(near)).shots[0];
  assert.ok(close(s3.hold1, 4.85 + RULES.typeAfter), "a click inside the view doesn't end the shot, which holds through it");
});

test("a close-up never holds while the cursor works outside it", () => {
  const field = { x: 200, y: 200, w: 400, h: 44 };
  // Typing ends at 3 s and the cursor leaves for a far corner at 3.1 s, before the shot could hold 1.2 s: no shot.
  const far = timeline({ duration: 14, actions: [type(2, 3, field), click(3.1, { x: 1100, y: 650, w: 100, h: 40 })] });
  assert.deepEqual(planCamera(far, planEdit(far)).shots, []);
  // A button just past the field's edge is taken into the shot, so the cursor stays in view.
  const button = { x: 700, y: 230, w: 120, h: 44 };
  const near = timeline({ duration: 14, actions: [type(2, 3, field), click(3.1, button)] });
  const [s] = planCamera(near, planEdit(near)).shots;
  assert.ok(s, "the shot is kept");
  const box = { x: s.cx * 1280 - 640 / s.z, y: s.cy * 720 - 360 / s.z, w: 1280 / s.z, h: 720 / s.z };
  for (const r of [field, button]) {
    assert.ok(r.x >= box.x - 1 && r.y >= box.y - 1 && r.x + r.w <= box.x + box.w + 1 && r.y + r.h <= box.y + box.h + 1, JSON.stringify(r));
  }
  // An action that starts while the camera is still moving in counts too.
  const result = { x: 100, y: 80, w: 300, h: 120 };
  const moving = timeline({
    duration: 16,
    actions: [click(2), { kind: "select", t0: 8.3, t1: 8.8, rect: { x: 900, y: 600, w: 300, h: 44 }, label: "Size" }],
    busy: [{ t: 2.1, on: true, rect: null }, { t: 8, on: false, rect: result }],
  });
  assert.deepEqual(planCamera(moving, planEdit(moving)).shots, []);
});

test("a result that appears just before the end gets its shot from a held last frame", () => {
  const tl = timeline({
    duration: 12,
    actions: [click(2)],
    busy: [{ t: 2.1, on: true, rect: null }, { t: 10.5, on: false, rect: { x: 300, y: 200, w: 500, h: 250 } }],
  });
  const edit = planEdit(tl);
  assert.ok(edit.tailHold > 0);
  const last = edit.segments[edit.segments.length - 1];
  assert.deepEqual([last.speed, last.src0, last.src1], [0, 12, 12]);
  assert.equal(srcAt(edit, edit.seconds - 0.01), 12);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 1);
  assert.ok(cam.shots[0].hold1 - cam.shots[0].hold0 >= RULES.minHold);
  assert.equal(edit.runs[edit.runs.length - 1].frame, tl.frames.length - 1);
});

test("zoompan's expressions compute the same camera as the plan", () => {
  const tl = timeline({
    duration: 30,
    actions: [type(2, 4, { x: 900, y: 80, w: 300, h: 40 }), click(5), type(12, 13, { x: 100, y: 600, w: 300, h: 40 })],
    busy: [{ t: 5.1, on: true, rect: null }, { t: 20, on: false, rect: { x: 700, y: 300, w: 400, h: 200 } }],
  });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.ok(cam.shots.length >= 3);
  const exprs = zoompanExpressions(cam.keys);
  assert.ok(!/[^a-z0-9.+\-*/(),_]/.test(exprs.z + exprs.x + exprs.y), "only characters ffmpeg's evaluator takes, no exponents");
  const [iw, ih] = [2560, 1440];
  for (let on = 0; on < edit.frames; on++) {
    const want = cameraAt(cam.keys, on / FPS, iw, ih);
    const got = zoompanAt(exprs, on, iw, ih);
    assert.ok(close(got.zoom, want.z, 1e-9) && close(got.x, want.x, 1e-6) && close(got.y, want.y, 1e-6), `frame ${on}`);
  }
});

test("piecewise functions hold before the first key and after the last, and ease in between", () => {
  const points = [[1, 2], [2, 2], [3, 4], [5, 4], [6, 0]];
  const at = (t) => piecewiseAt(points, t);
  assert.equal(at(0), 2);
  assert.equal(at(1.5), 2);
  assert.equal(at(2.5), 3);
  assert.ok(at(2.25) < 2.5, "smoothstep starts slowly");
  assert.equal(at(4), 4);
  assert.equal(at(5.5), 2);
  assert.equal(at(9), 0);
  for (let t = 0; t <= 7; t += 0.05) assert.ok(close(evaluate(piecewiseExpr(points, "t"), { t }), at(t), 1e-9), `t=${t}`);
  assert.equal(piecewiseExpr([[0, 1]], "t"), "1");
});

test("captions follow the top-level steps in output time", () => {
  const tl = timeline({
    duration: 40,
    actions: [click(3)],
    busy: [{ t: 30, on: false, rect: null }],
    steps: [
      { title: "Open the app", t0: 0.2, t1: 2, depth: 0 },
      { title: "  ", t0: 2, t1: 2.1, depth: 0 },
      { title: "Upload a photo \u2014 any photo", t0: 2.1, t1: 10, depth: 0 },
      { title: "inner", t0: 3, t1: 4, depth: 1 },
      { title: "Upload a photo \u2014 any photo", t0: 10, t1: 12, depth: 0 },
      { title: "Check it", t0: 12, t1: 28.5, depth: 0 },
      { title: "Blink", t0: 28.5, t1: 28.7, depth: 0 },
      { title: "See the result", t0: 29, t1: 40, depth: 0 },
    ],
  });
  const edit = planEdit(tl);
  const caps = planCaptions(tl, edit);
  assert.deepEqual(
    caps.map((c) => [c.index, c.count, c.text]),
    [[1, 4, "Open the app"], [2, 4, "Upload a photo, any photo"], [3, 4, "Check it"], [4, 4, "See the result"]],
  );
  assert.ok(close(caps[0].out0, outAt(edit, 0.2), 1e-3));
  assert.equal(caps[0].out1, caps[1].out0, "each caption stays up until the next one");
  assert.ok(close(caps[1].out1, outAt(edit, 12), 1e-3), "identical neighbours are one caption");
  assert.ok(close(caps[2].out1, outAt(edit, 29), 1e-3), "the 0.5 s Blink step was dropped into the one before");
  assert.ok(close(caps[3].out1, edit.seconds - RULES.captionEnd, 1e-3), "the last one is gone before the outro");
});

test("caption text is cut to about two lines at a word", () => {
  const long = "Find every receipt line item and total, then sort them by category so the monthly budget shows where the money went last week";
  const text = captionText(long);
  assert.ok(text.length <= RULES.captionChars);
  assert.ok(text.endsWith("…"));
  assert.ok(long.startsWith(text.slice(0, -1)));
  assert.equal(captionText("Short   and\nsweet"), "Short and sweet");
});

test("a result the app scrolls into view is framed where it ended up, once the scroll is over", () => {
  // The recorder measures what appeared after window scrolling stops, so this rect is already in its final place.
  const tl = timeline({
    duration: 26,
    actions: [click(2)],
    busy: [{ t: 2.1, on: true, rect: null }, { t: 12, on: false, rect: { x: 300, y: 60, w: 600, h: 300 } }],
    scrolls: [{ t: 12.1, y: 120 }, { t: 12.3, y: 380 }, { t: 12.5, y: 500 }, { t: 12.6, y: 504 }],
  });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 1);
  const [s] = cam.shots;
  assert.ok(close(s.in0, outAt(edit, 12.6)), "moves in once the page stops scrolling");
  assert.ok(!s.cut, "the scroll that brought it into view doesn't end the shot");
  // 600x300 padded by 64, and 28 above, is 728x392: min(1280 / 728, 720 / 392) = 1.76, held to 1.6. Centered on 600,
  // 228, just inside the frame's top.
  assert.equal(s.z, 1.6);
  assert.ok(close(s.cx, 600 / 1280, 1e-4) && close(s.cy, 228 / 720, 1e-4), "centered on the result");
});

test("a field the page scrolls to before typing is framed where it was measured, after that scroll", () => {
  // The recorder scrolls the field into view right after t0 and measures it there.
  const tl = timeline({
    duration: 14,
    actions: [type(3, 5, { x: 200, y: 300, w: 400, h: 44 }), click(9)],
    scrolls: [{ t: 3.05, y: 600 }],
  });
  const edit = planEdit(tl);
  const [s] = planCamera(tl, edit).shots;
  assert.ok(s && !s.cut);
  assert.ok(close(s.cx, 400 / 1280, 1e-4) && close(s.cy, 322 / 720, 1e-4), "centered on the field as measured");
});

test("timelines from the older recorder still read: an action was ready when it ended, and the new lists are empty", () => {
  const tl = normalizeTimeline({
    duration: 5,
    frames: [{ file: "a.jpg", t: 0 }],
    actions: [{ kind: "type", t0: 1, t1: 3, rect: { x: 0, y: 0, w: 10, h: 10 } }, { kind: "click", t0: 3, ready: 9, t1: 4, typed: "x" }],
    activity: [{ t: 1, added: 3 }],
    results: [{ t: 2, rect: { x: 1, y: 2, w: 3, h: 4 }, scrollY: 40 }, { t: "soon" }],
    viewports: [{ t: 3, width: 390, height: 844 }, { t: 4, width: 0, height: 10 }],
  });
  assert.deepEqual(tl.actions.map((a) => [a.ready, a.typed]), [[3, undefined], [4, undefined]], "ready never passes t1");
  assert.equal(tl.activity[0].text, 0);
  assert.deepEqual(tl.results, [
    { t: 2, at: 2, rect: { x: 1, y: 2, w: 3, h: 4 }, scrollY: 40, waited: null, busy: null, media: 0, heads: [], blanks: [], pressed: null },
  ]);
  assert.deepEqual(tl.viewports, [{ t: 3, width: 390, height: 844 }]);
  assert.equal(tl.column, null);
});

test("what the recorder says about each result, action and the content column is read and checked", () => {
  const head = { x: 280, y: 60, w: 720, h: 32 };
  const tl = normalizeTimeline({
    duration: 9,
    frames: [{ file: "a.jpg", t: 0 }],
    actions: [{ kind: "click", t0: 1, t1: 1.2, rect: { x: 300, y: 400, w: 120, h: 44 }, noop: true, heads: [head, { x: 0, y: 0, w: 0, h: 9 }] }],
    results: [
      {
        t: 5,
        at: 4.6,
        rect: { x: 280, y: 100, w: 720, h: 300 },
        scrollY: 200,
        waited: 4.2,
        busy: true,
        media: 2,
        heads: [head],
        blanks: "none",
        pressed: { x: 1, y: 2, w: 3, h: 4 },
      },
      { t: 7, at: 8, rect: { x: 280, y: 100, w: 720, h: 300 }, waited: -1, busy: "yes", media: Number.NaN },
    ],
    column: { x: 280, w: 720 },
  });
  assert.deepEqual(tl.actions[0].heads, [head], "a box with no area is dropped");
  assert.equal(tl.actions[0].noop, true);
  assert.deepEqual(
    tl.results.map((r) => [r.at, r.waited, r.busy, r.media, r.heads.length, r.blanks.length, r.pressed?.w ?? null]),
    [[4.6, 4.2, true, 2, 1, 0, 3], [7, 0, null, 0, 0, 0, null]],
    "a result never appears after it came on screen",
  );
  assert.deepEqual(tl.column, { x: 280, w: 720 });
  // A phone-sized recording moves every box, and the column, by its margin in the 16:9 canvas.
  const phone = normalizeTimeline({ ...structuredClone(tl), viewport: { width: 390, height: 844 } });
  const { tl: boxed, box } = letterbox(phone);
  assert.equal(boxed.column.x, 280 + box.x);
  assert.equal(boxed.results[0].heads[0].x, 280 + box.x);
  assert.equal(boxed.results[0].pressed.x, 1 + box.x);
  assert.equal(boxed.actions[0].heads[0].x, 280 + box.x);
});

test("an echo plays a second at real speed, and without aria-busy the badge counts from the click to the answer", () => {
  // The button says it is working right after the click, and the answer comes 7 s later, with no aria-busy anywhere.
  const button = { x: 600, y: 400, w: 160, h: 44 };
  const tl = timeline({
    duration: 16,
    actions: [click(2, button)],
    activity: [
      { t: 2.06, added: 0, changed: 6, text: 19, rect: { x: 600, y: 400, w: 160, h: 44 } },
      { t: 9.05, added: 14, changed: 0, text: 300, rect: { x: 200, y: 200, w: 800, h: 300 } },
    ],
  });
  const [echo, answer] = findReveals(tl);
  assert.deepEqual([echo.echo, echo.frame, answer.echo, answer.frame], [true, false, false, true]);
  const edit = planEdit(tl);
  const sped = edit.segments.filter((g) => g.speed > 1);
  // The click is protected to 2.85 s and its echo only to 3.06 s, not 4.46 s.
  assert.ok(close(sped[0].src0, 2.06 + RULES.loadingAfter) && close(sped[0].src1, 9.05 - RULES.revealBefore));
  // The stretch is 5.79 s; the wait from the end of the click to the answer is 7 s.
  assert.deepEqual(edit.badges.map((b) => b.text), ["Waited 7 s, sped up"]);
});

test("a small change far from the action, or a line of new text, is a result to frame", () => {
  const tl = timeline({
    duration: 12,
    actions: [click(2, { x: 600, y: 400, w: 120, h: 44 })],
    activity: [
      // One new element with a sentence in it, far from the button: "Each person pays $16.00".
      { t: 2.1, added: 1, changed: 0, text: 40, rect: { x: 100, y: 100, w: 300, h: 24 } },
      // The same right under the button is the page answering the click.
      { t: 6, added: 1, changed: 0, text: 40, rect: { x: 600, y: 450, w: 200, h: 20 } },
      // A few characters are nothing.
      { t: 8, added: 1, changed: 0, text: 12, rect: { x: 100, y: 300, w: 300, h: 24 } },
    ],
  });
  tl.actions.push({ kind: "click", t0: 5.5, ready: 5.95, t1: 6, rect: { x: 600, y: 400, w: 120, h: 44 }, label: "Again" });
  const reveals = findReveals(tl);
  assert.deepEqual(reveals.map((r) => [r.t, r.echo, r.frame]), [[2.1, false, true], [6, true, false]]);
});

test("what appears mostly off screen isn't framed, and a held result is framed where the recorder measured it", () => {
  const tl = timeline({
    duration: 20,
    actions: [click(2, { x: 200, y: 100, w: 160, h: 44 })],
    // The dashboard lands below the fold at 9 s: 70 of its 300 px show.
    activity: [{ t: 9, added: 30, changed: 0, text: 400, rect: { x: 200, y: 650, w: 800, h: 300 } }],
    // The recorder scrolls it into view from 10 s and holds it.
    scrolls: [{ t: 10.1, y: 300 }, { t: 10.5, y: 600 }, { t: 10.6, y: 610 }],
    results: [{ t: 10, rect: { x: 200, y: 40, w: 800, h: 300 }, scrollY: 610 }],
  });
  const [below, held] = findReveals(tl);
  assert.deepEqual([below.frame, held.frame, held.result], [false, true, true]);
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 1);
  const [s] = cam.shots;
  assert.ok(s.result && close(s.in0, outAt(edit, 10.6)), "moves in once the scroll is over");
  const box = { x: s.cx * 1280 - 640 / s.z, y: s.cy * 720 - 360 / s.z, w: 1280 / s.z, h: 720 / s.z };
  assert.ok(box.x <= 200 && box.y <= 40 && box.x + box.w >= 1000 && box.y + box.h >= 340, `the result is in view: ${JSON.stringify(box)}`);
  assert.ok(cam.poster >= s.hold0 && cam.poster <= s.hold1, "the poster is the held result, framed");
});

test("the poster is the last frame when the last held result is too big to frame", () => {
  const tl = timeline({
    duration: 14,
    actions: [click(2)],
    busy: [{ t: 2.1, on: true, rect: null }, { t: 8, on: false, rect: { x: 0, y: 0, w: 1280, h: 700 } }],
    results: [{ t: 8, rect: { x: 0, y: 0, w: 1280, h: 700 }, scrollY: 0 }],
  });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.deepEqual(cam.shots, []);
  assert.ok(close(cam.poster, edit.seconds - 1 / FPS, 1e-3));
});

test("a long wait inside an action is sped up with a badge, and the approach and the click play at real speed", () => {
  // The cursor reaches a disabled button at 2.4 s; Playwright clicks it at 10 s, when the answer enables it.
  const tl = timeline({
    duration: 14,
    actions: [click(1), { kind: "click", t0: 1.6, ready: 2.4, t1: 10, rect: { x: 400, y: 300, w: 160, h: 44 }, label: "Download" }],
  });
  const edit = planEdit(tl);
  const sped = edit.segments.filter((g) => g.speed > 1);
  assert.equal(sped.length, 1);
  assert.ok(close(sped[0].src0, 2.4 + RULES.readyAfter) && close(sped[0].src1, 10 - RULES.doneBefore));
  // From the end of the first click, 1.05 s, to the second click, 10 s.
  assert.deepEqual(edit.badges.map((b) => b.text), ["Waited 9 s, sped up"]);
});

test("a fill that drew no text gets no zoom", () => {
  const drew = (typed) => timeline({ duration: 12, actions: [{ ...type(3, 5), typed }] });
  assert.equal(planCamera(drew(0), planEdit(drew(0))).shots.length, 0, "the field already said it");
  assert.equal(planCamera(drew(9), planEdit(drew(9))).shots.length, 1);
});

test("the camera holds a shot until it has to move, so every move takes the same time", () => {
  // Typing in the top left ends its shot at 3.6 s; a result appears in the bottom right at 4.6 s, too close to rest.
  const tl = timeline({
    duration: 14,
    actions: [type(2, 3, { x: 40, y: 40, w: 300, h: 40 }), click(9.5)],
    activity: [{ t: 4.6, added: 8, changed: 0, text: 100, rect: { x: 900, y: 500, w: 300, h: 160 } }],
  });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 2);
  const [a, b] = cam.shots;
  assert.equal(a.cutBy, null);
  const at = (t) => cameraAt(cam.keys, t, 1280, 720);
  assert.ok(close(at(b.hold0 - RULES.ease - 0.01).z, a.z, 1e-6), "still on the first shot just before the move");
  assert.ok(close(at(b.hold0).z, b.z, 1e-6));
});

test("a result's crop doesn't cut through the button that asked for it", () => {
  const button = { x: 420, y: 100, w: 160, h: 44 };
  const tl = timeline({
    duration: 16,
    actions: [click(2, button)],
    busy: [{ t: 2.1, on: true, rect: null }, { t: 8, on: false, rect: { x: 400, y: 160, w: 400, h: 450 } }],
  });
  const [s] = planCamera(tl, planEdit(tl)).shots;
  const top = s.cy * 720 - 360 / s.z;
  // Centered on the padded result, the crop's top edge would sit at 132, through the button (100 to 144).
  assert.ok(top >= button.y + button.h || top <= button.y, `top edge at ${top.toFixed(1)}`);
  assert.ok(top <= 160 && top + 720 / s.z >= 610, "the result is still in view");
});

test("a recording that isn't 16:9 is fitted into a 16:9 canvas, and nothing is framed after a viewport change", () => {
  const phone = normalizeTimeline({
    viewport: { width: 390, height: 844 },
    duration: 10,
    frames: [{ file: "a.jpg", t: 0 }],
    actions: [{ kind: "type", t0: 2, t1: 4, typed: 5, rect: { x: 20, y: 300, w: 350, h: 44 }, label: "Name" }],
  });
  const { tl, box } = letterbox(phone);
  assert.ok(close(tl.viewport.width, 844 * 16 / 9, 1e-6) && tl.viewport.height === 844);
  assert.ok(close(box.x, (844 * 16 / 9 - 390) / 2, 1e-6) && box.y === 0 && box.w === 390);
  assert.ok(close(tl.actions[0].rect.x, 20 + box.x, 1e-6));
  assert.equal(planCamera(tl, planEdit(tl)).shots.length, 1);
  const same = timeline({ duration: 4 });
  assert.equal(letterbox(same).tl, same, "a 16:9 recording comes back as it is");

  const resized = timeline({ duration: 12, actions: [{ ...type(5, 7), typed: 5 }], viewports: [{ t: 4, width: 390, height: 844 }] });
  assert.deepEqual(planCamera(resized, planEdit(resized)).shots, []);
});

/** The crop a shot shows, in viewport CSS px. */
const cropOf = (s, vw = 1280, vh = 720) => ({ x: s.cx * vw - vw / (2 * s.z), y: s.cy * vh - vh / (2 * s.z), w: vw / s.z, h: vh / s.z });
const holds = (outer, r) => r.x >= outer.x - 1 && r.y >= outer.y - 1 && r.x + r.w <= outer.x + outer.w + 1 && r.y + r.h <= outer.y + outer.h + 1;
const cutBy = (y, r) => r.y < y - 2 && r.y + r.h > y + 2;

/** A model wait from a click at 2 s to a held result at 12 s, with the result's rect and whatever the test adds. */
function heldResult(rect, extra = {}) {
  return timeline({
    duration: 20,
    actions: [click(2, { x: 300, y: 660, w: 160, h: 44 })],
    busy: [{ t: 2.1, on: true, rect: null }, { t: 12, on: false, rect }],
    results: [{ t: 12, at: 12, rect, scrollY: 0, waited: 9.9, busy: true }],
    column: { x: 280, w: 720 },
    ...extra,
  });
}

test("a result is framed on the content column, showing all of it when the zoom range allows", () => {
  // A narrow result at the column's right edge, like a chart outlined on a page thumbnail.
  const rect = { x: 761, y: 149, w: 219, h: 283 };
  const [s] = planCamera(heldResult(rect), planEdit(heldResult(rect))).shots;
  assert.ok(s && s.result);
  // The column and 64 px either side: 1280 / (720 + 128) = 1.51, under the 1.6 the result alone would get.
  assert.ok(close(s.z, 1280 / 848, 1e-3), `zoom ${s.z}`);
  const crop = cropOf(s);
  assert.ok(close(crop.x + crop.w / 2, 640, 0.5), "centered on the column, not on the result");
  assert.ok(holds(crop, { x: 280, y: rect.y, w: 720, h: 10 }) && holds(crop, rect), JSON.stringify(crop));
  // Without a column from the recorder, the held results and the actions give one.
  const old = heldResult(rect, { column: undefined, actions: [click(2, { x: 280, y: 660, w: 160, h: 44 })] });
  assert.ok(close(cropOf(planCamera(old, planEdit(old)).shots[0]).x, crop.x, 1), "the same crop from an older timeline");
});

test("a short result gets the room above it, and one taller than the crop shows its top", () => {
  const short = { x: 280, y: 300, w: 720, h: 200 };
  const [s] = planCamera(heldResult(short), planEdit(heldResult(short))).shots;
  const crop = cropOf(s);
  assert.ok(close(crop.y + crop.h, short.y + short.h + RULES.revealPad, 1), "its bottom edge is the result's, padded");
  assert.ok(short.y - crop.y > crop.y + crop.h - (short.y + short.h), "more room above it than below");
  // 720x680 of a 900 px result shows: the crop starts 28 px above it instead of cutting its top.
  const tall = { x: 280, y: 40, w: 720, h: 900 };
  const [t] = planCamera(heldResult(tall), planEdit(heldResult(tall))).shots;
  assert.ok(close(cropOf(t).y, tall.y - RULES.revealPadTop, 1), `top at ${cropOf(t).y}`);
});

test("crop edges keep clear of headings and the app bar near the shot", () => {
  // Typing in a field whose crop's top edge would run through the page's h1.
  const h1 = { x: 300, y: 120, w: 600, h: 40 };
  const field = { x: 300, y: 380, w: 680, h: 44 };
  const typed = timeline({ duration: 12, actions: [{ ...type(3, 5, field), typed: 9, heads: [{ x: 0, y: 0, w: 1280, h: 56 }, h1] }] });
  const [a] = planCamera(typed, planEdit(typed)).shots;
  const ca = cropOf(a);
  assert.ok(!cutBy(ca.y, h1) && !cutBy(ca.y + ca.h, h1), `edges at ${ca.y.toFixed(0)} and ${(ca.y + ca.h).toFixed(0)}`);
  assert.ok(holds(ca, field));
  const plain = timeline({ duration: 12, actions: [{ ...type(3, 5, field), typed: 9 }] });
  assert.ok(cutBy(cropOf(planCamera(plain, planEdit(plain)).shots[0]).y, h1), "without the heading's box the edge cuts it");
  // A held result's own heading above it.
  const result = { x: 280, y: 400, w: 720, h: 150 };
  const h2 = { x: 300, y: 160, w: 400, h: 36 };
  const held = heldResult(result);
  held.results[0].heads = [h2];
  const cb = cropOf(planCamera(held, planEdit(held)).shots[0]);
  assert.ok(!cutBy(cb.y, h2) && holds(cb, result), `top at ${cb.y.toFixed(0)}`);
});

test("a click that changes nothing doesn't pull a close-up away, since the cursor stays put", () => {
  const field = { x: 200, y: 200, w: 400, h: 44 };
  const corner = { x: 1100, y: 650, w: 100, h: 40 };
  const moved = timeline({ duration: 14, actions: [type(2, 3, field), click(3.1, corner)] });
  assert.deepEqual(planCamera(moved, planEdit(moved)).shots, [], "the cursor heads off, so no close-up");
  const still = timeline({ duration: 14, actions: [type(2, 3, field), { ...click(3.1, corner), noop: true }] });
  const [s] = planCamera(still, planEdit(still)).shots;
  assert.ok(s && s.hold1 - s.hold0 >= RULES.minHold);
});

/** Two held results: A after a long model wait at 12 s, B (any of its fields) after a short one at 19 s. */
function twoResults(a, b) {
  return timeline({
    duration: 26,
    actions: [click(2, { x: 300, y: 660, w: 160, h: 44 }), click(17, { x: 300, y: 660, w: 160, h: 44 })],
    busy: [{ t: 2.1, on: true, rect: null }, { t: 12, on: false, rect: null }],
    results: [
      { t: 12, rect: { x: 280, y: 100, w: 720, h: 300 }, scrollY: 0, waited: 9.9, busy: true, ...a },
      { t: 19, rect: { x: 280, y: 300, w: 720, h: 240 }, scrollY: 0, waited: 1.9, busy: false, ...b },
    ],
    column: { x: 280, w: 720 },
  });
}
const posterShot = (tl) => {
  const cam = planCamera(tl, planEdit(tl));
  return cam.shots.findIndex((s) => cam.poster >= s.hold0 - 1e-6 && cam.poster <= s.hold1 + 1e-6);
};

test("the poster is the result that ends the longest model wait, not the last one", () => {
  const tl = twoResults({}, {});
  const cam = planCamera(tl, planEdit(tl));
  assert.equal(cam.shots.length, 2);
  assert.equal(posterShot(tl), 0, `poster at ${cam.poster}, shots ${cam.shots.map((s) => `${s.hold0}-${s.hold1}`).join(", ")}`);
  // An older timeline says nothing about waits: the aria-busy span around the first one says it.
  const old = twoResults({ waited: undefined, busy: undefined }, { waited: undefined, busy: undefined });
  assert.equal(posterShot(old), 0);
});

test("of results waited about as long for, the poster takes one with pictures, then the biggest", () => {
  // B waited 8 s, at least 3/4 of A's 9.9 s, from an aria-busy section too.
  assert.equal(posterShot(twoResults({}, { waited: 8, busy: true })), 0, "same standing: the bigger one");
  assert.equal(posterShot(twoResults({}, { waited: 8, busy: true, media: 1 })), 1, "the one with a picture");
  assert.equal(posterShot(twoResults({}, { waited: 5, busy: true, media: 1 })), 0, "a picture doesn't beat a much longer wait");
});

test("the poster passes over an empty field in the frame, and a form the test just used", () => {
  const blank = { x: 300, y: 420, w: 680, h: 104 };
  assert.equal(posterShot(twoResults({ blanks: [blank] }, { waited: 9.9, busy: true })), 1, "A's frame holds an empty field");
  assert.equal(posterShot(twoResults({ blanks: [blank] }, { blanks: [blank] })), 0, "with no frame free of one, the best stands");
  // No model in sight: B is the bigger, but it is the form whose button was just pressed.
  const quick = { waited: 0.5, busy: false };
  assert.equal(posterShot(twoResults({ ...quick, rect: { x: 280, y: 100, w: 720, h: 200 } }, quick)), 1);
  const form = { ...quick, pressed: { x: 300, y: 480, w: 160, h: 44 } };
  assert.equal(posterShot(twoResults({ ...quick, rect: { x: 280, y: 100, w: 720, h: 200 } }, form)), 0);
});

test("captions change without two texts on screen together, on a pill that never blinks out", () => {
  const caps = [
    { out0: 0.5, out1: 4 },
    { out0: 4, out1: 9 },
    { out0: 9, out1: 12 },
  ];
  const layers = captionLayers(caps, 0.25);
  // Every pill under every text, so a pill fading in never covers the text fading out.
  assert.deepEqual(
    layers.map((l) => [l.index, l.part, l.from, l.to, l.fadeIn, l.fadeOut]),
    [
      [0, "pill", 0.5, 4.15, 0.25, 0.15],
      [1, "pill", 3.85, 9.15, 0.15, 0.15],
      [2, "pill", 8.85, 12, 0.15, 0.25],
      [0, "text", 0.5, 4, 0.25, 0.15],
      [1, "text", 4, 9, 0.15, 0.15],
      [2, "text", 9, 12, 0.15, 0.25],
    ],
  );
  const alpha = (l, t) => (t < l.from || t > l.to ? 0 : Math.min(1, (t - l.from) / l.fadeIn, (l.to - t) / l.fadeOut));
  for (let t = 0.75; t <= 11.75; t += 0.01) {
    const texts = layers.filter((l) => l.part === "text" && alpha(l, t) > 1e-9);
    assert.ok(texts.length <= 1, `two texts at ${t.toFixed(2)} s`);
    assert.ok(Math.max(...layers.filter((l) => l.part === "pill").map((l) => alpha(l, t))) > 1 - 1e-9, `no full pill at ${t.toFixed(2)} s`);
  }
});

test("of two caption pills that meet, the wider is on top, so the narrower never shows inside it", () => {
  // A narrower second step, as in a sandbox run where "2 of 3" and the end of the first title stuck out of the new pill.
  const caps = [
    { out0: 0.5, out1: 4, w: 900 },
    { out0: 4, out1: 9, w: 560 },
    { out0: 9, out1: 12, w: 1100 },
  ];
  const layers = captionLayers(caps, 0.25);
  assert.deepEqual(
    layers.map((l) => `${l.part} ${l.index}`),
    ["pill 1", "pill 0", "pill 2", "text 0", "text 1", "text 2"],
  );
  const above = (a, b) => layers.findIndex((l) => l.part === "pill" && l.index === a) > layers.findIndex((l) => l.part === "pill" && l.index === b);
  assert.ok(above(0, 1) && above(2, 1), "the wider of each pair that meets is above");
});

/** A model wait from a click at 1.1 s to a picture that appeared at 8 s half below the fold, scrolled into view at 9.1 s. */
function scrolledResult() {
  return timeline({
    duration: 16,
    actions: [click(1.1, { x: 300, y: 422, w: 140, h: 44 })],
    busy: [
      { t: 2, on: true, rect: { x: 300, y: 422, w: 175, h: 44 } },
      { t: 2, on: true, rect: { x: 300, y: 600, w: 680, h: 300 } },
      { t: 8, on: false, rect: { x: 300, y: 422, w: 140, h: 44 } },
      { t: 8, on: false, rect: { x: 300, y: 600, w: 680, h: 300 } },
    ],
    activity: [{ t: 8, added: 5, changed: 11, text: 19, rect: { x: 300, y: 523, w: 681, h: 438 } }],
    scrolls: [{ t: 9.2, y: 1 }, { t: 9.33, y: 180 }, { t: 9.44, y: 372 }, { t: 9.64, y: 382 }],
    results: [{ t: 9.12, at: 8, rect: { x: 280, y: 121, w: 720, h: 479 }, scrollY: 382, waited: 6, busy: true, media: 1 }],
    column: { x: 280, w: 720 },
  });
}

test("a result the recorder scrolled to is framed where it was held, not where it appeared", () => {
  // The shape of a sandbox run's coloring page: framing where it appeared cut the page off at the wheels.
  const tl = scrolledResult();
  const [appeared, held] = findReveals(tl);
  assert.deepEqual([appeared.frame, held.frame, held.result], [false, true, true]);
  const cam = planCamera(tl, planEdit(tl));
  assert.equal(cam.shots.length, 1);
  const [s] = cam.shots;
  assert.ok(s.result && holds(cropOf(s), { x: 280, y: 121, w: 720, h: 479 }), JSON.stringify(cropOf(s)));
  assert.ok(cam.poster >= s.hold0 && cam.poster <= s.hold1, "the poster is the held page, framed");
});

test("a held result taller than the screen gets a shot that shows its top", () => {
  // The recorder brings a tall result's top to 12% of the screen, so 634 of 720 px show 720x2600 of it.
  const tall = { x: 280, y: 86, w: 720, h: 2600 };
  const tl = heldResult(tall);
  assert.ok(findReveals(tl).find((r) => r.result).frame);
  const [s] = planCamera(tl, planEdit(tl)).shots;
  assert.ok(s && s.result, "it gets a shot");
  // Near the crop's top: 28 px of room, or more to keep the bottom edge off the button that asked for it.
  const crop = cropOf(s);
  assert.ok(crop.y <= tall.y && tall.y - crop.y <= 0.2 * crop.h, `top at ${crop.y}`);
});

test("a poster from a shot that began before its result shows the result, a second after it is in view", () => {
  // One shot frames typing a note and the note it adds, so 1.5 s into it the note wasn't there yet.
  const tl = timeline({
    duration: 8,
    actions: [type(0.1, 1.6, { x: 300, y: 160, w: 620, h: 42 }), click(1.65, { x: 300, y: 221, w: 80, h: 44 })],
    activity: [{ t: 2.3, added: 3, changed: 1, text: 47, rect: { x: 300, y: 316, w: 680, h: 55 } }],
    results: [{ t: 2.3, at: 2.3, rect: { x: 300, y: 316, w: 680, h: 55 }, scrollY: 0, waited: 0, busy: false }],
    column: { x: 280, w: 720 },
  });
  const edit = planEdit(tl);
  const cam = planCamera(tl, edit);
  assert.equal(cam.shots.length, 1);
  const [s] = cam.shots;
  assert.ok(s.result && s.hold0 < outAt(edit, 2.3), "one shot from the typing on");
  assert.ok(cam.poster >= outAt(edit, 2.3) + 1 - 1e-6 && cam.poster <= s.hold1 + 1e-6, `poster at ${cam.poster}`);
});
