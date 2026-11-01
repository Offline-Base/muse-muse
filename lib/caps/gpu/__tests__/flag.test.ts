/**
 * What GPU_GLIMMER_SHARED changes outside the route (docs/CAPABILITIES.md, section 17), and that it changes nothing with the
 * flag off: tokens, env, catalog, build prompt, judge. On a brief that picks muse-glimmer.
 *
 *   npx tsx --test lib/caps/gpu/__tests__/flag.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { gpuProofLines } from "@/lib/caps/gpu/judge";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsBuildLines, capsRefineLines } from "@/lib/caps/render";
import { env } from "@/lib/env";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { catalogSummary } from "@/lib/prompts/catalog";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import type { Brief } from "@/lib/brief/schema";

const GLIMMER_BRIEF = { ...BRIEF, capabilities: [{ need: "answer like my counter staff", model: "muse-glimmer", why: "its own model" }] } as unknown as Brief;
const saved = { ...process.env };

beforeEach(() => {
  for (const k of ["GPU_GLIMMER_SHARED", "VERCEL", "BUILDER_SNAPSHOT_ID"]) delete process.env[k];
  process.env.PLATFORM_URL = "https://platform.example";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("with GPU_GLIMMER_SHARED off", () => {
  it("nothing changes", () => {
    assert.deepEqual(allowedModelsFor(GLIMMER_BRIEF), []);
    assert.equal(capBuildEnv(GLIMMER_BRIEF), "");
    assert.deepEqual(capDeployEnv(GLIMMER_BRIEF, "tok"), {});
    assert.deepEqual(capsBuildLines(GLIMMER_BRIEF), []);
    assert.deepEqual(capsRefineLines(GLIMMER_BRIEF), []);
    assert.equal(capsJudgeNotes(GLIMMER_BRIEF), "");
    assert.match(catalogSummary([]), /Pick it only when the muse asks for local or offline use\./);
  });
});

describe("with GPU_GLIMMER_SHARED on", () => {
  beforeEach(() => {
    process.env.GPU_GLIMMER_SHARED = "1";
  });

  it("a brief without muse-glimmer stays as it was", () => {
    const other = { ...BRIEF, capabilities: [{ need: "x", model: "muse-wonder-1.0", why: "y" }] } as unknown as Brief;
    assert.deepEqual(allowedModelsFor(other), ["muse-wonder-1.0"]);
    assert.equal(capBuildEnv(other), "");
    assert.deepEqual(capDeployEnv(other, "tok"), {});
    assert.deepEqual(capsBuildLines(other), []);
  });

  it("the token gets the marker, and Muse Wonder for the fallback", () => {
    assert.deepEqual(allowedModelsFor(GLIMMER_BRIEF), ["muse-wonder-1.0", "glimmer"]);
  });

  it("a build's .env.local says the endpoint is on, and holds no token of its own", () => {
    assert.equal(capBuildEnv(GLIMMER_BRIEF), "GLIMMER_SHARED=1\nGLIMMER_MODEL=muse-glimmer\n");
  });

  it("the deploy sets the helper's own variables to the gateway, with the live token", () => {
    assert.deepEqual(capDeployEnv(GLIMMER_BRIEF, "live_tok"), {
      GLIMMER_URL: "https://platform.example/api/gateway/glimmer/v1",
      GLIMMER_API_KEY: "live_tok",
      GLIMMER_MODEL: "muse-glimmer",
    });
  });

  it("the writer gets General's line and the demo-window line, and the catalog's cache keeps them apart", () => {
    const on = catalogSummary([]);
    assert.ok(on.includes("When the muse wants its own trained model, pick muse-glimmer and say in need what it should learn; the product answers with Muse Wonder until that model passes and a window is open."));
    assert.ok(on.includes("only during demo windows"));
    delete process.env.GPU_GLIMMER_SHARED;
    assert.ok(!catalogSummary([]).includes("demo windows"));
  });

  it("the build prompt has its section, names the helper and the test header", () => {
    const text = capsBuildLines(GLIMMER_BRIEF).join("\n");
    assert.match(text, /## Platform services/);
    assert.match(text, /### Hosted Muse Glimmer/);
    assert.match(text, /askGlimmer/);
    assert.match(text, /x-musemuse-glimmer-test: closed/);
    assert.ok(!text.includes("—"), "no em dashes");
    assert.ok(capsRefineLines(GLIMMER_BRIEF).join("\n").includes("askGlimmer"));
  });

  it("the judge is told the answers are samples", () => {
    assert.match(capsJudgeNotes(GLIMMER_BRIEF), /Glimmer's answers in this test are samples/);
  });

  it("the gateway's record gives the judge both checks", () => {
    assert.deepEqual(gpuProofLines({ "glimmer-canned": 2 }), ["- glimmer, reply: passed", "- glimmer, closed-window: failed"]);
    assert.deepEqual(gpuProofLines({ "glimmer-canned": 2, "glimmer-closed": 1 }), ["- glimmer, reply: passed", "- glimmer, closed-window: passed"]);
  });

  it("on Vercel it waits for a snapshot from wave 3: none, or an unknown id, tells builds nothing", () => {
    process.env.VERCEL = "1";
    assert.equal(env.gpuGlimmerShared, true, "the route itself follows the flag");
    assert.equal(env.gpuGlimmerForBuilds, false);
    assert.deepEqual(allowedModelsFor(GLIMMER_BRIEF), []);
    assert.deepEqual(capsBuildLines(GLIMMER_BRIEF), []);
  });
});

describe("the admin and train routes with their flags off", () => {
  it("answer 404 before anything is read", async () => {
    delete process.env.GPU_GLIMMER_SHARED;
    delete process.env.GPU_TRAIN_ON_DATA;
    const windows = await import("@/app/api/admin/glimmer/windows/route");
    const one = await import("@/app/api/admin/glimmer/windows/[id]/route");
    const train = await import("@/app/api/products/[slug]/train/route");
    assert.equal((await windows.GET()).status, 404);
    assert.equal((await windows.POST(new Request("https://x.example/", { method: "POST", body: "{}" }))).status, 404);
    assert.equal((await one.DELETE(new Request("https://x.example/", { method: "DELETE" }), { params: Promise.resolve({ id: "x" }) })).status, 404);
    assert.equal((await train.POST(new Request("https://x.example/", { method: "POST", body: "{}" }), { params: Promise.resolve({ slug: "x" }) })).status, 404);
  });
});

describe("the skill", () => {
  it("keeps its new text in one marked block, with no em dashes", () => {
    const skill = readFileSync(new URL("../../../../template/.agents/skills/meta-glimmer/SKILL.md", import.meta.url), "utf8");
    assert.match(skill, /<!-- Wave 3, unit 11: the hosted Glimmer -->[\s\S]*askGlimmer[\s\S]*<!-- End wave 3, unit 11 -->/);
    assert.ok(!skill.includes("—"));
  });
});
