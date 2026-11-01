import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { DatasetDetail } from "@/components/train/DatasetDetail";
import { RefreshWhileActive } from "@/components/train/RefreshWhileActive";
import { isDatasetStalled } from "@/components/train/format";
import { toReadyDatasetView } from "@/components/train/results";
import { EmptyCard, NotConnected } from "@/components/ui";
import { safeQuery } from "@/lib/queries";
import type { DecisionRow, DecisionSpec } from "@/lib/decide/types";
import { sampleRowIndexes } from "@/lib/train/decision-datasets";
import { toDatasetView } from "@/lib/train/logic";
import { datasetPage, datasetProgress, decisionSplitRows, getDataset, getReadyDataset } from "@/lib/train/store";
import type { EvalExample, TrainExample } from "@/lib/train/types";
import { pageViewer } from "../../viewer";

export const metadata: Metadata = { title: "Training dataset" };

/** Training conversations the page shows. */
const SAMPLE_TRAIN = 10;
/** Eval prompts the page shows: all of them, since a dataset holds out at most 40. */
const SAMPLE_EVAL = 60;
/** Train rows of each label a decision dataset's page shows admins. */
const SAMPLE_ROWS = 5;
/** What the read-only page shows non-admins: a few of each. */
const LAB_SAMPLE_TRAIN = 3;
const LAB_SAMPLE_EVAL = 5;

/**
 * What non-admins see (docs/TRAINING.md "Lab results"): a ready dataset, read-only, with a few training conversations
 * and eval prompts. One still being written, or one that failed, is a 404.
 */
async function readyDatasetPage(id: string) {
  const now = Date.now();
  const result = await safeQuery(async () => {
    const row = await getReadyDataset(id);
    // The store only answers ready ones. Checked again here, since the samples are read next.
    if (!row || row.status !== "ready") return null;
    // A decision dataset's page shows its labels and counts only: never a person's rows.
    if (row.kind === "decision") return { dataset: toReadyDatasetView(row), sampleTrain: [], sampleEval: [] };
    const [train, held] = await Promise.all([
      datasetPage(row.id, "train", 0, LAB_SAMPLE_TRAIN),
      datasetPage(row.id, "eval", 0, LAB_SAMPLE_EVAL),
    ]);
    return {
      dataset: toReadyDatasetView(row),
      sampleTrain: (train?.items ?? []) as TrainExample[],
      sampleEval: (held?.items ?? []) as EvalExample[],
    };
  });
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this dataset" />
      </div>
    );
  }
  if (!result.data) notFound();
  return <DatasetDetail {...result.data} written={null} now={now} readOnly />;
}

/** The first train rows of each label of a decision dataset, by label id, as GET /api/train/datasets/{id} reads them. */
async function sampleRows(datasetId: string, spec: DecisionSpec): Promise<Record<string, DecisionRow[]>> {
  const read = await decisionSplitRows(datasetId, "train", sampleRowIndexes(spec, "train", SAMPLE_ROWS));
  const out: Record<string, DecisionRow[]> = Object.fromEntries(spec.labels.map((l) => [l.id, []]));
  for (const r of read?.rows.values() ?? []) out[r.label]?.push(r);
  return out;
}

export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const [{ id }, user] = await Promise.all([params, pageViewer()]);
  if (!user?.isAdmin) return readyDatasetPage(id);

  const now = Date.now();
  const result = await safeQuery(async () => {
    const row = await getDataset(id);
    if (!row) return null;
    if (row.kind === "decision" && row.decision) {
      return { dataset: toDatasetView(row), sampleTrain: [], sampleEval: [], written: null, sampleRows: await sampleRows(row.id, row.decision) };
    }
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
