/** BUILD_ROOM_STEPS: the feed's steps come only from the log, and the model can only reword them. Made-up data only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildFeed, NOT_PUBLISHED, withoutStepsFeed } from "@/lib/steps-feed/facts";
import { cleanWords, FEED_MODEL, summarizeFeed, type FeedDeps } from "@/lib/steps-feed/words";
import type { BuildEvent, BuildEventBody } from "@/lib/types";

const t0 = Date.parse("2026-11-01T12:00:00.000Z");
function log(bodies: Array<BuildEventBody & { s?: number }>): BuildEvent[] {
  return bodies.map((b, i) => ({ ...b, id: i + 1, at: new Date(t0 + (b.s ?? i * 60) * 1000).toISOString() })) as BuildEvent[];
}
const edit = (path: string, s: number, itemId = path): BuildEventBody & { s: number } => ({ type: "muse", round: 0, s, lines: [{ kind: "tool", itemId, tool: "edit_file", ok: true, text: `Edited \`${path}\`` }] });
const status = (status: "briefing" | "provisioning" | "verifying" | "failed" | "live"): BuildEventBody => ({ type: "status", status });
const started = log([status("briefing"), status("provisioning"), edit("app/page.tsx", 120), edit("app/globals.css", 200), edit("app/pricing/page.tsx", 300), status("verifying")]);

function deps(reply: unknown, over: Partial<FeedDeps> = {}) {
  const sent: unknown[] = [];
  const emitted: Array<Parameters<FeedDeps["emit"]>[0]> = [];
  const charged: unknown[] = [];
  const d: FeedDeps = {
    spendOk: async () => true,
    respond: async (body) => {
      sent.push(body);
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply), usage: [{ model: body.model, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, images: 0, costUsd: 0.00002 }] };
    },
    charge: async (u) => void charged.push(u),
    emit: async (b) => void emitted.push(b),
    log: () => undefined,
    ...over,
  };
  return { d, sent, emitted, charged };
}

describe("the feed's steps", () => {
  it("come from real events, with no path or tool name in a line", () => {
    const f = buildFeed(started);
    const lines = f.steps.map((s) => s.text);
    assert.deepEqual(lines, ["Reading what you asked for", "Setting up a little workspace", "Drawing the home page", "Picking the colors and letters", "Drawing the pricing page", "Trying everything out"]);
    assert.ok(lines.every((l) => !/[/`]|edit_file|\.tsx/.test(l)));
  });

  it("has nothing to say about an empty log, and adds no step of its own", () => {
    assert.equal(buildFeed([]).rows.length, 0);
    assert.equal(buildFeed(log([{ type: "log", text: "secret sauce" }])).rows.length, 0);
  });

  it("recaps each three steps, and a running step is never in one", () => {
    const f = buildFeed(started);
    assert.deepEqual(f.rows.map((r) => r.type), ["step", "step", "step", "recap", "step", "step", "step"]);
    const running = f.rows.at(-1);
    assert.ok(running?.type === "step" && running.running);
    assert.equal(f.recaps.length, 1);
    assert.equal(buildFeed(log([status("briefing"), status("provisioning"), status("verifying")])).recaps.length, 0);
  });

  it("reads a failure plainly, keeps a finished build's history, and shows no running step at the end", () => {
    const f = buildFeed(log([status("briefing"), status("provisioning"), { type: "verify", round: 0, summary: { passed: false, steps: [], failureOutput: "/tmp/x" }, screenshots: [] }, status("failed")]));
    assert.equal(f.steps.at(-1)?.text, "The build stopped and did not ship");
    assert.ok(f.rows.every((r) => r.type !== "step" || !r.running));
    const recap = f.recaps[0]!;
    assert.equal(recap.tone, "bad");
    assert.doesNotMatch(recap.comment, /worked|done|ready|paws/i);
  });

  it("the plain words never claim success before the ending", () => {
    for (const r of buildFeed(started).recaps) assert.doesNotMatch(`${r.text} ${r.comment}`, /\b(done|ready|live|passed|worked)\b/i);
  });

  it("uses Contributor's words only for a step that's over, and never on the ending", () => {
    const f = buildFeed([...started, { type: "steps_feed", id: 99, at: started[0]!.at, lines: [{ id: "e1", text: "Reading your idea" }, { id: "e6", text: "Too soon" }, { id: "nope", text: "Made up" }], recaps: [{ after: "e3.0", comment: "Cozy." }] }] as BuildEvent[]);
    assert.equal(f.steps[0]!.text, "Reading your idea");
    assert.ok(f.steps.every((s) => s.text !== "Made up" && s.text !== "Too soon"));
    assert.equal(f.recaps[0]!.comment, "Cozy.");
    const ended = buildFeed([...log([status("live")]), { type: "steps_feed", id: 9, at: started[0]!.at, lines: [{ id: "e1", text: "Sparkly" }], recaps: [] }] as BuildEvent[]);
    assert.equal(ended.steps[0]!.text, "It's online");
  });

  it("says a build with publishing off never went online", () => {
    const off = "Publishing is off for this run (no token), so the product didn't get its own link. The preview, checks and demo above ran for real.";
    const f = buildFeed(log([status("verifying"), { type: "log", text: off }, { type: "status", status: "deploying", step: "register" }, { type: "status", status: "live", message: "Finished as live without publishing to its own link." }]));
    assert.deepEqual(f.steps.map((s) => s.text), ["Trying everything out", "Saving the finished version", "It's finished, but not online"]);
    assert.equal(f.unpublished, true);
    assert.doesNotMatch(f.recaps[0]!.text, /online(?! )|going online/);
    const on = buildFeed(log([{ type: "status", status: "deploying" }, status("live")]));
    assert.deepEqual(on.steps.map((s) => s.text), ["Putting it online", "It's online"]);
    assert.equal(on.unpublished, false);
  });

  it("matches what the workflow really says when publishing is off", () => {
    const source = readFileSync("lib/pipeline/workflow.ts", "utf8");
    assert.match(source, /so the product didn't get its own link\./);
    assert.match(source, /without publishing to its own link\./);
    assert.ok(NOT_PUBLISHED.test("so the product didn't get its own link.") && NOT_PUBLISHED.test("without publishing to its own link."));
  });

  it("names the page even when every edit also logs a bare edit line", () => {
    const patch = (s: number, path: string): BuildEventBody & { s: number } => ({ type: "muse", round: 0, s, lines: [{ kind: "edit", itemId: `${path}#patch`, files: 1, added: 1, removed: 0, text: "Edited 1 file (+1 −0)" }, { kind: "tool", itemId: path, tool: "apply_patch", ok: true, text: `Edited \`${path}\`` }] });
    const f = buildFeed(log([status("provisioning"), patch(30, "app/page.tsx"), patch(35, "lib/a"), patch(36, "README.md"), patch(37, "notes.md"), patch(38, "more.md")]));
    assert.equal(f.steps.at(-1)?.text, "Drawing the home page");
    const bare = buildFeed(log([{ type: "muse", round: 0, lines: [{ kind: "edit", files: 1, text: "Edited 1 file (+1 −0)" }] }]));
    assert.equal(bare.steps[0]!.text, "Putting pieces together");
  });

  it("keeps summaries out with the flag off", () => {
    const events = log([status("briefing"), { type: "steps_feed", lines: [], recaps: [] }]);
    assert.equal(withoutStepsFeed(events).length, 1);
    const plain = log([status("briefing")]);
    assert.equal(withoutStepsFeed(plain), plain);
  });
});

describe("cleanWords", () => {
  const ok = { max: 70, facts: ["Drawing the home page"], mayClaim: false };
  it("keeps a simple line and turns dashes into commas", () => {
    assert.equal(cleanWords("Drawing the home page", ok), "Drawing the home page");
    assert.equal(cleanWords("Drawing the home page — slowly", ok), "Drawing the home page, slowly");
  });
  it("rejects paths, tool names, secrets, claims and made up things", () => {
    for (const bad of ["Editing app/page.tsx", "Ran npm install", "Used bash", "Checked the API key", "The home page is finished", "Added a login button", "Drew a chart", "x".repeat(71), "", 3]) {
      assert.equal(cleanWords(bad, ok), null, String(bad));
    }
  });
  it("lets a claim through only when the facts make it", () => {
    assert.equal(cleanWords("The checks passed", { max: 70, facts: ["The checks passed"], mayClaim: true }), "The checks passed");
  });
});

describe("summarizeFeed", () => {
  it("rewords on Contributor and sends only the plain facts", async () => {
    const secretish = log([status("briefing"), status("provisioning"), edit("app/.env.local", 120), status("verifying")]);
    const { d, sent, emitted, charged } = deps({ lines: [{ id: "e1", text: "Reading your idea" }, { id: "e2", text: "Making a cozy workspace" }, { id: "e3.0", text: "Opening .env.local" }], recaps: [{ after: "e3.0", text: "Reading and setting up.", comment: "Busy paws." }] });
    assert.equal(await summarizeFeed(secretish, d), "written");
    const body = sent[0] as { model: string; input: string };
    assert.equal(FEED_MODEL, "muse-spark-1.3-contributor");
    assert.equal(body.model, FEED_MODEL);
    assert.doesNotMatch(body.input, /\.env|edit_file|app\//);
    assert.deepEqual(emitted[0]!.lines.map((l) => l.id), ["e1", "e2"]);
    assert.equal(charged.length, 1);
  });

  it("won't turn a thing that's over into a thing still going", async () => {
    const events = log([status("verifying"), { type: "verify", round: 0, summary: { passed: true, steps: [] }, screenshots: [] }, { type: "status", status: "recording" }, { type: "status", status: "deploying" }] as never);
    const passed = buildFeed(events).steps[1]!;
    const a = deps({ lines: [{ id: passed.id, text: "Passing the checks" }, { id: "e1", text: "Trying it all out" }], recaps: [] });
    assert.equal(await summarizeFeed(events, a.d), "written");
    assert.deepEqual(a.emitted[0]!.lines.map((l) => l.text), ["Trying it all out"]);
    const b = deps({ lines: [{ id: passed.id, text: "The checks passed" }], recaps: [] });
    assert.equal(await summarizeFeed(events, b.d), "written");
    assert.deepEqual(b.emitted[0]!.lines.map((l) => l.text), ["The checks passed"]);
  });

  it("makes no call until a batch is ready, unless it's the last one", async () => {
    const few = log([status("briefing"), status("provisioning")]);
    const a = deps({ lines: [], recaps: [] });
    assert.equal(await summarizeFeed(few, a.d), "few");
    assert.equal(a.sent.length, 0);
    const b = deps({ lines: [{ id: "e1", text: "Reading your idea" }], recaps: [] });
    assert.equal(await summarizeFeed(few, b.d, true), "written");
    assert.equal(b.sent.length, 1);
  });

  it("never throws, whatever goes wrong, and the plain lines stay", async () => {
    const down = deps("", { respond: async () => { throw new Error("Contributor is down"); } });
    assert.equal(await summarizeFeed(started, down.d), "failed");
    assert.equal((await summarizeFeed(started, deps("not json").d)), "failed");
    assert.equal(await summarizeFeed(started, deps({ lines: [{ id: "e1", text: "Ran npm" }], recaps: [] }).d), "empty");
    assert.equal(await summarizeFeed(started, deps("", { spendOk: async () => { throw new Error("db"); } }).d), "failed");
    assert.equal(await summarizeFeed(started, deps({ lines: [{ id: "e1", text: "Reading" }], recaps: [] }, { emit: async () => { throw new Error("db"); } }).d), "failed");
    assert.equal(buildFeed(started).steps[0]!.text, "Reading what you asked for");
  });

  it("gives up inside its time box", async () => {
    const hung = deps("", {
      timeoutMs: 10,
      respond: (_b, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    assert.equal(await summarizeFeed(started, hung.d), "failed");
  });

  it("spends nothing over the daily cap or past the build's limit", async () => {
    const over = deps({}, { spendOk: async () => false });
    assert.equal(await summarizeFeed(started, over.d), "spend");
    assert.equal(over.sent.length, 0);
    const many = [...started, ...Array.from({ length: 40 }, (_, i) => ({ type: "steps_feed", id: 100 + i, at: started[0]!.at, lines: [], recaps: [] }))] as BuildEvent[];
    assert.equal(await summarizeFeed(many, deps({}).d), "capped");
  });
});
