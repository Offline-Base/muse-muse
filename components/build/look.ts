import { LOOK_CHANGES_MAX } from "@/lib/engine/look";
import type { BuildEvent } from "@/lib/types";

/** LOOK_FIRST (docs/LOOK_FIRST.md): where a build's screens-first stage is, from its events. Null for a build without it. */
export interface LookState {
  state: "building" | "ready" | "changing" | "wiring";
  /** While ready: when the build stops waiting and wires the screens in by itself. */
  waitUntil: number | null;
  /** Look changes the owner can still send. */
  changesLeft: number;
  /** An answer was sent since the screens were last shown, so the card waits for the build to pick it up. */
  answered: boolean;
}

export function lookState(events: readonly BuildEvent[]): LookState | null {
  let last: Extract<BuildEvent, { type: "look" }> | null = null;
  let lastAt = -1;
  let changes = 0;
  let answeredAt = -1;
  events.forEach((e, i) => {
    if (e.type === "look") {
      last = e;
      lastAt = i;
      if (e.state === "changing") changes++;
    } else if (e.type === "look_reply") answeredAt = i;
  });
  if (!last) return null;
  const look = last as Extract<BuildEvent, { type: "look" }>;
  const waitUntil = look.state === "ready" && look.waitUntil ? Date.parse(look.waitUntil) : null;
  return {
    state: look.state,
    waitUntil: Number.isFinite(waitUntil) ? waitUntil : null,
    changesLeft: Math.max(0, LOOK_CHANGES_MAX - changes),
    answered: answeredAt > lastAt,
  };
}

/** POST /api/builds/{id}/look. Null when it went through, else a sentence for the owner. */
export async function sendLook(
  buildId: string,
  body: { action: "approve" } | { action: "change"; text: string },
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<string | null> {
  try {
    const res = await fetcher(`/api/builds/${buildId}/look`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 409) return "The build has already moved on from the screens.";
    return typeof data.error === "string" && data.error.includes(" ") ? data.error : "That didn't go through. Try again.";
  } catch {
    return "That didn't go through. Check your connection and try again.";
  }
}
