import { signOut } from "@/lib/auth";
import { route } from "@/lib/http";

/** POST -> 200 {ok: true}. Clears the mm_session cookie. */
export const POST = route(async () => {
  await signOut();
  return Response.json({ ok: true });
});
