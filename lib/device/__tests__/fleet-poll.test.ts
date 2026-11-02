/**
 * When the fleet card asks for the fleet, with the clock faked: each ask can cost one of the tunnel's 20,000 requests a month,
 * so a hidden tab costs none, an unattended window stops, and a fleet that's down or refusing isn't asked over and over.
 *
 *   npx tsx --test lib/device/__tests__/fleet-poll.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { FLEET_REFRESH_MS, FLEET_RETRY_MS, FLEET_WATCH_MS, pollFleet, type FleetLoadResult } from "@/lib/device/fleet-poll";

const DAY_MS = 24 * 60 * 60_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Moves the fake clock one minute at a time, letting each ask finish. */
async function pass(ms: number) {
  for (let left = ms; left > 0; left -= 60_000) {
    mock.timers.tick(Math.min(left, 60_000));
    await settle();
  }
}

function harness(start: { hidden?: boolean; result?: FleetLoadResult } = {}) {
  const state = {
    hidden: start.hidden ?? false,
    result: start.result ?? ("ok" as FleetLoadResult),
    asks: 0,
    paused: false,
    listening: true,
    comeBack: () => {},
  };
  const poll = pollFleet(
    async () => {
      state.asks++;
      return state.result;
    },
    {
      hidden: () => state.hidden,
      onReturn: (listener) => {
        state.comeBack = listener;
        return () => {
          state.listening = false;
        };
      },
      onPaused: (paused) => {
        state.paused = paused;
      },
    },
  );
  return { state, poll };
}

describe("when the fleet card asks", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("asks on opening, then once a minute while someone's there", async () => {
    const { state, poll } = harness();
    await settle();
    assert.equal(state.asks, 1);
    await pass(FLEET_REFRESH_MS * 3);
    assert.equal(state.asks, 4);
    poll.stop();
  });

  it("asks nothing from a hidden tab, however long, and asks once on coming back", async () => {
    const { state, poll } = harness();
    await settle();
    state.hidden = true;
    await pass(DAY_MS);
    assert.equal(state.asks, 1);

    state.comeBack();
    await settle();
    assert.equal(state.asks, 1, "hiding the tab also fires the event, and must not ask");

    state.hidden = false;
    state.comeBack();
    await settle();
    assert.equal(state.asks, 2);
    poll.stop();
  });

  it("doesn't ask at all from a tab opened in the background, until it's shown", async () => {
    const { state, poll } = harness({ hidden: true });
    await pass(FLEET_REFRESH_MS * 10);
    assert.equal(state.asks, 0);
    state.hidden = false;
    state.comeBack();
    await settle();
    assert.equal(state.asks, 1);
    poll.stop();
  });

  it("doesn't ask again for every focus, and keeps to the minute", async () => {
    const { state, poll } = harness();
    await settle();
    for (let i = 0; i < 5; i++) {
      await pass(1000);
      state.comeBack();
      await settle();
    }
    assert.equal(state.asks, 1);
    await pass(FLEET_REFRESH_MS - 5000);
    assert.equal(state.asks, 2);
    poll.stop();
  });

  it("stays well under the tunnel's monthly cap in a window left open and visible", async () => {
    const { state, poll } = harness();
    await pass(DAY_MS);
    assert.ok(state.asks <= FLEET_WATCH_MS / FLEET_REFRESH_MS + 1, `${state.asks} asks`);
    assert.equal(state.paused, true);

    const before = state.asks;
    state.comeBack();
    await settle();
    assert.equal(state.asks, before + 1);
    assert.equal(state.paused, false);
    poll.stop();
  });

  it("asks far less often while the fleet is down", async () => {
    const { state, poll } = harness({ result: "failed" });
    await settle();
    assert.equal(state.asks, 1);
    await pass(FLEET_RETRY_MS - FLEET_REFRESH_MS);
    assert.equal(state.asks, 1);
    await pass(FLEET_REFRESH_MS);
    assert.equal(state.asks, 2);
    poll.stop();
  });

  it("stops at an answer that won't change, even on coming back, until Refresh", async () => {
    const { state, poll } = harness({ result: "final" });
    await settle();
    await pass(FLEET_WATCH_MS);
    state.comeBack();
    await settle();
    assert.equal(state.asks, 1);

    state.result = "ok";
    poll.refresh();
    await settle();
    assert.equal(state.asks, 2);
    await pass(FLEET_REFRESH_MS);
    assert.equal(state.asks, 3);
    poll.stop();
  });

  it("starts the watch again on Refresh, and asks nothing after it stops", async () => {
    const { state, poll } = harness();
    await pass(DAY_MS);
    assert.equal(state.paused, true);
    poll.refresh();
    await settle();
    assert.equal(state.paused, false);
    const before = state.asks;
    await pass(FLEET_REFRESH_MS * 2);
    assert.equal(state.asks, before + 2);

    poll.stop();
    await pass(DAY_MS);
    assert.equal(state.asks, before + 2);
    assert.equal(state.listening, false);
  });
});
