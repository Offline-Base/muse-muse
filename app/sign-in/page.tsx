import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { SignInForm } from "@/components/SignInForm";
import { safeNext } from "@/lib/format";
import { currentUser } from "@/lib/queries";

export const metadata: Metadata = { title: "Sign in" };

// Plainly Muse Muse: its own brand and copy, no Meta look, and never a request for an API key.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null);
  const user = await currentUser();

  return (
    <div className="page page-narrow">
      <section className="card signin">
        <p className="signin-brand">
          <span className="brand-name">Muse Muse</span>
          <span className="concept">Concept</span>
        </p>
        {user && !user.openAccess ? (
          <>
            <h1>You&apos;re signed in</h1>
            <p className="muted">
              Signed in as <strong>{user.email}</strong>.
            </p>
            <div className="row-actions">
              <Link className="btn btn-primary" href={next}>
                Continue
              </Link>
              <Link className="btn btn-outline" href="/builds">
                My builds
              </Link>
            </div>
          </>
        ) : (
          <>
            {user ? (
              <>
                <h1>Sign-in is off for now</h1>
                <p className="muted">
                  Anyone can build right now without signing in. Builds go to{" "}
                  {user.isAdmin ? <strong>{user.email}</strong> : "a shared guest account"}. Sign in only if you want
                  builds under your own account.
                </p>
                <div className="row-actions">
                  <Link className="btn btn-primary" href={next}>
                    Continue without signing in
                  </Link>
                </div>
              </>
            ) : (
              <>
                <h1>Sign in to build</h1>
                <p className="muted">
                  Browsing is open to everyone. Building spends model credits, so it needs your email, a password and
                  the access code the Muse Muse team shared with you.
                </p>
              </>
            )}
            <SignInForm next={next} />
            <p className="muted small">
              Muse Muse never asks for a Meta account or an API key. It uses its own key on the server.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
