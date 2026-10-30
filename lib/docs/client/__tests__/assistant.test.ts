import assert from "node:assert/strict";
import { test } from "node:test";
import { chatStarters, clipResult, historyItems, matchLabel, noEmDashes, parseToolArgs, readerOnlyReason, toolLabel, type ChatMessage } from "@/lib/docs/client/assistant";

test("approvals, deletes and anything that needs the reader's hands stay theirs", () => {
  for (const label of ["1) Allow once", "Acknowledge and run", "Approve", "Delete file", "Upload a photo", "Record", "Choose file", "Confirm"]) {
    assert.ok(readerOnlyReason(label), label);
  }
  for (const label of ["Run", "Run all", "Run 4 efforts", "Generate", "Reset", "Compare"]) assert.equal(readerOnlyReason(label), null, label);
});

test("a label matches exactly first, then by its start, then anywhere", () => {
  const labels = ["Run all", "Run", "1) Allow once", "Show the code"];
  assert.equal(matchLabel(labels, "run"), "Run");
  assert.equal(matchLabel(labels, "RUN ALL"), "Run all");
  assert.equal(matchLabel(labels, "Allow"), "1) Allow once");
  assert.equal(matchLabel(labels, "code"), "Show the code");
  assert.equal(matchLabel(labels, "nope"), null);
  assert.equal(matchLabel(labels, "  "), null);
});

test("tool arguments that aren't a JSON object read as none", () => {
  assert.deepEqual(parseToolArgs('{"slug":"a","n":2}'), { slug: "a", n: "2" });
  for (const bad of ["", "[1]", "null", "{broken", '"text"']) assert.deepEqual(parseToolArgs(bad), {}, bad);
});

test("a step reads differently while it runs and after", () => {
  assert.equal(toolLabel("open_page", { slug: "quickstart" }, true), "Opening quickstart");
  assert.equal(toolLabel("open_page", { slug: "quickstart", section: "Streaming" }, false), "Opened quickstart, Streaming");
  assert.equal(toolLabel("run_demo", {}, false), "Ran the demo");
  assert.match(toolLabel("search_docs", { query: "x".repeat(60) }, true), /\.\.\."$/);
  assert.match(toolLabel("open_build", {}, false), /for you to send/);
});

test("clipResult says how much it cut", () => {
  assert.equal(clipResult("short", 10), "short");
  assert.equal(clipResult("x".repeat(15), 10), `${"x".repeat(10)}\n... (cut, 5 more characters)`);
});

test("a new question sends earlier words, not earlier tool steps", () => {
  const messages: ChatMessage[] = [
    { role: "user", parts: [{ kind: "text", text: "Open it" }] },
    { role: "assistant", parts: [{ kind: "tool", name: "open_page", label: "Opened", state: "done" }, { kind: "text", text: "Opened." }] },
    { role: "assistant", parts: [{ kind: "tool", name: "run_demo", label: "Ran", state: "failed" }] },
  ];
  assert.deepEqual(historyItems(messages), [
    { role: "user", content: "Open it" },
    { role: "assistant", content: "Opened." },
  ]);
});

test("history keeps the newest messages and starts with the reader", () => {
  const many: ChatMessage[] = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", parts: [{ kind: "text", text: `m${i}` }] }));
  const out = historyItems(many);
  assert.ok(out.length <= 12);
  assert.equal(out[0].role, "user");
  assert.equal(out.at(-1)?.content, "m14");
});

test("the starters only offer the page's demo on a page", () => {
  assert.ok(chatStarters(true).some((s) => /demo/.test(s)));
  assert.ok(!chatStarters(false).some((s) => /demo/.test(s)));
});

test("em dashes never reach the chat", () => {
  assert.equal(noEmDashes("Done \u2014 now running. A\u2014B"), "Done, now running. A, B");
});
