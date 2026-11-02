import Link from "next/link";
import { FlowTable } from "@/components/story/FlowTable";
import { env } from "@/lib/env";
import { FRONTIER_CLAIM, FRONTIER_LIMIT } from "@/lib/story/flow";

/**
 * The claim and its evidence. On /offline and /how-it-works, both with STORY_PAGES. The link to /offline reads the same
 * flag as that page, so it never points at a 404.
 */
export function FrontierSection({ linkOffline = false }: { linkOffline?: boolean }) {
  return (
    <>
      <h2 className="how-heading">From one sentence to your own model</h2>
      <p className="st-claim">{FRONTIER_CLAIM}</p>
      <p className="muted">{FRONTIER_LIMIT}</p>
      <FlowTable />
      {linkOffline && env.storyPages ? (
        <p className="muted">
          <Link href="/offline">Build in the cloud, own it and run it offline</Link>: how this fits Offline Base, and what hasn&apos;t run yet.
        </p>
      ) : null}
    </>
  );
}
