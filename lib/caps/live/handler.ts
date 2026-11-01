import { allowedCapIds } from "@/lib/caps/manifest";
import { CAP_NEEDS_BUILDER } from "@/lib/caps/ids";
import { target as dataTarget, type DataDeps } from "@/lib/caps/data/handler";
import { capError, readJsonBody, runCapGate, unknownEndpoint, unknownKeys, type CapGateDeps, type CapLimit, type CapProduct, type CapStage } from "@/lib/caps/gate";
import { liveProofKey } from "@/lib/caps/live/captions";
import { LIVE_LIMITS } from "@/lib/caps/live/limits";
import type { LiveChange, LiveRowsKey } from "@/lib/caps/live/store";
import { mintLiveTicket, readLiveTicket, type LiveTicket } from "@/lib/caps/live/ticket";
import { gatewayError } from "@/lib/gateway/errors";
import { builderTier, tierMayUseBuilderCaps } from "@/lib/trust/tiers";
import { mac } from "@/lib/tools/sign";

/**
 * {GATEWAY_URL}/live/ticket and /live/stream (docs/CAPABILITIES.md, section 13): live shared updates, over the data cap's
 * rows. The ticket route runs the cap gate, then asks the data cap who may read what, so a ticket reads only what its
 * holder could read with data(). The stream takes only the ticket: an EventSource can't send the product's token, and
 * the browser must never hold it. It polls every 1.5 s and closes at 55 s, and the browser reconnects with `after`.
 * Everything here answers 404 until the live and data caps are served and LIVE_UPDATES is on.
 */
export interface LiveDeps extends CapGateDeps, Pick<DataDeps, "rules"> {
  /** LIVE_UPDATES. */
  updatesOn(): boolean;
  acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight(key: string, slot: Date): Promise<void>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  changes(key: LiveRowsKey, after: number, limit: number): Promise<LiveChange[]>;
  buildPreviewOrigin(buildId: string): Promise<string | null>;
  /** Waits, or ends early when the signal aborts. Tests pass their own. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Tests shorten these. */
  stream?: { pollMs?: number; maxMs?: number; heartbeatMs?: number };
}

const updatesServed = (deps: LiveDeps) => deps.updatesOn() && deps.servedCaps().includes("live") && deps.servedCaps().includes("data");

/** Serves everything under {GATEWAY_URL}/live. Anything else, and everything with the flags off, is a 404. */
export async function handleLive(req: Request, path: readonly string[], deps: LiveDeps): Promise<Response> {
  if (!updatesServed(deps)) return unknownEndpoint("/live");
  if (path.length === 1 && path[0] === "ticket") return handleLiveTicket(req, deps);
  if (path.length === 1 && path[0] === "stream") return handleLiveStream(req, deps);
  return unknownEndpoint("/live");
}

/** Updates read the data cap's rows, so a product needs what the data gate would ask of it. */
function dataRefusal(stage: CapStage, deps: LiveDeps): Response | null {
  if (!allowedCapIds(stage.token, stage.product.manifest).includes("data")) return capError("cap_not_allowed", "This product wasn't built with saved data, so it has nothing to stream.");
  if (CAP_NEEDS_BUILDER.data) {
    const owner = stage.product;
    const tier = builderTier({ email: owner.ownerEmail, isAdmin: owner.ownerIsAdmin && deps.adminEmails.includes(owner.ownerEmail), bannedAt: owner.ownerBannedAt });
    if (!tierMayUseBuilderCaps(tier)) return capError("sign_in_required", "This service needs a product made by someone signed in to Muse Muse.");
  }
  return null;
}

function handleLiveTicket(req: Request, deps: LiveDeps): Promise<Response> {
  return runCapGate<{ key: LiveRowsKey }>(req, deps, {
    cap: "live",
    what: "/live",
    enabled: deps.updatesOn,
    allow: (stage) => dataRefusal(stage, deps),
    async args(stage) {
      if (stage.req.method !== "POST") return capError("invalid_arguments", "Use POST.");
      const body = await readJsonBody(stage.req, 4 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["collection", "scope"]);
      if (extra) return extra;
      if (typeof body.collection !== "string") return capError("invalid_arguments", "Say which collection, as collection.");
      // The data cap's own rule: the product's list, the collection's scope, and the caller's key in that scope.
      const t = await dataTarget(stage, deps, body.collection, body.scope);
      if (t instanceof Response) return t;
      return {
        key: { productId: stage.token.productId, namespace: stage.token.scope === "build" ? `b:${stage.token.buildId}` : "live", collection: t.collection, scope: t.scope, ownerKey: t.ownerKey },
      };
    },
    limits(stage) {
      const limits: CapLimit[] = [{ key: `live-ticket:token:${stage.token.id}`, limit: LIVE_LIMITS.ticketsPerTokenPerMinute, window: "minute", who: "this product" }];
      if (stage.caller.ip) limits.push({ key: `live-ticket:ip:${stage.token.productId}:${stage.caller.ip}`, limit: LIVE_LIMITS.ticketsPerIpPerMinute, window: "minute", who: "this user" });
      return limits;
    },
    async work(ctx) {
      const { ticket, expiresAt } = mintLiveTicket(ctx.args.key, ctx.now);
      if (ctx.token.scope === "build" && ctx.token.buildId) await deps.hitRateLimits([liveProofKey("tickets", ctx.token.buildId)], ctx.now);
      return Response.json({ ticket, expiresAt: expiresAt.toISOString() }, { headers: { "cache-control": "no-store" } });
    },
  });
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const BUILD_NAMESPACE = /^b:([0-9a-f-]{36})$/;

const originOf = (url: string | null) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** A browser's origin may read this ticket's stream: the product's live origin, or for a build its test machine and preview. */
async function originAllowed(origin: string, ticket: LiveTicket, product: CapProduct, deps: LiveDeps): Promise<boolean> {
  const build = ticket.namespace.match(BUILD_NAMESPACE)?.[1];
  if (!build) return ticket.namespace === "live" && origin === originOf(product.liveUrl);
  return LOCAL_ORIGIN.test(origin) || origin === (await deps.buildPreviewOrigin(build));
}

/** Where to read from: the larger of `after` and the browser's own Last-Event-ID, or null when one isn't a number. */
function readAfter(req: Request, url: URL): number | null {
  const parse = (v: string | null) => {
    if (v === null || v === "") return 0;
    const n = Number(v);
    return /^\d{1,16}$/.test(v) && Number.isSafeInteger(n) ? n : null;
  };
  const after = parse(url.searchParams.get("after"));
  const last = parse(req.headers.get("last-event-id"));
  return after === null || last === null ? null : Math.max(after, last);
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

const encoder = new TextEncoder();

async function handleLiveStream(req: Request, deps: LiveDeps): Promise<Response> {
  if (req.method !== "GET") return gatewayError(405, "invalid_request_error", "method_not_allowed", "Use GET for /live/stream.", { retry: false, headers: { allow: "GET" } });
  const release: Array<() => Promise<void>> = [];
  const giveBack = () => Promise.all(release.splice(0).map((r) => r().catch(() => undefined)));
  try {
    const now = deps.now?.() ?? new Date();
    const url = new URL(req.url);
    const raw = url.searchParams.get("ticket");
    const ticket = readLiveTicket(raw, now);
    if (!ticket) return gatewayError(401, "authentication_error", "invalid_ticket", "This ticket is no good or has expired. Ask the product for a new one.", { retry: false });
    const after = readAfter(req, url);
    if (after === null) return capError("invalid_arguments", "after is the seq of the last change this browser saw.");
    const product = await deps.product(ticket.productId);
    if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) {
      return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
    }
    // A browser always sends Origin on a cross-site stream. With none, this is the same site or no browser at all, and the
    // ticket alone decides.
    const origin = req.headers.get("origin");
    if (origin && !(await originAllowed(origin, ticket, product, deps))) return capError("cap_not_allowed", "This stream is only for the product's own site.");

    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const opensKey = `live-open:${mac("live-open", [raw!]).slice(0, 32)}`;
    const opens = await deps.hitRateLimits([opensKey], minute);
    if ((opens[opensKey] ?? 0) > LIVE_LIMITS.opensPerTicketPerMinute) return capError("rate_limited", "This stream is reconnecting too fast. Try again in a minute.", { "retry-after": "60" });
    for (const [key, limit] of [[`live-stream:${ticket.productId}`, LIVE_LIMITS.streamsPerProduct], ["live-stream:all", LIVE_LIMITS.streamsTotal]] as const) {
      const slot = await deps.acquireInFlight(key, limit, now);
      if (!slot) {
        await giveBack();
        return capError("rate_limited", `Too many people are watching right now: at most ${limit}. Try again in a minute.`, { "retry-after": "30" });
      }
      release.push(() => deps.releaseInFlight(key, slot));
    }
    const build = ticket.namespace.match(BUILD_NAMESPACE)?.[1] ?? null;
    if (build) await deps.hitRateLimits([liveProofKey("streams", build)], now);

    const stop = new AbortController();
    const onAbort = () => stop.abort();
    req.signal.addEventListener("abort", onAbort);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void pump(controller, ticket, after, build, stop.signal, deps)
          .catch((err) => {
            // Writing to a stream the browser just left isn't a failure.
            if (!stop.signal.aborted) console.error("[caps] live stream failed:", err instanceof Error ? err.message : "unknown");
          })
          .finally(async () => {
            req.signal.removeEventListener("abort", onAbort);
            await giveBack();
            try {
              controller.close();
            } catch {
              // The browser already went away.
            }
          });
      },
      cancel() {
        stop.abort();
      },
    });
    const headers = new Headers({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", vary: "Origin" });
    if (origin) headers.set("access-control-allow-origin", origin);
    return new Response(stream, { headers });
  } catch (err) {
    console.error("[caps] live stream failed:", err instanceof Error ? err.message : "unknown");
    await giveBack();
    return capError("cap_failed", "The platform service hit an unexpected error. Try again.");
  }
}

/** Sends changes until the stream's time is up, its ticket expires, it has sent its share, or the browser goes away. */
async function pump(controller: ReadableStreamDefaultController<Uint8Array>, ticket: LiveTicket, start: number, build: string | null, signal: AbortSignal, deps: LiveDeps): Promise<void> {
  const clock = () => deps.now?.() ?? new Date();
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.stream?.pollMs ?? LIVE_LIMITS.pollMs;
  const heartbeatMs = deps.stream?.heartbeatMs ?? LIVE_LIMITS.heartbeatMs;
  const opened = clock().getTime();
  const endAt = Math.min(opened + (deps.stream?.maxMs ?? LIVE_LIMITS.streamMaxMs), ticket.exp.getTime());
  const key: LiveRowsKey = { productId: ticket.productId, namespace: ticket.namespace, collection: ticket.collection, scope: ticket.scope, ownerKey: ticket.ownerKey };
  const send = (text: string) => controller.enqueue(encoder.encode(text));
  let after = start;
  let rows = 0;
  let bytes = 0;
  let lastByte = opened;
  send(`retry: 2000\n\n`);
  send(`event: open\ndata: {"after":${start}}\n\n`);
  while (!signal.aborted && clock().getTime() < endAt && rows < LIVE_LIMITS.streamMaxRows && bytes < LIVE_LIMITS.streamMaxBytes) {
    const changes = await deps.changes(key, after, LIVE_LIMITS.batchRows);
    if (signal.aborted) break;
    for (const c of changes) {
      const line = `id: ${c.seq}\ndata: ${JSON.stringify({ seq: c.seq, op: c.op, id: c.id, data: c.data })}\n\n`;
      send(line);
      after = c.seq;
      rows += 1;
      bytes += line.length;
    }
    const at = clock();
    if (changes.length) {
      lastByte = at.getTime();
      if (build) await deps.adjustCounter(liveProofKey("events", build), at, changes.length);
      // A full page means more are waiting: catch up at once, up to this connection's share.
      if (changes.length === LIVE_LIMITS.batchRows) continue;
    } else if (at.getTime() - lastByte >= heartbeatMs) {
      send(": still here\n\n");
      lastByte = at.getTime();
    }
    await sleep(pollMs, signal);
  }
  // A plain end: the browser reconnects with the last seq it saw, without waiting out `retry`.
  if (!signal.aborted) send(`event: end\ndata: {"after":${after}}\n\n`);
}
