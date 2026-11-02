/**
 * Muse, the mascot (components/mascot/Mascot.tsx): whether it's on screen, kept in this browser. On unless the person
 * turns it off in Settings. Settings tells an open page at once with MASCOT_EVENT, and other tabs hear the storage event.
 */

export const MASCOT_KEY = "musemuse-mascot";
export const MASCOT_EVENT = "musemuse-mascot";

/** On unless switched off here, or storage is blocked and nothing says so. */
export function readMascotOn(): boolean {
  try {
    return localStorage.getItem(MASCOT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setMascotOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(MASCOT_KEY);
    else localStorage.setItem(MASCOT_KEY, "off");
  } catch {
    // Blocked storage: the switch still applies to this page.
  }
  window.dispatchEvent(new CustomEvent(MASCOT_EVENT, { detail: { on } }));
}

/** The walk loop's frame size (public/muse/muse-walk.*), for the drawn width at a given height. */
export const WALK_FRAME = { width: 196, height: 256 };

/** About how far one stride carries it, as a share of its height per second, so the feet don't slide. */
export const WALK_SPEED_PER_HEIGHT = 0.42;

/** The climb loops' frame size (public/muse/muse-climb-*), cut flush at the wall, so the window's edge is the wall. */
export const CLIMB_FRAME = { width: 180, height: 300 };

/** How fast it goes up or down the side, as a share of its height per second. */
export const CLIMB_SPEED_PER_HEIGHT = 0.3;

/** One step up (way 1) or down (way -1) the side, between the ground (0) and `top`. Pure, so it's tested without a browser. */
export function climbStep(y: number, way: 1 | -1, dt: number, speed: number, top: number): { y: number; arrived: boolean } {
  const next = y + way * speed * dt;
  if (way > 0 && next >= top) return { y: top, arrived: true };
  if (way < 0 && next <= 0) return { y: 0, arrived: true };
  return { y: next, arrived: false };
}

/**
 * One step of the bottom walk: where it is next, which way it faces, and whether it turned at an edge. Pure, so it's
 * tested without a browser.
 */
export function walkStep(
  state: { x: number; dir: 1 | -1 },
  dt: number,
  speed: number,
  bounds: { left: number; right: number },
): { x: number; dir: 1 | -1; turned: boolean } {
  let x = state.x + state.dir * speed * dt;
  let dir = state.dir;
  let turned = false;
  if (x >= bounds.right) {
    x = bounds.right;
    dir = -1;
    turned = state.dir !== -1;
  } else if (x <= bounds.left) {
    x = bounds.left;
    dir = 1;
    turned = state.dir !== 1;
  }
  return { x, dir, turned };
}
