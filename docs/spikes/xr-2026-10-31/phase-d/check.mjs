// Phase D's checks: how many frames the recorder got in VR, and whether the video's frames have a picture in them.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { decode, stats } from "/tmp/spike/phase-a/probe.mjs";

const tl = JSON.parse(readFileSync("test-results/demo/timeline.json", "utf8"));
const xrActions = tl.actions.filter((a) => a.kind === "xr");
const start = Math.min(...xrActions.map((a) => a.t0));
const end = Math.max(...xrActions.map((a) => a.t1));
const inVr = tl.frames.filter((f) => f.t >= start && f.t <= end).length;
const seen = tl.frames.map((f) => f.t);
let worstGap = 0;
for (let i = 1; i < seen.length; i++) if (seen[i] >= start && seen[i] <= end) worstGap = Math.max(worstGap, seen[i] - seen[i - 1]);
console.log(JSON.stringify({
  duration: tl.duration, frames: tl.frames.length, viewport: tl.viewport, dpr: tl.dpr, status: tl.status,
  actions: tl.actions.map((a) => `${a.kind}:${a.label.slice(0, 24)}`), results: tl.results.length,
  vr: { seconds: Number((end - start).toFixed(1)), frames: inVr, fps: Number((inVr / (end - start)).toFixed(1)), worstGapS: Number(worstGap.toFixed(2)) },
}));
for (const a of xrActions) {
  const n = seen.filter((t) => t >= a.t0 && t <= a.t1).length;
  console.log(`${a.label}: ${(a.t1 - a.t0).toFixed(1)} s, ${n} frames, ${(n / (a.t1 - a.t0)).toFixed(1)} fps`);
}
const frameStats = (file) => stats(decode(file));
console.log("first recorded VR frame", JSON.stringify(frameStats(`test-results/demo/${tl.frames.find((f) => f.t >= start)?.file}`)));
const dur = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "/tmp/xd/demo.mp4"]).stdout.toString());
for (let i = 0; i < 8; i++) {
  const t = ((i + 0.5) * dur) / 8;
  const file = `/tmp/out/d/video-${i}.jpg`;
  spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", "/tmp/xd/demo.mp4", "-frames:v", "1", "-q:v", "4", "-vf", "scale=960:-2", file]);
  console.log(`video at ${t.toFixed(1)} s`, JSON.stringify(frameStats(file)));
}
