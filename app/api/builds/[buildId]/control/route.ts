import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { isCrossSite, requireUser } from "@/lib/auth";
import { checkChange } from "@/lib/brief/policy";
import { StructuredOutputError } from "@/lib/brief/structured";
import { db, schema } from "@/lib/db/client";
import { canSteerBuild } from "@/lib/edit-pass";
import { env } from "@/lib/env";
import { addBuildCost, emit } from "@/lib/events";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import {
  controlRound,
  CONTROLS_PER_MINUTE,
  noteForAgent,
  NOTES_PER_BUILD,
  NOTES_PER_MINUTE,
  parseControl,
  STEERABLE_STATUSES,
  type ControlAction,
} from "@/lib/pipeline/control";
import { spendPaused } from "@/lib/quota";
import type { MuseCommandEnvelope } from "@/lib/sandbox/bridge-protocol";
import { MuseRoundEndedError, sendMuseCommand } from "@/lib/sandbox/builder";
import type { ModelUsage } from "@/lib/types";
import { recordUsage } from "@/lib/usage";

type Ctx = { params: Promise<{ buildId: string }> };

// A note's policy check is one low-effort model call, with one repair retry at most.
export const maxDuration = 60;

/** The largest body: a 4,000-character note, or three answers, with room for JSON escapes. */
const BODY_MAX = 64 * 1024;
const WINDOW_MS = 60_000;
/** The control event's error when the policy check gave no answer. */
const NOT_CHECKED = "Muse Muse couldn't check this, so it wasn't sent.";
/** The control event's error when the sandbox didn't take the command. */
const NOT_REACHED = "Muse Code couldn't be reached, so this didn't arrive.";
/** The control event's error when the round finished before the command got there (MuseRoundEndedError). */
const ROUND_ENDED = "That round of Muse Code had just finished, so this wasn't sent.";

/** The build, its product's owner and the Muse Code round it runs now. */
async function lookUp(buildId: string) {
  const [build] = await db()
    .select({
      userId: schema.builds.userId,
      productId: schema.builds.productId,
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
  return build;
}

/** The round a build is in and the sandbox it runs in, or null while no Muse Code round runs. */
function runningRound(build: Awaited<ReturnType<typeof lookUp>>) {
  if (!build || !STEERABLE_STATUSES.includes(build.status) || build.museRound === null || !build.sandboxName) return null;
  return { museRound: build.museRound, status: build.status, fixRounds: build.fixRounds, sandboxName: build.sandboxName };
}

/**
 * What the owner wrote, through the change policy a refinement passes before Muse Code sees it (checkChange), charged
 * to the build as the refinement's check is. The refusal for the owner, or null when it may go. Throws when no valid
 * answer came back, so nothing goes unchecked.
 */
async function policyRefusal(build: { id: string; productId: string | null }, message: string): Promise<string | null> {
  const charge = async (usage: ModelUsage[]) => {
    if (!usage.length) return;
    await recordUsage({ source: "platform", endpoint: "responses", buildId: build.id, productId: build.productId }, usage);
    await addBuildCost(build.id, usage.reduce((sum, u) => sum + (u.costUsd || 0), 0), "Note check");
  };
  const result = await checkChange({ message, references: [] }).catch(async (err: unknown) => {
    if (err instanceof StructuredOutputError) await charge(err.usage);
    throw err;
  });
  await charge(result.usage);
  return result.refusal;
}

/**
 * The build room's `control` event. Never fails the request: by then the command went, or it didn't. `commandIds` are
 * the ids of the envelopes the route made, delivered or not, so the build room counts the session bridge's line for
 * each as the owner's (components/build/derive.ts).
 */
async function tell(
  buildId: string,
  event: { round: number; action: ControlAction; text?: string; error?: string; commandIds?: string[] },
): Promise<void> {
  await emit(buildId, {
    type: "control",
    round: event.round,
    action: event.action,
    ...(event.text ? { text: event.text } : {}),
    ok: !event.error,
    ...(event.error ? { error: event.error } : {}),
    ...(event.commandIds?.length ? { commandIds: event.commandIds } : {}),
  }).catch((err) => console.error("[control] event", buildId, err));
}

/**
 * POST {action: "steer"|"queue"|"interrupt"|"stop"|"goal"|"answer"|"workflow"|"subagent", text?, goalAction?, objective?,
 * userInputId?, answers?, workflowAction?, workflowId?, childSessionId?, subagentAction?} -> 200 {ok: true, id}: the
 * build's owner sends the Muse Code round running now a command (docs/MUSE_CODE_FULL.md, "The owner steers"). It goes
 * into the round's mailbox as a MuseCommandEnvelope (sendMuseCommand), and a `control` build event tells the build
 * room. A stop sends an interrupt, then an end, and before either marks the build, so the workflow ends it after its
 * next Muse Code poll ("Stopped by you") even when the session never hears them. Words the owner wrote (a note, a goal,
 * a subagent message, typed answers) first pass the same change policy as a refinement, charged to the build.
 *
 * The owner is decided as in the messages route: the product's owner or an admin. The shared guest only under STEER_CHAT,
 * and only for a build their browser's pass names (canSteerBuild). Under STEER_CHAT a note also goes to Muse Code with
 * how to answer it (noteForAgent), and past 6 notes a minute or 40 a build it gets 429. 403
 * cross_site from another site, 503 steering_off unless steering is on (env.steeringEnabled), 401 signed out, 404 for
 * everyone else and for unknown builds, 400 with a sentence for a bad body (lib/pipeline/control.ts) or with the
 * policy's refusal, 409 no_round while no Muse Code round runs (the build row names none, or the sandbox says the round
 * it names has finished), 429 rate_limited with {retryAfterSeconds} past 20
 * commands a minute for one build (never for a stop), 503 paused for words while the daily spend cap is reached, and
 * 502 not_checked when the policy check gave no answer or not_delivered when the sandbox didn't take the command.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  if (!env.steeringEnabled) return errorJson(503, "steering_off");
  const user = await requireUser();
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");
  const parsed = parseControl(await readJson(req, BODY_MAX));
  if (!parsed.ok) return errorJson(400, parsed.error);
  const { action, commands, text, ownerText } = parsed.value;

  const build = await lookUp(buildId);
  // The product's owner decides, as for refinements. Anyone else gets the same answer as a build that doesn't exist.
  if (!build) return errorJson(404, "not_found");
  const allowed = await canSteerBuild(user, { id: buildId, userId: build.userId, productId: build.productId, ownerId: build.ownerId });
  if (!allowed) return errorJson(404, "not_found");
  let round = runningRound(build);
  if (!round) return errorJson(409, "no_round");

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `build-control:${buildId}`;
  const hits = await hitRateLimits([key], new Date(windowStart));
  if (action !== "stop" && (hits[key] ?? 0) > CONTROLS_PER_MINUTE) {
    return errorJson(429, "rate_limited", { retryAfterSeconds: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) });
  }

  const isNote = action === "steer" || action === "queue";
  if (env.steerChat && isNote) {
    const minute = `build-notes:${buildId}`;
    const total = `build-notes-all:${buildId}`;
    const [perMinute, perBuild] = await Promise.all([hitRateLimits([minute], new Date(windowStart)), hitRateLimits([total], new Date(0))]);
    if ((perBuild[total] ?? 0) > NOTES_PER_BUILD) return errorJson(429, "note_limit");
    if ((perMinute[minute] ?? 0) > NOTES_PER_MINUTE) {
      return errorJson(429, "rate_limited", { retryAfterSeconds: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) });
    }
  }

  if (ownerText) {
    // The agent takes these words as instructions, so they get the refinement's check before anything is sent.
    if (await spendPaused()) return errorJson(503, "paused");
    let refusal: string | null;
    try {
      refusal = await policyRefusal({ id: buildId, productId: build.productId }, ownerText);
    } catch (err) {
      console.error("[control] check", buildId, action, err instanceof Error ? err.message : err);
      await tell(buildId, { round: controlRound(round), action, text, error: NOT_CHECKED });
      return errorJson(502, "not_checked");
    }
    if (refusal) {
      await tell(buildId, { round: controlRound(round), action, text, error: refusal });
      return errorJson(400, refusal);
    }
    // The check takes a few seconds, and the round may have ended meanwhile.
    round = runningRound(await lookUp(buildId));
    if (!round) return errorJson(409, "no_round");
  }

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
    round = { ...round, museRound: marked.museRound, status: marked.status, fixRounds: marked.fixRounds };
  }

  // A millisecond apart, so the mailbox, read in name order, applies them in the order given.
  const at = Date.now();
  const envelopes: MuseCommandEnvelope[] = commands.map((command, i) => ({
    id: randomUUID(),
    at: new Date(at + i).toISOString(),
    by: "owner",
    command: env.steerChat && (command.type === "steer" || command.type === "queue") ? { ...command, text: noteForAgent(command.text) } : command,
  }));
  // museRound is the round's log number, the one startMuse got (roundBase + round), which names its mailbox; the event
  // takes the build room's (controlRound). No MuseRun is at hand here, so sendMuseCommand reads the round's engine from
  // the file startMuse wrote for it before the round went on the build row.
  let delivered = true;
  let ended = false;
  try {
    for (const envelope of envelopes) await sendMuseCommand({ sandboxName: round.sandboxName, round: round.museRound, envelope });
  } catch (err) {
    delivered = false;
    ended = err instanceof MuseRoundEndedError;
    console.error("[control]", buildId, action, err instanceof Error ? err.message : err);
  }
  // A stop holds without the session: the workflow kills the run once it sees the mark.
  const ok = delivered || action === "stop";
  await tell(buildId, {
    round: controlRound(round),
    action,
    text,
    commandIds: envelopes.map((e) => e.id),
    ...(ok ? {} : { error: ended ? ROUND_ENDED : NOT_REACHED }),
  });
  if (!ok) return ended ? errorJson(409, "no_round") : errorJson(502, "not_delivered");
  return Response.json({ ok: true, id: envelopes[0]!.id });
});
