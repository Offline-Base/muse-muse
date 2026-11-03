/**
 * Where the platform takes the owner's shared keys out (docs/BUILD_KEYS.md, leak guards): build events on the way in
 * and out, a build's status message and error, the Code page's and source.zip's secret check, the judge's text and the
 * old recorder's captions. The database is faked and every value is made up. Needs --experimental-test-module-mocks for
 * the events part (it skips without it).
 *
 *   npx tsx --experimental-test-module-mocks --test lib/keys/__tests__/redaction.scenario.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

const TOKEN = "hf_fakeRedactToken0123456789abcd";
const canMock = typeof (mock as { module?: unknown }).module === "function";

const inserted: unknown[] = [];
const updated: unknown[] = [];
let stored: Array<{ id: number; payload: unknown; at: Date }> = [];

const fakeDb = () => ({
  insert: () => ({ values: async (v: unknown) => void inserted.push(v) }),
  update: () => ({ set: (v: unknown) => ({ where: async () => void updated.push(v) }) }),
  select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => stored }) }) }) }),
});

before(() => {
  process.env.BUILD_SHARED_HF_TOKEN = TOKEN;
});
after(() => {
  delete process.env.BUILD_SHARED_HF_TOKEN;
});

describe("build events", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let events: typeof import("@/lib/events");
  before(async () => {
    mock.module(new URL("../../db/client.ts", import.meta.url).href, {
      namedExports: { db: fakeDb, schema: { buildEvents: { buildId: "build_id", id: "id", type: "type" }, builds: { id: "id", costUsd: "cost_usd" } } },
    });
    events = await import(new URL("../../events.ts", import.meta.url).href);
  });

  it("an event is stored without the key, its type kept", async () => {
    inserted.length = 0;
    await events.emit("b1", { type: "log", text: `printed ${TOKEN} by mistake` });
    const row = inserted[0] as { type: string; payload: { text: string } };
    assert.equal(row.type, "log");
    assert.equal(row.payload.text, "printed [redacted] by mistake");
  });

  it("a status's message and error are stored without the key, and its dates stay dates", async () => {
    inserted.length = 0;
    updated.length = 0;
    const when = new Date("2026-11-02T00:00:00Z");
    await events.setBuildStatus("b1", "failed", { message: `failed with ${TOKEN}`, set: { error: `Error: ${TOKEN}`, startedAt: when } as never });
    const set = updated[0] as { error: string; message?: string; startedAt: Date; finishedAt: Date };
    assert.equal(set.error, "Error: [redacted]");
    assert.equal(set.startedAt, when);
    assert.ok(set.finishedAt instanceof Date);
    assert.equal((inserted[0] as { payload: { message: string } }).payload.message, "failed with [redacted]");
  });

  it("events stored before are redacted on the way out to the build room", async () => {
    stored = [{ id: 7, payload: { type: "log", text: `old ${TOKEN}` }, at: new Date("2026-11-02T00:00:00Z") }];
    const out = await events.eventsAfter("b1", 0);
    assert.deepEqual(out, [{ type: "log", text: "old [redacted]", id: 7, at: "2026-11-02T00:00:00.000Z" }]);
  });
});

describe("files, the judge and captions", () => {
  it("a file with the key, plain or encoded, is held from the Code page, source.zip and the GitHub export", async () => {
    const { holdsSecret } = await import("@/lib/versions/policy");
    assert.equal(holdsSecret(Buffer.from(`const k = "${TOKEN}";`)), true);
    assert.equal(holdsSecret(Buffer.from(`Basic ${Buffer.from(`u:${TOKEN}`).toString("base64")}`)), true);
    assert.equal(holdsSecret(Buffer.from("const k = process.env.HF_TOKEN;")), false);
  });

  it("the judge reads no key in any text part, and its images are left as they are", async () => {
    const { judgeContent } = await import("@/lib/judge");
    const brief = { name: "X", tagline: "t", user: "u", verdict: "yes", inspiration: { summary: "s", references: [], borrow: [], dontCopy: [] }, fixtures: [], capabilities: [], primaryFlow: [], screens: [], inputs: [], outputs: [], actions: [], limits: [], complexity: "simple", estimatedCostPerRunUsd: 0, costNotes: "" };
    const { content } = judgeContent({
      brief: brief as never,
      references: [],
      screenshots: [{ url: "https://blob.example/s.png", caption: `shows ${TOKEN}` }],
      ownerNotes: [`use ${TOKEN}`],
    });
    const text = content.filter((p) => p.type === "input_text").map((p) => (p as { text: string }).text).join("\n");
    assert.ok(!text.includes(TOKEN));
    assert.match(text, /\[redacted\]/);
    assert.ok(content.some((p) => p.type === "input_image"));
  });

  it("the old recorder's captions never show the key", async () => {
    const { captionTimeline } = await import("@/lib/sandbox/artifacts");
    const caps = captionTimeline([{ title: `Paste ${TOKEN}`, duration: 2000 } as never], 5);
    assert.equal(caps[0].text, "Paste [redacted]");
  });
});
