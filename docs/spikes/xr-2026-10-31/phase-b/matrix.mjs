// Phase B: the real stack (Next.js, R3F, @react-three/xr, uikit) under next start. Flag sets at the skill's budget in both
// Chromium builds, then the winner on the light scene, with MSAA, at 960x540 and with DevUI, plus the blank scene. Writes
// the winner to scripts/browser.json for verify and the demo.
import { writeFileSync } from "node:fs";
import { probe, shortfalls } from "/tmp/spike/phase-a/probe.mjs";

const URL_BASE = `http://localhost:${process.argv[2]}/`;
const OUT = "/tmp/out/b";
const SW = "--enable-unsafe-swiftshader";
const FLAGS = { none: [], unsafe: [SW], gl: ["--use-gl=swiftshader", SW], angle: ["--use-angle=swiftshader", SW] };
const CHANNELS = { shell: undefined, chromium: "chromium" };

const results = [];
if (process.env.XR_SKIP_MATRIX) {
  writeFileSync("scripts/browser.json", `${JSON.stringify({ args: FLAGS.unsafe }, null, 2)}\n`);
  process.exit(0);
}
async function run(spec) {
  const r = await probe({ out: OUT, ...spec });
  const short = shortfalls(r);
  results.push({ ...r, shortfalls: short });
  console.log(
    `${r.label.padEnd(30)} ${short.length ? "FAIL" : "PASS"} fps=${r.fps ?? "-"}/${r.fpsAfter ?? "-"} session=${r.sessionMs ?? "-"}ms cast=${r.screencast?.fps ?? "-"} diff=${r.poseChanged ?? "-"} err=${r.animateErrorCm ?? "-"}cm select=${r.select?.changed ?? "-"} calls=${r.info?.drawCalls ?? "-"} tris=${r.info?.triangles ?? "-"} buffer=${r.info?.buffer ?? "-"} aa=${r.info?.antialias ?? "-"} targets=${r.targets ?? "-"}`,
  );
  if (short.length) console.log(`  short: ${short.join(" | ")}`);
  for (const key of ["consoleErrors", "pageErrors", "failedRequests", "badResponses", "external"]) if (r[key]?.length) console.log(`  ${key}: ${JSON.stringify(r[key].slice(0, 4)).slice(0, 700)}`);
  return r;
}

const combos = Object.entries(CHANNELS).flatMap(([c, channel]) => Object.entries(FLAGS).map(([f, args]) => ({ label: `${c}-${f}`, channel, args, c, f })));
for (const { label, channel, args } of combos) await run({ label: `${label}-budget`, channel, args, url: `${URL_BASE}?scene=budget` });

// The default headless shell with the documented flag, unless a set beats it by more than 15% without logging console
// errors. channel:"chromium" fetches /favicon.ico, which the template doesn't have, and that 404 fails verify's console
// step. --use-angle=swiftshader halves the screencast, which score() catches.
const score = (r) => Math.min(r.fps ?? 0, r.fpsAfter ?? 0, r.screencast?.fps ?? 0);
const scored = combos.map((x) => ({ ...x, r: results.find((r) => r.label === `${x.label}-budget`) }));
const clean = scored.filter((x) => !x.r.loadConsoleErrors);
const passing = scored.filter((x) => !x.r.shortfalls.length);
const best = (clean.length ? clean : scored).reduce((a, b) => (score(b.r) > score(a.r) ? b : a));
const plain = scored.find((x) => x.label === "shell-unsafe");
const chosen = score(best.r) > score(plain.r) * 1.15 ? best : plain;
console.log(`chosen: ${chosen.label} (best ${best.label}, ${passing.length} of ${scored.length} passed at budget)`);
writeFileSync("scripts/browser.json", `${JSON.stringify({ ...(chosen.channel ? { channel: chosen.channel } : {}), args: chosen.args }, null, 2)}\n`);

const { label, channel, args } = chosen;
await run({ label: `${label}-light`, channel, args, url: URL_BASE });
await run({ label: `${label}-budget-2nd`, channel, args, url: `${URL_BASE}?scene=budget`, seconds: 8 });
await run({ label: `${label}-budget-msaa`, channel, args, url: `${URL_BASE}?scene=budget&aa=1` });
await run({ label: `${label}-budget-960`, channel, args, url: `${URL_BASE}?scene=budget`, width: 960, height: 540 });
await run({ label: `${label}-devui`, channel, args, url: `${URL_BASE}?devui=1` });
await run({ label: `${label}-hands`, channel, args, url: URL_BASE, hands: true });
const blank = await run({ label: `${label}-blank`, channel, args, url: `${URL_BASE}?blank=1`, expectBlank: true, seconds: 1 });
console.log(`blank check on an empty scene with controllers: ${JSON.stringify(blank.pose1)}`);
writeFileSync("/tmp/out/b-results.json", JSON.stringify(results, null, 2));
