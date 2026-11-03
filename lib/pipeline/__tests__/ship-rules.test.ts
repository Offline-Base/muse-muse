/**
 * Shipping rules (Nov 3 audit, C-2 and C-3, and the phone pass): the live action check's reply rules and sample swap,
 * the known issues a shipped build shows, the walled build's end reserve, and what visitors read about a build.
 *
 *   npx tsx --test lib/pipeline/__tests__/ship-rules.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlaceholderDataUrl, judgeLiveReply, pickLiveCall, pickSample, provedCall, withSamples } from "@/lib/pipeline/live-action";
import { knownIssues } from "@/lib/pipeline/known-issues";
import { scrubMachineText, visitorLines, visitorNote } from "@/lib/pipeline/visitor-text";
import { capWithinWall, fullChecksReserveMs, fullRoundCap, fullRoundPlan, MIN_FIX_ROUND_MS, SHIP_RESERVE_MS } from "@/lib/pipeline/steps";
import { buildHighlights } from "@/lib/queries";
import type { BuildEvent, Manifest } from "@/lib/types";

const MIN = 60_000;

describe("the live action check's reply rules", () => {
  const judge = (status: number | null, body: unknown, extra: { timedOut?: boolean } = {}) => judgeLiveReply({ action: "decide_next_step", status, body, ...extra });

  it("fails the audit's stand-ins: model false with an error, fallback, estimate, an error at 200, and HTTP errors", () => {
    assert.equal(judge(200, { model: false, error: "An AI model is unavailable right now. Using the local plan instead." }).ok, false);
    assert.equal(judge(200, { rules: "harbor copy", fallback: true }).reason, "decide_next_step answered with a stand-in instead of its AI model (fallback: true)");
    assert.equal(judge(200, { trackId: "est-1", estimate: true }).ok, false);
    assert.equal(judge(200, { error: { message: "upstream refused" } }).reason, "decide_next_step answered with an error: upstream refused");
    assert.equal(judge(502, { error: "That proof call failed." }).reason, "decide_next_step answered HTTP 502: That proof call failed.");
    assert.equal(judge(null, null, { timedOut: true }).reason, "decide_next_step gave no answer within 120 seconds");
    assert.equal(judge(null, null).reason, "decide_next_step couldn't be reached");
  });

  it("passes a good reply, and leaves a refused sample, a busy product or a bare model false undecided", () => {
    assert.deepEqual(judge(200, { action: "click", model: true, error: null }), { ok: true });
    assert.deepEqual(judge(200, { items: [{ model: false }] }), { ok: true }, "markers count at the top level only");
    assert.deepEqual(judge(200, null), { ok: true }, "a reply that isn't JSON can't say it used a stand-in");
    for (const status of [400, 413, 422, 429]) {
      const v = judge(status, { error: "bad input" });
      assert.equal(v.ok, true);
      assert.ok(v.inconclusive);
    }
    assert.equal(judge(200, { ledger: [], model: false }).inconclusive, "decide_next_step said it used no AI model for this call");
  });

  it("reads a 401, 403 or 404 in the product's own JSON as its answer to the sample, and the host's page as a failure", () => {
    for (const status of [401, 403, 404, 409]) assert.equal(judge(status, { error: "No case with that id." }).ok, true, `HTTP ${status} in JSON`);
    assert.equal(judge(404, null).reason, "decide_next_step answered HTTP 404", "no such route");
    assert.equal(judge(401, null).ok, false, "a locked link");
    assert.equal(judge(405, { error: "Method not allowed" }).ok, false);
  });
});

describe("the live action check's call and samples", () => {
  const manifest = (actions: Manifest["actions"], over: Partial<Manifest> = {}): Manifest => ({
    name: "N",
    slug: "n",
    tagline: "t",
    inspiration: "i",
    models: [],
    actions,
    fixtures: [],
    limits: [],
    estimatedCostPerRunUsd: 0.1,
    ...over,
  });
  const action = (name: string, over: Partial<Manifest["actions"][number]> = {}): Manifest["actions"][number] => ({ name, description: name, input: { type: "object" }, output: { type: "object" }, ...over });

  it("picks the action Prove it would call first, and says why when there is none", () => {
    const picked = pickLiveCall(manifest([action("wipe", { example: { all: true }, annotations: { readOnly: false } }), action("start_run", { example: { notes: ["a"] } })]), "https://x");
    assert.deepEqual(picked, { call: { name: "start_run", args: { notes: ["a"] } } });
    assert.deepEqual(pickLiveCall(null, "https://x"), { skip: "it has no musemuse.json to read its actions from" });
    assert.match(String((pickLiveCall(manifest([action("go")]), "https://x") as { skip: string }).skip), /^no action was safe to call \(go: it has no example input/);
    assert.match(String((pickLiveCall(manifest([action("go", { example: {} })], { estimatedCostPerRunUsd: 3 }), "https://x") as { skip: string }).skip), /\$3\.00, above the check's \$2\.00/);
  });

  it("swaps only shortened data URLs, for the smallest sample of the same type, then the same kind", () => {
    assert.equal(isPlaceholderDataUrl("data:image/svg+xml;base64,AAA"), true);
    assert.equal(isPlaceholderDataUrl(`data:image/png;base64,${"A".repeat(400)}`), false);
    const samples = [
      { path: "fixtures/big.png", type: "image/png", bytes: Buffer.alloc(50, 1) },
      { path: "fixtures/small.png", type: "image/png", bytes: Buffer.alloc(5, 2) },
      { path: "fixtures/a.wav", type: "audio/wav", bytes: Buffer.alloc(3, 3) },
    ];
    assert.equal(pickSample("image/png", samples)!.path, "fixtures/small.png");
    assert.equal(pickSample("image/svg+xml", samples)!.path, "fixtures/small.png", "an SVG example gets a PNG, which Meta's API takes");
    assert.equal(pickSample("application/pdf", samples), null);
    const out = withSamples({ shot: "data:image/svg+xml;base64,AAA", pdf: "data:application/pdf;base64,JVBERi0...", keep: "hello", list: ["data:audio/wav;base64,UklG"] }, samples) as Record<string, unknown>;
    assert.equal(out.shot, `data:image/png;base64,${Buffer.alloc(5, 2).toString("base64")}`);
    assert.equal(out.pdf, "data:application/pdf;base64,JVBERi0...", "left as it is with no sample of its kind");
    assert.equal(out.keep, "hello");
    assert.deepEqual(out.list, [`data:audio/wav;base64,${Buffer.alloc(3, 3).toString("base64")}`]);
  });

  it("finds Prove it's call of the action after the last deploy only", () => {
    const prove = (ok: boolean) => ({ type: "prove", item: "mcp", checks: [{ ok: true, label: "Connect to the MCP server" }, { ok, label: "Call go" }] });
    assert.deepEqual(provedCall([{ type: "deploy" }, prove(true)], "go"), { ok: true });
    assert.equal(provedCall([prove(true), { type: "deploy" }], "go"), null);
    assert.equal(provedCall([{ type: "deploy" }, prove(false)], "other"), null);
  });
});

describe("known issues", () => {
  const judge = (pass: boolean, mismatches: string[], reasons: string[] = ["r"]) => ({ type: "judge", round: 3, verdict: { pass, mismatches, reasons } });

  it("shows the failed judge's mismatches and the failed live checks of a shipped build", () => {
    const events = [
      judge(false, ["Old mismatch."]),
      { type: "live_check", ok: false, reason: "an old deploy" },
      judge(false, ["Final Memo screen must show the signed memo without a memo call failed error box"]),
      { type: "deploy" },
      { type: "live_check", ok: false, action: "file_memo", reason: "file_memo answered HTTP 502: That call failed." },
    ];
    assert.deepEqual(knownIssues(events, "partial"), [
      "Final Memo screen must show the signed memo without a memo call failed error box.",
      "On its live link: file_memo answered HTTP 502: That call failed.",
    ]);
  });

  it("is empty for a clean ship and for a build that didn't ship, and falls back to the judge's first reason", () => {
    assert.deepEqual(knownIssues([judge(false, ["x"]), judge(true, [])], "live"), []);
    assert.deepEqual(knownIssues([judge(false, ["x"])], "failed"), []);
    assert.deepEqual(knownIssues([judge(false, [], ["The memo screen shows an error box"])], "partial"), ["The memo screen shows an error box."]);
  });

  it("keeps machine paths and em dashes out of what it shows", () => {
    const [line] = knownIssues([{ type: "deploy" }, { type: "live_check", ok: false, reason: "go \u2014 failed reading /tmp/run-1/out.json" }], "partial");
    assert.equal(line, "On its live link: go, failed reading a file on the build machine.");
  });
});

describe("a walled build keeps its last fix round and shipping inside the wall", () => {
  const plan = fullRoundPlan({ requirements: 10 }, [{ title: "a" }, { title: "b" }, { title: "c" }], { wallMinutes: 150 });

  it("reserves the checks, a whole fix round with its own checks, and shipping", () => {
    assert.equal(fullChecksReserveMs(plan), 2 * (20 + 3) * MIN + 15 * MIN + SHIP_RESERVE_MS);
    // The Nov 3 legal build at its start: 150 minutes less the reserve, shared by 3 milestones.
    assert.equal(Math.round(fullRoundCap({ plan, startedAt: 0, now: 0, milestonesLeft: 3 })! / MIN), Math.round((150 - 71) / 3));
  });

  it("starts no fix round that would get less than MIN_FIX_ROUND_MS", () => {
    const fix = (now: number) => capWithinWall({ capMs: 15 * MIN, startedAt: 0, now, wallMs: 150 * MIN, reserveMs: 33 * MIN, minMs: MIN_FIX_ROUND_MS });
    assert.equal(fix(100 * MIN), 15 * MIN);
    assert.equal(fix(110 * MIN), null, "7 minutes left: not started");
    assert.equal(fix(108 * MIN), 9 * MIN);
    assert.equal(capWithinWall({ capMs: 15 * MIN, startedAt: 0, now: 0, wallMs: null, minMs: MIN_FIX_ROUND_MS }), 15 * MIN, "no wall, today's cap");
  });
});

describe("what visitors read about a build", () => {
  it("takes out sandbox and machine paths, session ids and raw tool noise, and keeps readable lines", () => {
    assert.equal(scrubMachineText("Saved /vercel/app/fixtures/sample-1.txt for 01a19fda-2f91-7801-af60-9c4a872edba7"), "Saved fixtures/sample-1.txt for");
    assert.equal(scrubMachineText("Wrote /tmp/muse/x.json and /Users/someone/a.txt"), "Wrote a file on the build machine and a file on the build machine");
    assert.equal(scrubMachineText("See the /runs page and /variables list"), "See the /runs page and /variables list", "only whole machine folder names");
    assert.equal(scrubMachineText("Ran in /tmp."), "Ran in a file on the build machine.");
    assert.deepEqual(
      visitorLines([
        "Read text file `/vercel/.local/share/muse/sessions/2026/11/03/01a19fda-2f91-7801-af60-9c4a872edba7/tool-outputs/x/subagent-1-subagent_result.txt`.",
        "{",
        '<read-skill-result name="muse-agent" status="ok">',
        "Read text file `app/page.tsx`.",
        "Read text file `app/page.tsx`.",
        "Muse Code started a subagent: Scout milestone 1",
      ]),
      ["Read text file `app/page.tsx`.", "Muse Code started a subagent: Scout milestone 1"],
    );
    assert.equal(visitorNote("How it was built:\n266 tool calls\nRead text file `/vercel/x`."), null);
    assert.equal(visitorNote("Muse Code was stopped after 37 minutes."), "Muse Code was stopped after 37 minutes.");
  });

  it("leaves the raw tool log off the product page's How it was built", () => {
    const at = "2026-11-03T06:14:45.000Z";
    const events = [
      { id: 1, at, type: "log", text: "The build is near its time limit, so no more fix rounds run." },
      { id: 2, at, type: "log", text: "How it was built:\n266 tool calls, 80 edits touching 80 files\nRead text file `/vercel/.local/share/muse/sessions/2026/11/03/01a19fda-2f91-7801-af60-9c4a872edba7/tool-outputs/a.txt`." },
      { id: 3, at, type: "log", text: "Checked /vercel/musemuse/run/x.cjs again" },
    ] as BuildEvent[];
    const lines = buildHighlights(events, null);
    assert.deepEqual(lines, ["The build is near its time limit, so no more fix rounds run.", "Checked a file on the build machine again"]);
    assert.ok(lines.every((l) => !/\/vercel\/|[0-9a-f]{8}-[0-9a-f]{4}/.test(l)));
  });
});
