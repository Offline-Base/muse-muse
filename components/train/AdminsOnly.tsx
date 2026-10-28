import { EmptyCard } from "@/components/ui";

/** What non-admins see on the fine-tuning pages. Signed-out visitors get a sign-in button back to `next`. */
export function AdminsOnly({ signedIn, next = "/fine-tuning" }: { signedIn: boolean; next?: string }) {
  return (
    <EmptyCard
      icon="tune"
      title="Admins only"
      action={signedIn ? undefined : { href: `/sign-in?next=${encodeURIComponent(next)}`, label: "Sign in" }}
    >
      <p>
        Fine-tuning runs on the owner&apos;s Lambda GPU account, which bills for every minute a GPU is on, so only admins
        can see and start jobs.
      </p>
    </EmptyCard>
  );
}
