/**
 * "Its own model" in the build room (components/build/OwnModelRow.tsx, docs/TRAINING.md "Fine-tune like a build", B):
 * the row shows only for a live or partial build whose brief picked muse-glimmer, with an offer from the page (the
 * flags on, the owner or an admin); its words are honest (Muse Wonder until the model passes and a window is open, an
 * estimate); Plan it opens the composer for that build, prefilled from the brief. The build page offers it only with
 * TUNE_FROM_BUILDS and TUNE_COMPOSER on and an owner or admin viewing (ownModelOffer), and without an offer the room
 * renders exactly as before (tune-flag-off.test.tsx checks the hashes). Made-up data only; the clock is frozen.
 *
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/own-model.test.tsx
 *
 * Without --experimental-test-module-mocks, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import type { Brief, BuildEvent } from "@/lib/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const FROZEN = Date.parse("2026-11-01T12:00:00.000Z");
const savedEnv = { ...process.env };

type Fixtures = typeof import("@/components/build/__tests__/room-fixture");
let fx: Fixtures;
let BuildRoom: ComponentType<never>;
let renderToString: (node: ReactNode) => string;
let fromBuild: typeof import("@/lib/train/tune/from-build");

const offer = { examples: 200, ceilings: { maxMinutes: 90, maxUsd: 5 }, canPlan: true };

function glimmerBrief(base: Brief): Brief {
  return {
    ...base,
    capabilities: [...base.capabilities, { need: "Answer bird questions the way a local guide would", model: "muse-glimmer", why: "Its own tuned model" }],
  };
}

describe("Its own model", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.timers.enable({ apis: ["Date"], now: FROZEN });
    mock.module("next/navigation", {
      namedExports: {
        notFound: () => {
          throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
        },
        useRouter: () => ({ push() {}, refresh() {} }),
        usePathname: () => "/b/x",
        unstable_rethrow: () => {},
      },
    });
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module("@/components/camera/CameraCapture", { namedExports: { CameraCapture: () => null, useCameraSupported: () => false } });
    ({ renderToString } = (await import("react-dom/server")) as unknown as { renderToString: (node: ReactNode) => string });
    fx = await import("@/components/build/__tests__/room-fixture");
    ({ BuildRoom } = (await import("@/components/build/BuildRoom")) as unknown as { BuildRoom: ComponentType<never> });
    fromBuild = await import("@/lib/train/tune/from-build");
  });

  after(() => {
    mock.timers.reset();
    mock.restoreAll();
    process.env = savedEnv;
  });

  /** A fixture build with its brief (on the row and in its brief events) swapped for `brief`. */
  const withBrief = (name: "finished" | "running", brief: Brief) => {
    const f = fx.FIXTURES[name];
    const events = f.events.map((e) => (e.type === "brief" ? ({ ...e, brief } as BuildEvent) : e));
    return { build: { ...f.build, brief }, product: f.product, events };
  };
  const roomProps = (f: ReturnType<typeof withBrief>, ownModel: unknown) => ({
    build: f.build,
    product: f.product,
    inspiration: fx.inspiration,
    events: f.events,
    history: [],
    tokens: fx.tokens,
    canRefine: true,
    canSteer: false,
    signedIn: true,
    origin: "https://musemuse.example",
    serverNow: Date.parse(f.build.startedAt) + 60_000,
    focusRefine: false,
    rebuild: null,
    maxFixRounds: 3,
    nativeActive: false,
    ...(ownModel === undefined ? {} : { ownModel }),
  });
  // React puts <!-- --> between text pieces; the checks read the text without them.
  const room = (f: ReturnType<typeof withBrief>, ownModel?: unknown) => renderToString(createElement(BuildRoom, roomProps(f, ownModel) as never));
  const text = (html: string) => html.replace(/<!-- -->/g, "");

  it("shows the row for a shipped build whose brief picked Muse Glimmer, in honest words, with Plan it for that build", () => {
    const f = withBrief("finished", glimmerBrief(fx.brief));
    const html = text(room(f, offer));
    assert.match(html, /<li class="room-answer own-model">/);
    assert.match(html, /<strong>Its own model<\/strong>/);
    assert.match(html, /trained for what its brief asked of it: Answer bird questions the way a local guide would\./);
    assert.match(html, /write about 200 examples, train on one GPU, and score the tuned model against the base/);
    assert.match(html, /It keeps answering with Muse Wonder[^<]* until its own model passes and a serving window is open\./);
    assert.match(html, /an estimate, not a promise/);
    assert.match(html, /It takes (<!-- -->)?about an hour(<!-- -->)? and costs up to about/);
    assert.doesNotMatch(html, /[Aa]bout (<!-- -->)?about/, "never 'About about'");
    assert.match(html, /Nothing starts until you press Start\./);
    assert.match(html, new RegExp(`<a class="btn btn-outline" href="/fine-tuning/new\\?fromBuild=${f.build.id}">Plan it</a>`));
    assert.ok(!html.includes("—"), "no em dashes in the copy");
    // It sits after the answer, under the shipped product.
    assert.ok(html.indexOf("own-model") > html.indexOf("room-meta"), "after the answer's last line");

    const noPlan = text(room(f, { ...offer, canPlan: false }));
    assert.match(noPlan, /Only admins can plan and start training today\./);
    assert.ok(!noPlan.includes("Plan it"));
  });

  it("shows nothing while the build runs, for a brief without Muse Glimmer, or without an offer", () => {
    const running = withBrief("running", glimmerBrief(fx.brief));
    assert.equal(room(running, offer), room(running), "a running build has no row");
    const plain = withBrief("finished", fx.brief);
    assert.equal(room(plain, offer), room(plain), "a brief without muse-glimmer has no row");
    const glimmer = withBrief("finished", glimmerBrief(fx.brief));
    assert.equal(room(glimmer, null), room(glimmer), "no offer, no row");
    assert.ok(!room(glimmer).includes("own-model"));
  });

  it("is offered by the build page only with both flags on, to the owner or an admin, and planned by admins today", () => {
    const base = { fromBuilds: true, composer: true, hasProduct: true, ownerOrAdmin: true, isAdmin: true, examples: 200, ceilings: offer.ceilings };
    assert.deepEqual(fromBuild.ownModelOffer(base), offer);
    assert.deepEqual(fromBuild.ownModelOffer({ ...base, isAdmin: false }), { ...offer, canPlan: false }, "the owner sees it; planning is admins'");
    assert.equal(fromBuild.ownModelOffer({ ...base, fromBuilds: false }), null, "TUNE_FROM_BUILDS off: no offer, so the room is as before");
    assert.equal(fromBuild.ownModelOffer({ ...base, composer: false }), null, "it needs the composer too");
    assert.equal(fromBuild.ownModelOffer({ ...base, ownerOrAdmin: false, isAdmin: false }), null, "nobody else");
    assert.equal(fromBuild.ownModelOffer({ ...base, hasProduct: false }), null);
  });

  it("prefills the composer from the brief: what to learn, the product, who uses it and its steps", () => {
    const brief = glimmerBrief(fx.brief);
    const note = fromBuild.ownModelNote(brief);
    assert.equal(
      note,
      "Answer bird questions the way a local guide would. It answers inside Feeder Count: Counts and outlines the birds in a short feeder video. The people using it: Backyard bird watchers. In the product they go through: Upload a clip; See each bird outlined; Get a count.",
    );
    assert.ok(note.length >= 20 && note.length <= 1500);
    const long = fromBuild.ownModelNote({ ...brief, tagline: "x".repeat(2000) });
    assert.equal(long.length, 1500);
    assert.equal(fromBuild.glimmerNeed(fx.brief), null);
    assert.equal(fromBuild.glimmerNeed({ capabilities: [{ need: " ", model: "muse-glimmer", why: "" }] }), "the product's own answers");
    assert.equal(fromBuild.offersOwnModel(brief, "live"), true);
    assert.equal(fromBuild.offersOwnModel(brief, "partial"), true);
    assert.equal(fromBuild.offersOwnModel(brief, "building"), false);
    assert.equal(fromBuild.offersOwnModel(fx.brief, "live"), false);
    assert.equal(fromBuild.planFromBuildHref("33333333-3333-4333-8333-333333333333"), "/fine-tuning/new?fromBuild=33333333-3333-4333-8333-333333333333");
  });
});
