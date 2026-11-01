// Platform file (Muse Muse platform services). Don't edit: put it in the app bar's action or the card it unlocks.
//
// The passkey sign-in through Muse Muse, or who is signed in with a way out. No script: two small forms.
//   const user = currentUser(await headers());
//   <SignIn user={user} returnTo="/" />
import type { CurrentUser } from "@/lib/platform/user";

export function SignIn({ user, returnTo = "/" }: { user: CurrentUser | null; returnTo?: string }) {
  if (!user) {
    return (
      <form method="get" action="/api/musemuse/user" className="row">
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" className="secondary">
          Sign in
        </button>
      </form>
    );
  }
  return (
    <form method="post" action="/api/musemuse/user-sign-out" className="row">
      <span className="chip">{user.name || "Signed in"}</span>
      <input type="hidden" name="returnTo" value={returnTo} />
      <button type="submit" className="text">
        Sign out
      </button>
    </form>
  );
}
