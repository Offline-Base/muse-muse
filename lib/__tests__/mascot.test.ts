/**
 * Muse, the mascot (lib/mascot.ts): the walk and climb steps it moves by, the on or off switch in Settings, and Muse mode.
 *
 *   npx tsx --test lib/__tests__/mascot.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MASCOT_EVENT, MASCOT_KEY, MUSE_MODE_EVENT, MUSE_MODE_KEY, climbStep, readMascotOn, readMuseMode, setMascotOn, setMuseMode, subRole, walkStep } from "@/lib/mascot";

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

describe("Muse mode", () => {
  it("is off until switched on, says so to the page, and stays off when storage is blocked", () => {
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
    assert.equal(readMuseMode(), false);
    setMuseMode(true);
    assert.equal(store.get(MUSE_MODE_KEY), "on");
    assert.equal(readMuseMode(), true);
    setMuseMode(false);
    assert.equal(store.has(MUSE_MODE_KEY), false);
    assert.deepEqual(heard, [
      [MUSE_MODE_EVENT, { on: true }],
      [MUSE_MODE_EVENT, { on: false }],
    ]);
    (globalThis as { localStorage: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(readMuseMode(), false);
  });

  it("turns sub-agents each way in turn", () => {
    assert.deepEqual([0, 1, 2, 3].map(subRole), ["sub-left", "sub-right", "sub-left", "sub-right"]);
  });
});
