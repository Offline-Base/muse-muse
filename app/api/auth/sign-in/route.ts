import { sql } from "drizzle-orm";
import { signIn } from "@/lib/auth";
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

/** POST {email, code} -> 200 {ok, user: {email, isAdmin}} and the mm_session cookie, or 401 {error}. */
export const POST = route(async (req: Request) => {
  const body = await readJson(req, 4096);
  const email = typeof body.email === "string" ? body.email : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (!email || !code) return errorJson(401, "Enter your email and the access code.");
  if (await tooManyAttempts(clientIp(req))) return errorJson(429, "Too many tries. Wait a few minutes and try again.");
  const user = await signIn(email, code);
  if (!user) return errorJson(401, "That email or access code didn't work.");
  return Response.json({ ok: true, user: { email: user.email, isAdmin: user.isAdmin } });
});
