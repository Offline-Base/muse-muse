/**
 * Drives POST /api/builds/[buildId]/control with the database, requireUser, the rate limiter, the event log and the
 * sandbox faked: only the build's owner (or an admin), never from another site and never while steering is off, every
 * field checked, nothing outside a Muse Code round, the envelopes sendMuseCommand gets, the control event, the Stop's
 * mark on the build row, and 20 commands a minute. The build room's steer box (components/build/SteerBox.tsx) runs
 * against the same route, so the two agree on the body and every error code, and the build room shows it only while a
 * round runs. Nothing reaches a sandbox or Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/pipeline/__tests__/control-route.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realSchema from "@/lib/db/schema";
import type { SessionUser } from "@/lib/auth";
import type { MuseCommandEnvelope } from "@/lib/sandbox/bridge-protocol";

const BUILD_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const CHILD = "01a18fef-c533-74a3-b49d-da9cf5ff74b8";
/** Built from its code point, so this file holds none. */
const EM_DASH = String.fromCharCode(0x2014);
const OWNER: SessionUser = { id: "11111111-1111-4111-8111-111111111111", email: "maker@example.com", isAdmin: false };
const STRANGER: SessionUser = { id: "22222222-2222-4222-8222-222222222222", email: "someone@example.com", isAdmin: false };
const ADMIN: SessionUser = { id: "33333333-3333-4333-8333-333333333333", email: "admin@example.com", isAdmin: true };
/** The shared open-access account. It owns nothing it can act on, even a build it started. */
const GUEST: SessionUser = { ...OWNER, email: "guest@musemuse.invalid", openAccess: true };

type Call = { fn: string; args: unknown[] };
let calls: Call[] = [];
/** What the build lookup finds: the build joined to its product's owner. Null for no build. */
let row: Record<string, unknown> | null = null;
/** What the Stop's update returns: the build, when it was still in a round. */
let marked: Record<string, unknown>[] = [];
let viewer: SessionUser | null = OWNER;
let sendFails = false;
let hits: Record<string, number> = {};

const called = (fn: string) => calls.filter((c) => c.fn === fn);
const sent = () => called("sendMuseCommand").map((c) => c.args[0] as { sandboxName: string; round: number; envelope: MuseCommandEnvelope });
const events = () => called("emit").map((c) => c.args[1] as Record<string, unknown>);

function inRound(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: OWNER.id,
    status: "building",
    fixRounds: 0,
    sandboxName: "product-shelf-scout-6f1d2c3b",
    museRound: 0,
    ownerId: OWNER.id,
    ...over,
  };
}

const fakeDb = () => ({
  select: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "where", "orderBy"]) q[m] = () => q;
    q.limit = async () => {
      calls.push({ fn: "select", args: [] });
      return row ? [row] : [];
    };
    return q;
  },
  update: (t: never) => {
    const update = { table: getTableName(t), set: {} as Record<string, unknown>, where: undefined as SQL | undefined };
    const q: Record<string, unknown> = {};
    q.set = (values: Record<string, unknown>) => {
      update.set = values;
      return q;
    };
    q.where = (where: SQL) => {
      update.where = where;
      return q;
    };
    q.returning = async () => {
      calls.push({ fn: "update", args: [update] });
      return marked;
    };
    return q;
  },
});

const canMock = typeof (mock as { module?: unknown }).module === "function";
type Ctx = { params: Promise<{ buildId: string }> };
let POST: (req: Request, ctx: Ctx) => Promise<Response>;
let steer: typeof import("@/components/build/SteerBox");
const savedEngine = process.env.MUSE_ENGINE;
const savedFull = process.env.MUSE_FULL;

function controlReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://muse.example.com/api/builds/${BUILD_ID}/control`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ctx = (buildId = BUILD_ID): Ctx => ({ params: Promise.resolve({ buildId }) });

async function send(body: unknown, headers?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await POST(controlReq(body, headers), ctx());
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/builds/{id}/control", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module(at("../../db/client.ts"), { namedExports: { db: fakeDb, schema: realSchema } });
    // lib/auth as it is (canActAsOwner and the same-origin check included), with a requireUser the test sets.
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    mock.module(at("../../auth.ts"), {
      namedExports: {
        ...realAuth,
        requireUser: async () => {
          calls.push({ fn: "requireUser", args: [] });
          if (!viewer) throw new realAuth.AuthError("Sign in to build.", 401);
          return viewer;
        },
      },
    });
    mock.module(at("../../events.ts"), {
      namedExports: { emit: async (...args: unknown[]) => void calls.push({ fn: "emit", args }) },
    });
    mock.module(at("../../gateway/store.ts"), {
      namedExports: {
        hitRateLimits: async (keys: string[], windowStart: Date) => {
          calls.push({ fn: "hitRateLimits", args: [keys, windowStart] });
          return Object.fromEntries(keys.map((k) => [k, (hits[k] = (hits[k] ?? 0) + 1)]));
        },
      },
    });
    mock.module(at("../../sandbox/builder.ts"), {
      namedExports: {
        sendMuseCommand: async (input: unknown) => {
          calls.push({ fn: "sendMuseCommand", args: [input] });
          if (sendFails) throw new Error("The session bridge isn't built yet.");
        },
      },
    });
    ({ POST } = await import(at("../../../app/api/builds/[buildId]/control/route.ts")));
    steer = await import("@/components/build/SteerBox");
  });

  after(() => {
    mock.restoreAll();
    for (const [k, v] of [
      ["MUSE_ENGINE", savedEngine],
      ["MUSE_FULL", savedFull],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    process.env.MUSE_ENGINE = "serve";
    delete process.env.MUSE_FULL;
    calls = [];
    hits = {};
    row = inRound();
    marked = [];
    viewer = OWNER;
    sendFails = false;
  });

  it("puts the owner's note in the running round's mailbox as an envelope, and tells the build room", async () => {
    const before = Date.now();
    const res = await send({ action: "steer", text: "  Make the start button bigger.\r\nKeep it blue.  " });
    assert.equal(res.status, 200);
    const [one, ...rest] = sent();
    assert.equal(rest.length, 0);
    assert.equal(one!.sandboxName, "product-shelf-scout-6f1d2c3b");
    assert.equal(one!.round, 0);
    const { envelope } = one!;
    assert.deepEqual(res.json, { ok: true, id: envelope.id });
    assert.match(envelope.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(Date.parse(envelope.at) >= before && Date.parse(envelope.at) <= Date.now(), "at is now");
    assert.equal(envelope.at, new Date(envelope.at).toISOString());
    assert.equal(envelope.by, "owner");
    assert.deepEqual(envelope.command, { type: "steer", text: "Make the start button bigger.\nKeep it blue." });
    assert.deepEqual(events(), [
      { type: "control", round: 0, action: "steer", text: "Make the start button bigger.\nKeep it blue.", ok: true },
    ]);
    assert.equal(called("emit")[0]!.args[0], BUILD_ID);
    assert.equal(called("update").length, 0, "only a stop marks the build");
  });

  it("sends to the round the build row names, and numbers the event as the build room's rounds", async () => {
    // A refinement's second fix round: its log and mailbox are round 12, and the build room calls it fix round 2.
    row = inRound({ status: "fixing", fixRounds: 2, museRound: 12 });
    assert.equal((await send({ action: "queue", text: "After this, add a dark mode." })).status, 200);
    assert.equal(sent()[0]!.round, 12);
    assert.deepEqual(sent()[0]!.envelope.command, { type: "queue", text: "After this, add a dark mode." });
    assert.deepEqual(events(), [{ type: "control", round: 2, action: "queue", text: "After this, add a dark mode.", ok: true }]);
  });

  it("marks the build before anything else for a stop, then sends an interrupt and an end, in that order", async () => {
    marked = [{ museRound: 0, status: "building", fixRounds: 0 }];
    assert.equal((await send({ action: "stop" })).status, 200);
    const order = calls.map((c) => c.fn).filter((fn) => fn === "update" || fn === "sendMuseCommand" || fn === "emit");
    assert.deepEqual(order, ["update", "sendMuseCommand", "sendMuseCommand", "emit"]);
    const update = called("update")[0]!.args[0] as { table: string; set: Record<string, unknown>; where: SQL };
    assert.equal(update.table, "builds");
    assert.deepEqual(update.set, { stopRequested: true });
    // Only a build still in a round takes the mark, in the same statement, so a run that just ended can't miss it.
    const where = new PgDialect().sqlToQuery(update.where);
    assert.match(where.sql, /"builds"\."id" = \$1/);
    assert.match(where.sql, /"builds"\."status" in \(\$2, \$3\)/);
    assert.match(where.sql, /"builds"\."muse_round" is not null/);
    assert.deepEqual(where.params, [BUILD_ID, "building", "fixing"]);

    const [interrupt, end] = sent().map((s) => s.envelope);
    assert.deepEqual(interrupt!.command, { type: "interrupt" });
    assert.equal(end!.command.type, "end");
    assert.notEqual(interrupt!.id, end!.id);
    // The mailbox applies files in name order (`<at>-<id>.json`), so the end is always named after the interrupt.
    assert.ok(`${interrupt!.at}-${interrupt!.id}` < `${end!.at}-${end!.id}`);
    assert.deepEqual(events(), [{ type: "control", round: 0, action: "stop", ok: true }]);
  });

  it("refuses a stop when the round ended between the lookup and the mark", async () => {
    marked = [];
    const res = await send({ action: "stop" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: "no_round" });
    assert.equal(sent().length + events().length, 0);
  });

  it("keeps a stop when the sandbox can't be reached, and says so for anything else", async () => {
    sendFails = true;
    marked = [{ museRound: 0, status: "building", fixRounds: 0 }];
    assert.equal((await send({ action: "stop" })).status, 200, "the workflow ends the build either way");
    assert.deepEqual(events(), [{ type: "control", round: 0, action: "stop", ok: true }]);

    calls = [];
    const res = await send({ action: "steer", text: "Use bigger type." });
    assert.equal(res.status, 502);
    assert.deepEqual(res.json, { error: "not_delivered" });
    assert.deepEqual(events(), [
      {
        type: "control",
        round: 0,
        action: "steer",
        text: "Use bigger type.",
        ok: false,
        error: "Muse Code couldn't be reached, so this didn't arrive.",
      },
    ]);
  });

  it("answers 404 to anyone but the build's owner or an admin, and 401 to someone signed out", async () => {
    for (const who of [STRANGER, GUEST]) {
      viewer = who;
      const res = await send({ action: "steer", text: "Hello" });
      assert.equal(res.status, 404, who.email);
      assert.deepEqual(res.json, { error: "not_found" });
    }
    // The product's owner decides, not whoever asked for the change.
    viewer = OWNER;
    row = inRound({ userId: STRANGER.id, ownerId: OWNER.id });
    assert.equal((await send({ action: "steer", text: "Hello" })).status, 200);
    row = inRound({ userId: OWNER.id, ownerId: STRANGER.id });
    assert.equal((await send({ action: "steer", text: "Hello" })).status, 404);

    viewer = ADMIN;
    row = inRound();
    assert.equal((await send({ action: "steer", text: "Hello" })).status, 200, "admins have owner powers, as for changes");

    viewer = null;
    assert.equal((await send({ action: "steer", text: "Hello" })).status, 401);

    viewer = OWNER;
    row = null;
    assert.equal((await send({ action: "steer", text: "Hello" })).status, 404, "an unknown build");
    assert.equal((await POST(controlReq({ action: "steer", text: "Hello" }), ctx("not-a-build"))).status, 404);
    // Only the product's owner and the admin got through.
    assert.equal(sent().length, 2);
  });

  it("refuses requests from other sites, and everything while steering is off, before asking who is signed in", async () => {
    const elsewhere: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "", origin: "https://evil.example" },
    ];
    for (const headers of elsewhere) {
      const res = await send({ action: "stop" }, headers);
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.deepEqual(res.json, { error: "cross_site" });
    }
    delete process.env.MUSE_ENGINE;
    const off = await send({ action: "steer", text: "Hello" });
    assert.equal(off.status, 503);
    assert.deepEqual(off.json, { error: "steering_off" });
    assert.equal(called("requireUser").length + called("select").length + sent().length, 0);

    // MUSE_FULL's hook hands notes to `muse exec`, so it turns steering on too.
    process.env.MUSE_FULL = "1";
    assert.equal((await send({ action: "steer", text: "Hello" })).status, 200);
  });

  it("answers 409 while no Muse Code round runs", async () => {
    for (const over of [
      { status: "verifying", museRound: null },
      { status: "building", museRound: null },
      { status: "fixing", museRound: null },
      { status: "live", museRound: null },
      { status: "failed", museRound: 3 },
      { status: "building", museRound: 0, sandboxName: null },
    ]) {
      row = inRound(over);
      const res = await send({ action: "steer", text: "Hello" });
      assert.equal(res.status, 409, JSON.stringify(over));
      assert.deepEqual(res.json, { error: "no_round" });
    }
    assert.equal(sent().length + events().length + called("hitRateLimits").length, 0);
  });

  it("checks every field, and refuses the body with a sentence before looking the build up", async () => {
    const id = { userInputId: "01a18fef-c524-7db2-9531-d6a40e6ba223" };
    const bad: Array<[unknown, RegExp]> = [
      [{}, /^Say what to do: steer, queue/],
      [{ action: "dance" }, /^Say what to do/],
      [{ action: "steer" }, /^Write the note first\.$/],
      [{ action: "steer", text: " \n\t " }, /^Write the note first\.$/],
      [{ action: "steer", text: 42 }, /^Write the note first\.$/],
      [{ action: "steer", text: "x".repeat(4001) }, /^Keep the note to 4,000 characters\.$/],
      [{ action: "steer", text: "red\u0000blue" }, /control characters/],
      [{ action: "steer", text: "\u001b[31mred" }, /control characters/],
      [{ action: "steer", text: "a\u0085b" }, /control characters/],
      [{ action: "steer", text: "broken \ud800 pair" }, /control characters/],
      [{ action: "steer", text: "Hello", txet: "typo" }, /^Send only the fields this action takes\.$/],
      [{ action: "queue", text: "" }, /^Write the note first\.$/],
      [{ action: "goal" }, /^Say what to do with the goal/],
      [{ action: "goal", goalAction: "finish" }, /^Say what to do with the goal/],
      [{ action: "goal", goalAction: "set" }, /^Write the goal first\.$/],
      [{ action: "goal", goalAction: "edit", objective: "y".repeat(4001) }, /^Keep the goal to 4,000 characters\.$/],
      [{ action: "answer", userInputId: "../../etc/passwd", answers: [{ questionId: "q1", selectedLabel: "Yes" }] }, /^Say which question/],
      [{ action: "answer", answers: [{ questionId: "q1", selectedLabel: "Yes" }] }, /^Say which question/],
      [{ action: "answer", ...id, answers: [] }, /^Send one answer for each question/],
      [{ action: "answer", ...id, answers: [1, 2, 3, 4] }, /^Send one answer for each question/],
      [{ action: "answer", ...id, answers: ["Yes"] }, /^Send each answer as an object\.$/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1" }] }, /only one of those/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1", selectedLabel: "Yes", freeText: "and no" }] }, /only one of those/],
      [{ action: "answer", ...id, answers: [{ questionId: "", selectedLabel: "Yes" }] }, /needs the id of the question/],
      [{ action: "answer", ...id, answers: [{ questionId: "q".repeat(65), selectedLabel: "Yes" }] }, /needs the id of the question/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1", selectedLabel: "Y".repeat(81) }] }, /^Pick one of the options/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1", selectedLabel: "Yes\nNo" }] }, /^Pick one of the options/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1", selectedLabels: ["A", "A"] }] }, /each one once/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1", selectedLabels: ["A", "B", "C", "D"] }] }, /each one once/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1", freeText: "z".repeat(501) }] }, /^Keep the reply to 500 characters\.$/],
      [{ action: "answer", ...id, answers: [{ questionId: "q1", selectedLabel: "Yes", note: "hi" }] }, /^Send only questionId/],
      [
        {
          action: "answer",
          ...id,
          answers: [
            { questionId: "q1", selectedLabel: "Yes" },
            { questionId: "q1", selectedLabel: "No" },
          ],
        },
        /^Answer each question once\.$/,
      ],
      [{ action: "workflow", workflowAction: "restart" }, /^Say what to do with the workflow/],
      [{ action: "workflow", workflowAction: "pause", workflowId: "two words" }, /workflow id/],
      [{ action: "workflow", workflowAction: "pause", workflowId: 7 }, /workflow id/],
      [{ action: "subagent", subagentAction: "stop", childSessionId: "main/scout/1" }, /child session id/],
      [{ action: "subagent", subagentAction: "message", childSessionId: CHILD }, /^Write the message first\.$/],
      [{ action: "subagent", subagentAction: "shout", childSessionId: CHILD }, /^Say what to do with the subagent/],
      ["not json", /^Send a JSON body\.$/],
      [[{ action: "stop" }], /^Send a JSON object\.$/],
    ];
    for (const [body, error] of bad) {
      const res = await send(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
      assert.match(String(res.json.error), error, JSON.stringify(body).slice(0, 120));
      assert.ok(!String(res.json.error).includes(EM_DASH), "no em dashes");
    }
    assert.equal(called("select").length + sent().length + events().length, 0);
  });

  it("takes 4,000 characters, line breaks and tabs, counting characters rather than code units", async () => {
    for (const text of [String.fromCodePoint(0xe9).repeat(4000), String.fromCodePoint(0x1f600).repeat(4000), "first line\nsecond\tline"]) {
      assert.equal((await send({ action: "steer", text })).status, 200, text.slice(0, 12));
    }
    assert.deepEqual(
      sent().map((s) => [...(s.envelope.command as { text: string }).text].length),
      [4000, 4000, 22],
    );
  });

  it("turns every other command into what the session bridge expects", async () => {
    const cases: Array<[Record<string, unknown>, MuseCommandEnvelope["command"], string | undefined]> = [
      [{ action: "interrupt" }, { type: "interrupt" }, undefined],
      [{ action: "goal", goalAction: "set", objective: "  Ship the bird counter. " }, { type: "goal", action: "set", objective: "Ship the bird counter." }, "Ship the bird counter."],
      [{ action: "goal", goalAction: "edit", objective: "Ship it with a dark mode." }, { type: "goal", action: "edit", objective: "Ship it with a dark mode." }, "Ship it with a dark mode."],
      [{ action: "goal", goalAction: "pause", objective: "ignored" }, { type: "goal", action: "pause" }, "Pause the goal"],
      [{ action: "goal", goalAction: "resume" }, { type: "goal", action: "resume" }, "Resume the goal"],
      [{ action: "goal", goalAction: "clear" }, { type: "goal", action: "clear" }, "Clear the goal"],
      [
        {
          action: "answer",
          userInputId: "01a18fef-c524-7db2-9531-d6a40e6ba223",
          answers: [
            { questionId: "color", selectedLabel: "Blue" },
            { questionId: "sizes", selectedLabels: ["S", "M"] },
            { questionId: "drink", freeText: "  Tea, please. " },
          ],
        },
        {
          type: "answer",
          userInputId: "01a18fef-c524-7db2-9531-d6a40e6ba223",
          answers: [
            { questionId: "color", selectedLabel: "Blue" },
            { questionId: "sizes", selectedLabels: ["S", "M"] },
            { questionId: "drink", freeText: "Tea, please." },
          ],
        },
        "Blue; S, M; Tea, please.",
      ],
      [
        { action: "workflow", workflowAction: "cancel", workflowId: "workflow-run-model-tool-call_01a18fefd9c3731388f28accf410f017" },
        { type: "workflow", action: "cancel", workflowId: "workflow-run-model-tool-call_01a18fefd9c3731388f28accf410f017" },
        "Cancel the workflow",
      ],
      [{ action: "workflow", workflowAction: "pause", workflowId: null }, { type: "workflow", action: "pause" }, "Pause the workflow"],
      [{ action: "workflow", workflowAction: "resume" }, { type: "workflow", action: "resume" }, "Resume the workflow"],
      [
        { action: "subagent", subagentAction: "message", childSessionId: CHILD, text: "Check the empty state too." },
        { type: "subagent", action: "message", childSessionId: CHILD, text: "Check the empty state too." },
        "Check the empty state too.",
      ],
      [{ action: "subagent", subagentAction: "interrupt", childSessionId: CHILD }, { type: "subagent", action: "interrupt", childSessionId: CHILD }, "Interrupt the subagent"],
      [{ action: "subagent", subagentAction: "stop", childSessionId: CHILD, text: "ignored" }, { type: "subagent", action: "stop", childSessionId: CHILD }, "Stop the subagent"],
    ];
    for (const [body, command, text] of cases) {
      calls = [];
      assert.equal((await send(body)).status, 200, JSON.stringify(body));
      assert.deepEqual(sent().map((s) => s.envelope.command), [command], JSON.stringify(body));
      assert.deepEqual(events(), [{ type: "control", round: 0, action: body.action, ...(text ? { text } : {}), ok: true }], JSON.stringify(body));
    }
  });

  it("takes 20 commands a minute for one build, then answers 429, but always takes a stop", async () => {
    for (let i = 0; i < 20; i++) assert.equal((await send({ action: "steer", text: `Note ${i}` })).status, 200);
    const limited = await send({ action: "queue", text: "One more." });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, "rate_limited");
    const wait = limited.json.retryAfterSeconds as number;
    assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 60, String(wait));
    const [keys, windowStart] = called("hitRateLimits")[0]!.args as [string[], Date];
    assert.deepEqual(keys, [`build-control:${BUILD_ID}`]);
    assert.equal(windowStart.getTime() % 60_000, 0, "a one-minute window");
    assert.equal(sent().length, 20);

    marked = [{ museRound: 0, status: "building", fixRounds: 0 }];
    assert.equal((await send({ action: "stop" })).status, 200);
    assert.equal(sent().length, 22);
  });

  describe("the steer box", () => {
    /** A fetch that hands the box's request to the route, as the browser would on the same origin. */
    const toRoute: import("@/components/build/SteerBox").Fetch = async (url, init) => {
      calls.push({ fn: "fetch", args: [url, init] });
      const req = new Request(`https://muse.example.com${url}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "sec-fetch-site": "same-origin" } });
      return POST(req, ctx(url.split("/")[3]));
    };

    it("posts to the control route and reads every answer as a sentence", async () => {
      assert.equal(await steer.sendSteer(BUILD_ID, { action: "steer", text: "Bigger buttons" }, toRoute), null);
      assert.equal(called("fetch")[0]!.args[0], `/api/builds/${BUILD_ID}/control`);
      assert.deepEqual(sent()[0]!.envelope.command, { type: "steer", text: "Bigger buttons" });
      assert.equal(await steer.sendSteer(BUILD_ID, { action: "queue", text: "Then a dark mode" }, toRoute), null);
      marked = [{ museRound: 0, status: "building", fixRounds: 0 }];
      assert.equal(await steer.sendSteer(BUILD_ID, { action: "stop" }, toRoute), null);

      assert.equal(await steer.sendSteer(BUILD_ID, { action: "steer", text: "x".repeat(4001) }, toRoute), "Keep the note to 4,000 characters.");
      row = inRound({ status: "verifying", museRound: null });
      assert.match((await steer.sendSteer(BUILD_ID, { action: "steer", text: "Hi" }, toRoute))!, /isn't taking notes right now/);
      row = inRound();
      viewer = STRANGER;
      assert.match((await steer.sendSteer(BUILD_ID, { action: "steer", text: "Hi" }, toRoute))!, /Only the person who made this build/);
      viewer = OWNER;
      sendFails = true;
      assert.match((await steer.sendSteer(BUILD_ID, { action: "steer", text: "Hi" }, toRoute))!, /couldn't be reached/);
      delete process.env.MUSE_ENGINE;
      assert.equal(await steer.sendSteer(BUILD_ID, { action: "steer", text: "Hi" }, toRoute), "Steering is off in this deployment.");
      const offline = await steer.sendSteer(BUILD_ID, { action: "steer", text: "Hi" }, async () => {
        throw new TypeError("Failed to fetch");
      });
      assert.match(offline!, /Couldn't reach Muse Muse/);
      assert.match(steer.steerErrorText(429, "rate_limited"), /Wait a minute/);
      for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 503]) {
        assert.ok(!steer.steerErrorText(status, undefined).includes(EM_DASH), "no em dashes");
      }
    });

    it("shows a note box with Send now, After this step and Stop", async () => {
      const { renderToString } = await import("react-dom/server");
      const html = renderToString(createElement(steer.SteerBox, { buildId: BUILD_ID })).replace(/<!-- -->/g, "");
      assert.match(html, /<form[^>]*aria-label="Steer Muse Code"/);
      assert.match(html, /<label[^>]*>A note for Muse Code<\/label>/);
      assert.match(html, /<textarea[^>]*maxLength="4000"/);
      for (const label of ["Send now", "After this step", "Stop"]) assert.ok(html.includes(`${label}<`), label);
      assert.match(html, /<button type="submit"[^>]*>.*Send now/);
      assert.ok(!html.includes(EM_DASH), "no em dashes");
    });

    it("shows in the build room only while a round runs, for a viewer who may steer, and leaves a finished build's composer alone", async () => {
      mock.module("next/navigation", { namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => `/b/${BUILD_ID}` } });
      mock.module("next/link", { defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }) });
      const { renderToString } = await import("react-dom/server");
      const { BuildRoom } = await import("@/components/build/BuildRoom");
      const t = "2026-10-31T03:00:00.000Z";
      const room = (status: string, canSteer: boolean | undefined) => {
        const done = status === "live";
        const props = {
          build: {
            id: BUILD_ID,
            kind: "build",
            message: null,
            rebuildOf: null,
            productId: "prod-1",
            userId: OWNER.id,
            inspirationId: "insp-1",
            status,
            step: done ? null : "build",
            brief: null,
            buildModel: "muse-wonder-1.0",
            museSessionId: null,
            fixRounds: status === "fixing" ? 1 : 0,
            previewUrl: null,
            costUsd: 0,
            error: null,
            startedAt: t,
            finishedAt: done ? t : null,
          },
          product: {
            id: "prod-1",
            slug: "shelf-scout",
            name: "Shelf Scout",
            tagline: "Find the book you saw",
            ownerId: OWNER.id,
            inspirationId: "insp-1",
            rebuildOf: null,
            manifest: null,
            latestBuildId: BUILD_ID,
            liveUrl: null,
            demoVideoUrl: null,
            demoPosterUrl: null,
            transcriptUrl: null,
            status: done ? "live" : "building",
            createdAt: t,
            updatedAt: t,
          },
          inspiration: null,
          events: [],
          history: [],
          tokens: { input: 0, cached: 0, output: 0 },
          canRefine: true,
          canSteer,
          signedIn: true,
          origin: "https://muse.example.com",
          serverNow: Date.parse(t),
          focusRefine: false,
          rebuild: null,
          maxFixRounds: 3,
        };
        return renderToString(createElement(BuildRoom, props as never));
      };
      const box = /aria-label="Steer Muse Code"/;
      assert.match(room("building", true), box);
      assert.match(room("fixing", true), box);
      for (const [status, canSteer] of [["verifying", true], ["building", false], ["building", undefined]] as const) {
        assert.doesNotMatch(room(status, canSteer), box, `${status} ${canSteer}`);
      }
      // A finished build offers the change composer as before, whether or not the viewer could steer.
      for (const canSteer of [true, false, undefined]) {
        const html = room("live", canSteer);
        assert.match(html, /<div id="refine">/);
        assert.doesNotMatch(html, box);
      }
    });
  });
});
