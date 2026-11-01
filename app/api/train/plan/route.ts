import { limitCeilings } from "@/app/api/train/shared";
import { env } from "@/lib/env";
import { reserveCounter } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { tuneCaller } from "@/lib/train/tune/caller";
import { examplesFromBody } from "@/lib/train/tune/examples";
import { clampExamples, contentFindings, draftPlan, NOTE_MAX, NOTE_MIN, StructuredOutputError } from "@/lib/train/tune/plan";
import { DATASET_MAX_COUNT, DATASET_MIN_COUNT } from "@/lib/train/logic";
import { recordUsage } from "@/lib/usage";

/** Plans one caller may draft an hour: each is one Muse Wonder call, about $0.01 to $0.03 (an estimate). */
export const PLANS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

/**
 * POST {note, examples?, settings?: {examples?}} -> 200 {plan}. Admins or automation (tuneCaller). Off with
 * TUNE_COMPOSER: 404. One respondStructured call on Muse Wonder (TEST_MODEL where that is on) names the model, sums it
 * up and checks the task against the brief writer's refusal policy; `examples` (at most 50 of the person's own
 * {prompt, answer} rows, parsed in the browser) fold into the task as style examples. The plan comes back signed for
 * this caller, for POST /api/train/runs. 400 bad input, 422 {refusal} when it can't be trained, 429 rate_limited (20
 * an hour per caller), 502 plan_failed (no valid reply after a retry), 503 meta_not_configured or paused.
 */
export const POST = route(async (req: Request) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  const caller = await tuneCaller(req);
  const body = await readJson(req, 64 * 1024);

  if (typeof body.note !== "string") return errorJson(400, "Say what the model should do.");
  const note = body.note.trim();
  if (note.length < NOTE_MIN) return errorJson(400, `Say what the model should do in at least ${NOTE_MIN} characters.`);
  if (note.length > NOTE_MAX) return errorJson(400, `Keep it under ${NOTE_MAX} characters. Add the rest as examples.`);
  const rows = examplesFromBody(body.examples);
  if (!rows) return errorJson(400, "examples must be up to 50 rows, each with a prompt and an answer.");
  const asked = body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>).examples : undefined;
  if (asked !== undefined && (typeof asked !== "number" || !Number.isInteger(asked) || asked < DATASET_MIN_COUNT || asked > DATASET_MAX_COUNT)) {
    return errorJson(400, `examples must be a whole number from ${DATASET_MIN_COUNT} to ${DATASET_MAX_COUNT}.`);
  }

  const findings = contentFindings({ note, rows });
  if (findings.length) return errorJson(422, "refused", { refusal: findings.join(" ") });
  if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const now = new Date();
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  if ((await reserveCounter(`tune-plan:${caller.id}`, hour, 1, PLANS_PER_HOUR)) === null) {
    const retryAfterSeconds = Math.max(1, Math.ceil((hour.getTime() + HOUR_MS - now.getTime()) / 1000));
    return errorJson(429, "rate_limited", { retryAfterSeconds });
  }

  let result: Awaited<ReturnType<typeof draftPlan>>;
  try {
    result = await draftPlan({
      note,
      rows,
      callerId: caller.id,
      examples: clampExamples(typeof asked === "number" ? asked : env.tuneDefaultExamples),
      ceilings: limitCeilings(),
      now,
    });
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    await recordUsage({ source: "platform", endpoint: "responses" }, err.usage).catch((e) => console.error("[train/plan] usage", e));
    return errorJson(502, "plan_failed");
  }
  await recordUsage({ source: "platform", endpoint: "responses" }, result.usage).catch((e) => console.error("[train/plan] usage", e));
  if (!result.ok) return errorJson(422, "refused", { refusal: result.refusal });
  return Response.json({ plan: result.plan });
});
