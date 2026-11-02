import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { env } from "@/lib/env";
import { addBuildCost, emit, eventsAfter } from "@/lib/events";
import { metaPlatform } from "@/lib/meta/platform";
import { fromResponsesUsage } from "@/lib/meta/pricing";
import { feedReply, FEED_TIMEOUT_MS, summarizeFeed, type FeedOutcome } from "@/lib/steps-feed/words";
import { platformSpendToday, recordUsage } from "@/lib/usage";
import type { BuildEvent } from "@/lib/types";

const PAGE = 500;

async function allEvents(buildId: string): Promise<BuildEvent[]> {
  const out: BuildEvent[] = [];
  for (;;) {
    const batch = await eventsAfter(buildId, out.at(-1)?.id ?? 0, PAGE);
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

/**
 * BUILD_ROOM_STEPS: one batch of the feed's words (lib/steps-feed/words.ts). The workflow starts it beside the build and
 * never waits for it, so it can't slow or fail one. Never throws and never retries: the next tick picks up what this
 * one missed, and until then, or for good, the feed shows its plain lines. The call counts in the build's costs.
 */
export async function stepsFeedStep(buildId: string, last = false): Promise<FeedOutcome | null> {
  "use step";
  if (!env.buildRoomSteps) return null;
  try {
    const events = await allEvents(buildId);
    return await summarizeFeed(
      events,
      {
        spendOk: async () => (await platformSpendToday()) < env.dailySpendCapUsd,
        respond: async (body, signal) => {
          const r = await metaPlatform().responses.create(
            { ...body, reasoning: { effort: "low" }, text: { format: { type: "json_schema", name: "steps_feed", strict: true, schema: strictJsonSchema(feedReply) } } },
            { signal, maxRetries: 0, timeout: FEED_TIMEOUT_MS },
          );
          return { text: r.output_text ?? "", usage: [fromResponsesUsage(body.model, r.usage)] };
        },
        charge: async (usage) => {
          await recordUsage({ source: "platform", endpoint: "responses", buildId }, usage);
          await addBuildCost(buildId, usage.reduce((sum, u) => sum + (u.costUsd || 0), 0), "Step summaries");
        },
        emit: (body) => emit(buildId, { type: "steps_feed", ...body }),
        log: (message) => console.warn(`[steps feed] ${buildId}: ${message}`),
      },
      last,
    );
  } catch (err) {
    console.warn(`[steps feed] ${buildId}: ${(err as Error).message}`);
    return null;
  }
}
stepsFeedStep.maxRetries = 0;
