import { WebhookControls } from "@/components/jobs/WebhookControls";
import { jobsBlock } from "@/lib/caps/jobs/brief";
import { everyWords } from "@/lib/caps/jobs/schedule";
import { jobsPanel, noteOwnerSeen } from "@/lib/caps/jobs/store";
import { env } from "@/lib/env";
import { relativeTime } from "@/lib/format";

const STATUS: Record<string, string> = { queued: "Waiting", running: "Running", done: "Done", failed: "Failed", budget: "Stopped at its limit", cancelled: "Cancelled" };
const PAUSED: Record<string, string> = { owner_away: "Paused until you visit", product_off: "Paused while the product is off" };

/**
 * The owner's view of a product's background jobs, on its page (docs/CAPABILITIES.md, section 12). Renders nothing, and
 * reads nothing, while the jobs cap is off, for anyone else, or for a product with no jobs. Opening it counts as a visit,
 * so paused schedules start again before they're read. An admin acting as the owner can look without it counting.
 */
export async function JobsPanel({ productId, slug, brief, isOwner, viewerIsOwner }: { productId: string; slug: string; brief: object | null; isOwner: boolean; viewerIsOwner: boolean }) {
  if (!isOwner || !env.servedCaps.includes("jobs")) return null;
  const block = jobsBlock(brief);
  if (!block) return null;
  try {
    if (viewerIsOwner) await noteOwnerSeen(productId);
    const data = await jobsPanel(productId);
    const now = Date.now();
    return (
      <section className="card section-card" aria-labelledby="jobs-title">
        <h2 id="jobs-title">Background jobs</h2>
        {data.schedules.length ? (
          <ul>
            {data.schedules.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong>: every {everyWords(s)}.{" "}
                <span className="muted small">
                  {s.pausedAt ? (PAUSED[s.pauseReason ?? ""] ?? "Paused") : `Next at ${s.nextRunAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
                  {s.lastRunAt ? `. Last ${relativeTime(s.lastRunAt.toISOString(), now)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {env.jobsWebhooks && block.webhooks.length
          ? block.webhooks.map((w) => (
              <div key={w.name}>
                <p>
                  <strong>{w.name}</strong>: from {w.from}.
                </p>
                <WebhookControls slug={slug} name={w.name} active={data.webhooks.some((h) => h.name === w.name)} />
              </div>
            ))
          : null}
        {data.runs.length ? (
          <>
            <h3>Recent runs</h3>
            <ul>
              {data.runs.map((r) => (
                <li key={r.id}>
                  {r.name}: {STATUS[r.status] ?? r.status}{" "}
                  <span className="muted small">
                    {relativeTime(r.createdAt.toISOString(), now)}
                    {r.error ? `. ${r.error}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    );
  } catch (err) {
    console.error("[jobs] panel:", err instanceof Error ? err.message : "unknown");
    return null;
  }
}
