/**
 * With MAKE_CHAT_ALL off nothing changes (docs/TRAINING.md "One box for everything"): the Make page, the run room, the
 * plan step and the folder drop render byte for byte as they did before the switch's edits. Each render's SHA-256 was
 * taken from the code before those edits (fixtures/make-flag-off.json). The two new routes answer 404 before they read
 * anything, and /fine-tuning/new doesn't redirect. The build composer and the build room are held by
 * components/train/__tests__/tune-flag-off.test.tsx. The clock is frozen. Made-up data only.
 *
 *   npx tsx --test --experimental-test-module-mocks components/make/__tests__/make-flag-off.test.tsx
 *
 * MAKE_GOLDEN_WRITE=1 rewrites the fixture; run it only on code from before the edits it guards.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { after, before, describe, it, mock } from "node:test";
import { createElement, type ComponentType, type ReactNode } from "react";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
const FIXTURE = new URL("./fixtures/make-flag-off.json", import.meta.url);
const FROZEN = Date.parse("2026-11-01T12:00:00.000Z");
const savedEnv = { ...process.env };
const sha = (html: string) => ({ sha256: createHash("sha256").update(html).digest("hex"), length: html.length });

describe("with MAKE_CHAT_ALL off", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let renders: Array<[string, () => Promise<string>]> = [];
  let user: { id: string; email: string; isAdmin: boolean } | null = null;

  before(async () => {
    mock.timers.enable({ apis: ["Date"], now: FROZEN });
    process.env.DATABASE_URL = "postgres://make-flag-off.invalid/db";
    delete process.env.MAKE_CHAT_ALL;
    delete process.env.MODEL_API_KEY;
    mock.module("next/navigation", {
      namedExports: {
        notFound: () => {
          throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
        },
        redirect: (to: string) => {
          throw new Error(`redirect ${to}`);
        },
        unstable_rethrow: () => {},
        useRouter: () => ({ push() {}, refresh() {} }),
        usePathname: () => "/",
      },
    });
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/link", { defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }) });
    mock.module("@/components/camera/CameraCapture", { namedExports: { CameraCapture: () => null, useCameraSupported: () => false } });
    // The Make page's featured row (components/gallery/FeaturedProducts.tsx) imports a stylesheet, which Node can't load.
    register("data:text/javascript,export const load = (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);", import.meta.url);
    // No featured products here, so the row stays out and the page is the one the hashes stand for.
    mock.module(at("../../../lib/queries.ts"), { namedExports: { currentUser: async () => user, listShippedProducts: async () => [], safeQuery: async (fn: () => unknown) => ({ ok: true, data: await fn() }) } });
    // As on production: a Meta key and Sandbox credentials, so the setup banner (components/composer/BuildSetupBanner.tsx) stays out.
    const realQuota = (await import(at("../../../lib/quota.ts"))) as typeof import("../../../lib/quota");
    mock.module(at("../../../lib/quota.ts"), { namedExports: { ...realQuota, buildSetupRefusal: () => null } });

    const { renderToString } = await import("react-dom/server");
    const node = (n: ReactNode) => renderToString(n as never);
    const render = (c: ComponentType<never>, props: object) => node(createElement(c, props as never));
    const Home = (await import("@/app/page")).default as unknown as () => Promise<ReactNode>;
    const { TrainRoom } = await import("@/components/train/room/TrainRoom");
    const { PlanStep } = await import("@/components/train/compose/TrainComposer");
    const { FolderDrop } = await import("@/components/train/compose/FolderDrop");
    const { ROOM_FIXTURES, T0 } = await import("@/components/train/__tests__/tune-room-fixture");
    const room = (name: keyof typeof ROOM_FIXTURES) => async () => render(TrainRoom as ComponentType<never>, { initial: ROOM_FIXTURES[name].view, admin: true, serverNow: T0 });
    const settings = { examples: 200, recipe: "glimmer-lora", steps: 120, loraRank: 16, learningRate: 2e-4, studentPrompt: "short", publish: 0, gpu: "gpu_1x_a100_sxm4", maxMinutes: 90, maxUsd: 5 };
    const cost = { metaLowUsd: 3, metaHighUsd: 6, gpuMaxUsd: 5, scoreLowUsd: 0.2, scoreHighUsd: 0.5, minutes: 70, trainMinutes: 40 };
    const plan = { v: 1, kind: "chat", name: "a made-up bakery's counter helper", tagline: "Answers bakery questions.", task: "Answer questions for a made-up bakery.", samples: ["Open Sunday?"], examples: { given: 0, used: 0 }, settings, cost, source: { kind: "task" }, token: "t", exp: "2026-11-01T14:00:00.000Z" };
    const step = (phase: object, extra: object = {}) => async () =>
      render(PlanStep as ComponentType<never>, { phase, examples: 200, onExamples() {}, ceilings: { maxMinutes: 90, maxUsd: 5 }, starting: false, startError: null, onStart() {}, onChange() {}, ...extra });
    const ready = {
      hash: "a".repeat(64),
      draft: { mode: "rows", rows: [{ prompt: "Open Sunday?", answer: "8 to 2." }], grounding: "" },
      review: { used: [{ path: "faq.csv", rows: 40 }], skipped: [{ path: ".env", reason: "env_file" }], droppedRows: 1, removedLines: 2, cutRows: 3, samples: [{ prompt: "Open Sunday?", answer: "8 to 2." }] },
    };
    renders = [
      ["make page: signed out", async () => { user = null; return node(await Home()); }],
      ["make page: signed in", async () => { user = { id: "u1", email: "person@example.com", isAdmin: false }; return node(await Home()); }],
      ["run room: writing", room("writing")],
      ["run room: training", room("training")],
      ["run room: ready", room("ready")],
      ["plan step: drafting", step({ at: "drafting", note: "A made-up bakery helper.", files: [] })],
      ["plan step: plan", step({ at: "plan", note: "A made-up bakery helper.", files: [], plan })],
      ["plan step: visitor plan", step({ at: "plan", note: "A made-up bakery helper.", files: [], plan }, { visitor: { maxExamples: 100, maxSteps: 120 }, startCode: "" })],
      ["plan step: problem", step({ at: "problem", note: "A made-up bakery helper.", files: [], text: "No plan." })],
      ["folder drop: empty", async () => render(FolderDrop as ComponentType<never>, { ready: null, onReady() {} })],
      ["folder drop: reviewed", async () => render(FolderDrop as ComponentType<never>, { ready, onReady() {} })],
    ];
  });

  after(() => {
    mock.timers.reset();
    mock.restoreAll();
    process.env = savedEnv;
  });

  it("renders the Make page, the run room, the plan step and the folder drop exactly as before", async () => {
    const off: Record<string, { sha256: string; length: number }> = {};
    const html: Record<string, string> = {};
    for (const [name, fn] of renders) off[name] = sha((html[name] = await fn()));
    assert.match(html["make page: signed in"]!, /What should Muse make\?/);
    assert.match(html["make page: signed in"]!, /aria-label="Make it"/);
    if (process.env.MAKE_GOLDEN_WRITE === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(off, null, 2)}\n`);
      return;
    }
    assert.ok(existsSync(FIXTURE));
    assert.deepEqual(off, JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("keeps the new routes shut and /fine-tuning/new where it was, before reading anything", { skip: process.env.MAKE_GOLDEN_WRITE === "1" }, async () => {
    const post = (path: string) => new Request(`https://muse.example.com${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const intent = (await import("@/app/api/make/intent/route")).POST;
    const pair = (await import("@/app/api/make/pair/route")).POST;
    assert.equal((await intent(post("/api/make/intent"))).status, 404);
    assert.equal((await pair(post("/api/make/pair"))).status, 404);
    const { makeChatAllOn } = await import("@/lib/make/switch");
    assert.equal(makeChatAllOn(), false);
    process.env.TUNE_COMPOSER = "1";
    assert.equal(makeChatAllOn(), false, "TUNE_COMPOSER alone doesn't turn it on");
    delete process.env.TUNE_COMPOSER;
  });
});
