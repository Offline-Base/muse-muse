/** The rover view with a fake camera and a fake SAM board; made-up photos only. npx tsx --test lib/fleet/__tests__/rover-view.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROVER_VIEW, type RoverDeps, roverFrame, roverSvg } from "@/lib/fleet/rover-view";
import { renderDisplay } from "@/lib/fleet/display";

const PHOTO = "/9j/" + "A".repeat(400);
const OUTLINED = "/9j/" + "B".repeat(400);
const SAM = { url: "https://cp.example/admin", token: "jpt_test", node: "jetson-04" };

function deps(over: Partial<RoverDeps> = {}) {
  const seen = { looks: 0, released: 0, captureArgs: null as unknown };
  const d: RoverDeps = {
    camera: () => ({ url: "https://board.example/mcp", token: "t" }),
    sam: () => SAM,
    capture: async (_c, args) => {
      seen.captureArgs = args;
      return { isError: false, content: [{ type: "image", data: PHOTO, mimeType: "image/jpeg" }] };
    },
    look: async (_s, look) => {
      seen.looks++;
      assert.equal(look.b64, PHOTO);
      assert.equal(look.overlay, true);
      return { count: 2, overlay_jpeg_b64: OUTLINED };
    },
    hitRateLimits: async () => ({ "fleetsam:rover": 1 }),
    acquireInFlight: async () => new Date(0),
    releaseInFlight: async () => {
      seen.released++;
    },
    ...over,
  };
  return { d, seen };
}

describe("rover view", () => {
  it("takes a photo, has SAM outline it, and holds and frees the board's one slot", async () => {
    const { d, seen } = deps();
    const f = await roverFrame(d, "box");
    assert.equal(f.jpegB64, OUTLINED);
    assert.equal(f.outlined, true);
    assert.equal(f.count, 2);
    assert.deepEqual(seen.captureArgs, { width: ROVER_VIEW.width, height: ROVER_VIEW.height });
    assert.equal(seen.released, 1);
    const svg = roverSvg(f, "box", new Date("2026-11-04T03:41:00Z"));
    assert.match(svg, /2 “box” outlined by Meta SAM 3.1/);
    assert.match(svg, /Photo at 10:41 PM/);
    assert.ok(svg.includes(`base64,${OUTLINED}`));
  });

  it("shows the plain photo, and says why, when SAM can't look", async () => {
    const busy = await roverFrame(deps({ acquireInFlight: async () => null }).d, "box");
    assert.equal(busy.jpegB64, PHOTO);
    assert.equal(busy.outlined, false);
    assert.match(busy.note, /busy/);
    const spent = await roverFrame(deps({ hitRateLimits: async () => ({ "fleetsam:rover": ROVER_VIEW.perDay + 1 }) }).d, "box");
    assert.match(spent.note, /today's looks/);
    const { d, seen } = deps({ look: async () => { throw new Error("timeout"); } });
    const slow = await roverFrame(d, "box");
    assert.match(slow.note, /didn't answer/);
    assert.equal(seen.released, 1, "the slot is freed after a failure");
    assert.match((await roverFrame(deps({ sam: () => null }).d, "box")).note, /isn't connected/);
    const odd = deps();
    assert.match((await roverFrame(odd.d, "box; rm -rf /")).note, /prompt/);
    assert.equal(odd.seen.looks, 0, "an odd prompt never reaches the board");
    assert.match(roverSvg(busy, "box", new Date()), /Camera only: SAM 3.1 is busy/);
  });

  it("says so with no photo, and never throws", async () => {
    assert.equal((await roverFrame(deps({ camera: () => null }).d, "box")).jpegB64, null);
    const err = await roverFrame(deps({ capture: async () => { throw new Error("down"); } }).d, "box");
    assert.match(err.note, /didn't answer/);
    const notJpeg = await roverFrame(deps({ capture: async () => ({ isError: false, content: [{ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" }] }) }).d, "box");
    assert.match(notJpeg.note, /didn't send a photo/);
    assert.match(roverSvg(notJpeg, "box", new Date()), /<rect/);
    assert.match(roverSvg(notJpeg, "box", new Date()), /Checked at/);
    const said = await roverFrame(deps({ capture: async () => ({ isError: true, content: [{ type: "text", text: "No camera found at https://10.0.0.5:8790 (token jpt_secret)" }] }) }).d, "box");
    assert.match(said.note, /No camera found/);
    assert.ok(!said.note.includes("10.0.0.5") && !said.note.includes("jpt_"), said.note);
  });

  it("puts the rover's view below the display only when asked", () => {
    const data = { boards: [], note: null, history: null, totals: { online: 1, total: 1, powerW: 3, tokensToday: 0, tokensPerS: 0 } };
    assert.ok(!renderDisplay(data, new Date()).includes("Rover camera"));
    const html = renderDisplay(data, new Date(), { roverSrc: "/fleet/display/rover?k=a&b" });
    assert.ok(html.includes('<img src="/fleet/display/rover?k=a&amp;b"'));
    assert.ok(html.includes("Rover camera"));
  });
});
