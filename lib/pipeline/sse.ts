/** Server-sent events framing for the build room. Pure, so the route and tests share it. */
import { TERMINAL_STATUSES, type BuildEvent, type BuildStatus } from "@/lib/types";

/** One build event as an SSE message. JSON.stringify escapes newlines, so `data` is always a single line. */
export function formatSseEvent(event: BuildEvent): string {
  return `id: ${event.id}\nevent: build\ndata: ${JSON.stringify(event)}\n\n`;
}

export const SSE_PING = ": ping\n\n";

/** Where to resume: the Last-Event-ID header wins over ?after=. Anything that isn't a non-negative integer is 0. */
export function parseCursor(lastEventId: string | null, after: string | null): number {
  for (const raw of [lastEventId, after]) {
    if (raw && /^\d{1,18}$/.test(raw.trim())) return Number(raw.trim());
  }
  return 0;
}

export function isTerminal(status: BuildStatus | string | null | undefined): boolean {
  return TERMINAL_STATUSES.includes(status as BuildStatus);
}

/** True for a status event that ends the build. */
export function isTerminalEvent(event: BuildEvent): boolean {
  return event.type === "status" && isTerminal(event.status);
}
