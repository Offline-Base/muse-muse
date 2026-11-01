/** The public Try box's limits, on fakes: nothing here calls a provider. npx tsx --test lib/train/host/__tests__/try.test.ts */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { dayWindow } from "@/lib/docs/proxy/limits";
import { facts, JOB, row } from "@/lib/train/host/__tests__/helpers";
import { askAsVisitor, tryMessagesProblem, tryView, wakeForVisitor, TRY_ANSWERS_PER_TEN_MINUTES, type TryDeps } from "@/lib/train/host/try";
import { HostError, type HostAdapter, type HostEndpoint } from "@/lib/train/host/types";
import { TryNote, tryLead } from "@/components/models/TryTuned";
import { renderToStaticMarkup } from "react-dom/server";

const NOW = new Date("2026-11-03T12:00:00Z");
let rows: HostEndpoint[];
let deploys: { provider: string; callerId: string | null; minutes: number }[];
let counters: Map<string, number>;
let chats: { variant?: string; baseRepo?: string | null; first: string }[];
let deployError: Error | null;

const adapter = (id: HostAdapter["id"], hourlyUsd: number, over: Partial<HostAdapter> = {}): HostAdapter => ({
  id,
  label: id,
  missingKeys: () => [],
  cantServe: () => null,
  price: () => ({ hourlyUsd, gpu: "x" }),
  async deploy(input) {
    deploys.push({ provider: id, callerId: input.callerId, minutes: input.minutes });
    if (deployError) throw deployError;
    return { url: "https://secret" };
  },
  status: async () => "ready",
  stop: async () => ({ done: true }),
  inferenceUrl: () => null,
  chat: async (_ref, input) => {
    chats.push({ variant: input.variant, baseRepo: input.baseRepo, first: input.messages[0]!.role });
    return { text: "hi", finish: "stop", usage: { input: 1, output: 1 } };
  },
  ...over,
});

function deps(over: Partial<TryDeps> = {}, limits = { dailyUsd: 10, wakesPerDay: 4, minutes: 60 }): TryDeps {
  const adapters: HostAdapter[] = [adapter("modal", 4.85), adapter("baseten", 6.5), adapter("fireworks", 8, { cantServe: () => "no" }), adapter("lambda", 0.01, { price: () => ({ hourlyUsd: 0.01, gpu: "x", capUsd: 5 }) })];
  const open = () => rows.filter((e) => e.status === "starting" || e.status === "live");
  return {
    on: () => true,
    tryOn: () => true,
    tryLimits: () => limits,
    limits: () => ({ dailyUsd: 25, maxLive: 2, idleMinutes: 15, maxMinutes: 240 }),
    platformCapUsd: () => 500,
    platformSpend: async () => 0,
    adapter: (p) => adapters.find((a) => a.id === p)!,
    adapters: () => adapters,
    rows: async () => rows,
    insert: async (r) => {
      const saved = row({ ...r, status: "starting", ref: null, costUsd: null, stopReason: null, readyAt: null, lastUsedAt: null, stoppedAt: null });
      rows.push(saved);
      return saved;
    },
    patch: async (id, patch) => {
      rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    },
    touch: async () => undefined,
    takeDeployLock: async () => true,
    reserveSpend: async () => "res",
    settleSpend: async () => undefined,
    hashToken: () => "hash",
    newId: () => `00000000-0000-4000-8000-${String(rows.length).padStart(12, "0")}`,
    byOwnerTokenHash: async () => null,
    byModel: async (id) => open().find((e) => e.adapterJobId === id) ?? null,
    findToken: async () => null,
    product: async () => null,
    productOwnsModel: async () => false,
    hitRateLimits: async (keys, start) => {
      const out: Record<string, number> = {};
      for (const k of keys) {
        const key = `${k}|${start.toISOString()}`;
        counters.set(key, (counters.get(key) ?? 0) + 1);
        out[k] = counters.get(key)!;
      }
      return out;
    },
    recordUsage: async () => undefined,
    reserveCounter: async (k, start, amount, limit) => {
      const key = `${k}|${start.toISOString()}`;
      const next = (counters.get(key) ?? 0) + amount;
      if (next > limit) return null;
      counters.set(key, next);
      return next;
    },
    adjustCounter: async (k, start, delta) => {
      const key = `${k}|${start.toISOString()}`;
      counters.set(key, Math.max(0, (counters.get(key) ?? 0) + delta));
    },
    counterValue: async (k, start) => counters.get(`${k}|${start.toISOString()}`) ?? 0,
    ...over,
  };
}
const code = (c: string) => (e: unknown) => e instanceof HostError && e.code === c;
const asleep = (r: HostEndpoint) => ({ ...r, status: "stopped" as const, stoppedAt: NOW });
const ask = (over = {}) => ({ facts: facts(), visitor: "1.2.3.4", variant: "tuned" as const, messages: [{ role: "user" as const, content: "hello" }], system: null, ...over });

beforeEach(() => {
  rows = [];
  deploys = [];
  counters = new Map();
  chats = [];
  deployError = null;
});

describe("waking a model as a visitor", () => {
  it("starts the cheapest allowed provider, with no account, for the try minutes", async () => {
    await wakeForVisitor({ facts: facts(), visitor: "1.1.1.1" }, deps(), NOW);
    assert.deepEqual(deploys, [{ provider: "modal", callerId: null, minutes: 60 }]);
  });

  it("never picks Lambda, even when it is the only one left", async () => {
    const d = deps();
    const only = { ...d, adapter: (p: HostAdapter["id"]) => (p === "lambda" ? d.adapter(p) : adapter(p, 1, { cantServe: () => "no" })) };
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "1.1.1.1" }, only, NOW), code("provider_unavailable"));
    assert.equal(deploys.length, 0);
  });

  it("returns no owner token", async () => {
    assert.equal(await wakeForVisitor({ facts: facts(), visitor: "1.1.1.1" }, deps(), NOW), undefined);
  });

  it("does nothing when the model already runs", async () => {
    rows = [row({ adapterJobId: JOB, status: "live" })];
    await wakeForVisitor({ facts: facts(), visitor: "1.1.1.1" }, deps(), NOW);
    assert.equal(deploys.length, 0);
  });

  it("gives one visitor one wake a day", async () => {
    await wakeForVisitor({ facts: facts(), visitor: "1.1.1.1" }, deps(), NOW);
    rows = rows.map(asleep);
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "1.1.1.1" }, deps(), NOW), code("try_wake_limit"));
    assert.equal(deploys.length, 1);
  });

  it("gives one model two wakes a day, from any visitors", async () => {
    for (const v of ["a", "b"]) {
      await wakeForVisitor({ facts: facts(), visitor: v }, deps({}, { dailyUsd: 100, wakesPerDay: 40, minutes: 60 }), NOW);
      rows = rows.map(asleep);
    }
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "c" }, deps({}, { dailyUsd: 100, wakesPerDay: 40, minutes: 60 }), NOW), code("try_wake_limit"));
    assert.equal(deploys.length, 2);
  });

  it("stops at the daily try budget, however many visitors and models come", async () => {
    let n = 0;
    for (; n < 10; n += 1) {
      const f = facts({ adapterJobId: `aaaaaaaa-0000-4000-8000-00000000000${n}` });
      try {
        await wakeForVisitor({ facts: f, visitor: `v${n}` }, deps(), NOW);
      } catch (err) {
        assert.ok(code("try_budget")(err));
        break;
      }
      rows = rows.map(asleep);
    }
    // $4.85 an hour, an hour each, against $10.
    assert.equal(deploys.length, 2);
  });

  it("stops at the wakes a day, with money left", async () => {
    const big = { dailyUsd: 1000, wakesPerDay: 1, minutes: 60 };
    await wakeForVisitor({ facts: facts({ adapterJobId: "aaaaaaaa-0000-4000-8000-000000000008" }), visitor: "x" }, deps({}, big), NOW);
    rows = rows.map(asleep);
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "y" }, deps({}, big), NOW), code("try_budget"));
    assert.equal(deploys.length, 1);
  });

  it("its day counters survive the hourly prune, which deletes windows that began over an hour ago", async () => {
    const windows: Date[] = [];
    const d = deps();
    const spy = { ...d, reserveCounter: (k: string, w: Date, a: number, l: number) => (windows.push(w), d.reserveCounter(k, w, a, l)) };
    await wakeForVisitor({ facts: facts(), visitor: "x" }, spy, NOW);
    assert.equal(windows.length, 2);
    for (const w of windows) assert.ok(w.getTime() > NOW.getTime());
  });

  it("a zero budget or zero wakes starts nothing", async () => {
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "x" }, deps({}, { dailyUsd: 0, wakesPerDay: 4, minutes: 60 }), NOW), code("try_budget"));
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "z" }, deps({}, { dailyUsd: 10, wakesPerDay: 0, minutes: 60 }), NOW), code("try_budget"));
    assert.equal(deploys.length, 0);
  });

  it("hosting's own limits still hold: a smaller HOST_TUNED day refuses and gives the money back", async () => {
    const d = deps({ limits: () => ({ dailyUsd: 1, maxLive: 2, idleMinutes: 15, maxMinutes: 240 }) });
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "x" }, d, NOW), code("budget_exceeded"));
    assert.equal(deploys.length, 0);
    assert.equal(await d.counterValue("try:usd-cents", dayWindow(NOW)), 0);
    assert.equal(await d.counterValue("try:wakes", dayWindow(NOW)), 0);
  });

  it("a deploy that fails keeps its money taken, since it may have started", async () => {
    deployError = new Error("boom");
    const d = deps();
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "x" }, d, NOW));
    assert.equal(await d.counterValue("try:usd-cents", dayWindow(NOW)), 485);
  });

  it("refuses a model that didn't pass, and any wake with the flag off", async () => {
    await assert.rejects(wakeForVisitor({ facts: facts({ problem: "no" }), visitor: "x" }, deps(), NOW), code("cant_host"));
    await assert.rejects(wakeForVisitor({ facts: facts(), visitor: "x" }, deps({ tryOn: () => false }), NOW), code("not_found"));
    assert.equal(deploys.length, 0);
  });
});

describe("asking as a visitor", () => {
  beforeEach(() => {
    rows = [row({ status: "live", lastUsedAt: NOW, createdAt: new Date(NOW.getTime() - 60_000) })];
  });

  it("never starts anything: a sleeping model says so", async () => {
    rows = [];
    await assert.rejects(askAsVisitor(ask(), deps(), NOW), code("asleep"));
    assert.equal(deploys.length, 0);
  });

  it("asks for the base with the base's repo from the server, and the tuned without", async () => {
    await askAsVisitor(ask({ variant: "base" }), deps(), NOW);
    await askAsVisitor(ask(), deps(), NOW);
    assert.equal(chats[0]!.variant, "base");
    assert.equal(chats[0]!.baseRepo, "OfflineBase/Glimmer-30B-2026-Knowledge");
    assert.equal(chats[1]!.variant, "tuned");
  });

  it("adds the server's system message, first", async () => {
    await askAsVisitor(ask({ system: "You are x." }), deps(), NOW);
    assert.equal(chats[0]!.first, "system");
  });

  it("holds a visitor to the window, and another visitor isn't touched", async () => {
    for (let i = 0; i < TRY_ANSWERS_PER_TEN_MINUTES; i += 1) await askAsVisitor(ask(), deps(), NOW);
    await assert.rejects(askAsVisitor(ask(), deps(), NOW), code("rate_limited"));
    await askAsVisitor(ask({ visitor: "9.9.9.9" }), deps(), NOW);
  });

  it("holds a visitor to the day across windows", async () => {
    let refused = false;
    for (let i = 0; i < 60 && !refused; i += 1) {
      const later = new Date(NOW.getTime() + i * 1000 * 60);
      rows = rows.map((r) => ({ ...r, lastUsedAt: later }));
      await askAsVisitor(ask(), deps(), later).catch((err) => {
        assert.ok(code("rate_limited")(err));
        refused = (err as Error).message.includes("today");
      });
    }
    assert.ok(refused);
  });

  it("the flag off refuses before anything", async () => {
    await assert.rejects(askAsVisitor(ask(), deps({ tryOn: () => false }), NOW), code("not_found"));
    assert.equal(chats.length, 0);
  });
});

describe("what a visitor may send", () => {
  it("takes no system message, and the last turn must be theirs", () => {
    assert.ok(tryMessagesProblem([{ role: "system", content: "x" }]));
    assert.ok(tryMessagesProblem([{ role: "assistant", content: "x" }]));
    assert.equal(tryMessagesProblem([{ role: "user", content: "x" }]), null);
    assert.ok(tryMessagesProblem([{ role: "user", content: "x".repeat(601) }]));
    assert.ok(tryMessagesProblem(Array(7).fill({ role: "user", content: "x" })));
    assert.ok(tryMessagesProblem("nope"));
  });
});

describe("what a visitor sees", () => {
  const duties = { line: "Built with Llama", license: "The license applies.", points: ["Check it."] };
  it("the view has no address, ref, token or dollars", async () => {
    rows = [row({ status: "starting" })];
    const view = await tryView(facts(), deps(), NOW);
    assert.equal(view.state, "waking");
    const text = JSON.stringify(view);
    for (const secret of ["secret-host", "hash", "reservedUsd", "hourlyUsd"]) assert.ok(!text.includes(secret), secret);
  });

  it("says when wake-ups are spent, for a sleeping model", async () => {
    const view = await tryView(facts(), deps({}, { dailyUsd: 1, wakesPerDay: 4, minutes: 60 }), NOW);
    assert.equal(view.state, "asleep");
    assert.match(view.cantWake ?? "", /used up/);
  });

  it("every state says what is going on, and the note is honest about the data", () => {
    assert.match(tryLead({ state: "waking", provider: null, cantWake: null, duties }), /several minutes/);
    assert.match(tryLead({ state: "asleep", provider: null, cantWake: null, duties }), /asleep/);
    const note = renderToStaticMarkup(TryNote({ view: { state: "live", provider: "Modal", cantWake: null, duties } }));
    assert.match(note, /on Modal/);
    assert.match(note, /doesn&#x27;t save your words/);
    assert.match(note, /network address/);
    assert.match(note, /Built with Llama/);
    assert.ok(!note.includes("—"));
  });
});
