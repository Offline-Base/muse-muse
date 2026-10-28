import type { Metadata } from "next";
import { connection } from "next/server";
import { AdminsOnly } from "@/components/train/AdminsOnly";
import { DatasetDetail } from "@/components/train/DatasetDetail";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import { isDatasetStalled } from "@/components/train/format";
import { EmptyCard, NotConnected, PageHeader } from "@/components/ui";
import { safeQuery } from "@/lib/queries";
import { toDatasetView } from "@/lib/train/logic";
import { datasetPage, datasetProgress, getDataset } from "@/lib/train/store";
import type { EvalExample, TrainExample } from "@/lib/train/types";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Training dataset" };

/** Training conversations the page shows. */
const SAMPLE_TRAIN = 10;
/** Eval prompts the page shows: all of them, since a dataset holds out at most 40. */
const SAMPLE_EVAL = 60;

export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const [{ id }, user] = await Promise.all([params, pageViewer()]);
  if (!user?.isAdmin) {
    return (
      <div className="page">
        <PageHeader title="Training dataset" />
        <AdminsOnly signedIn={Boolean(user)} next={`/fine-tuning/datasets/${encodeURIComponent(id)}`} />
      </div>
    );
  }

  const now = Date.now();
  const result = await safeQuery(async () => {
    const row = await getDataset(id);
    if (!row) return null;
    const [train, held, written] = await Promise.all([
      datasetPage(row.id, "train", 0, SAMPLE_TRAIN),
      // Until it is ready, eval holds the answers of the chunk being written, not held-out items.
      row.status === "ready" ? datasetPage(row.id, "eval", 0, SAMPLE_EVAL) : Promise.resolve(null),
      row.status === "generating" ? datasetProgress(row.id) : Promise.resolve(null),
    ]);
    return {
      dataset: toDatasetView(row),
      sampleTrain: (train?.items ?? []) as TrainExample[],
      sampleEval: (held?.items ?? []) as EvalExample[],
      written,
    };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this dataset" />
      </div>
    );
  }
  if (!result.data) {
    return (
      <div className="page">
        <EmptyCard icon="file" title="No dataset here" action={{ href: "/fine-tuning#datasets", label: "See all datasets" }}>
          <p>This link doesn&apos;t match a training dataset. It may have a typo.</p>
        </EmptyCard>
      </div>
    );
  }

  const { dataset } = result.data;
  return (
    <>
      <RefreshWhileActive active={dataset.status === "generating" && !isDatasetStalled(dataset, now)} />
      <DatasetDetail {...result.data} now={now} />
    </>
  );
}
