import { trainStatusLabel, trainTone } from "@/components/train/format";
import type { TrainStatus } from "@/lib/train/types";

/** A fine-tuning job's status, in the same pill as StatusPill: blue while it runs, then green, red or grey. */
export function TrainStatusPill({ status, stopRequested = false }: { status: TrainStatus; stopRequested?: boolean }) {
  return (
    <span className={`pill pill-${trainTone(status)}`}>
      <span className="pill-dot" aria-hidden />
      {trainStatusLabel(status, stopRequested)}
    </span>
  );
}
