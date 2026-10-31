import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { canActAsOwner, isCrossSite, requireUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { emit } from "@/lib/events";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { controlRound, CONTROLS_PER_MINUTE, parseControl, STEERABLE_STATUSES } from "@/lib/pipeline/control";
import type { MuseCommandEnvelope } from "@/lib/sandbox/bridge-protocol";
import { sendMuseCommand } from "@/lib/sandbox/builder";

type Ctx = { params: Promise<{ buildId: string }> };

/** The largest body: a 4,000-character note, or three answers, with room for JSON escapes. */
const BODY_MAX = 64 * 1024;
const WINDOW_MS = 60_000;

/**
 * POST {action: "steer"|"queue"|"interrupt"|"stop"|"goal"|"answer"|"workflow"|"subagent", text?, goalAction?, objective?,
 * userInputId?, answers?, workflowAction?, workflowId?, childSessionId?, subagentAction?} -> 200 {ok: true, id}: the
 * build's owner sends the Muse Code round running now a command (docs/MUSE_CODE_FULL.md, "The owner steers"). It goes
 * into the round's mailbox as a MuseCommandEnvelope (sendMuseCommand), and a `control` build event tells the build
 * room. A stop sends an interrupt, then an end, and before either marks the build, so the workflow ends it after its
 * next Muse Code poll ("Stopped by you") even when the session never hears them.
 *
 * The owner is decided as in the messages route: the product's owner or an admin, never the shared guest. 403
 * cross_site from another site, 503 steering_off unless steering is on (env.steeringEnabled), 401 signed out, 404 for
 * everyone else and for unknown builds, 400 with a sentence for a bad body (lib/pipeline/control.ts), 409 no_round
 * while no Muse Code round runs, 429 rate_limited with {retryAfterSeconds} past 20 commands a minute for one build
 * (never for a stop), and 502 not_delivered when the sandbox didn't take the command.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  if (!env.steeringEnabled) return errorJson(503, "steering_off");
  const user = await requireUser();
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");
  const parsed = parseControl(await readJson(req, BODY_MAX));
  if (!parsed.ok) return errorJson(400, parsed.error);
  const { action, commands, text } = parsed.value;

  const [build] = await db()
    .select({
      userId: schema.builds.userId,
      status: schema.builds.status,
      fixRounds: schema.builds.fixRounds,
      sandboxName: schema.builds.sandboxName,
      museRound: schema.builds.museRound,
      ownerId: schema.products.ownerId,
    })
    .from(schema.builds)
    .leftJoin(schema.products, eq(schema.builds.productId, schema.products.id))
    .where(eq(schema.builds.id, buildId))
    .limit(1);
  // The product's owner decides, as for refinements. Anyone else gets the same answer as a build that doesn't exist.
  if (!build || !canActAsOwner(user, build.ownerId ?? build.userId)) return errorJson(404, "not_found");
  const sandboxName = build.sandboxName;
  if (!STEERABLE_STATUSES.includes(build.status) || build.museRound === null || !sandboxName) return errorJson(409, "no_round");

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `build-control:${buildId}`;
  const hits = await hitRateLimits([key], new Date(windowStart));
  if (action !== "stop" && (hits[key] ?? 0) > CONTROLS_PER_MINUTE) {
    return errorJson(429, "rate_limited", { retryAfterSeconds: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) });
  }

  let round = { museRound: build.museRound, status: build.status, fixRounds: build.fixRounds };
  if (action === "stop") {
    // One update that only takes a build still in a round: the poll that sees a run end clears its round in an update of
    // its own, so either this stop lands while the workflow will still see it, or it is refused here.
    const [marked] = await db()
      .update(schema.builds)
      .set({ stopRequested: true })
      .where(
        and(
          eq(schema.builds.id, buildId),
          inArray(schema.builds.status, [...STEERABLE_STATUSES]),
          isNotNull(schema.builds.museRound),
        ),
      )
      .returning({ museRound: schema.builds.museRound, status: schema.builds.status, fixRounds: schema.builds.fixRounds });
    if (!marked || marked.museRound === null) return errorJson(409, "no_round");
    round = { ...marked, museRound: marked.museRound };
  }

  // A millisecond apart, so the mailbox, read in name order, applies them in the order given.
  const envelopes: MuseCommandEnvelope[] = commands.map((command, i) => ({
    id: randomUUID(),
    at: new Date(now + i).toISOString(),
    by: "owner",
    command,
  }));
  let delivered = true;
  try {
    for (const envelope of envelopes) await sendMuseCommand({ sandboxName, round: round.museRound, envelope });
  } catch (err) {
    delivered = false;
    console.error("[control]", buildId, action, err instanceof Error ? err.message : err);
  }
  // A stop holds without the session: the workflow kills the run once it sees the mark.
  const ok = delivered || action === "stop";
  await emit(buildId, {
    type: "control",
    round: controlRound(round),
    action,
    ...(text ? { text } : {}),
    ok,
    ...(ok ? {} : { error: "Muse Code couldn't be reached, so this didn't arrive." }),
  }).catch((err) => console.error("[control] event", buildId, err));
  if (!ok) return errorJson(502, "not_delivered");
  return Response.json({ ok: true, id: envelopes[0]!.id });
});
