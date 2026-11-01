/** The session checks the Run it routes share. */
import { AuthError, requireUser, type SessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { mayDeploy, mayUseModel } from "@/lib/train/host/limits";
import { getAdapterSource } from "@/lib/train/store";

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

/** The same, for one model: with HOST_TUNED_OPEN, a person may only start, stop or talk to a model they trained. */
export async function modelDeployer(modelId: string): Promise<SessionUser | Response> {
  const user = await deployer();
  if (user instanceof Response || user.isAdmin) return user;
  const source = await getAdapterSource(modelId);
  if (mayUseModel(user, source?.job.createdBy)) return user;
  return Response.json({ code: "not_allowed", error: "Only the person who trained this model can host it." }, { status: 403 });
}
