import Link from "next/link";

/** The note under the Lab results for non-admins. Signed-out visitors get a sign-in link back to `next`. */
export function AdminsOnly({ signedIn, next = "/fine-tuning" }: { signedIn: boolean; next?: string }) {
  return (
    <p className="muted small">
      Only admins can start jobs or make datasets, since the GPUs bill by the minute.
      {signedIn ? null : (
        <>
          {" "}
          <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
        </>
      )}
    </p>
  );
}
