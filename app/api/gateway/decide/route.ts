import { handleDecide, type DecideDeps } from "@/lib/gateway/decide";
import { hitRateLimits, productStatusById } from "@/lib/gateway/store";
import { findToken } from "@/lib/gateway/tokens";
import { windowBackends } from "@/lib/train/decide-window";
import { getDecisionModel, liveDecisionServeTarget, liveServeTarget, releaseDemoSlot, takeDemoSlot } from "@/lib/train/store";
import { recordUsage } from "@/lib/usage";

// Decisions for products (lib/gateway/decide.ts, docs/DECISION_MODELS.md "The gateway route"). A decision is two forward
// passes of at most 3 prompts on the GPU, well under 2 s, plus the wait for the window's one slot; the call gives up
// at 30 s.
export const runtime = "nodejs";
export const maxDuration = 60;

const deps: DecideDeps = {
  findToken,
  productStatus: productStatusById,
  hitRateLimits,
  findModel: getDecisionModel,
  // The lab's own serving windows: a glimmer-serve job of that decision model, or for base Glimmer (muse-decide until
  // it is trained) any decision model's. Wave 3 unit 11's shared endpoint is another DecideBackend for this slot.
  backend: windowBackends({
    target: (adapter) => (adapter ? liveServeTarget(adapter) : liveDecisionServeTarget()),
    takeSlot: (serveJobId) => takeDemoSlot(serveJobId),
    releaseSlot: releaseDemoSlot,
  }),
  recordUsage,
};

export async function POST(req: Request) {
  return handleDecide(req, deps);
}
