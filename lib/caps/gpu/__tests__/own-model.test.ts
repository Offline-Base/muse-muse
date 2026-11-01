/**
 * ownModelFor (the contract with General): the newest job trained for a product that passes evalVerdict and can still be
 * served. On fakes.
 *
 *   npx tsx --test lib/caps/gpu/__tests__/own-model.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownModelFor, type OwnModelDeps } from "@/lib/caps/gpu/own-model";

const R30B = "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit";
const PASS = { items: 20, tunedWins: 16, baseWins: 3, ties: 1, avgTunedScore: 8.5, avgBaseScore: 3.1 };
const FAIL = { ...PASS, tunedWins: 5, baseWins: 14, avgTunedScore: 3, avgBaseScore: 7 };

type Job = { id: string; params?: Record<string, string | number>; evalSummary?: unknown; cache?: boolean };

function deps(list: Job[]): OwnModelDeps & { filled: string[] } {
  const filled: string[] = [];
  return {
    filled,
    fill: async (id) => void filled.push(id),
    jobs: (async () =>
      list.map((j) => ({ id: j.id, title: "t", params: { baseModel: R30B, ...j.params }, evalSummary: j.evalSummary ?? null, status: "succeeded", recipe: "glimmer-lora", createdAt: new Date() }))) as unknown as OwnModelDeps["jobs"],
    source: (async (id: string) => {
      const j = list.find((x) => x.id === id)!;
      return {
        job: { id, recipe: "glimmer-lora", status: "succeeded", params: { baseModel: R30B, ...j.params } },
        metrics: j.cache === false ? {} : { cache_used: "yes", adapter_dir: `/cache/models/${id}` },
      };
    }) as unknown as OwnModelDeps["source"],
  };
}

describe("ownModelFor", () => {
  it("fills the job's product from its run, then picks the newest that passed", async () => {
    const d = deps([{ id: "new-fail", evalSummary: FAIL }, { id: "mid-pass", evalSummary: PASS, params: { trainChannel: 1 } }, { id: "old-pass", evalSummary: PASS }]);
    assert.deepEqual(await ownModelFor("p1", new Date(), d), { adapterJobId: "mid-pass", trainChannel: 1 });
    assert.deepEqual(d.filled, ["p1"]);
  });

  it("is null with no jobs, and for a job not yet judged", async () => {
    assert.equal(await ownModelFor("p1", new Date(), deps([])), null);
    assert.equal(await ownModelFor("p1", new Date(), deps([{ id: "a" }])), null);
  });

  it("refuses an adapter a GPU can't serve, or one trained on plain Glimmer, as General's start check does", async () => {
    assert.equal(await ownModelFor("p1", new Date(), deps([{ id: "a", evalSummary: PASS, cache: false }])), null);
    assert.equal(await ownModelFor("p1", new Date(), deps([{ id: "a", evalSummary: PASS, params: { baseModel: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit" } }])), null);
    assert.equal(await ownModelFor("p1", new Date(), deps([{ id: "a", evalSummary: PASS, params: { dryRun: 1 } }])), null);
  });

  it("never returns a decision model as a chat model", async () => {
    assert.equal(await ownModelFor("p1", new Date(), deps([{ id: "a", evalSummary: PASS, params: { mode: "decide" } }])), null);
  });
});
