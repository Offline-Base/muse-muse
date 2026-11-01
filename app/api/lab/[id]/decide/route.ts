import { isCrossSite, requireUser } from "@/lib/auth";
import { STATE_MAX_CHARS } from "@/lib/decide/format";
import { serveItems, servePick, serveRenderings } from "@/lib/decide/serving";
import type { DecideTryAnswer } from "@/lib/decide/types";
import { clientIpKey } from "@/lib/gateway/extract";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { askDecide, ServeError, serveKeyFor, serveTiming } from "@/lib/train/serve";
import { getDecisionModel, liveServeTarget, releaseDemoSlot, takeDemoSlot } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

// Two forward passes of at most 3 prompts on the GPU, well under 2 s; the call gives up at 30 s.
export const maxDuration = 60;

/** A state JSON escapes to at most 6 bytes a character (a control character), and the body holds little else. */
const BODY_MAX = 32 * 1024;
/** Inputs one client IP may send, per fixed 10-minute window, and one live demo scores per clock hour: /try's limits. */
const PER_IP = 5;
const IP_WINDOW_MS = 10 * 60_000;
const PER_DEMO_HOUR = 60;
const HOUR_MS = 3_600_000;

const noStore = { "cache-control": "no-store" };

function windowStart(now: Date, ms: number): Date {
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

function secondsLeft(now: Date, ms: number): number {
  return Math.max(1, Math.ceil((windowStart(now, ms).getTime() + ms - now.getTime()) / 1000));
}

/** A ServeError as the browser sees it: never the address, the key or the certificate. */
function serveErrorReply(err: ServeError): Response {
  switch (err.code) {
    case "timeout":
      return errorJson(504, "timeout");
    case "busy":
      return errorJson(409, "busy");
    case "stopping":
      return errorJson(404, "no_live_demo");
    case "bad_prompt":
      return errorJson(400, "The decision model couldn't take that input: it is too long once rendered. Try a shorter one.");
    default:
      return errorJson(502, "demo_unavailable");
  }
}

/** True for a signed-in admin, confirmed against the database. Never throws: anyone it can't confirm isn't one. */
async function viewerIsAdmin(): Promise<boolean> {
  try {
    return (await requireUser()).isAdmin === true;
  } catch {
    return false;
  }
}

/**
 * POST {state} -> DecideTryAnswer {base, tuned, ms}: one input decided by base Muse Glimmer and by the decision model of
 * training job {id}, on the GPU of its live demo (a running glimmer-serve job for that adapter, whose demo server
 * answers POST /decide, docs/DECISION_MODELS.md "On the lab's GPU"). The Try it live box of a decision model. /try's
 * access rules and limits: same-origin only (403 cross_site); the state trimmed, 1 to 3,000 characters (400); 404
 * no_live_demo when the job isn't a decision model with an adapter, when it has no public result page and the caller
 * isn't an admin, or when no demo for it is serving; 429 rate_limited with {scope, retryAfterSeconds} past 5 inputs per
 * client IP in 10 minutes ("ip") or 60 an hour for the demo ("demo"); 409 busy while the demo scores another (one at a
 * time); 504 timeout after 30 s; 502 demo_unavailable when the GPU couldn't be reached, its certificate wasn't the one
 * its job reported (nothing is sent then), it answered with an error or with numbers that can't be log-probabilities.
 * Each side's pick is made from its scores as scoring made the results page's (decisionFromScores), then softened by
 * the T its scoring fit. Nothing about the GPU is ever in a reply, and the input is never logged.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "no_live_demo");
  const body = await readJson(req, BODY_MAX);
  if (body.state !== undefined && typeof body.state !== "string") return errorJson(400, "Send the input as text.");
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (!state) return errorJson(400, "Type an input first.");
  if ([...state].length > STATE_MAX_CHARS) {
    return errorJson(400, `Keep the input to ${STATE_MAX_CHARS.toLocaleString("en-US")} characters.`, { max: STATE_MAX_CHARS });
  }

  // Only a decision model with a public result page has a public demo; one that isn't scored yet is an admin's to try.
  // Checked before the rate limits, so probing ids uses up nobody's window.
  const adapterJobId = id.toLowerCase();
  const model = await getDecisionModel(adapterJobId);
  if (!model || (!model.public && !(await viewerIsAdmin()))) return errorJson(404, "no_live_demo");
  const rendered = serveRenderings({ state, question: model.question, labels: model.labels });
  if (!rendered.ok) return errorJson(400, rendered.error);

  const now = new Date();
  const target = await liveServeTarget(adapterJobId, now);
  if (!target) return errorJson(404, "no_live_demo");

  const ip = clientIpKey(req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")) ?? "unknown";
  const ipKey = `lab-decide:ip:${ip}`;
  const perIp = await hitRateLimits([ipKey], windowStart(now, IP_WINDOW_MS));
  if ((perIp[ipKey] ?? 0) > PER_IP) {
    return errorJson(429, "rate_limited", { scope: "ip", retryAfterSeconds: secondsLeft(now, IP_WINDOW_MS) });
  }

  const slot = await takeDemoSlot(target.jobId, now);
  if (!slot) return errorJson(409, "busy");
  try {
    const demoKey = `lab-decide:demo:${target.jobId}`;
    const perDemo = await hitRateLimits([demoKey], windowStart(now, HOUR_MS));
    if ((perDemo[demoKey] ?? 0) > PER_DEMO_HOUR) {
      return errorJson(429, "rate_limited", { scope: "demo", retryAfterSeconds: secondsLeft(now, HOUR_MS) });
    }
    const scores = await askDecide(
      { ip: target.ip, port: target.port, certSha256: target.certSha256 },
      serveKeyFor(target.jobId, target.tokenHash),
      serveItems(rendered.renderings),
      serveTiming.decideMs,
    );
    let answer: DecideTryAnswer;
    try {
      answer = {
        base: servePick(model.labels, rendered.renderings, scores.base, model.base),
        tuned: servePick(model.labels, rendered.renderings, scores.tuned, model.tuned),
        ms: scores.ms,
      };
    } catch (err) {
      console.error("[lab/decide]", target.jobId, "unusable scores:", err instanceof Error ? err.message : err);
      return errorJson(502, "demo_unavailable");
    }
    return Response.json(answer, { headers: noStore });
  } catch (err) {
    if (!(err instanceof ServeError)) throw err;
    // Only the platform's log sees this, with the address blanked out; never the input, the key or the certificate.
    console.error("[lab/decide]", target.jobId, err.code, err.message.split(target.ip).join("[demo GPU]"));
    return serveErrorReply(err);
  } finally {
    await releaseDemoSlot(target.jobId, slot).catch((e) =>
      console.error("[lab/decide] releasing the demo slot failed", e instanceof Error ? e.message : e),
    );
  }
});
