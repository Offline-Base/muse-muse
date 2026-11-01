import { randomBytes, randomUUID } from "node:crypto";
import { cleanDisplayName, endUserSubject, mintPasskeyState, mintUserCode, readPasskeyState, type PasskeyState } from "@/lib/caps/data/identity";
import { DATA_LIMITS } from "@/lib/caps/data/limits";
import type { StoredPasskey } from "@/lib/caps/data/users";
import { PASSKEY_ALGS, verifyAssertion, verifyRegistration } from "@/lib/caps/data/webauthn";
import { safeReturnPath } from "@/lib/tools/principal";
import { mac } from "@/lib/tools/sign";

/**
 * The passkey ceremonies on the platform (docs/CAPABILITIES.md, section 9): POST {PLATFORM_URL}/api/u/passkey/
 * {register,login}/{options,verify}, same origin only. The relying party is the platform's host, so one passkey works
 * for every product, and each product still knows the person by its own subject. The platform keeps no row for a
 * ceremony in progress: its state is signed (pk1) and its challenge is spent once. On success the browser is sent to
 * the product's registered live origin with a 5-minute sign-in code, never to an address from the request.
 */

export interface PasskeyDeps {
  /** The data cap is served and DATA_SIGN_IN is on. */
  enabled(): boolean;
  /** The platform's origin and host name: the relying party. */
  origin: string;
  rpId: string;
  productForSignIn(slug: string): Promise<{ id: string; name: string; liveUrl: string } | null>;
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  createEndUser(input: { endUserId: string; name: string; credentialId: string; publicKey: Buffer; counter: number; transports: string[] }): Promise<void>;
  findPasskey(credentialId: string): Promise<StoredPasskey | null>;
  usePasskey(passkeyId: string, endUserId: string, from: number, to: number): Promise<boolean>;
  now?(): Date;
}

const MAX_BODY = 32 * 1024;
const TRANSPORTS = ["usb", "nfc", "ble", "internal", "hybrid", "smart-card"];

function refused(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

/** The visitor's IP from Vercel's headers, as an HMAC: only ever a rate-limit key. */
function ipKey(req: Request): string | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim();
  return ip ? mac("passkey-ip", [ip.slice(0, 64)]).slice(0, 32) : null;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Only this platform's own sign-in page may call these: a fetch from it has our Origin and is same-origin. */
function sameOrigin(req: Request, origin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return req.headers.get("origin") === origin;
}

const userHandle = (endUserId: string) => Buffer.from(endUserId.replace(/-/g, ""), "hex").toString("base64url");

/** Where the browser goes after a passkey: the product's own live origin, with the code and a path on it. */
function backToProduct(liveUrl: string, code: string, returnTo: string): string {
  const url = new URL("/api/musemuse/user", liveUrl);
  url.searchParams.set("code", code);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

export async function handlePasskey(req: Request, kind: string, step: string, deps: PasskeyDeps): Promise<Response> {
  if (!deps.enabled() || !["register", "login"].includes(kind) || !["options", "verify"].includes(step)) return refused(404, "Not found.");
  if (req.method !== "POST") return refused(405, "Use POST.");
  if (!sameOrigin(req, deps.origin)) return refused(403, "This only works from Muse Muse's own sign-in page.");
  const now = deps.now?.() ?? new Date();
  try {
    const ip = ipKey(req);
    if (ip) {
      const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
      const key = `u-passkey:${ip}`;
      const counts = await deps.hitRateLimits([key], window);
      if ((counts[key] ?? 0) > DATA_LIMITS.passkeyPerIpPerMinute) return refused(429, "Too many tries from here. Wait a minute and try again.");
    }
    const body = await readBody(req);
    if (!body) return refused(400, "The request isn't valid.");
    if (step === "options") return await options(kind as PasskeyState["kind"], body, deps, now);
    return await verifyStep(kind as PasskeyState["kind"], body, deps, now);
  } catch (err) {
    console.error("[u/passkey] failed:", err instanceof Error ? err.message : "unknown");
    return refused(500, "Signing in didn't work this time. Try again.");
  }
}

async function options(kind: PasskeyState["kind"], body: Record<string, unknown>, deps: PasskeyDeps, now: Date): Promise<Response> {
  const slug = typeof body.product === "string" && /^[a-z0-9-]{1,60}$/.test(body.product) ? body.product : null;
  const product = slug ? await deps.productForSignIn(slug) : null;
  if (!product) return refused(404, "This app doesn't take sign-ins.");
  const returnTo = safeReturnPath(body.returnTo) ?? "/";
  const challenge = randomBytes(32).toString("base64url");
  if (kind === "login") {
    const state = mintPasskeyState({ kind, challenge, productId: product.id, returnTo }, now);
    return Response.json(
      { state, publicKey: { challenge, rpId: deps.rpId, timeout: DATA_LIMITS.challengeValidMs, userVerification: "preferred", allowCredentials: [] } },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const name = cleanDisplayName(body.name);
  if (!name) return refused(400, "Type the name this app should show for you.");
  const endUserId = randomUUID();
  const state = mintPasskeyState({ kind, challenge, productId: product.id, returnTo, endUserId, name }, now);
  return Response.json(
    {
      state,
      publicKey: {
        challenge,
        rp: { id: deps.rpId, name: "Muse Muse" },
        user: { id: userHandle(endUserId), name, displayName: name },
        pubKeyCredParams: PASSKEY_ALGS.map((alg) => ({ type: "public-key", alg })),
        timeout: DATA_LIMITS.challengeValidMs,
        attestation: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function credentialOf(body: Record<string, unknown>): { id: string; response: Record<string, unknown> } | null {
  const c = body.credential as { id?: unknown; type?: unknown; response?: unknown } | undefined;
  if (!c || typeof c.id !== "string" || !/^[A-Za-z0-9_-]{16,1400}$/.test(c.id) || c.type !== "public-key") return null;
  if (!c.response || typeof c.response !== "object" || Array.isArray(c.response)) return null;
  return { id: c.id, response: c.response as Record<string, unknown> };
}

async function verifyStep(kind: PasskeyState["kind"], body: Record<string, unknown>, deps: PasskeyDeps, now: Date): Promise<Response> {
  const state = readPasskeyState(body.state, kind, now);
  if (!state) return refused(400, "This sign-in took too long or isn't valid. Start again.");
  const credential = credentialOf(body);
  if (!credential) return refused(400, "The passkey's answer isn't valid. Start again.");
  if ((await deps.reserveCounter(`passkey-challenge:${state.challenge}`, new Date(state.exp), 1, 1)) === null) {
    return refused(400, "This sign-in was already used. Start again.");
  }
  const expected = { challenge: state.challenge, origin: deps.origin, rpId: deps.rpId };
  const product = await deps.productForSignIn((body.product as string) ?? "").catch(() => null);
  // The product is the one the state names, looked up again: it must still be live and saving data.
  if (!product || product.id !== state.productId) return refused(404, "This app doesn't take sign-ins right now.");

  if (kind === "register") {
    const r = credential.response;
    const checked = verifyRegistration({ id: credential.id, clientDataJSON: r.clientDataJSON as string, attestationObject: r.attestationObject as string }, expected);
    if (!checked.ok) return refused(400, `That passkey couldn't be set up: ${checked.reason}.`);
    const transports = Array.isArray(r.transports) ? r.transports.filter((t): t is string => typeof t === "string" && TRANSPORTS.includes(t)) : [];
    await deps.createEndUser({ endUserId: state.endUserId!, name: state.name!, credentialId: checked.value.credentialId, publicKey: checked.value.publicKey, counter: checked.value.counter, transports });
    const code = mintUserCode({ productId: product.id, subject: endUserSubject(state.endUserId!, product.id), name: state.name! }, now);
    return Response.json({ redirect: backToProduct(product.liveUrl, code, state.returnTo) }, { headers: { "cache-control": "no-store" } });
  }

  const stored = await deps.findPasskey(credential.id);
  if (!stored) return refused(400, "That passkey isn't one Muse Muse knows. Make a new one.");
  const r = credential.response;
  if (r.userHandle !== undefined && r.userHandle !== null && r.userHandle !== "" && r.userHandle !== userHandle(stored.endUserId)) {
    return refused(400, "That passkey belongs to someone else.");
  }
  const checked = verifyAssertion(
    { id: credential.id, clientDataJSON: r.clientDataJSON as string, authenticatorData: r.authenticatorData as string, signature: r.signature as string },
    expected,
    stored,
  );
  if (!checked.ok) return refused(400, `That passkey didn't sign you in: ${checked.reason}.`);
  if (!(await deps.usePasskey(stored.id, stored.endUserId, stored.counter, checked.value.counter))) return refused(409, "That passkey was just used somewhere else. Try again.");
  const code = mintUserCode({ productId: product.id, subject: endUserSubject(stored.endUserId, product.id), name: stored.displayName ?? "" }, now);
  return Response.json({ redirect: backToProduct(product.liveUrl, code, state.returnTo) }, { headers: { "cache-control": "no-store" } });
}
