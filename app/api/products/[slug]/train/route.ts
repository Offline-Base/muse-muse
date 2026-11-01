import { handleProductTrain } from "@/lib/caps/gpu/train";
import { trainDeps } from "@/lib/caps/gpu/train-deps";

// "Train on my data" (docs/CAPABILITIES.md, section 17, decision 12): the product's signed-in builder starts one run on
// their own owner rows. 404 while GPU_TRAIN_ON_DATA is off, before anything is read.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return handleProductTrain(req, slug, trainDeps());
}
