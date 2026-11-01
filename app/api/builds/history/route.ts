import { getSessionUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { listBuildsByIds, listUserBuilds, safeQuery } from "@/lib/queries";
import { historyFor, parseHistoryIds } from "@/lib/shell/history";

/**
 * GET ?ids=<uuid,...> -> 200 {builds: [{id, title}]}, the sidebar's History (lib/shell/history.ts). Empty when nobody is
 * signed in or the database doesn't answer, since the sidebar then just leaves the section out.
 */
export const GET = route(async (req: Request) => {
  const viewer = await getSessionUser();
  const ids = parseHistoryIds(new URL(req.url).searchParams.get("ids"));
  const result = await safeQuery(() => historyFor(viewer, ids, { listUserBuilds, listBuildsByIds }));
  return Response.json({ builds: result.ok ? result.data : [] }, { headers: { "Cache-Control": "private, no-store" } });
});
