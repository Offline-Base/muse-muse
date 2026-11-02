import { errorJson, route } from "@/lib/http";
import { makeChatAllOn } from "@/lib/make/switch";
import { datasetPage, getDataset } from "@/lib/train/store";
import { mayTouchRun, runCaller } from "@/lib/train/tune/caller";

type Ctx = { params: Promise<{ id: string }> };

/** Pages of this size, up to the most a dataset holds. */
const PAGE = 200;
const MOST_ROWS = 10_000;
const SAMPLES_MOST = 10;

/**
 * GET -> a run's examples, for whoever may touch it: its own starter (a visitor too) or an admin (mayTouchRun), the same
 * check as the run's room. MAKE_CHAT_ALL (docs/TRAINING.md "One box for everything"). Off: 404. Spends nothing.
 *
 * ?sample=n (1 to 10): 200 {total, rows}, the first few training examples for the room. Otherwise a JSONL download of
 * every example, each line with its split ("train" or "eval"). 404 not_found, 403 forbidden, 409 not_ready while they're written.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!makeChatAllOn()) return errorJson(404, "not_found");
  const caller = await runCaller(req);
  const { id } = await params;
  const dataset = await getDataset(id);
  if (!dataset || dataset.kind === "decision") return errorJson(404, "not_found");
  if (!(await mayTouchRun(caller, dataset.createdBy))) return errorJson(403, "forbidden");
  if (dataset.status !== "ready") return errorJson(409, "not_ready");

  const asked = new URL(req.url).searchParams.get("sample");
  if (asked !== null) {
    const n = Math.max(1, Math.min(SAMPLES_MOST, Math.floor(Number(asked)) || 1));
    const page = await datasetPage(id, "train", 0, n);
    if (!page) return errorJson(404, "not_found");
    return Response.json({ total: page.total, rows: page.items });
  }

  const lines: string[] = [];
  for (const split of ["train", "eval"] as const) {
    for (let from = 0; from < MOST_ROWS; from += PAGE) {
      const page = await datasetPage(id, split, from, PAGE);
      if (!page?.items.length) break;
      for (const row of page.items) lines.push(JSON.stringify({ split, ...row }));
      if (from + PAGE >= page.total) break;
    }
  }
  return new Response(lines.length ? `${lines.join("\n")}\n` : "", {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="dataset-${id.slice(0, 8)}.jsonl"`,
      "cache-control": "private, no-store",
    },
  });
});
