/**
 * The import bundle's strict parser and its check for links back to the laptop (lib/promote/bundle.ts): every field
 * typed and sized, nothing it doesn't take (a user id least of all), only a live product with its latest build live
 * and every build finished, the rows' ids agreeing, another product's sandbox refused, the brief checked against its
 * schema, and no local file link or non-public link field left. Pure: nothing is mocked.
 *
 *   npx tsx --test lib/promote/__tests__/bundle.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { getTableColumns } from "drizzle-orm";
import { builds, products } from "@/lib/db/schema";
import { BUILD_KEYS, linkProblems, OPTIONAL_BUILD_KEYS, OPTIONAL_PRODUCT_KEYS, parseImportBundle, PRODUCT_KEYS, type ImportBundle } from "../bundle";
import { BRIEF, LOCAL, sampleBundle, STORE } from "./fixtures";

/** The bundle as JSON would carry it, so a test can break it in ways the type doesn't allow. */
function raw(b: ImportBundle = sampleBundle()): Record<string, any> {
  return JSON.parse(JSON.stringify(b));
}

function refused(bundle: unknown): { error: string; field: string } {
  const parsed = parseImportBundle(bundle);
  assert.equal(parsed.ok, false, "expected the parser to refuse it");
  return parsed as { error: string; field: string };
}

describe("parseImportBundle", () => {
  it("takes the bundle the script sends, as it is", () => {
    const b = sampleBundle();
    const parsed = parseImportBundle(raw(b));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, b);
  });

  it("takes a bundle without refineInspirations, which then has none", () => {
    const b = raw();
    b.builds = b.builds.slice(0, 1);
    b.events = b.events.filter((e: { buildId: string }) => e.buildId === b.builds[0].id);
    delete b.refineInspirations;
    const parsed = parseImportBundle(b);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.refineInspirations, []);
  });

  it("refuses anything it doesn't take, a user id first of all", () => {
    for (const [field, set] of [
      ["product.ownerId", (b: Record<string, any>) => (b.product.ownerId = randomUUID())],
      ["builds[0].userId", (b: Record<string, any>) => (b.builds[0].userId = randomUUID())],
      ["inspiration.userId", (b: Record<string, any>) => (b.inspiration.userId = randomUUID())],
      ["events[0].id", (b: Record<string, any>) => (b.events[0].id = 7)],
      ["usage", (b: Record<string, any>) => (b.usage = [])],
    ] as const) {
      const b = raw();
      set(b);
      const out = refused(b);
      assert.equal(out.field, field);
      assert.match(out.error, /isn't something an import takes/);
    }
  });

  it("needs every field, and each to be the right type and size", () => {
    const cases: Array<[string, (b: Record<string, any>) => void]> = [
      ["product.tagline", (b) => delete b.product.tagline],
      ["product.id", (b) => (b.product.id = "bird-count")],
      ["product.slug", (b) => (b.product.slug = "Bird Count")],
      ["product.name", (b) => (b.product.name = "")],
      ["builds[0].costUsd", (b) => (b.builds[0].costUsd = -1)],
      ["builds[0].fixRounds", (b) => (b.builds[0].fixRounds = 1.5)],
      ["builds[0].kind", (b) => (b.builds[0].kind = "rebuild")],
      ["builds[0].startedAt", (b) => (b.builds[0].startedAt = "yesterday")],
      ["events[0].at", (b) => (b.events[0].at = 1_761_739_200_000)],
      ["inspiration.note", (b) => (b.inspiration.note = "x".repeat(4001))],
      ["builds", (b) => (b.builds = "all of them")],
    ];
    for (const [field, set] of cases) {
      const b = raw();
      set(b);
      assert.equal(refused(b).field, field, field);
    }
    assert.equal(refused([]).field, "bundle");
    assert.equal(refused(null).error, "The bundle must be an object.");
  });

  it("takes only a live product, its latest build live and every build finished", () => {
    const partial = raw();
    partial.product.status = "partial";
    assert.equal(refused(partial).error, "Only a live product can be imported.");
    const latest = raw();
    latest.builds[0].status = "partial";
    assert.equal(refused(latest).error, "The product's latest build is partial, not live.");
    const running = raw();
    running.builds[1].status = "building";
    assert.equal(refused(running).field, "builds[1].status");
  });

  it("checks the rows against each other", () => {
    const cases: Array<[string, (b: Record<string, any>) => void]> = [
      ["builds[0].productId", (b) => (b.builds[0].productId = randomUUID())],
      ["events[0].buildId", (b) => (b.events[0].buildId = randomUUID())],
      ["builds[1].inspirationId", (b) => (b.builds[1].inspirationId = randomUUID())],
      ["product.inspirationId", (b) => (b.product.inspirationId = randomUUID())],
      ["product.latestBuildId", (b) => (b.product.latestBuildId = randomUUID())],
      ["builds[1].id", (b) => (b.builds[1].id = b.builds[0].id)],
      ["refineInspirations[1].id", (b) => b.refineInspirations.push({ ...b.inspiration, id: randomUUID() })],
      ["builds", (b) => (b.builds = [])],
    ];
    for (const [field, set] of cases) {
      const b = raw();
      set(b);
      assert.equal(refused(b).field, field, field);
    }
  });

  it("refuses a sandbox that isn't this product's, and takes the older product-<slug> names", () => {
    const other = raw();
    other.product.sandboxName = "product-bird-count-ffffffff";
    assert.equal(refused(other).error, "product.sandboxName isn't this product's sandbox.");
    const older = raw();
    older.product.sandboxName = "product-bird-count";
    assert.ok(parseImportBundle(older).ok);
  });

  it("checks briefs against the brief's schema", () => {
    const b = raw();
    b.builds[0].brief = { ...BRIEF, capabilities: [] };
    const out = refused(b);
    assert.equal(out.field, "builds[0].brief.capabilities");
    assert.match(out.error, /doesn't fit the brief's schema/);
  });

  it("takes event types this site doesn't render yet, as long as the payload names its own type", () => {
    const b = raw();
    b.events.push({ buildId: b.builds[0].id, type: "question", payload: { type: "question", text: "Which color?" }, at: b.events[0].at });
    assert.ok(parseImportBundle(b).ok);
    const mismatch = raw();
    mismatch.events[0].payload.type = "log";
    assert.equal(refused(mismatch).field, "events[0].payload.type");
    const badType = raw();
    badType.events[0].type = "Status!";
    badType.events[0].payload.type = "Status!";
    assert.equal(refused(badType).field, "events[0].type");
  });
});

describe("links back to the laptop", () => {
  it("are refused in the product's link fields, the events' and the references", () => {
    const b = raw();
    const local = (u: string) => u.replace(STORE, LOCAL);
    b.product.demoVideoUrl = local(b.product.demoVideoUrl);
    assert.equal(refused(b).field, "product.demoVideoUrl");

    const shot = raw();
    const verify = shot.events.findIndex((e: { type: string }) => e.type === "verify");
    shot.events[verify].payload.screenshots[0].url = local(shot.events[verify].payload.screenshots[0].url);
    assert.equal(refused(shot).field, `events[${verify}].payload.screenshots[0].url`);

    // Where lib/local-files.ts would take it as a stored inspo file, the link check still refuses it.
    const ref = raw();
    ref.inspiration.references[0].url = local(ref.inspiration.references[0].url);
    assert.match(refused(ref).field, /^inspiration\.references/);
  });

  it("are refused inside text too, while text that only mentions the sandbox's localhost passes", () => {
    const b = raw();
    const log = b.events.findIndex((e: { type: string }) => e.type === "log");
    b.events[log].payload.text = `Saved it to ${LOCAL}/demos/${b.builds[0].id}/demo-1a2b3c4d.mp4.`;
    const out = refused(b);
    assert.equal(out.field, `events[${log}].payload.text`);
    assert.match(out.error, /still points at a file on the machine it came from/);
    assert.ok(JSON.stringify(sampleBundle()).includes("curl http://localhost:3000/api/health"));
    assert.ok(parseImportBundle(raw()).ok);
  });

  it("are refused in any link field that isn't https on a public host", () => {
    for (const bad of ["http://sb-1a2b3c.vercel.run", "https://127.0.0.1/x.png", "https://localhost/x.png", "https://user:pw@sb.vercel.run", "data:image/png;base64,AAAA"]) {
      const b = raw();
      b.builds[0].previewUrl = bad;
      assert.equal(refused(b).field, "builds[0].previewUrl", bad);
    }
    const poster = raw();
    const rec = poster.events.findIndex((e: { type: string }) => e.type === "recording");
    poster.events[rec].payload.posterUrl = "http://localhost:3000/poster.jpg";
    assert.equal(refused(poster).field, `events[${rec}].payload.posterUrl`);
  });

  it("leave what the models wrote to the first rule: no local file links, but any other value", () => {
    const b = raw();
    b.product.manifest.actions = [{ name: "count", description: "d", input: {}, output: {}, example: { imageUrl: "data:image/png;base64,AAAA" } }];
    assert.ok(parseImportBundle(b).ok);
    b.product.manifest.actions[0].example.imageUrl = `${LOCAL}/fixtures/x/sample-1.png`;
    assert.equal(refused(b).field, "product.manifest.actions[0].example.imageUrl");
  });

  it("are listed by linkProblems for any JSON, with where each one is", () => {
    assert.deepEqual(linkProblems({ a: [{ url: "https://sb.vercel.run" }], note: "see http://localhost:3000/" }), []);
    assert.deepEqual(
      linkProblems({ a: [{ url: "http://localhost:3000/x" }], b: `${LOCAL}/screens/b/r0/1.png` }).map((p) => p.field),
      ["a[0].url", "b"],
    );
  });
});

describe("the bundle and the tables", () => {
  /**
   * What a local product's row doesn't send, and why. A new column fails here until someone decides: send it (add it to
   * the bundle, toBundle and the store) or leave it out on purpose (add it here).
   */
  const LEFT_OUT = {
    // The live site gives every row to its guest account, and sets the link once it publishes.
    products: [
      "ownerId", "vercelProjectId", "liveUrl",
      // Wave 3, unit 1 (0018_trust): a takedown belongs to the site that made it (docs/CAPABILITIES.md, section 4).
      "takenDownAt", "takedownReason", "statusBeforeTakedown",
    ],
    // The guest account again; IMPORTED_RUN marks the run; a finished build has no round running and no Stop to heed.
    builds: [
      "userId", "workflowRunId", "museRound", "stopRequested",
      // Wave 3, unit 2 (0019_engine): the live check belongs to the site that ran it (docs/CAPABILITIES.md, section 4).
      "liveCheck",
    ],
  };

  it("sends every column of products or leaves it out on purpose", () => {
    const sent = [...PRODUCT_KEYS, ...OPTIONAL_PRODUCT_KEYS, ...LEFT_OUT.products].sort();
    assert.deepEqual(sent, Object.keys(getTableColumns(products)).sort());
  });

  it("sends every column of builds or leaves it out on purpose", () => {
    const sent = [...BUILD_KEYS, ...OPTIONAL_BUILD_KEYS, ...LEFT_OUT.builds].sort();
    assert.deepEqual(sent, Object.keys(getTableColumns(builds)).sort());
  });
});

describe("what the engine adds to a bundle (0019_engine)", () => {
  it("sends a build's round plan when it has one, checked, and leaves it out when it hasn't", () => {
    const b = raw();
    assert.ok(!("roundPlan" in parseOk(b).builds[0]!));
    b.builds[0].roundPlan = { capMinutes: 35, milestones: [{ title: "Play one level", state: "passed" }, { title: "Level maker", state: "failed" }] };
    assert.deepEqual(parseOk(b).builds[0]!.roundPlan, b.builds[0].roundPlan);
    b.builds[0].roundPlan = { capMinutes: 35, milestones: [{ title: "A", state: "exploded" }] };
    assert.equal(parseImportBundle(b).ok, false);
    b.builds[0].roundPlan = { capMinutes: 35, milestones: [], extra: 1 };
    assert.equal(parseImportBundle(b).ok, false, "unknown keys are refused");
  });

  function parseOk(b: Record<string, any>) {
    const parsed = parseImportBundle(b);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.value;
  }
});

describe("what targets add to a bundle", () => {
  const CLIP = { url: `${STORE}/clips/p1/quest.mp4`, posterUrl: `${STORE}/clips/p1/quest.jpg`, caption: "Filmed on a Meta Quest 3", addedAt: "2026-11-03T12:00:00.000Z" };

  /** A bundle with clips, targets and fixtures, as a product built with them makes one. */
  function withTargets(): Record<string, any> {
    const b = raw();
    b.product.extraClips = [{ ...CLIP }];
    b.builds[0].requestedTargets = ["web", "phone"];
    b.builds[0].toolFixtures = { SERPAPI_SEARCH: [{ title: "A sample", url: "https://example.com/a" }] };
    return b;
  }

  it("leaves them out for a product with none, so a bundle reads as it always did", () => {
    const b = sampleBundle();
    assert.ok(!("extraClips" in b.product));
    for (const build of b.builds) {
      assert.ok(!("requestedTargets" in build));
      assert.ok(!("toolFixtures" in build));
    }
    const parsed = parseImportBundle(raw(b));
    assert.ok(parsed.ok);
    assert.ok(!("extraClips" in parsed.value.product));
    assert.ok(!("requestedTargets" in parsed.value.builds[0]!));
  });

  it("takes them, as a bundle from before they existed still parses", () => {
    const parsed = parseImportBundle(withTargets());
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.product.extraClips, [CLIP]);
    assert.deepEqual(parsed.value.builds[0]!.requestedTargets, ["web", "phone"]);
    assert.deepEqual(parsed.value.builds[0]!.toolFixtures, { SERPAPI_SEARCH: [{ title: "A sample", url: "https://example.com/a" }] });
  });

  it("takes a native event in a build's log, like any other", () => {
    const b = raw();
    const event = { type: "native", runId: "run-1", origin: "ship", item: "package:android", target: "phone", state: "done", title: "Packaged the Android app", artifact: { kind: "android_apk", url: `${STORE}/native/products/p1/r1/a.apk`, bytes: 41 } };
    b.events.push({ buildId: b.builds[0].id, type: "native", payload: event, at: "2026-10-29T13:00:00.000Z" });
    const parsed = parseImportBundle(b);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.events.at(-1)!.payload, event);
  });

  it("refuses a target it doesn't know, or requested targets that aren't a list", () => {
    const unknown = withTargets();
    unknown.builds[0].requestedTargets = ["toaster"];
    assert.equal(refused(unknown).field, "builds[0].requestedTargets");
    const notAList = withTargets();
    notAList.builds[0].requestedTargets = "phone";
    assert.equal(refused(notAList).field, "builds[0].requestedTargets");
  });

  it("refuses canned outputs that aren't an object", () => {
    const b = withTargets();
    b.builds[0].toolFixtures = ["nope"];
    assert.equal(refused(b).field, "builds[0].toolFixtures");
  });

  it("checks each clip: a public link, a caption, nothing extra", () => {
    const local = withTargets();
    local.product.extraClips[0].url = `${LOCAL}/clips/p1/quest.mp4`;
    assert.equal(refused(local).field, "product.extraClips[0].url");
    const noLink = withTargets();
    noLink.product.extraClips[0].url = null;
    assert.equal(refused(noLink).field, "product.extraClips[0].url");
    const noCaption = withTargets();
    noCaption.product.extraClips[0].caption = "";
    assert.equal(refused(noCaption).field, "product.extraClips[0].caption");
    const extra = withTargets();
    extra.product.extraClips[0].ownerId = randomUUID();
    assert.equal(refused(extra).field, "product.extraClips[0].ownerId");
  });

  it("finds a link back to the laptop in native events and clips", () => {
    const event = { type: "native", item: "check:android_emu", media: [{ kind: "video", url: `${LOCAL}/native/runs/r1/j1/clip.mp4`, caption: "On an emulator" }] };
    assert.equal(linkProblems({ payload: event }).length, 1);
    assert.equal(linkProblems({ extraClips: [{ url: `${LOCAL}/clips/p1/a.mp4` }] }).length, 1);
  });

  it("treats canned outputs like a brief: only a local file link counts inside them", () => {
    assert.deepEqual(linkProblems({ toolFixtures: { X: [{ url: "not a link" }] } }), []);
    assert.equal(linkProblems({ toolFixtures: { X: [{ url: `${LOCAL}/fixtures/b1/a.txt` }] } }).length, 1);
  });
});
