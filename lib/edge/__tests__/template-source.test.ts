/**
 * What provisionStep writes while EDGE_BUILDS is on must be the template's edge files as they are now. When this fails,
 * run `npx tsx scripts/edge/gen-edge-template.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EDGE_TEMPLATE_PATHS } from "@/lib/edge/paths";
import { edgeExtraFiles } from "@/lib/edge/template-files";
import { EDGE_TEMPLATE_FILES } from "@/lib/edge/template-source";

const ROOT = path.join(import.meta.dirname, "../../..");
const saved = process.env.EDGE_BUILDS;
afterEach(() => {
  if (saved === undefined) delete process.env.EDGE_BUILDS;
  else process.env.EDGE_BUILDS = saved;
});

describe("the edge template", () => {
  it("is the template's edge files as they are now", () => {
    assert.deepEqual(EDGE_TEMPLATE_FILES.map((f) => f.path), [...EDGE_TEMPLATE_PATHS]);
    for (const f of EDGE_TEMPLATE_FILES) {
      assert.ok(f.content === readFileSync(path.join(ROOT, "template", f.path), "utf8"), `${f.path} is stale: run npx tsx scripts/edge/gen-edge-template.ts`);
    }
  });

  it("has no em dashes, and its code says none of the lines we never say (the skill names them only to forbid them)", () => {
    for (const f of EDGE_TEMPLATE_FILES) {
      assert.ok(!f.content.includes("\u2014"), f.path);
      if (!f.path.endsWith(".md")) assert.ok(!/attack-proof|works offline|on-device|private/i.test(f.content), f.path);
    }
  });
});

describe("edgeExtraFiles", () => {
  it("is empty while EDGE_BUILDS is off, so builds get nothing new", () => {
    for (const v of [undefined, "", "0", "false", "off"]) {
      if (v === undefined) delete process.env.EDGE_BUILDS;
      else process.env.EDGE_BUILDS = v;
      assert.deepEqual(edgeExtraFiles(), []);
    }
  });

  it("is the helper, the skill and the drill kit while it is on", () => {
    process.env.EDGE_BUILDS = "1";
    const paths = edgeExtraFiles().map((f) => f.path);
    for (const want of ["lib/meta/edge.ts", ".agents/skills/muse-edge/SKILL.md", "scripts/edge-fake.mjs", "scripts/edge-blackhole.mjs", "scripts/edge-drill.mjs"]) {
      assert.ok(paths.includes(want), want);
    }
  });
});
