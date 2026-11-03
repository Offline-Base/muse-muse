/**
 * What provisionStep writes for an edge build must be the template's edge files as they are now. When this fails,
 * run `npx tsx scripts/edge/gen-edge-template.ts`. edgeExtraFiles gives them only to a brief with the edge target while
 * EDGE_ENABLED and EDGE_BUILDS are on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EDGE_TEMPLATE_PATHS } from "@/lib/edge/paths";
import { edgeExtraFiles } from "@/lib/edge/template-files";
import { EDGE_TEMPLATE_FILES } from "@/lib/edge/template-source";

const ROOT = path.join(import.meta.dirname, "../../..");
const FLAGS = ["EDGE_BUILDS", "EDGE_ENABLED"] as const;
const saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
afterEach(() => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
});
const EDGE = { targets: [{ id: "web" }, { id: "edge" }] };
const WEB = { targets: [{ id: "web" }] };
const on = () => {
  process.env.EDGE_BUILDS = "1";
  process.env.EDGE_ENABLED = "1";
};

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
  it("is empty while the flags are off, even for an edge brief, so builds get nothing new", () => {
    for (const v of [undefined, "", "0", "false", "off"]) {
      for (const f of FLAGS) {
        if (v === undefined) delete process.env[f];
        else process.env[f] = v;
      }
      assert.deepEqual(edgeExtraFiles(EDGE), []);
    }
    process.env.EDGE_BUILDS = "1";
    assert.deepEqual(edgeExtraFiles(EDGE), [], "EDGE_BUILDS alone");
  });

  it("is empty with the flags on for a build whose brief has no edge target", () => {
    on();
    for (const brief of [WEB, { targets: [] }, { targets: null }, null, undefined]) assert.deepEqual(edgeExtraFiles(brief), [], JSON.stringify(brief));
  });

  it("is the helper, the board status line, the skill and the drill kit for an edge build with the flags on", () => {
    on();
    const paths = edgeExtraFiles(EDGE).map((f) => f.path);
    for (const want of ["lib/meta/edge.ts", ".agents/skills/muse-edge/SKILL.md", "scripts/edge-fake.mjs", "scripts/edge-blackhole.mjs", "scripts/edge-drill.mjs", "lib/meta/board-status.ts", "app/api/board-status/route.ts", "components/BoardStatus.tsx"]) {
      assert.ok(paths.includes(want), want);
    }
  });
});
