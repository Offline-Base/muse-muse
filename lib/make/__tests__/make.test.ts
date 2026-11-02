/**
 * The spending, access and privacy rules of the one box for everything (docs/TRAINING.md "One box for everything"). Made-up
 * data only, nothing reaches Meta, Lambda or a database.
 *
 *   npx tsx --test lib/make/__tests__/make.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthError } from "@/lib/auth";
import { appNoteFor, connectMode } from "@/lib/make/connect";
import { mayAskForModel, settleIntent } from "@/lib/make/intent";
import { linkRun, type LinkDeps, type PairBuild } from "@/lib/make/pair";
import { pairedRunFor, type PairedRunDeps } from "@/lib/make/paired-run";
import type { RunCaller } from "@/lib/train/tune/caller";
import type { TuneRunView } from "@/lib/train/tune/types";

const NOTE = "Answer questions for a made-up bakery, warm and short.";
const reply = (kind: "product" | "model" | "both", appNote: string | null, modelNote: string | null) => ({ reason: "made up", kind, appNote, modelNote });

describe("which way a sentence goes", () => {
  it("makes no model call for a sentence with no word about a model", () => {
    for (const note of ["A tracker for my made-up plants", "A site for my band", "Train schedule app for commuters"]) assert.equal(mayAskForModel(note), false, note);
  });

  it("asks when a sentence might mean a model", () => {
    for (const note of ["Fine-tune a model for my bakery", "tune glimmer on my notes", "train a model on these", "An app and a tuned LoRA"]) assert.equal(mayAskForModel(note), true, note);
  });

  it("treats a folder as data for a model, so it never goes on as a plain product", () => {
    assert.equal(settleIntent(reply("product", null, null), NOTE, true).kind, "both");
    assert.equal(settleIntent(reply("product", null, null), NOTE, false).kind, "product");
  });

  it("gives a model request no app, and a model note the plan route accepts", () => {
    const d = settleIntent(reply("model", "ignored", "short"), NOTE, false);
    assert.equal(d.appNote, null);
    assert.equal(d.modelNote, NOTE);
  });

  it("falls back to the person's words for both", () => {
    const d = settleIntent(reply("both", null, null), NOTE, false);
    assert.equal(d.appNote, NOTE);
    assert.equal(d.modelNote, NOTE);
  });
});

describe("how the app and the model connect", () => {
  it("is a real link only for an admin with both switches on", () => {
    assert.equal(connectMode({ isAdmin: true, fromBuilds: true, gpuForBuilds: true }), "window");
    assert.equal(connectMode({ isAdmin: false, fromBuilds: true, gpuForBuilds: true }), "none");
    assert.equal(connectMode({ isAdmin: true, fromBuilds: false, gpuForBuilds: true }), "none");
    assert.equal(connectMode({ isAdmin: true, fromBuilds: true, gpuForBuilds: false }), "none");
  });

  it("asks a build for Muse Glimmer only where it could really use it", () => {
    assert.equal(appNoteFor("An app", "none"), "An app");
    assert.match(appNoteFor("An app", "window"), /Muse Glimmer/);
  });
});

describe("linking a run to its build's product", () => {
  const live: PairBuild = { userId: "u", productId: "p", status: "live", brief: { capabilities: [{ need: "made up", model: "muse-glimmer", why: "made up" }] } };
  const deps = (over: Partial<LinkDeps> = {}) => {
    const calls = { saved: 0, reserved: 0, given: 0 };
    const d: LinkDeps = {
      fromBuilds: true,
      readProduct: (async () => null) as unknown as LinkDeps["readProduct"],
      saveProduct: (async () => {
        calls.saved++;
      }) as unknown as LinkDeps["saveProduct"],
      reserve: (async () => {
        calls.reserved++;
        return 1;
      }) as unknown as LinkDeps["reserve"],
      giveBack: (async () => {
        calls.given++;
      }) as unknown as LinkDeps["giveBack"],
      ...over,
    };
    return { d, calls };
  };
  const input = (caller: Pick<RunCaller, "isAdmin" | "visitor">, build: PairBuild = live) => ({ caller, runId: "r", buildId: "b", build, now: new Date("2026-11-01T12:00:00Z") });
  const admin = { isAdmin: true, visitor: null } as unknown as Pick<RunCaller, "isAdmin" | "visitor">;

  it("never links for a non-admin or a visitor, and takes nothing from the product's day", async () => {
    const { d, calls } = deps();
    assert.equal(await linkRun(input({ isAdmin: false, visitor: null } as unknown as Pick<RunCaller, "isAdmin" | "visitor">), d), "off");
    assert.equal(await linkRun(input({ isAdmin: true, visitor: { ip: "203.0.113.1" } } as unknown as Pick<RunCaller, "isAdmin" | "visitor">), d), "off");
    assert.deepEqual(calls, { saved: 0, reserved: 0, given: 0 });
  });

  it("stays off without TUNE_FROM_BUILDS", async () => {
    assert.equal(await linkRun(input(admin), deps({ fromBuilds: false }).d), "off");
  });

  it("waits for a finished build", async () => {
    const { d, calls } = deps();
    assert.equal(await linkRun(input(admin, { ...live, status: "building" }), d), "not_yet");
    assert.equal(await linkRun(input(admin, { ...live, productId: null }), d), "not_yet");
    assert.equal(calls.reserved, 0);
  });

  it("refuses a brief that didn't pick Muse Glimmer", async () => {
    const { d, calls } = deps();
    assert.equal(await linkRun(input(admin, { ...live, brief: { capabilities: [{ need: "made up", model: "muse-wonder-1.0", why: "made up" }] } }), d), "no_glimmer");
    assert.equal(calls.reserved, 0);
  });

  it("holds a product to one run a day", async () => {
    const { d, calls } = deps({ reserve: (async () => null) as unknown as LinkDeps["reserve"] });
    assert.equal(await linkRun(input(admin), d), "product_daily");
    assert.equal(calls.saved, 0);
  });

  it("gives the day back when saving fails", async () => {
    const { d, calls } = deps({
      saveProduct: (async () => {
        throw new Error("made up");
      }) as unknown as LinkDeps["saveProduct"],
    });
    await assert.rejects(linkRun(input(admin), d));
    assert.equal(calls.given, 1);
  });

  it("links once", async () => {
    const { d, calls } = deps();
    assert.equal(await linkRun(input(admin), d), "linked");
    assert.equal(calls.saved, 1);
    const again = deps({ readProduct: (async () => "p") as unknown as LinkDeps["readProduct"] });
    assert.equal(await linkRun(input(admin), again.d), "linked");
    assert.equal(again.calls.reserved, 0);
  });
});

describe("who sees the model in a public build room", () => {
  const view = { id: "r", stage: "training", job: { logTail: "made up", instanceIp: "203.0.113.9" } } as unknown as TuneRunView;
  const deps = (over: Partial<PairedRunDeps> = {}): PairedRunDeps => ({
    caller: async () => ({ isAdmin: false, visitor: null, id: "someone" }) as unknown as RunCaller,
    runs: async () => ["r"],
    owner: async () => "owner",
    mayTouch: async () => false,
    load: async () => view,
    ...over,
  });

  it("shows nothing to someone who may not touch the run, and never loads it", async () => {
    let loaded = 0;
    const out = await pairedRunFor(
      "b",
      new Date(),
      deps({
        load: async () => {
          loaded++;
          return view;
        },
      }),
    );
    assert.equal(out, null);
    assert.equal(loaded, 0);
  });

  it("shows nothing to someone not signed in, as the room always was", async () => {
    const out = await pairedRunFor(
      "b",
      new Date(),
      deps({
        caller: async () => {
          throw new AuthError("made up", 401);
        },
      }),
    );
    assert.equal(out, null);
  });

  it("does nothing at all for a build with no pair", async () => {
    let asked = 0;
    const out = await pairedRunFor(
      "b",
      new Date(),
      deps({
        runs: async () => [],
        caller: async () => {
          asked++;
          return {} as RunCaller;
        },
      }),
    );
    assert.equal(out, null);
    assert.equal(asked, 0);
  });

  it("skips a run that no longer exists", async () => {
    assert.equal(await pairedRunFor("b", new Date(), deps({ owner: async () => false, mayTouch: async () => true })), null);
  });

  it("gives its owner the run, without the link control", async () => {
    const out = await pairedRunFor("b", new Date(), deps({ mayTouch: async () => true }));
    assert.equal(out?.run.id, "r");
    assert.equal(out?.canLink, false);
  });

  it("shows nothing when the run can't be loaded", async () => {
    assert.equal(await pairedRunFor("b", new Date(), deps({ mayTouch: async () => true, load: async () => null })), null);
  });
});
