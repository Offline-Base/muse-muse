import { after } from "next/server";
import { isCrossSite, requireUser } from "@/lib/auth";
import { passesBotCheck } from "@/lib/drive/bot";
import {
  BROWSER_COOKIE,
  cookieValue,
  DRIVE_IMAGE_VERSION,
  driveModelOf,
  driveProblem,
  filesForBuild,
  orderLink,
  ownerSummary,
  parseDriveRequest,
} from "@/lib/drive/logic";
import { notifyOwner } from "@/lib/drive/notify";
import {
  browserKeyOf,
  clientKeyOf,
  countRequested,
  createOrder,
  newBrowserId,
  newOrderSecret,
  purgeDriveOrders,
} from "@/lib/drive/store";
import { env } from "@/lib/env";
import { clientIpKey } from "@/lib/gateway/extract";
import { hashToken } from "@/lib/gateway/tokens";
import { errorJson, readJson, route } from "@/lib/http";
import { localFilesFor } from "@/lib/train/local-files-server";
import { getResultJob } from "@/lib/train/store";
import { browserCookie, noStore, orderCookie } from "../shared";

/** The form's whole body is under 2 KB; anything near this isn't the form. */
const BODY_MAX = 8 * 1024;

/**
 * POST {trainingJobId, build, name, email, address: {line1, line2?, city, state, postalCode}, ageOk: true, termsVersion}
 * -> 201 {orderId, link}: a flash drive order request (docs/VIBE_TUNING.md, Feature 6). No payment: the owner emails an
 * invoice. Anyone may send one, but not from another site (requireUser, and 403 cross_site), and only past the bot check
 * (403 bot_check). 503 drive_off unless DRIVE_ENABLED; 400 with a sentence and the `field` it is about; 409
 * terms_changed with {termsVersion} when the form showed older terms; 404 not_orderable with {reason} for a model that
 * can't go on a drive (no public results page, no public local files, none that passed); 429 daily_limit with {scope}
 * past DRIVE_CLIENT_REQUESTS for this client (its IP's key or its browser's key, "client") or DRIVE_DAILY_REQUESTS for
 * everyone ("everyone") in 24 hours.
 *
 * The link holds the order's secret and is shown once; this browser also gets it as an HttpOnly cookie. After the
 * reply, the owner's webhook gets one line without the buyer's details, and old buyers' details are purged.
 */
export const POST = route(async (req: Request) => {
  if (!env.driveEnabled) return errorJson(503, "drive_off");
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const user = await requireUser();
  if (!(await passesBotCheck(req))) return errorJson(403, "bot_check");

  const body = await readJson(req, BODY_MAX);
  const parsed = parseDriveRequest(body);
  if (!parsed.ok) return errorJson(400, parsed.error, { field: parsed.field });
  const request = parsed.value;
  if (request.termsVersion !== env.driveTermsVersion) {
    return errorJson(409, "terms_changed", { termsVersion: env.driveTermsVersion });
  }

  const [judged, files] = await Promise.all([getResultJob(request.trainingJobId), localFilesFor(request.trainingJobId)]);
  const problem = driveProblem({ enabled: true, judged: judged !== null, files });
  if (problem || !files?.repo || !files.commit) return errorJson(404, "not_orderable", { reason: problem });
  const picked = filesForBuild(files.files, request.build);
  if (!picked) {
    return errorJson(400, "That size didn't pass its checks, so it can't go on a drive. Pick another.", { field: "build" });
  }

  // Vercel sets x-real-ip to the client. Only its HMAC is kept, as the browser cookie's is.
  const ip = clientIpKey(req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")) ?? "unknown";
  const known = cookieValue(req.headers.get("cookie"), BROWSER_COOKIE);
  const browserId = known && /^[A-Za-z0-9_-]{22}$/.test(known) ? known : newBrowserId();
  const secret = newOrderSecret();
  const saved = await createOrder(
    {
      request,
      files: picked,
      repo: files.repo,
      commit: files.commit,
      model: driveModelOf(files),
      imageVersion: DRIVE_IMAGE_VERSION,
      secretHash: hashToken(secret),
      clientKey: clientKeyOf(ip),
      browserKey: browserKeyOf(browserId),
    },
    // Admins skip the per-client quota, as they skip the build quota. Everyone's total still counts them.
    { perClient: user.isAdmin ? Number.MAX_SAFE_INTEGER : env.driveClientRequests, everyone: env.driveDailyRequests },
  );
  if (!saved.ok) return errorJson(429, "daily_limit", { scope: saved.limit });

  const order = saved.order;
  after(async () => {
    try {
      const waiting = await countRequested();
      const adminUrl = `${env.platformUrl}/fine-tuning/orders`;
      await notifyOwner(ownerSummary({ title: order.model.title, build: order.build, count: order.files.length, orderId: order.id, waiting, adminUrl }));
    } catch (err) {
      console.error("[drive] couldn't tell the owner:", err instanceof Error ? err.message : err);
    }
    await purgeDriveOrders().catch((err) => console.error("[drive] purge:", err instanceof Error ? err.message : err));
  });

  const headers = new Headers(noStore);
  headers.append("set-cookie", orderCookie(order.id, secret));
  if (browserId !== known) headers.append("set-cookie", browserCookie(browserId));
  return Response.json({ orderId: order.id, link: orderLink(env.platformUrl, order.id, secret) }, { status: 201, headers });
});
