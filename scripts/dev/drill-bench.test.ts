/**
 * The drill bench's files read the way the repo's own readers read them: the folder drop keeps all 900 Simulated rows and
 * drops none as personal data or a secret, and the sealed and kept-aside rows parse as prompt and reference. No model, no
 * network: it runs scripts/dev/drill-bench.py make into a temp folder.
 *
 *   npx tsx --test --experimental-test-module-mocks scripts/dev/drill-bench.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { piiCounts } from "@/lib/train/public/content";
import { parseExamples } from "@/lib/train/tune/examples";
import { cleanFolder, hasSecret } from "@/lib/train/tune/folder-clean";

let out = "";
const read = (name: string) => readFileSync(join(out, name), "utf8");
const lines = (name: string) => read(name).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("drill-bench files", () => {
  before(() => {
    out = mkdtempSync(join(tmpdir(), "drill-node-"));
    execFileSync("python3", ["-I", join(import.meta.dirname, "drill-bench.py"), "make", "--out", out], { stdio: "ignore" });
  });
  after(() => rmSync(out, { recursive: true, force: true }));

  it("the folder drop keeps every training row and drops none", () => {
    const files = readdirSync(join(out, "folder")).map((f) => ({ path: `drill/${f}`, text: read(join("folder", f)) }));
    const r = cleanFolder({ files }, 2000);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.draft.mode, "rows");
    assert.equal(r.draft.rows.length, 900);
    assert.equal(r.review.droppedRows, 0);
    assert.equal(r.review.skipped.length, 0);
    assert.equal(r.review.cutRows, 0);
  });

  it("training rows are system, user, assistant, and nothing looks personal or secret", () => {
    const train = lines("train.jsonl");
    assert.equal(train.length, 900);
    for (const row of train) {
      const msgs = row.messages as Array<{ role: string; content: string }>;
      assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant"]);
      for (const m of msgs.slice(1)) {
        assert.deepEqual(piiCounts(m.content), {});
        assert.equal(hasSecret(m.content), false);
      }
    }
  });

  it("sealed and kept-aside rows parse as prompt and reference", () => {
    const sealed = parseExamples(read("sealed.jsonl"), "sealed.jsonl", 1000);
    assert.equal(sealed.rows.length, 100);
    assert.equal(sealed.rows[0]!.prompt.startsWith("Simulated cold-room log"), true);
    assert.equal(parseExamples(read("dev.jsonl"), "dev.jsonl", 1000).rows.length, 50);
    for (const name of ["demo-calm-cloud-down.csv", "demo-spoofed-controller.csv"]) {
      assert.deepEqual(piiCounts(read(name)), {});
      assert.ok(read(name).split("\n").slice(1).filter(Boolean).every((l) => l.startsWith("Simulated,")));
    }
  });
});
