// What the budget scene's frame rate is spent on, at the flags phase B chose. Each row changes one thing.
import { readFileSync, writeFileSync } from "node:fs";
import { probe, shortfalls } from "/tmp/spike/phase-a/probe.mjs";

const base = `http://localhost:${process.argv[2]}/`;
const { channel, args } = JSON.parse(readFileSync("scripts/browser.json", "utf8"));
const rows = [
  ["budget", "?scene=budget"],
  ["budget-two-views", "?scene=budget&mono=0"],
  ["budget-unpickable", "?scene=budget&nopick=1"],
  ["budget-lambert", "?scene=budget&mat=lambert"],
  ["half", "?scene=budget&orbs=45"],
  ["half-two-views", "?scene=budget&orbs=45&mono=0"],
  ["half-lambert", "?scene=budget&orbs=45&mat=lambert"],
  ["quarter", "?scene=budget&orbs=22"],
  ["light", ""],
  ["light-two-views", "?mono=0"],
  ["budget-again", "?scene=budget"],
];
const results = [];
for (const [label, query] of rows) {
  const r = await probe({ label: `tune-${label}`, out: "/tmp/out/t", channel, args, url: `${base}${query}`, seconds: 6 });
  const short = shortfalls(r);
  results.push({ ...r, shortfalls: short });
  console.log(`${label.padEnd(30)} ${short.length ? "FAIL" : "PASS"} fps=${r.fps ?? "-"}/${r.fpsAfter ?? "-"} cast=${r.screencast?.fps ?? "-"} xrFps=${r.screencast?.xrFps ?? "-"} calls=${r.info?.drawCalls ?? "-"} tris=${r.info?.triangles ?? "-"}${r.failedAt ? ` failed at ${r.failedAt}` : ""}`);
}
writeFileSync("/tmp/out/t-results.json", JSON.stringify(results, null, 2));
