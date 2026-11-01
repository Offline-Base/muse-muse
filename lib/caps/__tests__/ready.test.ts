/**
 * Cap readiness and the builder snapshot (docs/CAPABILITIES.md, 2.4a): the snapshot manifest, env.enabledCaps on
 * Vercel, the brief writer's schema and catalog, and the build's working copy of a stored brief.
 *
 *   npx tsx --test lib/caps/__tests__/ready.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { newBriefSchemaFor, NewBriefSchemaNoGadget } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { CAP_FLAG, CAP_IDS, CAP_READY } from "@/lib/caps/ids";
import { CAP_OVERLAYS_ALL, capOverlaysNeeded } from "@/lib/caps/overlays";
import { capDropLine, capsForBuild, capsMissingOverlays, readCapDrops, withoutCaps } from "@/lib/caps/ready";
import { env } from "@/lib/env";
import { catalogSummary } from "@/lib/prompts/catalog";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { capOverlaysIn } from "@/lib/sandbox/setup";
import { resetSnapshotWarnings, SNAPSHOTS, snapshotCapOverlays } from "@/lib/sandbox/snapshots";

const ROOT = join(import.meta.dirname, "../../..");
const ready = CAP_READY as Record<string, boolean>;
const ENV = ["VERCEL", "VERCEL_ENV", "BUILDER_SNAPSHOT_ID", "TRUST_SIGNED_IN_CAPS", ...CAP_IDS.map((id) => CAP_FLAG[id])];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const DATA_BLOCK = { collections: [{ name: "groceries", scope: "shared", writes: "anyone", holds: "One item to buy.", personal: false }], signIn: "none" };
const WITH_DATA = { ...BRIEF, data: DATA_BLOCK } as typeof BRIEF;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  resetSnapshotWarnings();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  ready.data = false;
  for (const id of Object.keys(SNAPSHOTS)) if (id.startsWith("snap_test")) delete SNAPSHOTS[id];
  mock.restoreAll();
});

describe("the snapshot manifest", () => {
  it("starts empty and is valid JSON of id to {createdAt, templateHash, capOverlays}", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "lib/sandbox/snapshots.json"), "utf8")) as Record<string, { createdAt: string; templateHash: string; capOverlays: string[] }>;
    for (const [id, entry] of Object.entries(manifest)) {
      assert.match(id, /^snap_[A-Za-z0-9]+$/);
      assert.equal(typeof entry.createdAt, "string");
      assert.equal(typeof entry.templateHash, "string");
      assert.ok(Array.isArray(entry.capOverlays) && entry.capOverlays.includes("core"), id);
    }
  });

  it("has every snapshot id that .env.example, the README or the contract names as the one to use", () => {
    const ids = new Set<string>();
    for (const file of [".env.example", "README.md", "docs/CAPABILITIES.md"]) {
      for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(/snap_[A-Za-z0-9]{8,}/g)) ids.add(m[0]);
    }
    for (const id of ids) assert.ok(id in SNAPSHOTS, `${id} is named but isn't in lib/sandbox/snapshots.json`);
  });

  it("an unknown id, or none, gives no caps and one warning per id", () => {
    const warned: string[] = [];
    const warn = (l: string) => void warned.push(l);
    assert.deepEqual(snapshotCapOverlays("snap_unknown", {}, warn), []);
    assert.deepEqual(snapshotCapOverlays("snap_unknown", {}, warn), []);
    assert.deepEqual(snapshotCapOverlays(undefined, {}, warn), []);
    assert.equal(warned.length, 2);
    assert.match(warned[0]!, /snap_unknown is not in lib\/sandbox\/snapshots\.json, so no caps/);
    assert.deepEqual(snapshotCapOverlays("snap_x", { snap_x: { createdAt: "", templateHash: "", capOverlays: ["core", "data"] } }, warn), ["core", "data"]);
  });

  it("records the overlays a snapshot installed, sorted, from readCapFiles' paths", () => {
    const f = (p: string) => ({ path: p, content: Buffer.from("") });
    assert.deepEqual(capOverlaysIn([f("caps/runtime/deps.json"), f("caps/core/files/x.ts"), f("caps/core/deps.json"), f("caps/data/deps.json")]), ["core", "data", "runtime"]);
  });
});

describe("env.enabledCaps with the snapshot", () => {
  it("with every flag off is empty and reads nothing, whatever the manifest or the id", () => {
    const warn = mock.method(console, "warn", () => undefined);
    process.env.VERCEL = "1";
    process.env.BUILDER_SNAPSHOT_ID = "snap_not_listed";
    assert.deepEqual(env.enabledCaps, []);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps }), NewBriefSchemaNoGadget);
    assert.equal(warn.mock.callCount(), 0, "the manifest isn't read while no cap passes the flags");
  });

  it("on Vercel leaves out a ready, switched-on cap the snapshot lacks, from the writer's schema and the catalog too", () => {
    mock.method(console, "warn", () => undefined);
    ready.data = true;
    process.env.DATA_ENABLED = "1";
    // Locally the checkout's template/caps is used, so the cap is offered.
    assert.deepEqual(env.enabledCaps, ["data"]);
    process.env.VERCEL = "1";
    process.env.BUILDER_SNAPSHOT_ID = "snap_test_old";
    SNAPSHOTS.snap_test_old = { createdAt: "2026-11-02T08:00:00Z", templateHash: "abc", capOverlays: ["core", "runtime"] };
    assert.deepEqual(env.enabledCaps, []);
    const strict = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps })) as { properties: Record<string, unknown> };
    assert.ok(!("data" in strict.properties));
    assert.ok(!catalogSummary().includes("data (Saving)"));
    SNAPSHOTS.snap_test_new = { createdAt: "2026-11-02T09:00:00Z", templateHash: "def", capOverlays: ["core", "data", "runtime"] };
    process.env.BUILDER_SNAPSHOT_ID = "snap_test_new";
    assert.deepEqual(env.enabledCaps, ["data"]);
    assert.ok(catalogSummary().includes("data (Saving)"));
    assert.ok("data" in (strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps })) as { properties: Record<string, unknown> }).properties);
  });

  it("core missing from the snapshot drops every cap, and an unknown id gives none", () => {
    const warn = mock.method(console, "warn", () => undefined);
    ready.data = true;
    process.env.DATA_ENABLED = "1";
    process.env.VERCEL = "1";
    process.env.BUILDER_SNAPSHOT_ID = "snap_test_nocore";
    SNAPSHOTS.snap_test_nocore = { createdAt: "", templateHash: "", capOverlays: ["data"] };
    assert.deepEqual(env.enabledCaps, []);
    process.env.BUILDER_SNAPSHOT_ID = "snap_test_missing";
    assert.deepEqual(env.enabledCaps, []);
    assert.deepEqual(env.enabledCaps, []);
    assert.equal(warn.mock.callCount(), 1, "one warning for the unknown id");
  });

  it("a cap with picks needs every pick, and core", () => {
    const all = CAP_OVERLAYS_ALL as Record<string, readonly string[]>;
    all.games = ["games-phaser", "games-babylon"];
    try {
      assert.deepEqual(capOverlaysNeeded("games"), ["core", "games-phaser", "games-babylon"]);
    } finally {
      delete all.games;
    }
    assert.deepEqual(capOverlaysNeeded("data"), ["core", "data"]);
  });

  it("the gate's servedCaps and capsOnSite don't depend on the snapshot", () => {
    mock.method(console, "warn", () => undefined);
    ready.data = true;
    process.env.DATA_ENABLED = "1";
    process.env.VERCEL = "1";
    process.env.BUILDER_SNAPSHOT_ID = "snap_test_missing";
    assert.deepEqual(env.servedCaps, ["data"]);
    assert.deepEqual(env.capsOnSite, ["data"]);
    process.env.VERCEL_ENV = "production";
    assert.deepEqual(env.capsOnSite, [], "on production a builder cap waits for TRUST_SIGNED_IN_CAPS");
    assert.deepEqual(env.servedCaps, ["data"], "but its routes still answer for products that have it");
  });
});

describe("the build's working copy", () => {
  it("a brief with no cap blocks is the same object, and nothing is read", () => {
    const out = capsForBuild(BRIEF);
    assert.equal(out.brief, BRIEF);
    assert.deepEqual(out.dropped, []);
  });

  it("drops a cap that's switched off or missing from the snapshot, says which, and keeps the stored brief", () => {
    const off = capsForBuild(WITH_DATA, { enabled: [], onSite: [] });
    assert.deepEqual(off.dropped, [{ cap: "data", reason: "off" }]);
    assert.equal((off.brief as { data?: unknown }).data, null);
    assert.deepEqual((WITH_DATA as { data?: unknown }).data, DATA_BLOCK, "the stored brief keeps its block");
    const missing = capsForBuild(WITH_DATA, { enabled: [], onSite: ["data"] });
    assert.deepEqual(missing.dropped, [{ cap: "data", reason: "snapshot" }]);
    const kept = capsForBuild(WITH_DATA, { enabled: ["data"], onSite: ["data"] });
    assert.equal(kept.brief, WITH_DATA);
    assert.deepEqual(kept.dropped, []);
  });

  it("a refinement keeps a cap the snapshot lacks, since its sandbox has the overlay, and drops one switched off", () => {
    assert.deepEqual(capsForBuild(WITH_DATA, { kind: "refine", enabled: [], onSite: ["data"], served: ["data"] }).dropped, []);
    assert.deepEqual(capsForBuild(WITH_DATA, { kind: "refine", enabled: [], onSite: [], served: [] }).dropped, [{ cap: "data", reason: "off" }]);
  });

  it("a refinement on production keeps a cap the product has while TRUST_SIGNED_IN_CAPS is off; a new build doesn't get it", () => {
    // capsOnSite drops data on production without TRUST_SIGNED_IN_CAPS; servedCaps (what the gate serves) keeps it.
    const production = { enabled: [], onSite: [], served: ["data"] } as const;
    assert.deepEqual(capsForBuild(WITH_DATA, { kind: "refine", ...production }).dropped, [], "a change keeps the product's saved data");
    assert.deepEqual(capsForBuild(WITH_DATA, { kind: "build", ...production }).dropped, [{ cap: "data", reason: "off" }]);
  });

  it("a decision saved at provision is the answer, whatever the env says later", () => {
    const decided = capsForBuild(WITH_DATA, { decided: [{ cap: "data", reason: "snapshot" }], enabled: ["data"], onSite: ["data"] });
    assert.equal((decided.brief as { data?: unknown }).data, null);
    assert.equal(capsForBuild(WITH_DATA, { decided: [], enabled: [], onSite: [] }).brief, WITH_DATA, "nothing dropped then means nothing dropped now");
    assert.deepEqual(readCapDrops([{ cap: "data", reason: "off" }, { cap: "nope", reason: "off" }, { cap: "data", reason: "x" }, 3]), [{ cap: "data", reason: "off" }]);
    assert.equal(readCapDrops(null), null);
  });

  it("says each drop in one plain line", () => {
    assert.equal(capDropLine({ cap: "runtime", reason: "snapshot" }), "This build goes without Python functions: the builder snapshot doesn't have them yet.");
    assert.equal(capDropLine({ cap: "data", reason: "off" }), "This build goes without saved data: it is switched off.");
    for (const id of CAP_IDS) for (const reason of ["off", "snapshot"] as const) assert.ok(!capDropLine({ cap: id, reason }).includes("—"));
  });

  it("finds the caps whose overlays a sandbox lacks: core missing is all of them", () => {
    const file = { caps: ["data", "runtime"], overlays: ["core", "data", "runtime"] };
    assert.deepEqual(capsMissingOverlays(file, []), []);
    assert.deepEqual(capsMissingOverlays(file, ["runtime"]), ["runtime"]);
    assert.deepEqual(capsMissingOverlays(file, ["core"]), ["data", "runtime"]);
    assert.deepEqual(withoutCaps({ a: 1, data: { x: 1 }, runtime: null }, ["data", "runtime"]), { a: 1, data: null, runtime: null });
  });
});
