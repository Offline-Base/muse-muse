import type { Feed } from "@/lib/steps-feed/facts";

/**
 * BUILD_ROOM_STEPS: the steps a five year old could follow, one bullet each, with a short recap and a kind comment
 * after every three (lib/steps-feed/facts.ts). A finished build keeps it as its history. The raw steps stay behind Show
 * details.
 */
export function StepsFeed({ feed, label = "What Muse Code is doing" }: { feed: Pick<Feed, "rows">; label?: string }) {
  if (!feed.rows.length) return null;
  return (
    <ul className="steps-feed" aria-label={label}>
      {feed.rows.map((row) =>
        row.type === "step" ? (
          <li key={row.step.id} className="steps-feed-step" data-tone={row.step.tone} data-running={row.running}>
            {row.step.text}
          </li>
        ) : (
          <li key={`recap-${row.recap.after}`} className="steps-feed-recap">
            <p>{row.recap.text}</p>
            <p className="steps-feed-comment">{row.recap.comment}</p>
          </li>
        ),
      )}
    </ul>
  );
}
