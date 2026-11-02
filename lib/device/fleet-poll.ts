/**
 * When the fleet card asks for the fleet. An ask can become one request through the control plane's tunnel, and ngrok's free
 * plan caps the account at 20,000 requests a month (jetson-infra's docs/serving-over-ngrok.md), a cap the boards and the
 * public gateway share. So it only asks while someone is looking: never from a hidden tab, and only for a while from a window
 * left open with nobody there. A minute apart all day would still be 43,200 a month. Apart from the component so the timing
 * can be tested.
 */
export const FLEET_REFRESH_MS = 60_000;
/** A fleet that's down isn't helped by asking often. */
export const FLEET_RETRY_MS = 5 * 60_000;
/** How long it keeps refreshing after someone last came back to the page or pressed Refresh. */
export const FLEET_WATCH_MS = 30 * 60_000;

/** "final" is an answer that asking again won't change, so only Refresh asks again. */
export type FleetLoadResult = "ok" | "failed" | "final";

export interface FleetPage {
  hidden: () => boolean;
  /** Calls back when the tab is shown or the window gets focus, and returns how to stop listening. */
  onReturn: (listener: () => void) => () => void;
  /** Whether it has stopped refreshing by itself, so the card can say so. */
  onPaused: (paused: boolean) => void;
}

/** Starts asking. load never throws. */
export function pollFleet(load: () => Promise<FleetLoadResult>, page: FleetPage): { refresh: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let stopped = false;
  /** When the next ask is due, or null after a final answer. */
  let nextAt: number | null = 0;
  let watchUntil = Date.now() + FLEET_WATCH_MS;

  const wait = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };

  async function ask() {
    busy = true;
    page.onPaused(false);
    const result = await load();
    busy = false;
    if (stopped) return;
    if (result === "final") {
      nextAt = null;
      return;
    }
    const delay = result === "ok" ? FLEET_REFRESH_MS : FLEET_RETRY_MS;
    nextAt = Date.now() + delay;
    wait(delay);
  }

  /** A hidden tab or a pause only stops asking. The due time stays, so coming back asks straight away. */
  function tick() {
    if (page.hidden()) return;
    if (Date.now() >= watchUntil) return page.onPaused(true);
    void ask();
  }

  const stopListening = page.onReturn(() => {
    if (page.hidden()) return;
    watchUntil = Date.now() + FLEET_WATCH_MS;
    if (busy || nextAt === null) return;
    const left = nextAt - Date.now();
    if (left <= 0) void ask();
    else wait(left);
  });

  tick();

  return {
    refresh() {
      if (busy) return;
      clearTimeout(timer);
      watchUntil = Date.now() + FLEET_WATCH_MS;
      void ask();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      stopListening();
    },
  };
}
