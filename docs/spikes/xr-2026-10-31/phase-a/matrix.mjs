// Phase A: every flag set in both Chromium builds with the light scene, then the winners at the skill's budget, with MSAA,
// at 960x540, plus the two checks that must fail on purpose: force=0 and a blank scene.
import { writeFileSync } from "node:fs";
import { probe, shortfalls } from "./probe.mjs";

const URL_BASE = "http://localhost:3199/";
const OUT = "/tmp/out/a";
const SW = "--enable-unsafe-swiftshader";
const FLAGS = {
  none: [],
  unsafe: [SW],
  angle: ["--use-angle=swiftshader", SW],
  gl: ["--use-gl=swiftshader", SW],
  anglePlus: ["--use-angle=swiftshader", SW, "--ignore-gpu-blocklist"],
};
const CHANNELS = { shell: undefined, chromium: "chromium" };

const results = [];
async function run(spec) {
  const r = await probe({ out: OUT, ...spec });
  const short = shortfalls(r);
  results.push({ ...r, shortfalls: short });
  console.log(
    `${r.label.padEnd(30)} ${short.length ? "FAIL" : "PASS"} fps=${r.fps ?? "-"} session=${r.sessionMs ?? "-"}ms cast=${r.screencast?.fps ?? "-"} diff=${r.poseChanged ?? "-"} err=${r.animateErrorCm ?? "-"}cm select=${r.select?.changed ?? "-"} calls=${r.info?.drawCalls ?? "-"} tris=${r.info?.triangles ?? "-"} renderer=${r.info?.renderer ?? r.info?.webglError ?? r.error ?? "-"}`,
  );
  if (short.length) console.log(`  short: ${short.join(" | ")}`);
  return r;
}

const combos = [];
for (const [c, channel] of Object.entries(CHANNELS)) for (const [f, args] of Object.entries(FLAGS)) combos.push({ c, channel, f, args });
for (const { c, channel, f, args } of combos) await run({ label: `${c}-${f}`, channel, args, url: `${URL_BASE}?scene=light` });

const passing = results.filter((r) => !r.shortfalls.length).sort((a, b) => b.fps - a.fps);
console.log(`passing: ${passing.map((r) => r.label).join(", ") || "none"}`);
// The ones to measure further: the fastest flags in each build, or the design's default when nothing passed.
const heavy = [...new Map(combos.map((x) => [x.c, passing.map((p) => combos.find((y) => `${y.c}-${y.f}` === p.label)).find((y) => y.c === x.c) ?? combos.find((y) => y.c === x.c && y.f === "angle")])).values()];
for (const { c, channel, f, args } of heavy) {
  const base = `${c}-${f}`;
  await run({ label: `${base}-budget`, channel, args, url: `${URL_BASE}?scene=budget` });
  await run({ label: `${base}-budget-msaa`, channel, args, url: `${URL_BASE}?scene=budget&aa=1` });
  await run({ label: `${base}-budget-960`, channel, args, url: `${URL_BASE}?scene=budget`, width: 960, height: 540 });
  await run({ label: `${base}-force0`, channel, args, url: `${URL_BASE}?scene=light&force=0`, checkOnly: true });
  await run({ label: `${base}-blank`, channel, args, url: `${URL_BASE}?blank=1`, expectBlank: true, seconds: 1 });
}
writeFileSync("/tmp/out/a-results.json", JSON.stringify(results, null, 2));
console.log(`force=0 emulatedSupported: ${results.filter((r) => r.label.endsWith("force0")).map((r) => `${r.label}=${r.info?.emulatedSupported}`).join(", ")}`);
console.log(`blank check: ${results.filter((r) => r.label.endsWith("-blank")).map((r) => `${r.label}=${JSON.stringify(r.pose1)}`).join(", ")}`);
