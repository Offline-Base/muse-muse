/**
 * With PLAN_ART off the plan card is exactly the one the owner asked for on Oct 31 (the whole brief, wrapping beside
 * and under the stock mascot), before the per-build picture was added: the build room at each stored build and the card
 * alone at each picture, running or not, render byte for byte as they did. Each render's SHA-256 and length were taken
 * from the code before the picture's edits (fixtures/plan-art-flag-off.json) and every render must match them, with the
 * flag off and on, since a build with no picture of its own renders the same either way. The clock is frozen. Made-up
 * data only.
 *
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/plan-art-flag-off.test.tsx
 *
 * PLAN_ART_GOLDEN_WRITE=1 rewrites the fixture; run it only on code from before the edits it guards.
 * Without --experimental-test-module-mocks, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const FIXTURE = new URL("./fixtures/plan-art-flag-off.json", import.meta.url);
const FROZEN = Date.parse("2026-11-01T12:00:00.000Z");
const saved = process.env.PLAN_ART;

let renders: Array<[string, () => string]> = [];
const sha = (html: string) => ({ sha256: createHash("sha256").update(html).digest("hex"), length: html.length });

describe("with PLAN_ART off", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.timers.enable({ apis: ["Date"], now: FROZEN });
    mock.module("next/navigation", {
      namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/b/x" },
    });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    const { renderToString } = await import("react-dom/server");
    const render = (c: ComponentType<never>, props: object) => renderToString(createElement(c, props as never));
    const { BuildRoom } = await import("@/components/build/BuildRoom");
    const { PlanCard } = await import("@/components/build/PlanCard");
    const { FIXTURES, brief, inspiration, tokens } = await import("@/components/build/__tests__/room-fixture");
    const room = (name: keyof typeof FIXTURES) => {
      const f = FIXTURES[name];
      return render(BuildRoom as ComponentType<never>, {
        build: f.build,
        product: f.product,
        inspiration,
        events: f.events,
        history: [],
        tokens,
        canRefine: name === "finished",
        canSteer: false,
        signedIn: true,
        origin: "https://musemuse.example",
        serverNow: Date.parse(f.build.startedAt) + 60_000,
        focusRefine: false,
        rebuild: null,
        maxFixRounds: 3,
      });
    };
    const card = (props: object) => () => render(PlanCard as ComponentType<never>, props);
    renders = [
      ["build room: running", () => room("running")],
      ["build room: failed", () => room("failed")],
      ["build room: finished", () => room("finished")],
      ["plan card: part of it, presenting, running", card({ brief, art: "present", running: true })],
      ["plan card: part of it, building, running", card({ brief, art: "building", running: true })],
      ["plan card: all of it, the pair, finished", card({ brief: { ...brief, verdict: "yes" }, art: "shield", running: false })],
      ["plan card: no one it's for, no steps or tagline", card({ brief: { ...brief, verdict: "yes", user: " ", tagline: "", primaryFlow: [" "] }, art: "present", running: false })],
    ];
  });

  after(() => {
    mock.timers.reset();
    mock.restoreAll();
    if (saved === undefined) delete process.env.PLAN_ART;
    else process.env.PLAN_ART = saved;
  });

  it("renders the build room and the plan card exactly as before the per-build picture, flag off and on", () => {
    delete process.env.PLAN_ART;
    const off: Record<string, { sha256: string; length: number }> = {};
    const html: Record<string, string> = {};
    for (const [name, fn] of renders) off[name] = sha((html[name] = fn()));
    // Real cards, with the stock mascot: what the hashes stand for.
    assert.match(html["build room: running"]!, /class="plan-card plan-card-wrap" data-art="building"/);
    assert.match(html["plan card: all of it, the pair, finished"]!, /<img class="is-on" src="\/muse\/muse-shield\.jpg" alt=""/);
    if (process.env.PLAN_ART_GOLDEN_WRITE === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(off, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof off;
    assert.deepEqual(Object.keys(off), Object.keys(golden));
    for (const name of Object.keys(golden)) assert.deepEqual(off[name], golden[name], `${name} changed with the flag off`);
    process.env.PLAN_ART = "1";
    for (const [name, fn] of renders) assert.deepEqual(sha(fn()), golden[name], `${name} reads the flag`);
  });
});
