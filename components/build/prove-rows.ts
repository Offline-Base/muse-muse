import type { StepItem, StepMedia, StepState } from "@/components/chat";
import { settleProveView } from "@/lib/outputs/labels";
import { usd } from "@/lib/format";
import { condenseProveEvents, type ProveItemState, type ProveItemView } from "@/lib/types";

const ROW_STATE: Record<ProveItemState, StepState> = { planned: "running", running: "running", done: "done", failed: "failed", skipped: "done" };

function outputRow(item: ProveItemView): StepItem {
  const media: StepMedia | undefined = item.media?.posterUrl
    ? { kind: "video", src: item.media.posterUrl, alt: item.media.caption, href: item.media.url }
    : undefined;
  return {
    id: `prove:${item.item}`,
    title: item.title,
    ...(item.detail ? { description: item.detail } : {}),
    state: ROW_STATE[item.state],
    // A folded row hides its media. A row with a video passed, and the product page lists its checks.
    ...(media
      ? { media }
      : item.checks?.length
        ? { children: item.checks.map((c, i) => ({ id: `prove:${item.item}/${i}`, title: c.label, state: c.ok ? ("done" as const) : ("failed" as const) })), folded: true }
        : {}),
  };
}

/**
 * The Prove it step of the build room (docs/PRODUCT_OUTPUTS.md): one row under the deploy, with a row for each output
 * and its video. A run that failed in an output still shows as done here, since the run itself finished: its row says
 * what didn't work. With no run there is no row.
 */
export function proveRows(events: ReadonlyArray<{ type: string; at?: string }>, now: number): StepItem[] {
  const view = settleProveView(condenseProveEvents(events), now);
  if (!view) return [];
  const stage = view.items.find((i) => i.item === "stage");
  const outputs = view.items.filter((i) => i.item !== "stage").map(outputRow);
  const cost = view.costUsd > 0 ? `${usd(view.costUsd)} est.` : "";
  const description = [stage?.detail, cost].filter(Boolean).join(" · ");
  return [
    {
      id: "prove",
      title: view.active ? "Testing what it comes with" : stage?.title ?? "Tested what it comes with",
      ...(description ? { description } : {}),
      state: stage ? ROW_STATE[stage.state] : view.active ? "running" : "done",
      ...(outputs.length ? { children: outputs } : {}),
    },
  ];
}
