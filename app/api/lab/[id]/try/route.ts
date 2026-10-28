import { isCrossSite, requireUser } from "@/lib/auth";
import { clientIpKey } from "@/lib/gateway/extract";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { askLive, ServeError, serveKeyFor, serveTiming } from "@/lib/train/serve";
import { getResultJob, liveServeTarget, releaseDemoSlot, takeDemoSlot } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

// The GPU answers both models with up to 400 new tokens each; the call gives up at 120 s.
export const maxDuration = 150;

/** The longest app idea the demo takes. The GPU's server caps it again. */
const PROMPT_MAX = 600;
const BODY_MAX = 8 * 1024;
/** Prompts one client IP may send, per fixed 10-minute window. */
const PER_IP = 5;
const IP_WINDOW_MS = 10 * 60_000;
/** Prompts one live demo answers per clock hour, from everyone together. */
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
      // The GPU's minutes ran out a moment before the platform's clock said so: the demo has ended.
      return errorJson(404, "no_live_demo");
    case "bad_prompt":
      return errorJson(400, "The live demo couldn't take that idea. Try a shorter one.");
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
 * POST {prompt} -> {base, tuned, ms}: one app idea answered by the base and the tuned Muse Glimmer on the GPU of the
 * adapter's live demo (a running glimmer-serve job for training job {id}, docs/TRAINING.md "Live demo"). Public, so a
 * request from another site is refused (403 cross_site), as open-access writes are. The prompt is trimmed and must be
 * 1 to 600 characters (400). 404 no_live_demo when the adapter's job has no public result page (it isn't judged) and
 * the caller isn't an admin, or when no demo for that adapter is serving (or its GPU says it is shutting down); 429
 * rate_limited with {scope, retryAfterSeconds} past 5 prompts per client IP in 10 minutes ("ip") or 60 an hour for the
 * demo ("demo"); 409 busy while the demo answers another prompt (one at a time); 504 timeout after 120 s; 502
 * demo_unavailable when the GPU
 * couldn't be reached, its certificate wasn't the one its job reported (nothing is sent then) or it answered with an
 * error. The call is HTTPS pinned to that certificate, with the serving key derived from the job's token hash. Nothing
 * about the GPU (its IP, the key, the certificate) is ever in a reply.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "no_live_demo");
  const body = await readJson(req, BODY_MAX);
  if (body.prompt !== undefined && typeof body.prompt !== "string") return errorJson(400, "Send the app idea as text.");
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return errorJson(400, "Type an app idea first.");
  if ([...prompt].length > PROMPT_MAX) return errorJson(400, `Keep the idea to ${PROMPT_MAX} characters.`, { max: PROMPT_MAX });

  // Only an adapter with a public result page has a public demo. One that isn't judged yet is an admin's to try (the
  // admin confirmed against the database, as requireUser does), and to anyone else there is no demo at all. Checked
  // before the rate limits, so probing ids uses up nobody's window.
  const adapterJobId = id.toLowerCase();
  if (!(await getResultJob(adapterJobId)) && !(await viewerIsAdmin())) return errorJson(404, "no_live_demo");

  const now = new Date();
  const target = await liveServeTarget(adapterJobId, now);
  if (!target) return errorJson(404, "no_live_demo");

  // Vercel sets x-real-ip to the client. Counted before anything else, so hammering a busy demo uses up the window.
  const ip = clientIpKey(req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")) ?? "unknown";
  const ipKey = `lab-try:ip:${ip}`;
  const perIp = await hitRateLimits([ipKey], windowStart(now, IP_WINDOW_MS));
  if ((perIp[ipKey] ?? 0) > PER_IP) {
    return errorJson(429, "rate_limited", { scope: "ip", retryAfterSeconds: secondsLeft(now, IP_WINDOW_MS) });
  }

  const slot = await takeDemoSlot(target.jobId, now);
  if (!slot) return errorJson(409, "busy");
  try {
    // Only prompts that reach the GPU count toward the demo's hour.
    const demoKey = `lab-try:demo:${target.jobId}`;
    const perDemo = await hitRateLimits([demoKey], windowStart(now, HOUR_MS));
    if ((perDemo[demoKey] ?? 0) > PER_DEMO_HOUR) {
      return errorJson(429, "rate_limited", { scope: "demo", retryAfterSeconds: secondsLeft(now, HOUR_MS) });
    }
    const answer = await askLive(
      { ip: target.ip, port: target.port, certSha256: target.certSha256 },
      serveKeyFor(target.jobId, target.tokenHash),
      prompt,
      serveTiming.answerMs,
    );
    return Response.json(answer, { headers: noStore });
  } catch (err) {
    if (!(err instanceof ServeError)) throw err;
    // Only the platform's log sees this. Node's connection errors name the address, so it is blanked out; the key and
    // the certificate are never in a ServeError's message.
    console.error("[lab/try]", target.jobId, err.code, err.message.split(target.ip).join("[demo GPU]"));
    return serveErrorReply(err);
  } finally {
    await releaseDemoSlot(target.jobId, slot).catch((e) =>
      console.error("[lab/try] releasing the demo slot failed", e instanceof Error ? e.message : e),
    );
  }
});
