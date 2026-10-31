import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, route } from "@/lib/http";
import type { DecisionRow } from "@/lib/decide/types";
import { sampleRowIndexes } from "@/lib/train/decision-datasets";
import { toDatasetView } from "@/lib/train/logic";
import { datasetPage, decisionSplitRows, getDataset } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

/** Examples shown on the dataset's page. */
const SAMPLE = 5;

/**
 * GET -> {dataset: DatasetView, sampleTrain: TrainExample[], sampleEval: EvalExample[]}, the first 5 of each. While it
 * is generating, sampleTrain shows the first answered examples, before the eval items are held out, and sampleEval is
 * empty (eval then holds the answers of the chunk being written). Admins only.
 *
 * A decision dataset's view carries its spec (dataset.decision: the question, labels, seed and rows per split), and
 * the reply adds sampleRows: the first 5 train rows of each label, by label id, as {input, label}. Its sampleTrain and
 * sampleEval are empty, since its rows aren't chat examples.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const dataset = await getDataset(id);
  if (!dataset) return errorJson(404, "not_found");
  if (dataset.kind === "decision" && dataset.decision) {
    const spec = dataset.decision;
    const read = await decisionSplitRows(id, "train", sampleRowIndexes(spec, "train", SAMPLE));
    const sampleRows: Record<string, DecisionRow[]> = Object.fromEntries(spec.labels.map((l) => [l.id, []]));
    for (const row of read?.rows.values() ?? []) sampleRows[row.label]?.push(row);
    return Response.json({ dataset: toDatasetView(dataset), sampleTrain: [], sampleEval: [], sampleRows });
  }
  const [train, held] = await Promise.all([
    datasetPage(id, "train", 0, SAMPLE),
    dataset.status === "ready" ? datasetPage(id, "eval", 0, SAMPLE) : Promise.resolve(null),
  ]);
  return Response.json({ dataset: toDatasetView(dataset), sampleTrain: train?.items ?? [], sampleEval: held?.items ?? [] });
});
