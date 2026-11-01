import Link from "next/link";
import { FlowTable } from "@/components/story/FlowTable";
import { FRONTIER_CLAIM, FRONTIER_LIMIT } from "@/lib/story/flow";

/** The claim and its evidence. On /offline always, and on /how-it-works with STORY_PAGES. */
export function FrontierSection({ linkOffline = false }: { linkOffline?: boolean }) {
  return (
    <>
      <h2 className="how-heading">From one sentence to your own model</h2>
      <p className="st-claim">{FRONTIER_CLAIM}</p>
      <p className="muted">{FRONTIER_LIMIT}</p>
      <FlowTable />
      {linkOffline ? (
        <p className="muted">
          <Link href="/offline">Build in the cloud, own it and run it offline</Link>: how this fits Offline Base, and what hasn&apos;t run yet.
        </p>
      ) : null}
    </>
  );
}
