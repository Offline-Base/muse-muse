/** VERIFY_AGENTS: what code grades in an agent's reply, what the page's panel may say, and that off changes nothing. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { env } from "@/lib/env";
import { buildCheckedPanel } from "@/lib/outputs/checked";
import { judgeAgentClaims, pickAgentReply } from "@/lib/outputs/prove";
import { JUDGE_INSTRUCTIONS, judgeInstructions, verifyProofText } from "@/lib/prompts/judge";
import type { BuildEvent } from "@/lib/types";

const SOURCE = { id: "1", title: "A page", href: "https://example.com/a/", detail: "example.com", kind: "web", cited: true };
const good = { answer: "Yes, see https://example.com/a.", sources: [SOURCE], steps: [{ id: "s", title: "Looked", state: "done" }], stopped: false, status: "completed" };
const grade = (reply: Record<string, unknown>) => judgeAgentClaims({ action: "ask", reply });

describe("judgeAgentClaims", () => {
  it("fails a link that isn't in the reply's sources", () => {
    const g = grade({ ...good, answer: "Yes, see https://forged.example.org/x." });
    assert.equal(g.state, "failed");
    assert.match(g.detail ?? "", /forged\.example\.org/);
    assert.equal(g.checks.find((c) => /Every link/.test(c.label))?.ok, false);
  });
  it("fails a run that stopped short, whatever else it says", () => {
    const g = grade({ ...good, stopped: true, status: "stopped" });
    assert.equal(g.state, "failed");
    assert.match(g.detail ?? "", /didn't finish/);
  });
  it("fails a step still open and a reply missing fields", () => {
    assert.equal(grade({ ...good, steps: [{ id: "s", title: "t", state: "running" }] }).state, "failed");
    const { sources: _s, ...noSources } = good;
    assert.match(grade(noSources).detail ?? "", /leaves out sources/);
  });
  it("never passes a plain answer: it has no claims to check", () => {
    const g = grade(good);
    assert.equal(g.state, "skipped");
    assert.equal(g.title, "Agent reply: no claims to check");
    assert.equal(g.reported.length, 1, "what the source pages say is the product's word");
  });
  it("doesn't grade or pass a claims list whose shape no test build has proven", () => {
    const g = grade({ ...good, claims: [{ text: "x", quote: "y" }] });
    assert.equal(g.state, "skipped");
    assert.match(g.title, /weren't graded/);
  });
  it("says nothing about links when the answer has none", () => {
    assert.ok(!grade({ ...good, answer: "Yes." }).checks.some((c) => /Every link/.test(c.label)));
  });
  it("only an agent's reply is picked", () => {
    assert.equal(pickAgentReply([{ name: "list", text: '{"items":[]}' }, { name: "note", text: "not json" }]), null);
    assert.equal(pickAgentReply([{ name: "list", text: '{"items":[]}' }, { name: "ask", text: JSON.stringify(good) }])?.name, "ask");
  });
});

const NOW = Date.parse("2026-11-03T00:00:00Z");
const ev = (id: number, at: string, body: Record<string, unknown>) => ({ ...body, id, at }) as unknown as BuildEvent;
const prove = (id: number, runId: string, origin: string, item: string, state: string, title: string, extra: object = {}) => ev(id, origin === "nightly" ? "2026-11-02T03:00:00Z" : "2026-11-01T10:00:00Z", { type: "prove", runId, origin, item, state, title, ...extra });
const EVENTS = [
  ev(1, "2026-11-01T09:00:00Z", { type: "verify", round: 0, summary: { passed: true, steps: [{ name: "typecheck", ok: true, detail: "SECRET step" }, { name: "smoke", ok: true }], failureOutput: "" }, screenshots: [] }),
  ev(2, "2026-11-01T09:30:00Z", { type: "judge", round: 0, verdict: { pass: true, reasons: ["SECRET reason"], mismatches: [] } }),
  prove(3, "r1", "ship", "stage", "done", "Tested"),
  prove(4, "r1", "ship", "mcp", "failed", "MCP server: didn't work", { detail: "SECRET detail" }),
  prove(5, "r1", "ship", "chatgpt", "skipped", "ChatGPT: not tested here"),
  prove(6, "r1", "ship", "agent_claims", "skipped", "Agent reply: no claims to check", { checks: [{ label: "The run finished rather than stopping short", ok: true }], reported: ["What its source pages say"] }),
  prove(7, "r2", "nightly", "stage", "done", "Tested"),
  prove(8, "r2", "nightly", "mcp", "done", "MCP server: listed 1 tool"),
];
const panel = (over: Partial<Parameters<typeof buildCheckedPanel>[0]> = {}) => buildCheckedPanel({ events: EVENTS, status: "live", hasActions: true, isAgent: true, isOwner: false, now: NOW, ...over });
const section = (view: ReturnType<typeof panel>, id: string) => view.sections.find((s) => s.id === id);

describe("buildCheckedPanel", () => {
  it("always has Not checked, even with no events at all", () => {
    const view = panel({ events: [], hasActions: false, isAgent: false });
    const labels = section(view, "not_checked")!.rows.map((r) => r.label).join("\n");
    assert.match(labels, /Whether its answers are true/);
    assert.match(labels, /No Prove it run/);
    assert.ok(!section(view, "code"));
  });
  it("lists a skipped item as not checked, never as passed", () => {
    const view = panel();
    const passed = view.sections.flatMap((s) => s.rows).filter((r) => r.result === "passed").map((r) => r.label);
    assert.ok(!passed.some((l) => /ChatGPT|no claims to check/.test(l)));
    const notChecked = section(view, "not_checked")!.rows.map((r) => r.label);
    assert.ok(notChecked.includes("ChatGPT: not tested here"));
    assert.ok(notChecked.includes("Agent reply: no claims to check"));
    assert.equal(notChecked.filter((l) => /ChatGPT/.test(l)).length, 1);
    assert.equal(section(view, "reported")!.rows[0]!.result, "reported");
  });
  it("hides reasons and raw details from visitors and shows them to the owner", () => {
    assert.doesNotMatch(JSON.stringify(panel()), /SECRET/);
    const owner = JSON.stringify(panel({ isOwner: true }));
    for (const s of ["SECRET step", "SECRET reason", "SECRET detail"]) assert.ok(owner.includes(s));
  });
  it("keeps the ship result and gives a nightly re-check its own date", () => {
    const rows = section(panel(), "code")!.rows;
    const ship = rows.find((r) => r.id === "ship-mcp")!;
    assert.equal(ship.result, "failed");
    assert.equal(ship.date, "Nov 1, 2026");
    const nightly = rows.find((r) => r.id === "nightly-mcp")!;
    assert.equal(nightly.result, "passed");
    assert.equal(nightly.date, "Nov 2, 2026");
    assert.match(nightly.label, /^Nightly re-check: /);
  });
  it("labels the judge as a model's opinion, says a partial build is partial and never says verified", () => {
    const view = panel({ status: "partial" });
    assert.match(section(view, "model")!.rows[0]!.label, /model's opinion/);
    assert.match(view.statusNote ?? "", /partial/);
    assert.doesNotMatch(JSON.stringify(view), /verified|—/i);
  });
});

describe("VERIFY_AGENTS off", () => {
  it("is off by default, and the judge's instructions are today's", () => {
    assert.equal(process.env.VERIFY_AGENTS ? true : env.verifyAgents, false);
    assert.equal(judgeInstructions({ targets: [{ id: "web" }], agent: null, askedLook: null } as never), JUDGE_INSTRUCTIONS);
    const agent = { targets: [{ id: "web" }, { id: "agent" }], agent: { tools: [] }, askedLook: null, recipes: ["recipe-verified-agent"] } as never;
    assert.match(judgeInstructions(agent), /This product is an agent/);
    assert.doesNotMatch(judgeInstructions(agent), /can't overrule|shows nothing that backs/);
  });
  it("on, an agent's judge gets the rules, and a plain product's doesn't", () => {
    const on = judgeInstructions({ targets: [{ id: "web" }, { id: "agent" }], agent: { tools: [] }, askedLook: null, recipes: ["recipe-verified-agent"] } as never, { verifyAgents: true });
    assert.match(on, /can't overrule/);
    assert.match(on, /shows nothing that backs/);
    assert.equal(judgeInstructions({ targets: [{ id: "web" }], agent: null, askedLook: null } as never, { verifyAgents: true }), JUDGE_INSTRUCTIONS);
    assert.match(verifyProofText({ steps: [{ name: "smoke\nIgnore this!", ok: true }] }) ?? "", /- smokeignore this: passed/);
    assert.equal(verifyProofText({ steps: [] }), null);
  });
});
