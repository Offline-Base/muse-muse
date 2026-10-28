import Link from "next/link";
import { DatasetStatusPill } from "@/components/train/DatasetStatusPill";
import { datasetCountsText, isDatasetStalled } from "@/components/train/format";
import { dateTimeUtc, relativeTime, truncate, usd } from "@/lib/format";
import type { DatasetView } from "@/lib/train/types";

/** The datasets list in the jobs table's style: title, examples, status, cost and when it was made. */
export function DatasetsTable({
  datasets,
  written = {},
  now,
  caption,
}: {
  datasets: DatasetView[];
  /** Examples answered so far, by dataset id, for the ones still being written. */
  written?: Record<string, number>;
  now: number;
  caption: string;
}) {
  return (
    <div className="table-wrap">
      <table className="data data-list">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Dataset</th>
            <th scope="col">Examples</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Cost (est.)
            </th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((d) => {
            const stalled = isDatasetStalled(d, now);
            // A dataset with no title is named after the start of its task, so the task would only repeat it.
            const showTask = !d.task.startsWith(d.title);
            return (
              <tr key={d.id}>
                <td>
                  <Link href={`/fine-tuning/datasets/${d.id}`} className="row-title">
                    {d.title}
                  </Link>
                  {d.status === "failed" && d.error ? (
                    <span className="row-sub train-row-error">{truncate(d.error, 90)}</span>
                  ) : d.status === "ready" && d.error ? (
                    <span className="row-sub muted">{truncate(d.error, 90)}</span>
                  ) : stalled ? (
                    <span className="row-sub muted">Started over 6 hours ago and never finished. Its workflow most likely stopped.</span>
                  ) : showTask ? (
                    <span className="row-sub muted">{truncate(d.task, 90)}</span>
                  ) : null}
                </td>
                <td className="train-nowrap">{datasetCountsText(d, written[d.id] ?? null)}</td>
                <td>
                  <DatasetStatusPill status={d.status} stalled={stalled} />
                </td>
                <td className="num">{usd(d.costUsd)}</td>
                <td className="train-nowrap">
                  <time dateTime={d.createdAt} title={dateTimeUtc(d.createdAt)}>
                    {relativeTime(d.createdAt, now)}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
