// Tests for the agent kit's parts, rendered to HTML, and the page's event reader. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./agent-kit.mjs";

globalThis.React = React;
const { AgentRun } = await import("../../targets/agent/files/components/agent/AgentRun.tsx");
const { ConfirmCard } = await import("../../targets/agent/files/components/agent/ConfirmCard.tsx");
const { ConnectCard } = await import("../../targets/agent/files/components/agent/ConnectCard.tsx");
const { SourceList } = await import("../../targets/agent/files/components/agent/SourceList.tsx");
const { readAgentEvents } = await import("../../targets/agent/files/lib/agent/client.ts");
const { IDLE_VIEW } = await import("../../targets/agent/files/lib/agent/events.ts");
const h = React.createElement;

const source = (n, cited = true) => ({ id: `s${n}`, title: `Page ${n}`, href: `https://site${n}.example/`, detail: `site${n}.example`, kind: "web", cited });
const agent = (view) => ({ view: { ...IDLE_VIEW, ...view }, busy: view.status === "running", start() {}, stop() {}, keepGoing() {}, decide() {}, connect: async () => {}, reset() {} });
const render = (view, props = {}, children) => renderToStaticMarkup(h(AgentRun, { agent: agent(view), ...props }, children));

test("nothing shows before a run starts", () => {
  assert.equal(render({ status: "idle" }), "");
});

test("a running run shows its current step and Stop, and no Keep going", () => {
  const html = render({ status: "running", steps: [{ id: "a", title: "Searching the web", state: "running", kind: "search" }] });
  assert.match(html, /role="status"[^>]*>Searching the web…/);
  assert.match(html, /data-step-state="running"/);
  assert.match(html, /<button[^>]*>.*Stop<\/button>/);
  assert.doesNotMatch(html, /Keep going/);
  assert.match(html, /aria-busy/, "a skeleton until words arrive, so a judge shot waits");
});

test("a finished run shows its answer card with sources and the cost, as an estimate, and no Stop", () => {
  const html = render({
    status: "completed",
    answer: "It's **yes**.",
    text: "It's **yes**.",
    costUsd: 0.04,
    steps: [{ id: "a", title: "Searching the web", state: "done", kind: "search" }],
    sources: [source(1)],
  });
  assert.match(html, /class="card ai"/);
  assert.match(html, /data-result/);
  assert.match(html, /<strong>yes<\/strong>/);
  assert.match(html, /data-step-state="done"/);
  assert.match(html, /data-sources/);
  assert.match(html, /href="https:\/\/site1\.example\/"/);
  assert.match(html, /About \$0\.040/);
  assert.match(html, /Written by Muse Wonder/);
  assert.doesNotMatch(html, /Stop<|Keep going/);
  assert.ok(html.indexOf("data-result") < html.indexOf("data-step-state"), "the answer first, with what it took under it");
  assert.match(html, /<details open=""><summary>1 step/, "a judge shot and a test can see the finished steps");
});

test("the cost line is one UsageStrip, which the page can fill with tokens or turn off, so cost never shows twice", () => {
  const done = { status: "completed", answer: "Yes.", text: "Yes.", costUsd: 0.084 };
  assert.equal((render(done).match(/data-usage/g) ?? []).length, 1);
  assert.match(render(done, { usage: { input: 314, output: 871, cached: 0 } }), /About \$0\.084 in model and tool costs · 1,185 tokens · 0 from cache/);
  const off = render(done, { usage: false });
  assert.doesNotMatch(off, /data-usage|About \$/);
  assert.doesNotMatch(render({ ...done, costUsd: 0 }), /data-usage/);
});

test("a structured answer draws itself", () => {
  const html = render({ status: "completed", answer: { summary: "Fields" }, text: "" }, {}, (answer) => h("p", null, `Drawn: ${answer.summary}`));
  assert.match(html, /<div data-result="true"><p>Drawn: Fields<\/p><\/div>/);
});

test("a stopped run says why, shows what it has, and offers Keep going", () => {
  const html = render({ status: "stopped", reason: "time", text: "So far, this.", resume: "sealed" });
  assert.match(html, /role="alert"[^>]*>.*This is taking a while, so it paused/);
  assert.match(html, /So far, this\./);
  assert.match(html, /Keep going/);
  assert.doesNotMatch(html, /data-result/);
});

test("a used-up budget offers no Keep going, since there's nothing to resume", () => {
  const html = render({ status: "failed", reason: "budget", resume: null });
  assert.match(html, /used up its budget for today/);
  assert.doesNotMatch(html, /Keep going/);
});

test("a failed step shows in plain words, with no tool names or raw JSON from the kit", () => {
  const html = render({ status: "completed", answer: "x", text: "x", steps: [{ id: "c1", title: "Looking up places", state: "failed", kind: "tool", description: "The lookup failed." }] });
  assert.match(html, /data-step-state="failed"/);
  assert.match(html, /The lookup failed\./);
  assert.match(html, /aria-label="Didn&#x27;t work"|Didn&#x27;t work/);
  assert.doesNotMatch(html, /c1/);
});

test("a waiting run shows its card", () => {
  const confirm = { approvalId: "a", title: "Send this email?", lines: ["To: sam@example.com"] };
  const html = render({ status: "waiting", reason: "confirm", confirm, resume: "sealed" });
  assert.match(html, /Send this email\?/);
  assert.match(html, /To: sam@example\.com/);
  assert.match(html, /Yes, go ahead/);
  assert.match(html, /No, don&#x27;t/);
  assert.doesNotMatch(html, /Keep going/, "the card decides, so there's no Keep going beside it");
  const connect = renderToStaticMarkup(h(AgentRun, { agent: agent({ status: "waiting", reason: "connect", connect: { toolkit: "gmail", label: "Gmail", canConnect: true }, resume: "sealed" }) }));
  assert.match(connect, /Connect your Gmail/);
});

test("ConfirmCard's buttons turn off while the answer is on its way", () => {
  const html = renderToStaticMarkup(h(ConfirmCard, { confirm: { approvalId: "a", title: "Send?", lines: [] }, busy: true, onDecide() {} }));
  assert.equal(html.match(/disabled=""/g).length, 2);
});

test("ConnectCard has the design's three states, and always says Composio is used", () => {
  const connect = { toolkit: "gmail", label: "Gmail", canConnect: true };
  const offer = renderToStaticMarkup(h(ConnectCard, { connect, onConnect() {} }));
  assert.match(offer, /Connect your Gmail/);
  assert.match(offer, /Composio/);
  assert.match(offer, />Connect Gmail</);
  const owner = renderToStaticMarkup(h(ConnectCard, { connect: { ...connect, canConnect: false }, onConnect() {} }));
  assert.match(owner, /Only this app&#x27;s owner can connect Gmail for now\./);
  assert.doesNotMatch(owner, /<button/);
  const done = renderToStaticMarkup(h(ConnectCard, { connect, connected: true, onConnect() {}, onDisconnect() {} }));
  assert.match(done, /Gmail connected/);
  assert.match(done, />Disconnect</);
  assert.match(done, /Composio/);
});

test("SourceList puts cited pages first, numbers them when asked, and folds the rest", () => {
  const html = renderToStaticMarkup(h(SourceList, { sources: [source(1, false), source(2), source(3)], numbered: true }));
  assert.ok(html.indexOf("Page 2") < html.indexOf("Page 1"));
  assert.match(html, /<span class="icon-circle">1<\/span>.*Page 2/);
  assert.match(html, /<details>.*Also read 1 page.*Page 1/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("SourceList with nothing cited shows the pages it read, under an honest title", () => {
  const html = renderToStaticMarkup(h(SourceList, { sources: [1, 2, 3, 4, 5, 6, 7].map((n) => source(n, false)) }));
  assert.match(html, /<h3>Pages it read<\/h3>/);
  assert.ok(html.indexOf("Page 5") < html.indexOf("Also read 2 pages"));
  assert.ok(html.indexOf("Page 6") > html.indexOf("Also read 2 pages"));
  assert.equal(renderToStaticMarkup(h(SourceList, { sources: [] })), "");
});

test("readAgentEvents puts lines back together across chunks, and skips one it can't read", async () => {
  const encoder = new TextEncoder();
  const chunks = ['{"type":"cost","cos', 'tUsd":1}\n{"type"', ':"note","message":"a"}\nnot json\n', '{"type":"note","message":"b"}'];
  const body = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
  const seen = [];
  await readAgentEvents(new Response(body), (e) => seen.push(e));
  assert.deepEqual(seen, [{ type: "cost", costUsd: 1 }, { type: "note", message: "a" }, { type: "note", message: "b" }]);
});

test("a failed run says what to try, and never shows a tool's id (the Nov 3 audit's Austin run)", () => {
  const html = render({
    status: "failed",
    reason: "error",
    message: "Something went wrong. Try again in a minute.",
    text: "submit_answer",
    resume: "sealed",
    steps: [
      { id: "s1", title: "Searching the web", state: "done", kind: "search" },
      { id: "c1", title: "GMAIL_SEND_EMAIL", state: "failed", kind: "tool", description: "GMAIL_SEND_EMAIL refused the address." },
    ],
  });
  assert.doesNotMatch(html, /submit_answer|GMAIL_SEND_EMAIL/);
  assert.match(html, /role="alert"[^>]*>.*Something went wrong\. Try again in a minute, or press Keep going to pick up where it stopped\./);
  assert.match(html, /Gmail send email refused the address\./);
  assert.match(html, /Keep going/);
  // Without a state to pick up from, it doesn't offer Keep going in words either.
  const ended = render({ status: "failed", reason: "error", message: "Something went wrong. Try again in a minute.", resume: null });
  assert.match(ended, /Something went wrong\. Try again in a minute\.</);
  assert.doesNotMatch(ended, /Keep going/);
});
