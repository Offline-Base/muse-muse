/**
 * Rebuilds Meta's demo videos (catalog/meta-resources.json) unattended, then prints the pitch headline.
 *
 *   npm run rebuild-all                 every catalog item without a live or partial product yet
 *   npm run rebuild-all -- <id> <id>    exactly these catalog ids
 *   npm run rebuild-all -- --targets=phone,desktop <id>    these also run there, if their flags are on at PLATFORM_URL
 *
 * Starts the batch through POST /api/rebuilds at PLATFORM_URL with the AUTOMATION_SECRET bearer (acting as the first
 * ADMIN_EMAILS user, who must have signed in once or opened a preview once while it had OPEN_ACCESS=admin), polls each
 * build every 20 s until all are finished, and prints a table plus
 * "N of M rebuilt in X for $Y".
 */
import { env } from "@/lib/env";
import { catalogItem, itemTitle } from "@/lib/pipeline/catalog";
import { TERMINAL_STATUSES, type BuildStatus } from "@/lib/types";

const POLL_MS = 20_000;
/** Stop waiting after this long and print what finished. */
const GIVE_UP_MS = 4 * 3_600_000;

interface Tracked {
  id: string;
  buildId: string;
  title: string;
  status: BuildStatus | "unknown";
  startedAt: string | null;
  finishedAt: string | null;
  costUsd: number;
  liveUrl: string | null;
  error: string | null;
}

interface BuildSummary {
  build: { status: BuildStatus; startedAt: string; finishedAt: string | null; costUsd: number; error: string | null };
  product: { liveUrl: string | null } | null;
}

/** Admin automation header for POST /api/rebuilds. Nobody signs in, so no account password is involved. */
function automationHeaders(): Record<string, string> {
  if (!env.automationSecret) throw new Error("AUTOMATION_SECRET is not set. Add it to .env.local (and on Vercel).");
  return { authorization: `Bearer ${env.automationSecret}` };
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
}

function minutesOf(t: Tracked): string {
  if (!t.startedAt) return "";
  const end = t.finishedAt ? Date.parse(t.finishedAt) : Date.now();
  return ((end - Date.parse(t.startedAt)) / 60_000).toFixed(1);
}

function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function printTable(rows: Tracked[]): void {
  const header = `${cell("Title", 52)}  ${cell("Status", 9)}  ${"Min".padStart(5)}  ${"Cost".padStart(7)}  Live URL`;
  console.log(`\n${header}\n${"-".repeat(header.length + 20)}`);
  for (const r of rows) {
    console.log(
      `${cell(r.title, 52)}  ${cell(r.status, 9)}  ${minutesOf(r).padStart(5)}  ${`$${r.costUsd.toFixed(2)}`.padStart(7)}  ${r.liveUrl ?? (r.error ? `(${r.error.slice(0, 80)})` : "")}`,
    );
  }
}

async function main(): Promise<void> {
  const base = env.platformUrl;
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = process.argv.find((a) => a.startsWith("--targets="))?.slice("--targets=".length).split(",").map((t) => t.trim()).filter(Boolean);
  for (const id of ids) {
    if (!catalogItem(id)) throw new Error(`${id} isn't in catalog/meta-resources.json.`);
  }

  console.log(`Starting rebuilds at ${base} ...`);
  const res = await fetch(`${base}/api/rebuilds`, {
    method: "POST",
    headers: { "content-type": "application/json", ...automationHeaders() },
    body: JSON.stringify({ ...(ids.length ? { ids } : {}), ...(targets?.length ? { targets } : {}) }),
  });
  if (!res.ok) throw new Error(`POST /api/rebuilds failed (${res.status}): ${await res.text()}`);
  const { started } = (await res.json()) as { started: Array<{ id: string; buildId: string }> };
  if (!started.length) {
    console.log("Nothing to rebuild: every catalog item already has a live or partial product, or a build running.");
    return;
  }

  const batchStartedAt = Date.now();
  const rows: Tracked[] = started.map(({ id, buildId }) => {
    const item = catalogItem(id);
    return {
      id,
      buildId,
      title: item ? itemTitle(item) : id,
      status: "unknown",
      startedAt: null,
      finishedAt: null,
      costUsd: 0,
      liveUrl: null,
      error: null,
    };
  });
  console.log(`Started ${rows.length} rebuilds. Checking every ${POLL_MS / 1000} s.`);

  const done = (r: Tracked) => TERMINAL_STATUSES.includes(r.status as BuildStatus);
  while (rows.some((r) => !done(r)) && Date.now() - batchStartedAt < GIVE_UP_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    await Promise.all(
      rows
        .filter((r) => !done(r))
        .map(async (r) => {
          try {
            const reply = await fetch(`${base}/api/builds/${r.buildId}`);
            if (!reply.ok) return;
            const { build, product } = (await reply.json()) as BuildSummary;
            Object.assign(r, {
              status: build.status,
              startedAt: build.startedAt,
              finishedAt: build.finishedAt,
              costUsd: Number(build.costUsd) || 0,
              liveUrl: product?.liveUrl ?? null,
              error: build.error,
            });
          } catch (err) {
            console.error(`  could not check ${r.id}: ${err instanceof Error ? err.message : err}`);
          }
        }),
    );
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    const summary = [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
    console.log(`[${formatDuration(Date.now() - batchStartedAt)}] ${summary}`);
  }

  printTable(rows);
  const shipped = rows.filter((r) => r.status === "live" || r.status === "partial");
  const partial = shipped.filter((r) => r.status === "partial").length;
  const cost = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const unfinished = rows.filter((r) => !done(r)).length;
  console.log(
    `\n${shipped.length} of ${rows.length} rebuilt in ${formatDuration(Date.now() - batchStartedAt)} for $${cost.toFixed(2)}`,
  );
  if (partial) console.log(`(${partial} shipped as partial, with their limits in the build notes)`);
  if (unfinished) console.log(`(${unfinished} still running after ${formatDuration(GIVE_UP_MS)}; check them in the build room)`);
}

main().catch((err) => {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
  console.error(`${err instanceof Error ? err.message : err}${cause}`);
  console.error(`Platform: ${env.platformUrl}. Set PLATFORM_URL to the deployed platform.`);
  process.exit(1);
});
