import type { Metadata } from "next";
import { connection } from "next/server";
import resources from "@/catalog/meta-resources.json";
import { LearnView } from "@/components/learn/LearnView";
import { LESSONS } from "@/lib/learn";
import { currentUser, joinRebuilds, listRebuilds, safeQuery } from "@/lib/queries";

export const metadata: Metadata = { title: "Learn" };

/**
 * Learn: one card per lesson on Meta's Videos page (catalog/meta-resources.json), with what it teaches, Muse Muse's
 * version today and the improved plan. It replaced /rebuilds, which now redirects here.
 */
export default async function Learn() {
  await connection();
  const [user, result] = await Promise.all([currentUser(), safeQuery(() => listRebuilds())]);
  return (
    <LearnView
      lessons={LESSONS}
      data={result.ok ? result.data : joinRebuilds([], [])}
      connected={result.ok ? { ok: true } : { ok: false, reason: result.reason }}
      admin={Boolean(user?.isAdmin)}
      source={resources.source}
      checkedOn={resources.checkedOn}
    />
  );
}
