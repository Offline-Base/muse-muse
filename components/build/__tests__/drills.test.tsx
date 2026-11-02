/**
 * The simulated outage drills as their own group (lib/edge/drills.ts, components/build/DrillGroup.tsx): split out of
 * verify's steps in the build room's checks and shown on the product page, with failures winning. A build that never
 * ran the drill renders exactly as before.
 *
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/drills.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DrillGroup } from "@/components/build/DrillGroup";
import { DRILL_GROUP_TITLE, DRILLS_EARLIER_NOTE, EDGE_DRILLS, latestDrills, splitDrillSteps } from "@/lib/edge/drills";
import { edgeDrillSteps } from "@/lib/pipeline/edge-build";
import type { VerifySummary } from "@/lib/types";

mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const json = (pass: boolean[]) => JSON.stringify({ simulated: true, results: pass.map((p, i) => ({ id: i + 1, name: "x", pass: p, ms: 1200 + i * 1000, why: p ? null : "the reply has no plain both-down message" })) });
/** The drill's steps as the drill step records them (edgeDrillSteps), so the tests read real step names. */
const drillSteps = (pass: boolean[], exitCode = pass.every(Boolean) ? 0 : 1) => edgeDrillSteps({ exitCode, timedOut: false, outputTail: "", json: json(pass) }).steps;
const VERIFY: VerifySummary["steps"] = [
  { name: "typecheck", ok: true, ms: 4000 },
  { name: "build", ok: true, ms: 30000 },
  { name: "smoke", ok: true, ms: 9000 },
];

let CheckBody: ComponentType<{ seg: never; live: boolean }>;
before(async () => {
  ({ CheckBody } = (await import("@/components/build/turns")) as unknown as { CheckBody: typeof CheckBody });
});

const checkSeg = (summary: VerifySummary) =>
  ({ key: "check:0", startAt: "2026-11-02T12:00:00.000Z", endAt: "2026-11-02T12:01:00.000Z", costUsd: 0, notes: [], type: "check", round: 0, index: 0, verify: { summary, screenshots: [] }, judge: null }) as never;

describe("splitDrillSteps", () => {
  it("leaves a build with no drill as it was", () => {
    const { checks, drills } = splitDrillSteps(VERIFY);
    assert.deepEqual(checks, VERIFY);
    assert.deepEqual(drills, []);
  });

  it("takes the four drills out of verify's steps, with their time and what each simulated", () => {
    const { checks, drills } = splitDrillSteps([...VERIFY, ...drillSteps([true, true, false, true])]);
    assert.deepEqual(checks, VERIFY);
    assert.deepEqual(drills.map((d) => [d.id, d.name, d.ok, d.ms]), [
      [1, "cloud refused", true, 1200],
      [2, "cloud hung", true, 2200],
      [3, "both down", false, 3200],
      [4, "tampered reply rejected", true, 4200],
    ]);
    assert.equal(drills[2]!.detail, "the reply has no plain both-down message");
    assert.deepEqual(drills.map((d) => d.simulated), EDGE_DRILLS.map((d) => d.simulated));
  });
});

describe("latestDrills", () => {
  it("is null for a build that never ran the drill", () => {
    assert.equal(latestDrills([]), null);
    assert.equal(latestDrills([{ steps: VERIFY }, { steps: VERIFY }]), null);
  });

  it("takes the newest round that ran it, and says when newer checks ran without it", () => {
    const first = { steps: [...VERIFY, ...drillSteps([true, false, true, true])] };
    const second = { steps: [...VERIFY, ...drillSteps([true, true, true, true])] };
    assert.deepEqual(latestDrills([first, second])?.drills.map((d) => d.ok), [true, true, true, true]);
    assert.equal(latestDrills([first, second])?.later, false);
    const failedVerify = { steps: [{ name: "build", ok: false }] };
    const r = latestDrills([first, second, failedVerify])!;
    assert.equal(r.later, true);
    assert.deepEqual(r.drills.map((d) => d.ok), [true, true, true, true]);
  });
});

describe("DrillGroup", () => {
  it("renders nothing without drills", () => {
    assert.equal(renderToStaticMarkup(<DrillGroup drills={[]} />), "");
  });

  it("shows each drill's name, pass, time and what it simulated under its own label", () => {
    const html = renderToStaticMarkup(<DrillGroup drills={splitDrillSteps(drillSteps([true, true, true, true])).drills} />);
    const t = text(html);
    assert.ok(t.startsWith(`${DRILL_GROUP_TITLE} Passed 4 of 4 passed`), t);
    assert.match(t, /Drill 1: cloud refused Passed 1\.2 s The cloud refused every connection/);
    assert.match(t, /Drill 2: cloud hung Passed 2\.2 s The cloud never answered/);
    assert.match(t, /Drill 3: both down Passed 3\.2 s/);
    assert.match(t, /Drill 4: tampered reply rejected Passed 4\.2 s/);
    assert.ok(!html.includes('class="bad"'));
    assert.match(html, /data-drills="passed"/);
  });

  it("lets a failed drill win: the group reads Failed and the drill shows why", () => {
    const html = renderToStaticMarkup(<DrillGroup drills={splitDrillSteps(drillSteps([true, true, false, true])).drills} />);
    const t = text(html);
    assert.ok(t.startsWith(`${DRILL_GROUP_TITLE} Failed 3 of 4 passed`), t);
    assert.match(t, /Drill 3: both down Failed 3\.2 s The cloud and the simulated board were both down[^.]*\. the reply has no plain both-down message/);
    assert.equal(html.match(/class="bad"/g)?.length, 1);
    assert.match(html, /data-drills="failed"/);
  });

  it("still shows a failure without the reason, as the product page does for anyone but the owner", () => {
    const html = renderToStaticMarkup(<DrillGroup drills={splitDrillSteps(drillSteps([true, true, false, true])).drills} why={false} />);
    const t = text(html);
    assert.ok(t.startsWith(`${DRILL_GROUP_TITLE} Failed 3 of 4 passed`), t);
    assert.match(t, /Drill 3: both down Failed 3\.2 s/);
    assert.equal(html.match(/class="bad"/g)?.length, 1);
    assert.ok(!t.includes("the reply has no plain both-down message"));
  });

  it("fails all four when the drill wrote nothing", () => {
    const steps = edgeDrillSteps({ exitCode: null, timedOut: true, outputTail: "", json: null }).steps;
    const t = text(renderToStaticMarkup(<DrillGroup drills={splitDrillSteps(steps).drills} />));
    assert.ok(t.startsWith(`${DRILL_GROUP_TITLE} Failed 0 of 4 passed`), t);
  });

  it("shows the product page's earlier-try note when given one", () => {
    const t = text(renderToStaticMarkup(<DrillGroup drills={splitDrillSteps(drillSteps([true, true, true, true])).drills} note={DRILLS_EARLIER_NOTE} />));
    assert.ok(t.includes(DRILLS_EARLIER_NOTE));
  });

  it("says nothing the messaging rules rule out", () => {
    const html = renderToStaticMarkup(<DrillGroup drills={splitDrillSteps(drillSteps([true, false, true, true])).drills} note={DRILLS_EARLIER_NOTE} />);
    assert.ok(!html.includes("—"));
    assert.ok(!/attack-proof|works offline|private|on-device/i.test(html));
  });
});

describe("the build room's checks", () => {
  it("are unchanged for a build that never ran the drill", () => {
    const html = renderToStaticMarkup(createElement(CheckBody, { seg: checkSeg({ passed: true, steps: VERIFY, failureOutput: "" }), live: false }));
    assert.ok(!html.includes("drills") && !html.includes(DRILL_GROUP_TITLE));
    assert.equal(html.match(/<li /g)?.length, 3);
  });

  it("show the drills as their own group after verify's steps, and a failed drill fails the check", () => {
    const summary: VerifySummary = { passed: false, steps: [...VERIFY, ...drillSteps([true, true, true, false])], failureOutput: "The simulated outage drills failed" };
    const html = renderToStaticMarkup(createElement(CheckBody, { seg: checkSeg(summary), live: false }));
    const verifyList = html.slice(0, html.indexOf('class="drills"'));
    assert.equal(verifyList.match(/<li /g)?.length, 3, "verify's own list keeps only its steps");
    assert.ok(!verifyList.includes("Simulated outage drill"));
    const t = text(html);
    assert.match(t, /npm run verify Failed/);
    assert.match(t, new RegExp(`${DRILL_GROUP_TITLE.replace(/[()]/g, "\\$&")} Failed 3 of 4 passed`));
    assert.match(t, /Drill 4: tampered reply rejected Failed 4\.2 s/);
  });
});
