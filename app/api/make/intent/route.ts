import { getSessionUser, AuthError } from "@/lib/auth";
import { respondStructured, StructuredOutputError } from "@/lib/brief/structured";
import { env } from "@/lib/env";
import { reserveCounter } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { appNoteFor, connectMode } from "@/lib/make/connect";
import { decideIntent, INTENT_NOTE_MAX, mayAskForModel } from "@/lib/make/intent";
import { makeChatAllOn } from "@/lib/make/switch";
import { checkBuildAllowed, spendPaused } from "@/lib/quota";
import { runCaller, type RunCaller } from "@/lib/train/tune/caller";
import { hasSecret } from "@/lib/train/tune/folder-clean";
import { planModel } from "@/lib/train/tune/plan";
import { recordUsage } from "@/lib/usage";

/** Shared with POST /api/train/plan: this is a paid call before Start too, so they count together. */
const PLANS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

const product = (extra: Record<string, unknown> = {}) => Response.json({ kind: "product", appNote: null, modelNote: null, ...extra });

/**
 * POST {note, hasFolder?} -> 200 {kind: "product" | "model" | "both", appNote, modelNote, modelOff?, appBlock?, connect?}.
 * MAKE_CHAT_ALL (docs/TRAINING.md "One box for everything"). Off: 404.
 *
 * Nothing starts from this. A note with no word about a model and no folder answers product with no sign-in, no counter
 * and no model call. Otherwise the caller must be someone who may plan a run (runCaller, the same check as
 * POST /api/train/plan): anyone else answers {kind: "product", modelOff: true} with no model call. A visitor's request
 * is scanned for secrets first, and every call takes from the same limits as a plan: per caller, per IP and all visitors'
 * day. 400 bad input, 422 {refusal}, 429 and 503 as the plan route, 502 intent_failed.
 *
 * For both, `appBlock` is why a build couldn't start right now (read only), so the card can say so before Start.
 */
export const POST = route(async (req: Request) => {
  if (!makeChatAllOn()) return errorJson(404, "not_found");
  const body = await readJson(req, 16 * 1024);
  if (typeof body.note !== "string" || !body.note.trim()) return errorJson(400, "Say what you'd like first.");
  const note = body.note.trim();
  if (note.length > INTENT_NOTE_MAX) return errorJson(400, `Keep it under ${INTENT_NOTE_MAX} characters.`);
  const hasFolder = body.hasFolder === true && env.tuneFolder;
  if (!hasFolder && !mayAskForModel(note)) return product();

  let caller: RunCaller;
  try {
    caller = await runCaller(req);
  } catch (err) {
    if (err instanceof AuthError) return product({ modelOff: true });
    throw err;
  }
  if (caller.visitor && !env.tuneStartCode) return product({ modelOff: true });
  // As the plan route does: this text goes to Meta. Says nothing about what it matched.
  if (caller.visitor && hasSecret(note)) {
    return errorJson(422, "refused", { refusal: "This looks like it holds a key, token or password. Take it out and try again." });
  }
  if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const now = new Date();
  if (caller.visitor) {
    const { takeVisitorPlan } = await import("@/lib/train/public/open-start");
    const refused = await takeVisitorPlan(caller.visitor.ip, now);
    if (refused) return errorJson(refused.status, refused.code, { message: refused.error, ...(refused.retryAfterSeconds ? { retryAfterSeconds: refused.retryAfterSeconds } : {}) });
  }
  if (caller.id) {
    const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    if ((await reserveCounter(`tune-plan:${caller.id}`, hour, 1, PLANS_PER_HOUR)) === null) {
      return errorJson(429, "rate_limited", { retryAfterSeconds: Math.max(1, Math.ceil((hour.getTime() + HOUR_MS - now.getTime()) / 1000)) });
    }
  }

  let decided: Awaited<ReturnType<typeof decideIntent>>;
  try {
    decided = await decideIntent({ note, hasFolder }, { respond: respondStructured, model: planModel });
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    await recordUsage({ source: "platform", endpoint: "responses" }, err.usage).catch((e) => console.error("[make/intent] usage", e));
    return errorJson(502, "intent_failed");
  }
  await recordUsage({ source: "platform", endpoint: "responses" }, decided.usage).catch((e) => console.error("[make/intent] usage", e));
  const { kind, appNote, modelNote } = decided.decision;
  if (kind !== "both") return Response.json({ kind, appNote, modelNote });

  const user = await getSessionUser();
  const allowed = user ? await checkBuildAllowed(user) : null;
  const connect = connectMode({ isAdmin: caller.isAdmin, fromBuilds: env.tuneFromBuilds, gpuForBuilds: env.gpuGlimmerForBuilds });
  return Response.json({
    kind,
    appNote: appNoteFor(appNote, connect),
    modelNote,
    connect,
    appBlock: !user ? "sign_in" : allowed && !allowed.ok ? allowed.error : null,
  });
});
