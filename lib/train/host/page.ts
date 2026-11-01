/** Reading one model's Run it state, for the page and its routes. Reaches launch through deps, so only they import it. */
import type { SessionUser } from "@/lib/auth";
import { hostAdapters, hostLimits } from "@/lib/train/host/deps";
import { mayUseModel } from "@/lib/train/host/limits";
import { hostFacts } from "@/lib/train/host/facts";
import { hostRows } from "@/lib/train/host/store";
import { hostView, type HostView } from "@/lib/train/host/view";
import { getAdapterSource } from "@/lib/train/store";

/** With a viewer, null unless they may use this model: its page is public, and the section isn't. */
export async function loadHostView(modelId: string, now: Date = new Date(), viewer?: SessionUser): Promise<HostView | null> {
  const source = await getAdapterSource(modelId);
  if (!source) return null;
  if (viewer && !mayUseModel(viewer, source.job.createdBy)) return null;
  return hostView(hostFacts(source.job, source.metrics), hostAdapters(), await hostRows(now), hostLimits(), now);
}
