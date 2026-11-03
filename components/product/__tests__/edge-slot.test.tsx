/**
 * The "Get it" panel's Edge slot: nothing for a product without the edge target, and only what the platform knows for one
 * with it. It never says a board answered.
 *   npx tsx --test components/product/__tests__/edge-slot.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { GetItPanel } from "@/components/product/GetItPanel";
import { boardLine, drillsLine, DRILLS_SECTION_ID, edgeSlots, type EdgeSlotContext } from "@/components/product/EdgeSlot";
import { latestDrills } from "@/lib/edge/drills";

const step = (id: number, name: string, ok: boolean) => ({ name: `Simulated outage drill ${id}: ${name}`, ok, ms: 120 });
const drills = (ok18 = true) =>
  latestDrills([
    {
      steps: [{ name: "build", ok: true }, step(1, "cloud refused", true), step(2, "cloud hung", true), step(3, "both down", true), step(4, "tampered reply rejected", true), step(17, "board status, board up", true), step(18, "board status, board down", ok18)],
    },
  ]);

const ctx = (over: Partial<EdgeSlotContext> = {}): EdgeSlotContext => ({
  slug: "cold-room-watcher",
  edge: true,
  looks: false,
  drills: drills(),
  fleetSam: false,
  fleetAllProducts: false,
  codeReadable: true,
  ...over,
});
const html = (c: EdgeSlotContext) => renderToString(<GetItPanel slots={edgeSlots(c)} />);

describe("the Edge slot", () => {
  it("is empty for a product without the edge target, so the panel stays away", () => {
    assert.deepEqual(edgeSlots(ctx({ edge: false })), { edge: null });
    assert.equal(html(ctx({ edge: false })), "");
  });

  it("says plainly that a hosted copy isn't connected to a board, and never that a board answered", () => {
    const out = html(ctx());
    assert.match(out, /Not connected to a board/);
    assert.match(out, /every answer comes from the cloud/);
    assert.ok(!/Connected to (?!a board)|Answered on|on-device|works offline|private/i.test(out), out);
    assert.ok(!out.includes("—"));
  });

  it("names the office board for a product that looks, only while FLEET_SAM is on, and who may use it", () => {
    assert.equal(boardLine({ looks: true, fleetSam: false, fleetAllProducts: false }).headline, "Not connected to a board");
    const on = boardLine({ looks: true, fleetSam: true, fleetAllProducts: false });
    assert.equal(on.headline, "No board for the main answer");
    assert.match(on.notes[1]!, /office Jetson through Muse Muse when the cloud can't answer, for products a Muse Muse admin made\. The product's own board line says whether that board answers right now\./);
    assert.match(on.notes[0]!, /that answer comes from the cloud/, "never says every answer is the cloud's while the look may reach the board");
    assert.ok(!/admin/.test(boardLine({ looks: true, fleetSam: true, fleetAllProducts: true }).notes[1]!));
    assert.equal(boardLine({ looks: false, fleetSam: true, fleetAllProducts: true }).notes.length, 1, "a product that doesn't look never reaches the office board");
  });

  it("shows the build's drills as simulated, with the ones that failed by name and a link to each", () => {
    assert.equal(drillsLine(drills()), "All 6 outage drills passed. They ran in the build's sandbox against a simulated board and a blocked cloud, not on a real board.");
    const out = html(ctx({ drills: drills(false) }));
    assert.match(out, /5 of 6 outage drills passed/);
    assert.match(out, /Didn&#x27;t pass: drill 18, board status, board down/);
    assert.ok(out.includes(`href="#${DRILLS_SECTION_ID}"`));
    assert.match(html(ctx({ drills: null })), /No outage drill ran for this build\./);
  });

  it("links the Code page as the run kit only when the source can be read", () => {
    const out = html(ctx({ looks: true }));
    assert.ok(out.includes('href="/p/cold-room-watcher/code"'));
    assert.match(out, /EDGE_SAM_URL/);
    const closed = html(ctx({ codeReadable: false }));
    assert.ok(!closed.includes("/code\""));
    assert.match(closed, /source isn&#x27;t shared/);
  });
});
