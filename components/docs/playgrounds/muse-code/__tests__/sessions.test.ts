/**
 * The interactive, workflows, session-messaging and rewind models against their pages: the command catalog and its
 * search, /loop cadences, the composer keys, the workflow request and save rules, session names and delivery, and
 * rewind's branch tree.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code/__tests__/sessions.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { COMMANDS, searchCommands } from "@/components/docs/playgrounds/muse-code/commands";
import { composerReducer, INITIAL_COMPOSER, type ComposerAction, type ComposerState } from "@/components/docs/playgrounds/muse-code/composer";
import { occurrences, parseCron, parseLoop } from "@/components/docs/playgrounds/muse-code/loop-schedule";
import { contextOf, newTree, pickerMove, previousIdFor, rewindTo, addTurn, scrollbackOf, PICKER_SAMPLE } from "@/components/docs/playgrounds/muse-code/rewind";
import { initialWorld, nameRuleProblems, normalizeName, reducer, resolveTarget, type Action, type World } from "@/components/docs/playgrounds/muse-code/session-messaging";
import { capacity, childBody, nameProblems, saveCommand, scriptProblems, synthesisBody, workflowRequest } from "@/components/docs/playgrounds/muse-code/workflows";
import { MINI_CHILDREN, SAMPLE_SERVICE } from "@/components/docs/playgrounds/muse-code/workflow-sample";
import { initialRoom, openRoom, pressKey, recoverySteps, roomKey, type RoomKey, type RoomState } from "@/components/docs/playgrounds/muse-code/control-room";

const interactive = readFileSync("content/meta-docs/pages/muse-code/interactive.md", "utf8");

describe("commands", () => {
  it("covers every slash command the interactive page names", () => {
    const named = new Set([...interactive.matchAll(/(?:^|[\s`(])\/([a-z]+)\b/gm)].map((m) => `/${m[1]}`));
    const ours = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.forms ?? [])]).map((n) => n.split(" ")[0]));
    const skip = new Set(["/path", "/docs", "/bin", "/home", "/run", "/skill", "/dev", "/v"]);
    const missing = [...named].filter((n) => !skip.has(n) && !ours.has(n));
    assert.deepEqual(missing, []);
  });

  it("links every command to a documented section and marks side-chat limits", () => {
    for (const c of COMMANDS) assert.match(c.href, /^\/docs\/muse-code(\/[a-z-]+)?(#[a-z0-9-]+)?$/, c.name);
    const unavailable = COMMANDS.filter((c) => c.sideChat === "unavailable").map((c) => c.name).sort();
    assert.deepEqual(unavailable, ["/clear", "/fork", "/new", "/resume", "/side"]);
  });

  it("finds commands by what they do", () => {
    assert.equal(searchCommands("cron")[0].name, "/loop");
    assert.ok(searchCommands("branch earlier").some((c) => c.name === "/rewind"));
    assert.equal(searchCommands("queue next turn")[0].name, "Alt+Enter");
    assert.equal(searchCommands("zzzz").length, 0);
    assert.equal(searchCommands("", "Context").every((c) => c.group === "Context"), true);
  });
});

describe("/loop", () => {
  const start = new Date(2026, 9, 26, 8, 30); // a Monday, 8:30 local

  it("reads the page's two examples and the default", () => {
    const a = parseLoop("/loop 10m /run-tests");
    assert.ok(a.ok && a.cadence.kind === "interval" && a.cadence.minutes === 10 && a.prompt === "/run-tests");
    const b = parseLoop('/loop "0 9 * * 1-5" standup');
    assert.ok(b.ok && b.cadence.kind === "cron" && b.prompt === "standup");
    const c = parseLoop("/loop check the deploy");
    assert.ok(c.ok && c.defaulted && c.cadence.kind === "interval" && c.cadence.minutes === 10);
  });

  it("rejects bad cadences with a reason", () => {
    for (const bad of ['/loop "0 9 * *" x', '/loop "61 * * * *" x', "/loop 10x tests", "/loop", '/loop "0 9 * * 1-5"']) {
      const r = parseLoop(bad);
      assert.equal(r.ok, false, bad);
    }
    assert.equal(typeof parseCron("*/15 9-17 * * mon-fri"), "object");
  });

  it("lists occurrences until the 7-day expiry", () => {
    const every10 = parseLoop("/loop 10m /run-tests");
    assert.ok(every10.ok);
    const s = occurrences(every10.cadence, start, 3);
    assert.equal(s.total, 7 * 24 * 6);
    assert.equal(s.runs[0].getTime() - start.getTime(), 10 * 60_000);
    const weekdays = parseLoop('/loop "0 9 * * 1-5" standup');
    assert.ok(weekdays.ok);
    const w = occurrences(weekdays.cadence, start, 10);
    assert.equal(w.total, 5);
    assert.ok(w.runs.every((d) => d.getHours() === 9 && d.getMinutes() === 0 && d.getDay() >= 1 && d.getDay() <= 5));
  });
});

describe("composer keys", () => {
  const play = (actions: ComposerAction[], from: ComposerState = INITIAL_COMPOSER) => actions.reduce(composerReducer, from);
  const type = (value: string): ComposerAction => ({ type: "text", value });
  const key = (k: "Enter" | "Alt+Enter" | "Esc" | "Ctrl+C"): ComposerAction => ({ type: "key", key: k });

  it("starts a turn with Enter, steers it, and queues with Alt+Enter", () => {
    const s = play([type("fix the bug"), key("Enter"), type("also add a test"), key("Enter"), type("then update docs"), key("Alt+Enter")]);
    assert.equal(s.running, true);
    assert.deepEqual(s.turns[0].steered, ["also add a test"]);
    assert.deepEqual(s.queue, ["then update docs"]);
    const next = composerReducer(s, { type: "finish" });
    assert.equal(next.turns.length, 2);
    assert.equal(next.turns[1].prompt, "then update docs");
  });

  it("retracts the newest queued item, interrupts with Esc, and pauses a goal", () => {
    let s = play([{ type: "goal", on: true }, { type: "background", on: true }, type("go"), key("Enter"), type("a"), key("Alt+Enter"), type("b"), key("Alt+Enter")]);
    s = composerReducer(s, key("Esc"));
    assert.equal(s.composer, "b");
    assert.deepEqual(s.queue, ["a"]);
    s = composerReducer(s, key("Esc"));
    assert.equal(s.running, false);
    assert.equal(s.goal, "paused");
    assert.match(s.last, /\/stop/);
  });

  it("clears text with Ctrl+C and opens rewind with Esc twice when idle", () => {
    let s = play([type("draft"), key("Ctrl+C")]);
    assert.equal(s.composer, "");
    s = composerReducer(s, key("Esc"));
    assert.equal(s.escArmed, true);
    s = composerReducer(s, key("Esc"));
    assert.match(s.last, /rewind picker opens/);
  });
});

describe("workflows", () => {
  it("writes the request in the page's structure", () => {
    const text = workflowRequest({
      goal: "prepare this repository for the dependency upgrade",
      stages: [{ children: ["Inspect production call sites and compatibility risks"] }, { children: ["inspect tests", "inspect build configuration", "inspect release constraints"] }],
      verify: true,
      deliverable: "an ordered implementation plan with file references",
      writes: "read-only",
      runTests: false,
      commit: false,
    });
    assert.equal(
      text,
      [
        "Use a workflow to prepare this repository for the dependency upgrade.",
        "",
        "1. Inspect production call sites and compatibility risks.",
        "2. In parallel, have separate agents inspect tests, inspect build configuration, and inspect release constraints.",
        "3. Have a verifier challenge every high-risk finding.",
        "4. Synthesize an ordered implementation plan with file references.",
        "",
        "Keep this run read-only.",
      ].join("\n"),
    );
  });

  it("checks names, files and the save command like muse workflows save", () => {
    assert.deepEqual(nameProblems("review-change"), []);
    assert.deepEqual(nameProblems("v1.2_review"), []);
    assert.ok(nameProblems("Review Change").length);
    assert.ok(nameProblems("-review").length);
    assert.ok(nameProblems("a".repeat(65)).length);
    assert.equal(saveCommand("review-change", "./review-change.js", "project", false), "muse workflows save review-change --from ./review-change.js --scope project");
    assert.match(saveCommand("x", "", "user", true), /--scope user --overwrite$/);
    assert.deepEqual(scriptProblems(new TextEncoder().encode("export default 1")), []);
    assert.ok(scriptProblems(new Uint8Array()).length);
    assert.ok(scriptProblems(new Uint8Array(512 * 1024 + 1).fill(97)).length);
    assert.ok(scriptProblems(new Uint8Array([0xff, 0xfe])).some((p) => /UTF-8/.test(p)));
  });

  it("caps active children at 16, queues wider batches, and fails past 1,000", () => {
    const c = capacity({ cpuLimit: 32, stages: [40, 3], tokensPerChild: 1000 });
    assert.equal(c.activeLimit, 16);
    assert.deepEqual(c.waves, [3, 1]);
    assert.deepEqual(c.queued, [24, 0]);
    assert.equal(c.failsAt, null);
    assert.equal(capacity({ cpuLimit: 4, stages: [600, 401], tokensPerChild: 0 }).failsAt, 1001);
  });

  it("builds the mini workflow's child and synthesis requests", () => {
    const body = childBody("muse-spark-1.3-contributor", MINI_CHILDREN[1], SAMPLE_SERVICE);
    assert.equal(body.model, "muse-spark-1.3-contributor");
    assert.match(String(body.instructions), /inspect the security boundaries/);
    assert.match(String(body.input), /^ 1 {2}import express/);
    assert.ok((body.max_output_tokens as number) >= 400);
    const synth = synthesisBody("m", "Verify the findings, then return one prioritized report", SAMPLE_SERVICE, [{ title: "API design", text: "L8: query id" }]);
    assert.match(String(synth.input), /Child 1 \(API design\):\nL8: query id/);
  });
});

describe("workflow control room", () => {
  const keys = (state: RoomState, ...ks: RoomKey[]) => ks.reduce(pressKey, state);
  const open = () => openRoom(initialRoom());

  it("reads the page's keys, letters in either case", () => {
    assert.equal(roomKey("ArrowUp"), "up");
    assert.equal(roomKey("k"), "up");
    assert.equal(roomKey("J"), "down");
    assert.equal(roomKey(" "), "space");
    assert.equal(roomKey("Escape"), "esc");
    assert.equal(roomKey("P"), "p");
    assert.equal(roomKey("q"), null);
  });

  it("does nothing until /workflows opens it", () => {
    const s = pressKey(initialRoom(), "down");
    assert.equal(s.open, false);
    assert.match(s.message, /\/workflows/);
  });

  it("selects, opens and goes back with the page's keys", () => {
    const s = keys(open(), "down", "down", "down", "up");
    assert.equal(s.run, 1, "Down stops at the last run; Up goes back one");
    const inside = pressKey(s, "right");
    assert.equal(inside.level, "run");
    assert.equal(keys(inside, "left").level, "list");
    assert.equal(keys(inside, "esc").level, "list", "Esc goes back a level inside a run");
    assert.equal(keys(open(), "esc").open, false, "Esc closes from the run list");
    assert.equal(keys(inside, "space").open, false, "Space closes from any level");
  });

  it("cancels a running workflow from the list, and only one that's still going", () => {
    const s = pressKey(open(), "c");
    assert.equal(s.runs[0].status, "cancelled");
    assert.ok(s.runs[0].children.every((c) => c.status === "completed" || c.status === "cancelled"));
    assert.match(keys(open(), "down", "c").message, /Nothing to cancel: dependency-upgrade is already completed/);
  });

  it("opens a result only for a completed workflow", () => {
    assert.match(pressKey(open(), "r").message, /R opens the result of a completed workflow/);
    const result = keys(open(), "down", "r");
    assert.equal(result.level, "result");
    assert.equal(keys(result, "left").level, "list");
  });

  it("pauses, skips and restarts inside a run, and R is no retry for finished children", () => {
    const inside = keys(open(), "enter");
    assert.equal(pressKey(inside, "p").runs[0].status, "paused");
    assert.equal(keys(inside, "p", "p").runs[0].status, "running");
    // Child 0 completed; R on it explains instead of retrying.
    assert.match(pressKey(inside, "r").message, /R isn't a general retry: it restarts a running child only/);
    const onRunning = pressKey(inside, "down");
    assert.equal(pressKey(onRunning, "r").runs[0].children[1].restarts, 1);
    assert.equal(pressKey(onRunning, "x").runs[0].children[1].status, "skipped");
    assert.match(keys(open(), "down", "down", "enter", "down", "r").message, /packages\/web is failed/);
    assert.match(pressKey(open(), "p").message, /works inside a workflow/);
  });

  it("fills in both recovery paths", () => {
    const r = recoverySteps({ runId: "run-42", sessionId: "6f1c2b7a-41d2-4e8b-9a3c-0d5e7f9a1b24", scriptPath: "" });
    assert.equal(r.afterRestart, "muse workflows recover run-42 --session 6f1c2b7a-41d2-4e8b-9a3c-0d5e7f9a1b24 --apply");
    assert.match(r.sameProcess, /resumeFromRunId run-42/);
    assert.match(r.sameProcess, /<scriptPath from the Workflow result>/);
    const page = readFileSync("content/meta-docs/pages/muse-code/workflows.md", "utf8");
    assert.ok(page.includes("muse workflows recover <run-id> --session <session-id> --apply"));
    assert.equal(recoverySteps({ runId: "", sessionId: "", scriptPath: "" }).afterRestart, "muse workflows recover <run-id> --session <session-id> --apply");
  });
});

describe("session messaging", () => {
  const play = (actions: Action[], from: World = initialWorld()) => actions.reduce(reducer, from);
  const [impl, review] = initialWorld().sessions;

  it("normalizes and checks names by the page's rules", () => {
    assert.equal(normalizeName("API-Review-482731"), "api-review-482731");
    assert.deepEqual(nameRuleProblems("api-review-482731"), []);
    for (const bad of ["ab", "1review", "review--api", "api-", "all", "self", "current", "api_review", "a".repeat(33)]) assert.ok(nameRuleProblems(bad).length, bad);
  });

  it("keeps old names reserved to their session", () => {
    const w = play([{ type: "rename", session: review.id, name: "API-Review-2" }]);
    assert.equal(w.sessions[1].name, "api-review-2");
    assert.deepEqual(w.sessions[1].formerNames, ["api-review-482731"]);
    const taken = reducer(w, { type: "rename", session: impl.id, name: "api-review-482731" });
    assert.match(taken.status.text, /tombstoned/);
    const back = reducer(w, { type: "rename", session: review.id, name: "api-review-482731" });
    assert.equal(back.sessions[1].name, "api-review-482731");
    assert.match(resolveTarget(w, "api-review-482731").problem ?? "", /earlier name/);
  });

  it("asks the recipient to approve, then delivers by the chosen behavior", () => {
    let w = play([{ type: "send", from: impl.id, to: "api-review-482731", body: "Please review.", delivery: "steer", wake: "when-idle", messageId: "m1" }]);
    assert.equal(w.pending.length, 1);
    w = reducer(w, { type: "decide", key: "m1", choice: "allow-session" });
    assert.equal(w.pending.length, 0);
    assert.match(w.status.text, /wakes the session when it's idle/);
    assert.equal(w.sessions[1].inbox.length, 1);
    w = reducer(w, { type: "send", from: impl.id, to: review.id, body: "FYI", delivery: "notify", wake: "when-idle", messageId: "m2" });
    assert.match(w.status.text, /not added to the model's context/);
    assert.equal(w.sessions[1].inbox.length, 1, "notify-only never reaches the model");
    w = reducer(w, { type: "send", from: impl.id, to: review.id, body: "again", delivery: "steer", wake: "when-idle", messageId: "m2" });
    assert.match(w.status.text, /deduplicated/);
  });

  it("expires a pending request after 30 minutes, then cools down", () => {
    let w = play([{ type: "send", from: impl.id, to: review.id, body: "hi", delivery: "queue", wake: "stay-idle", messageId: "m1" }]);
    w = reducer(w, { type: "advance", minutes: 30 });
    assert.equal(w.pending.length, 0);
    w = reducer(w, { type: "send", from: impl.id, to: review.id, body: "hi again", delivery: "steer", wake: "when-idle", messageId: "m2" });
    assert.match(w.status.text, /^retry later/);
  });

  it("rejects self-messages, oversized ones and ineligible sessions", () => {
    assert.match(reducer(initialWorld(), { type: "send", from: impl.id, to: impl.id, body: "x", delivery: "steer", wake: "when-idle", messageId: "a" }).status.text, /Self-messaging is rejected/);
    assert.match(reducer(initialWorld(), { type: "send", from: impl.id, to: review.id, body: "x".repeat(8193), delivery: "steer", wake: "when-idle", messageId: "b" }).status.text, /8,192/);
    const win = reducer(initialWorld(), { type: "set", session: review.id, patch: { platform: "windows" } });
    assert.match(reducer(win, { type: "send", from: impl.id, to: review.id, body: "x", delivery: "steer", wake: "when-idle", messageId: "c" }).status.text, /Windows/);
    const blocked = play([
      { type: "send", from: impl.id, to: review.id, body: "x", delivery: "steer", wake: "when-idle", messageId: "d" },
      { type: "decide", key: "d", choice: "block-session" },
      { type: "send", from: impl.id, to: review.id, body: "y", delivery: "steer", wake: "when-idle", messageId: "e" },
    ]);
    assert.match(blocked.status.text, /blocked/);
    const restarted = reducer(blocked, { type: "restart", session: review.id });
    assert.deepEqual(restarted.sessions[1].blocked, []);
  });
});

describe("rewind", () => {
  it("branches from an earlier input and leaves the source intact", () => {
    let t = newTree();
    t = addTurn(t, "b0", { input: "A", reply: "a", responseId: "r1" });
    t = addTurn(t, "b0", { input: "B", reply: "b", responseId: "r2" });
    t = addTurn(t, "b0", { input: "C", reply: "c", responseId: "r3" });
    const out = rewindTo(t, "b0", 1);
    const child = out.tree.branches.find((b) => b.id === out.branch)!;
    assert.equal(child.draft, "B");
    assert.deepEqual(contextOf(out.tree, out.branch).map((x) => x.input), ["A"]);
    assert.equal(previousIdFor(out.tree, out.branch), "r1");
    assert.deepEqual(contextOf(out.tree, "b0").map((x) => x.input), ["A", "B", "C"]);
    assert.deepEqual(scrollbackOf(out.tree, out.branch).map((x) => [x.input, x.inContext]), [["A", true], ["B", false], ["C", false]]);
    const first = rewindTo(t, "b0", 0);
    assert.equal(previousIdFor(first.tree, first.branch), null);
  });

  it("moves through the picker with its keys and labels a sample of every kind", () => {
    assert.equal(pickerMove("ArrowUp", false, 2, 5), 1);
    assert.equal(pickerMove("n", true, 2, 5), 3);
    assert.equal(pickerMove("End", false, 0, 5), 4);
    assert.equal(pickerMove("x", false, 0, 5), null);
    assert.deepEqual([...new Set(PICKER_SAMPLE.map((r) => r.label))].sort(), ["blocked", "exact", "review"]);
  });
});
