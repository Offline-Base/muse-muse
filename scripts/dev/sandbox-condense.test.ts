/**
 * Unit test: condenses the real Muse Code JSONL sample from spike 1.
 *   npx tsx --test scripts/dev/sandbox-condense.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { completeLines, condenseMuseLines, highlightsFrom } from "@/lib/sandbox/muse-log";

const sample = readFileSync(path.join(process.cwd(), "docs/spikes/muse-exec-sample.jsonl"));

test("condenses the spike 1 sample per the SPIKES.md table", () => {
  const { lines, consumed } = completeLines(sample);
  assert.equal(consumed, sample.length, "sample ends with a newline, so every byte is consumed");
  const c = condenseMuseLines(lines);

  assert.equal(c.sessionId, "7661c49d-b561-4b2e-8cce-541a6cb64df2");
  assert.deepEqual(
    c.lines.map((l) => l.kind),
    ["start", "status", "tool", "edit", "tool", "say", "status", "status", "usage", "done"],
  );
  const [start, skill, read, edit, editTool, say, goal, verify, usage, done] = c.lines;
  assert.equal(start.text, "Started");
  // Three skill reminders ran, but each reminder agent gets one line per run.
  assert.deepEqual([skill.text, goal.text, verify.text], [
    "Muse Code started its skill reminder",
    "Muse Code started its goal reminder",
    "Muse Code started its verify reminder",
  ]);
  assert.deepEqual(c.announced, ["reminder:skill", "reminder:goal", "reminder:verify"]);
  assert.deepEqual(read, { kind: "tool", tool: "read_file", ok: true, text: "Read text file `app/page.tsx`." });
  assert.deepEqual(edit, { kind: "edit", files: 1, added: 1, removed: 1, text: "Edited 1 file (+1 −1)" });
  assert.deepEqual(editTool, { kind: "tool", tool: "edit_file", ok: true, text: "Edited `app/page.tsx`" });
  assert.equal(say.text, 'Done. The h1 in [app/page.tsx](/vercel/app/app/page.tsx:5) now says "Hello from Muse Code".');
  assert.match(usage.text, /^3 model calls, 89k input tokens \(46k cached\), 226 output tokens, about \$0\.06\d$/);
  assert.equal(done.ok, true);
  assert.equal(c.finalText, 'Done. The h1 in [app/page.tsx](/vercel/app/app/page.tsx:5) now says "Hello from Muse Code".');

  assert.equal(c.usage.length, 1);
  const u = c.usage[0];
  assert.equal(u.model, "muse-spark-1.3");
  assert.equal(u.inputTokens, 89374);
  assert.equal(u.cachedInputTokens, 45922);
  assert.equal(u.outputTokens, 226);
  // (89374 - 45922) * 1.25 + 45922 * 0.15 + 226 * 4.25, per million
  assert.ok(Math.abs(u.costUsd - (43452 * 1.25 + 45922 * 0.15 + 226 * 4.25) / 1e6) < 1e-9);
});

test("splits at the last newline and keeps a partial line for the next poll", () => {
  const cut = sample.subarray(0, 5000);
  const { lines, consumed } = completeLines(cut);
  assert.ok(consumed > 0 && consumed <= 5000);
  assert.equal(cut[consumed - 1], 0x0a);
  assert.ok(lines.every((l) => l === "" || l.startsWith("{")));
  // Resuming from `consumed` (with the first part's `announced`) and condensing the rest gives the same lines as
  // condensing everything at once.
  const a = condenseMuseLines(lines);
  const b = condenseMuseLines(completeLines(sample.subarray(consumed)).lines, a.announced);
  const all = condenseMuseLines(completeLines(sample).lines);
  assert.deepEqual([...a.lines, ...b.lines].map((l) => l.kind), all.lines.map((l) => l.kind));
});

test("no newline means nothing consumed", () => {
  assert.deepEqual(completeLines(Buffer.from('{"payload_type":"run.output.delta"')), { lines: [], consumed: 0 });
});

test("highlights list tool calls with a summary first", () => {
  const c = condenseMuseLines(completeLines(sample).lines);
  assert.deepEqual(highlightsFrom(c.lines), [
    "2 tool calls, 1 edit touching 1 file",
    "Read text file `app/page.tsx`.",
    "Edited `app/page.tsx`",
  ]);
});

test("non-completed terminal becomes an error line", () => {
  const c = condenseMuseLines([
    JSON.stringify({ payload_type: "run.terminal.completed", payload: { terminal: "failed", reason: "max_model_steps", text: "" } }),
  ]);
  assert.deepEqual(c.lines, [{ kind: "error", ok: false, text: "Muse Code stopped (failed): max_model_steps" }]);
});
