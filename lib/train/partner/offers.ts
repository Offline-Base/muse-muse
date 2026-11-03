/**
 * What an admin sees before starting partner evals: per partner, whether this job can go there, why not, and the most it
 * would cost at list price (lib/train/partner/logic.ts partnerOffer). The same checks the plan step makes, read only:
 * nothing is recorded or deployed. A plain module, not a step file, so the route can call it.
 */
import { checkSetOf } from "@/lib/train/general-checks";
import { hostFacts } from "@/lib/train/host/facts";
import { providerRefusal } from "@/lib/train/host/service";
import type { PartnerDeps } from "@/lib/train/partner/deps";
import { allowedPartners, fireworksPartnerProblem, PARTNER_MAX_ITEMS, partnerOffer, type PartnerOffers } from "@/lib/train/partner/logic";

export async function partnerOffers(jobId: string, d: PartnerDeps): Promise<PartnerOffers | null> {
  const s = d.settings();
  const source = await d.source(jobId);
  if (!source) return null;
  const facts = hostFacts(source.job, source.metrics);
  const host = d.host();
  const [indexes, results, judgeReady] = await Promise.all([d.evalIndexes(jobId), d.results(jobId), d.judgeReady()]);
  const items = indexes.filter((i) => checkSetOf(i) === null).slice(0, PARTNER_MAX_ITEMS).length;
  const now = d.now();
  const offers = [];
  for (const provider of allowedPartners(s)) {
    const adapter = host.adapter(provider);
    const refusal = providerRefusal(facts, adapter);
    const fireworks =
      !refusal && provider === "fireworks" && !facts.fireworksModel && facts.hubRepo && facts.hubCommit ? fireworksPartnerProblem(facts, await d.adapterConfig(facts.hubRepo, facts.hubCommit)) : null;
    offers.push(partnerOffer({ provider, facts, refusal, fireworks, price: adapter.price(facts), settings: s, items, results, judgeReady, now }));
  }
  return { offers, maxUsd: s.maxUsd, runMaxUsd: s.runMaxUsd ?? null };
}
