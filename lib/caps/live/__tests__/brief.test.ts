/** The live cap's brief block, writer rules, catalog, prompts and judge note (docs/CAPABILITIES.md, section 13). */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Brief } from "@/lib/brief/schema";
import { BriefSchema, newBriefSchemaFor } from "@/lib/brief/schema";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { briefCaps } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks } from "@/lib/caps/catalog";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { capsForBuild } from "@/lib/caps/ready";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { liveBlock, liveWriterRules, normalizeLiveBlock } from "@/lib/caps/live/brief";
import { liveCatalog } from "@/lib/caps/live/catalog";
import { liveJudgeNote } from "@/lib/caps/live/judge";
import { LIVE_RENDER } from "@/lib/caps/live/render";
import { capOverlaysNeeded, overlaysFor } from "@/lib/caps/overlays";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const DATA = { collections: [{ name: "scores", scope: "shared", writes: "anyone", holds: "A team's points", personal: false }], signIn: "none" };
const both = () => ({ ...BRIEF, data: DATA, live: { captions: true, updates: { collection: "scores" } } }) as unknown as Brief;
const captionsOnly = () => ({ ...BRIEF, live: { captions: true, updates: null } }) as unknown as Brief;
const updatesOnly = () => ({ ...BRIEF, data: DATA, live: { captions: false, updates: { collection: "scores" } } }) as unknown as Brief;

beforeEach(() => {
  delete process.env.LIVE_UPDATES;
  delete process.env.LIVE_ENABLED;
});

describe("the product's privacy page", () => {
  it("says where the microphone's audio goes when the brief has captions, and only then", async () => {
    const { productPrivacyFor } = await import("@/lib/trust/overlay");
    assert.match(JSON.stringify(productPrivacyFor(captionsOnly())), /what your microphone picks up goes to Muse Voice Transcribe/);
    process.env.LIVE_UPDATES = "1";
    assert.doesNotMatch(JSON.stringify(productPrivacyFor(updatesOnly())), /microphone/);
    assert.doesNotMatch(JSON.stringify(productPrivacyFor(BRIEF as unknown as Brief)), /microphone/);
  });
});

describe("the block", () => {
  it("is what the contract says, optional in a stored brief", () => {
    assert.equal(BriefSchema.safeParse(BRIEF).success, true);
    assert.equal(BriefSchema.safeParse({ ...BRIEF, live: null }).success, true);
    assert.equal(BriefSchema.safeParse({ ...BRIEF, live: { captions: true, updates: { collection: "scores" } } }).success, true);
    assert.equal(BriefSchema.safeParse({ ...BRIEF, live: { captions: "yes", updates: null } }).success, false);
    assert.deepEqual(briefCaps(captionsOnly()), ["live"]);
  });

  it("is required but nullable in the writer's schema only while the cap is on", () => {
    const on = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["live"], milestones: false }) as unknown as { shape: Record<string, unknown> };
    assert.ok(on.shape.live);
    const off = newBriefSchemaFor({ gadgets: false, targets: [], caps: [], milestones: false }) as unknown as { shape: Record<string, unknown> };
    assert.equal(off.shape.live, undefined);
  });

  it("gets its overlay and token marker", () => {
    assert.deepEqual(overlaysFor(captionsOnly()), ["core", "live"]);
    assert.ok(allowedModelsFor(captionsOnly()).includes("cap:live"));
    assert.ok(allowedModelsFor(captionsOnly()).includes("muse-voice-transcribe-1.0"), "captions need the voice model on the token");
    assert.ok(!allowedModelsFor(updatesOnly()).includes("muse-voice-transcribe-1.0"));
    assert.deepEqual(allowedModelsFor(BRIEF), BRIEF.capabilities.map((c) => c.model).filter((m) => m !== "muse-glimmer"), "no live block, today's list");
    assert.deepEqual(capOverlaysNeeded("live"), ["core", "live"]);
  });
});

describe("what the platform can serve", () => {
  it("leaves updates out with LIVE_UPDATES off, or a collection the data block doesn't list", () => {
    assert.deepEqual(liveBlock(both(), true), { captions: true, updates: { collection: "scores" } });
    assert.deepEqual(liveBlock(both(), false), { captions: true, updates: null });
    assert.deepEqual(liveBlock({ data: DATA, live: { captions: true, updates: { collection: "other" } } }, true), { captions: true, updates: null });
    assert.deepEqual(liveBlock({ live: { captions: true, updates: { collection: "scores" } } }, true), { captions: true, updates: null }, "no data block");
  });

  it("is null when nothing is left, or the block isn't one", () => {
    assert.equal(liveBlock(updatesOnly(), false), null);
    assert.equal(liveBlock({ live: { captions: false, updates: null } }, true), null);
    assert.equal(liveBlock({ live: { nonsense: true } }, true), null);
    assert.equal(liveBlock({}, true), null);
    assert.equal(liveBlock(null, true), null);
  });

  it("capsForBuild drops the cap when nothing is left, and keeps captions when only the data cap goes", () => {
    process.env.LIVE_UPDATES = "1";
    const dropped = (brief: Brief, enabled: ("data" | "live")[]) => capsForBuild(brief, { enabled, onSite: enabled, served: enabled }).dropped;
    assert.deepEqual(dropped(both(), ["data", "live"]), []);
    assert.deepEqual(dropped(updatesOnly(), ["data", "live"]), []);
    assert.deepEqual(dropped(both(), ["live"]), [{ cap: "data", reason: "off" }], "captions still stand");
    const noData = capsForBuild(both(), { enabled: ["live"], onSite: ["live"] }).brief;
    assert.deepEqual(liveBlock(noData), { captions: true, updates: null }, "the working copy has no updates");
    assert.deepEqual(dropped(updatesOnly(), ["live"]), [{ cap: "data", reason: "off" }, { cap: "live", reason: "off" }]);
    delete process.env.LIVE_UPDATES;
    assert.deepEqual(dropped(updatesOnly(), ["data", "live"]), [{ cap: "live", reason: "off" }]);
  });

  it("a stored brief's refinement drops it the same way", () => {
    assert.deepEqual(capsForBuild(updatesOnly(), { kind: "refine", served: ["data", "live"] }).dropped, [{ cap: "live", reason: "off" }]);
  });
});

describe("the writer", () => {
  it("names updates only while they're on, and never a voice conversation", () => {
    assert.match(liveWriterRules(true).join("\n"), /live\.updates: \{collection\} when/);
    assert.match(liveWriterRules(false).join("\n"), /live\.updates: always null/);
    assert.match(liveWriterRules(true).join("\n"), /Two-way voice isn't available/);
  });

  it("cleans the raw block", () => {
    const data = { collections: [{ name: "scores" }] };
    assert.deepEqual(normalizeLiveBlock({ captions: "yes", updates: null }, data, true), { captions: true, updates: null });
    assert.deepEqual(normalizeLiveBlock({ captions: true, updates: "scores" }, data, true), { captions: true, updates: { collection: "scores" } });
    assert.deepEqual(normalizeLiveBlock({ captions: true, updates: { collection: "scores" } }, data, false), { captions: true, updates: null });
    assert.deepEqual(normalizeLiveBlock({ captions: true, updates: { collection: "nope" } }, data, true), { captions: true, updates: null });
    assert.equal(normalizeLiveBlock({ captions: false, updates: { collection: "nope" } }, data, true), null);
    assert.equal(normalizeLiveBlock({ updates: null }, data, true), null);
    assert.equal(normalizeLiveBlock("nonsense", data, true), "nonsense", "left for zod to report");
  });

  it("normalizeRawBrief reads the data block it cleaned", () => {
    process.env.LIVE_UPDATES = "1";
    const raw = normalizeRawBrief({ ...BRIEF, data: DATA, live: { captions: false, updates: { collection: "scores" } } }, []) as { live: unknown };
    assert.deepEqual(raw.live, { captions: false, updates: { collection: "scores" } });
    const none = normalizeRawBrief({ ...BRIEF, live: { captions: false, updates: { collection: "scores" } } }, []) as { live: unknown };
    assert.equal(none.live, null);
  });
});

describe("the catalog", () => {
  it("says the contract's line, and names updates only while they're on", () => {
    assert.match(liveCatalog(false).block, /Near-live captions: the browser sends 2 to 3 second pieces, so text appears a few seconds behind\. No two-way voice conversation yet\./);
    assert.ok(!/updates:/.test(liveCatalog(false).block));
    assert.match(liveCatalog(true).block, /updates: changes to a saved collection/);
    assert.equal(liveCatalog(false).name, "near-live captions");
  });

  it("joins the catalog's blocks only when enabled", () => {
    assert.deepEqual(capsCatalogBlocks([]), []);
    assert.ok(capsCatalogBlocks(["live"]).join("\n").includes("Near-live captions"));
  });
});

describe("the prompts", () => {
  it("are empty for a block with nothing to serve", () => {
    assert.deepEqual(LIVE_RENDER.build(updatesOnly()), []);
    assert.deepEqual(LIVE_RENDER.refine!(updatesOnly()), []);
    assert.deepEqual(LIVE_RENDER.markdown!(updatesOnly()), []);
    assert.equal(liveJudgeNote(updatesOnly()), "");
    assert.ok(!capsJudgeNotes(updatesOnly()).includes("Second browser live"));
  });

  it("say what the contract's order asks, for captions", () => {
    const text = LIVE_RENDER.build(captionsOnly()).join("\n");
    for (const needle of ["near-live captions", "muse-voice-transcribe-1.0", "muse-live/SKILL.md", "useCaptions()", "CAPTIONS_NOTICE", "must come from the person's click", "Privacy", "a few seconds behind", "fixtures/talk.wav", "checkCaptions", "platform files"]) assert.ok(text.includes(needle), needle);
    assert.ok(!text.includes("useLive"));
    assert.ok(!text.includes("checkLiveUpdate"));
  });

  it("say what the contract's order asks, for updates, with the collection's own scope", () => {
    process.env.LIVE_UPDATES = "1";
    const text = LIVE_RENDER.build(updatesOnly()).join("\n");
    for (const needle of ['useLive("scores", "shared")', "scores is shared", "data()", "at most 20", "checkLiveUpdate", "within 5 seconds with no reload"]) assert.ok(text.includes(needle), needle);
    assert.ok(!text.includes("useCaptions"));
    assert.deepEqual(LIVE_RENDER.markdown!(both()), ["- Near-live captions, a few seconds behind", "- Live updates of scores, with no reload"]);
    assert.match(LIVE_RENDER.refine!(both()).join("\n"), /live updates of scores/);
  });

  it("tell the judge the recording is a sample and the second browser didn't reload", () => {
    process.env.LIVE_UPDATES = "1";
    const note = capsJudgeNotes(both());
    assert.match(note, /Captions came from a sample recording/);
    assert.match(note, /'Second browser live' was taken without a reload/);
    assert.ok(!/reload/.test(liveJudgeNote(captionsOnly())));
  });

  it("have no em dash anywhere a person reads", () => {
    process.env.LIVE_UPDATES = "1";
    const all = [...LIVE_RENDER.build(both()), ...LIVE_RENDER.refine!(both()), ...LIVE_RENDER.markdown!(both()), ...liveWriterRules(true), liveCatalog(true).block, liveJudgeNote(both())].join("\n");
    assert.ok(!all.includes("—"));
  });
});
