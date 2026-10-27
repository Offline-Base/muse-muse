import { sql } from "drizzle-orm";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, signIn } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { errorJson, readJson, route } from "@/lib/http";

/** Sign-in attempts per IP per window: enough for a room of judges behind one NAT, too few to guess the shared code. */
const MAX_ATTEMPTS = 60;
const WINDOW_MS = 10 * 60_000;

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

async function tooManyAttempts(ip: string): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);
  const [row] = await db()
    .insert(schema.rateLimits)
    .values({ key: `signin:${ip}`, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [schema.rateLimits.key, schema.rateLimits.windowStart],
      set: { count: sql`${schema.rateLimits.count} + 1` },
    })
    .returning({ count: schema.rateLimits.count });
  return (row?.count ?? 0) > MAX_ATTEMPTS;
}

/**
 * POST {email, password, code} -> 200 {ok, user: {email, isAdmin}} and the mm_session cookie, 400 for a password of
 * the wrong length, or 401 {error}. A new email is claimed with the password sent. A wrong code or password gets the
 * same 401.
 */
export const POST = route(async (req: Request) => {
  const body = await readJson(req, 4096);
  const email = typeof body.email === "string" ? body.email : "";
  const code = typeof body.code === "string" ? body.code : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !code || !password) return errorJson(401, "Enter your email, a password and the access code.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return errorJson(400, `Passwords are at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return errorJson(400, `Keep the password to ${MAX_PASSWORD_LENGTH} characters or fewer.`);
  }
  if (await tooManyAttempts(clientIp(req))) return errorJson(429, "Too many tries. Wait a few minutes and try again.");
  const user = await signIn(email, code, password);
  if (!user) return errorJson(401, "That email, password or access code didn't work.");
  return Response.json({ ok: true, user: { email: user.email, isAdmin: user.isAdmin } });
});
