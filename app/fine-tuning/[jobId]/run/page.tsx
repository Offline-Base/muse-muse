import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { evalRows } from "@/components/train/format";
import { hasResults, toPublicLiveDemo } from "@/components/train/results";
import { NotConnected } from "@/components/ui";
import { RunLocally } from "@/components/vibe/RunLocally";
import { driveProblem } from "@/lib/drive/logic";
import { env } from "@/lib/env";
import { safeQuery } from "@/lib/queries";
import type { LocalFiles } from "@/lib/train/local-files";
import { localFilesFor } from "@/lib/train/local-files-server";
import { ADAPTER_RECIPE } from "@/lib/train/logic";
import { getLiveDemo, getResultJob, listResultEvents } from "@/lib/train/store";
import type { LiveDemoView } from "@/lib/train/types";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Run it on your computer" };

/**
 * The model's local files (lib/train/local-files.ts), or null. A problem reading them is logged and the page says the
 * files aren't made yet, so it never takes the page down. Files that name another adapter are ignored.
 */
async function filesFor(jobId: string): Promise<LocalFiles | null> {
  try {
    const files = await localFilesFor(jobId);
    return files && files.adapterJobId === jobId ? files : null;
  } catch (err) {
    console.error("[run locally] local files:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The adapter's live demo while one is starting or serving, for Try it live, or null. Never fails the page. */
async function liveDemoOf(jobId: string, now: Date): Promise<LiveDemoView | null> {
  try {
    return await getLiveDemo(jobId, now);
  } catch (err) {
    console.error("[run locally] live demo:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Run it on your computer (docs/VIBE_TUNING.md, Feature 5) for a judged Muse Glimmer LoRA job, the same jobs that have
 * a public result page; any other id is a 404. It reads only the Lab reads (the job's safe columns and its eval items),
 * the live demo's public state, and the GGUF files through localFilesFor. Everything about the visitor's computer stays
 * in their browser.
 */
export default async function RunLocallyPage({ params }: { params: Promise<{ jobId: string }> }) {
  await connection();
  const [{ jobId }, user] = await Promise.all([params, pageViewer()]);
  const now = new Date();
  const result = await safeQuery(async () => {
    const row = await getResultJob(jobId);
    if (!row || row.recipe !== ADAPTER_RECIPE || !hasResults(row)) return null;
    const [events, files, live] = await Promise.all([listResultEvents(row.id), filesFor(row.id), liveDemoOf(row.id, now)]);
    const rows = evalRows(events);
    const first = rows[0];
    return {
      jobId: row.id,
      // The model as its Hub repos name it (its dataset's title), not the job's own title, such as "... LoRA".
      title: files?.title ?? row.title,
      files,
      hello: first ? { prompt: first.prompt, tuned: first.tuned, index: first.index, total: rows.length } : null,
      live: toPublicLiveDemo(live),
      // The verdict offers a flash drive on a long download, only while drives are on and this model can go on one.
      driveHref: driveProblem({ enabled: env.driveEnabled, judged: true, files }) ? null : `/orders/new?model=${row.id}`,
      // Where "Stuck?" says to write for help, when the site names an address.
      help: env.driveContactEmail,
    };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this page" />
      </div>
    );
  }
  if (!result.data) notFound();
  return <RunLocally {...result.data} showPrivate={Boolean(user?.isAdmin)} serverNow={now.getTime()} />;
}
