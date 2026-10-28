import { DATASET_STATUS_LABEL, datasetTone } from "@/components/train/format";
import type { DatasetStatus } from "@/lib/train/types";

/** A dataset's status in the same pill as the jobs: blue while it is written, then green or red. A stalled one is grey. */
export function DatasetStatusPill({ status, stalled = false }: { status: DatasetStatus; stalled?: boolean }) {
  return (
    <span className={`pill pill-${stalled ? "neutral" : datasetTone(status)}`}>
      <span className="pill-dot" aria-hidden />
      {stalled ? "Stalled" : (DATASET_STATUS_LABEL[status] ?? status)}
    </span>
  );
}
