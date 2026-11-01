/** The session check the Run it routes share. */
import { AuthError, requireUser, type SessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { mayDeploy } from "@/lib/train/host/limits";

export async function deployer(): Promise<SessionUser | Response> {
  try {
    const user = await requireUser();
    if (!mayDeploy(user, env.hostTunedOpen)) return Response.json({ code: "not_allowed", error: "Only admins can host a model for now." }, { status: 403 });
    return user;
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ code: "not_allowed", error: err.message }, { status: err.status });
    throw err;
  }
}
