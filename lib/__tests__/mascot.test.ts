/**
 * Muse, the mascot (lib/mascot.ts): the walk and climb steps it moves by, and the on or off switch in Settings.
 *
 *   npx tsx --test lib/__tests__/mascot.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTROL_SELECTOR, COVER_REACH, MASCOT_EVENT, MASCOT_KEY, climbStep, coverPoints, readMascotOn, setMascotOn, walkStep } from "@/lib/mascot";

describe("the walk", () => {
  const bounds = { left: 264, right: 1200 };
  it("moves at its speed the way it faces", () => {
    assert.deepEqual(walkStep({ x: 300, dir: 1 }, 0.5, 40, bounds), { x: 320, dir: 1, turned: false });
    assert.deepEqual(walkStep({ x: 300, dir: -1 }, 0.5, 40, bounds), { x: 280, dir: -1, turned: false });
  });
  it("turns at each edge, once, and never leaves the content area", () => {
    assert.deepEqual(walkStep({ x: 1190, dir: 1 }, 1, 40, bounds), { x: 1200, dir: -1, turned: true });
    assert.deepEqual(walkStep({ x: 270, dir: -1 }, 1, 40, bounds), { x: 264, dir: 1, turned: true });
    assert.equal(walkStep({ x: 1200, dir: -1 }, 0.01, 40, bounds).turned, false);
  });
});

describe("the climb", () => {
  it("goes up to the top and stops there, then down to the ground", () => {
    assert.deepEqual(climbStep(100, 1, 1, 30, 300), { y: 130, arrived: false });
    assert.deepEqual(climbStep(290, 1, 1, 30, 300), { y: 300, arrived: true });
    assert.deepEqual(climbStep(10, -1, 1, 30, 300), { y: 0, arrived: true });
  });
});

describe("the switch", () => {
  it("is on until turned off, tells the page, and survives blocked storage", () => {
    const store = new Map<string, string>();
    const heard: unknown[] = [];
    Object.assign(globalThis, {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
      window: { dispatchEvent: (e: CustomEvent) => heard.push([e.type, e.detail]) },
      CustomEvent: class<T> {
        constructor(public type: string, init?: { detail?: T }) {
          this.detail = init?.detail;
        }
        detail: T | undefined;
      },
    });
    assert.equal(readMascotOn(), true);
    setMascotOn(false);
    assert.equal(store.get(MASCOT_KEY), "off");
    assert.equal(readMascotOn(), false);
    setMascotOn(true);
    assert.equal(store.has(MASCOT_KEY), false);
    assert.deepEqual(heard, [
      [MASCOT_EVENT, { on: false }],
      [MASCOT_EVENT, { on: true }],
    ]);
    (globalThis as { localStorage: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(readMascotOn(), true);
  });
});

describe("never covering a control on a phone", () => {
  const view = { width: 390, height: 844 };
  it("tests a grid over the figure and its close button's reach", () => {
    const pts = coverPoints({ left: 100, top: 772, right: 155, bottom: 844 }, view);
    assert.equal(pts.length, 16);
    const xs = pts.map(([x]) => x);
    const ys = pts.map(([, y]) => y);
    assert.ok(Math.min(...xs) > 100 - COVER_REACH.side && Math.max(...xs) < 155 + COVER_REACH.side);
    assert.ok(Math.min(...ys) > 772 - COVER_REACH.top && Math.max(...ys) < 844);
    assert.ok(Math.min(...xs) < 100, "reaches past the figure's left edge");
    assert.ok(Math.min(...ys) < 772, "reaches up to the close button");
  });
  it("keeps every point inside the window", () => {
    for (const [x, y] of coverPoints({ left: 340, top: 800, right: 395, bottom: 872 }, view)) {
      assert.ok(x >= 0 && x <= view.width && y >= 0 && y <= view.height);
    }
  });
  it("counts an embedded product and a video's controls as controls, since their buttons are out of the page's sight", () => {
    for (const part of ["iframe", "video[controls]", "button", "a[href]", "textarea"]) assert.ok(CONTROL_SELECTOR.split(",").includes(part), part);
  });
  it("has nothing to test when the figure is off screen", () => {
    assert.deepEqual(coverPoints({ left: 500, top: 772, right: 555, bottom: 844 }, view), []);
  });
});
