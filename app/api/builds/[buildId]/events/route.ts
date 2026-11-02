import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { eventsAfter, proveStillRunning } from "@/lib/events";
import { errorJson, isUuid } from "@/lib/http";
import { nativeActive } from "@/lib/native/active";
import { SSE_PING, formatSseEvent, isTerminal, isTerminalEvent, parseCursor } from "@/lib/pipeline/sse";

export const runtime = "nodejs";
export const maxDuration = 300;

const POLL_MS = 1_000;
const PING_MS = 15_000;
/** Close before maxDuration. EventSource reconnects with Last-Event-ID. */
const LIFETIME_MS = 280_000;
const BATCH = 200;
/** Re-read the build's status this often, for viewers who join after the last event. */
const STATUS_EVERY_POLLS = 5;
/** Keep draining this long after the build ends: the failure event and cleanup logs land just after the status. */
const DRAIN_MS = 2_000;
/** After the build ends, how often to ask whether a Prove it run is still going (docs/PRODUCT_OUTPUTS.md). */
const PROVE_CHECK_MS = 5_000;

type Ctx = { params: Promise<{ buildId: string }> };

async function buildStatus(buildId: string): Promise<string | null> {
  const [row] = await db()
    .select({ status: schema.builds.status })
    .from(schema.builds)
    .where(eq(schema.builds.id, buildId))
    .limit(1);
  return row?.status ?? null;
}

/**
 * GET -> text/event-stream of BuildEvents: "id: <id>\nevent: build\ndata: <json>\n\n". Resumes from Last-Event-ID
 * or ?after=<id>, polls the database every second, pings every 15 s, and closes after about 280 s or once the build is
 * terminal and drained, no native run is still adding to its log, and no Prove it run is still going.
 */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");
  let status: string | null;
  try {
    status = await buildStatus(buildId);
  } catch (err) {
    console.error("[events]", err);
    return errorJson(500, "server_error");
  }
  if (!status) return errorJson(404, "not_found");

  let cursor = parseCursor(req.headers.get("last-event-id"), new URL(req.url).searchParams.get("after"));
  const encoder = new TextEncoder();
  let stopped = false;
  req.signal.addEventListener("abort", () => {
    stopped = true;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let lastWrite = Date.now();
      let endedAt: number | null = isTerminal(status) ? Date.now() : null;
      let proveCheckedAt = 0;
      // Null until it's first asked, which is only once the build has ended and drained.
      let native: boolean | null = null;
      const write = (text: string) => {
        controller.enqueue(encoder.encode(text));
        lastWrite = Date.now();
      };
      try {
        write("retry: 3000\n\n");
        for (let poll = 1; !stopped && Date.now() - startedAt < LIFETIME_MS; poll++) {
          const events = await eventsAfter(buildId, cursor, BATCH);
          for (const event of events) {
            cursor = event.id;
            // PLAN_ART off: a plan picture made while it was on stays out of the room, as the page leaves it out.
            if (event.type === "plan_art" && !env.planArt) continue;
            if (event.type === "steps_feed" && !env.buildRoomSteps) continue;
            write(formatSseEvent(event));
            if (endedAt === null && isTerminalEvent(event)) endedAt = Date.now();
          }
          if (events.length === BATCH) continue;
          if (endedAt === null && poll % STATUS_EVERY_POLLS === 0 && isTerminal(await buildStatus(buildId))) {
            endedAt = Date.now();
          }
          if (endedAt !== null && events.length === 0 && Date.now() - endedAt >= DRAIN_MS) {
            if (native === null || poll % STATUS_EVERY_POLLS === 0) native = await nativeActive(buildId);
            // Both kinds of run write events after the build's end, so the stream stays open while either is going.
            if (!native) {
              if (!env.proveIt) break;
              if (Date.now() - proveCheckedAt >= PROVE_CHECK_MS) {
                proveCheckedAt = Date.now();
                if (!(await proveStillRunning(buildId))) break;
              }
            }
          }
          if (Date.now() - lastWrite >= PING_MS) write(SSE_PING);
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (err) {
        if (!stopped) console.error("[events]", buildId, err);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
    cancel() {
      stopped = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
