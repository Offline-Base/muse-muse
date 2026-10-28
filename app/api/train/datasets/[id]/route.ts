import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, route } from "@/lib/http";
import { toDatasetView } from "@/lib/train/logic";
import { datasetPage, getDataset } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

/** Examples shown on the dataset's page. */
const SAMPLE = 5;

/**
 * GET -> {dataset: DatasetView, sampleTrain: TrainExample[], sampleEval: EvalExample[]}, the first 5 of each. While it
 * is generating, sampleTrain shows the first answered examples, before the eval items are held out. Admins only.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const dataset = await getDataset(id);
  if (!dataset) return errorJson(404, "not_found");
  const [train, held] = await Promise.all([datasetPage(id, "train", 0, SAMPLE), datasetPage(id, "eval", 0, SAMPLE)]);
  return Response.json({ dataset: toDatasetView(dataset), sampleTrain: train?.items ?? [], sampleEval: held?.items ?? [] });
});
