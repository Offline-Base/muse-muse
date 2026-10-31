/**
 * The usage page's device lab card. With NATIVE_LAB off it asks nothing of anyone, not even who's looking. With it on it's for
 * admins only, and shows what the lab has cost against its caps and how each box is doing.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/lab-card.test.tsx
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as realSchema from "@/lib/db/schema";
import { LabCard, type LabCardData } from "@/components/usage/LabCard";
import type { LabView } from "@/lib/native/lab-box";
import type { TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const SAVED = { ...process.env };
const NOW = Date.parse("2026-11-02T12:00:00Z");

function lab(over: Partial<LabView>): LabView {
  return { lane: "mac", known: true, online: true, lastSeenAt: new Date(NOW - 5000), version: "0.1.0", running: [], queued: 0, claimed: 0, control: {}, ...over };
}

function data(over: Partial<LabCardData> = {}): LabCardData {
  const lane = (reservedUsd: number, committedUsd: number, capUsd: number | null) => ({ reservedUsd, committedUsd, usedUsd: reservedUsd + committedUsd, capUsd });
  return {
    spend: {
      lanes: { mac: lane(0, 62.4, null), windows: lane(0.17, 1.05, 15), device_farm: lane(0, 6.8, 40), total: lane(0.17, 70.25, 150) },
      alertUsd: 120,
      alerting: false,
    },
    labs: [lab({ lane: "mac", claimed: 1, queued: 2 }), lab({ lane: "windows", online: false, lastSeenAt: new Date(NOW - 3_600_000), control: { boxState: "stopped", stopReason: "idle" } })],
    now: NOW,
    ...over,
  };
}

describe("the device lab card", () => {
  it("shows spend against the caps, and each box", () => {
    const html = renderToStaticMarkup(<LabCard data={data()} />);
    assert.match(html, /Device lab/);
    assert.match(html, /\$70\.42/);
    assert.match(html, /of the \$150\.00 limit/);
    assert.match(html, /\$62\.40/);
    assert.match(html, />None</);
    assert.match(html, /\$40\.00/);
    assert.match(html, /\$15\.00/);
    assert.match(html, /Online/);
    assert.match(html, /EC2 says stopped/);
    assert.match(html, /after 30 idle minutes/);
    assert.doesNotMatch(html, /alert line/);
    assert.ok(!html.includes("—"), "no em dashes in what people read");
  });

  it("says when spend is past the alert line", () => {
    const base = data();
    const html = renderToStaticMarkup(<LabCard data={data({ spend: { ...base.spend, alerting: true } })} />);
    assert.match(html, /Past the \$120\.00 alert line/);
  });

  it("says when a box has never spoken or isn't set up", () => {
    const html = renderToStaticMarkup(
      <LabCard data={data({ labs: [lab({ lane: "mac", online: false, lastSeenAt: null, version: null }), lab({ lane: "windows", known: false, online: false, lastSeenAt: null })] })} />,
    );
    assert.match(html, /Never heard from/);
    assert.match(html, /Not set up/);
    assert.match(html, /None yet/);
  });
});

describe("loading the card", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let testDb: TestDb;
  let close: () => Promise<void>;
  let viewer: { id: string; email: string; isAdmin: boolean } | null = null;
  let asked = 0;
  let queried = 0;
  let loadLabCard: typeof import("@/lib/native/lab-card").loadLabCard;

  before(async () => {
    const helpers = await import("./helpers");
    ({ db: testDb, close } = await helpers.makeTestDb());
    mock.module(at("../../db/client.ts"), {
      namedExports: {
        db: () => {
          queried += 1;
          return testDb;
        },
        schema: realSchema,
      },
    });
    mock.module(at("../../auth.ts"), {
      namedExports: {
        requireUser: async () => {
          asked += 1;
          if (!viewer) throw new Error("Sign in.");
          return viewer;
        },
      },
    });
    ({ loadLabCard } = await import(at("../lab-card.ts")));
  });
  after(async () => {
    await close();
    process.env = { ...SAVED };
  });
  beforeEach(() => {
    asked = 0;
    queried = 0;
    viewer = { id: "a", email: "owner@example.com", isAdmin: true };
  });

  it("with the lab off it's null, and asks nobody anything", async () => {
    process.env.NATIVE_LAB = "";
    assert.equal(await loadLabCard(), null);
    assert.equal(asked, 0);
    assert.equal(queried, 0);
  });

  it("shows nothing to anyone but an admin", async () => {
    process.env.NATIVE_LAB = "1";
    viewer = { id: "g", email: "guest@example.com", isAdmin: false };
    assert.equal(await loadLabCard(), null);
    viewer = null;
    assert.equal(await loadLabCard(), null);
    assert.equal(queried, 0);
  });

  it("gives an admin the spend and both boxes, with nothing set up yet", async () => {
    process.env.NATIVE_LAB = "1";
    const card = await loadLabCard(new Date(NOW));
    assert.ok(card);
    assert.equal(card.spend.lanes.total.capUsd, 150);
    assert.deepEqual(card.labs.map((l) => [l.lane, l.known]), [["mac", false], ["windows", false]]);
    assert.ok(renderToStaticMarkup(<LabCard data={card} />).includes("Not set up"));
  });
});
