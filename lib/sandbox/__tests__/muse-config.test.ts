/**
 * Unit tests for lib/sandbox/muse-config.ts: the settings, the hooks.json shape the Oct 30 spike verified, and each
 * hook script run in real node with its stdin and paths faked, as Muse Code runs them.
 *   npx tsx --test lib/sandbox/__tests__/muse-config.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  agentCapacity,
  BUILD_MCP_TOKEN_ENV,
  HOOK_SCRIPTS,
  hooksConfig,
  HOOKS_DIR,
  mcpConfig,
  museConfigFiles,
  museSettings,
  NOTES_DIR,
  noteStatusScript,
  parseNoteStatus,
} from "@/lib/sandbox/muse-config";
import { PLATFORM_FILES } from "@/lib/sandbox/paths";

const tmp = mkdtempSync(path.join(tmpdir(), "musemuse-muse-config-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = (name: string) => {
  const dir = path.join(tmp, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Runs one hook script the way Muse Code does: `node <script>` with the hook's JSON on stdin. */
function runHook(name: keyof typeof HOOK_SCRIPTS, input: unknown, env: Record<string, string> = {}) {
  const dir = freshDir("hooks");
  const file = path.join(dir, name);
  writeFileSync(file, HOOK_SCRIPTS[name]);
  const res = spawnSync("node", [file], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    // Muse Code gives hooks a small environment of their own.
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: tmp, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(res.status, 0, `${name} exited ${res.status}: ${res.stderr}`);
  assert.equal(res.stderr, "", `${name} wrote to stderr`);
  return { stdout: res.stdout, json: res.stdout ? (JSON.parse(res.stdout) as Record<string, unknown>) : null };
}

describe("settings", () => {
  it("holds the agent capacity to what Muse Code accepts", () => {
    assert.equal(agentCapacity(undefined), 6);
    assert.equal(agentCapacity(""), 6);
    assert.equal(agentCapacity("lots"), 6);
    assert.equal(agentCapacity(" 12 "), 12);
    assert.equal(agentCapacity("6.7"), 6);
    assert.equal(agentCapacity("0"), 1);
    assert.equal(agentCapacity("-3"), 1);
    assert.equal(agentCapacity("65"), 64);
  });

  it("are the keys the spike verified, with every reminder in one runtime_capabilities object", () => {
    assert.deepEqual(museSettings(6), [
      "agents.execution_capacity=6",
      'runtime_capabilities={"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":true}}',
      "max_consecutive_stop_hook_continuations=3",
    ]);
    assert.equal(museSettings(500)[0], "agents.execution_capacity=64");
    for (const setting of museSettings(6)) JSON.parse(setting.slice(setting.indexOf("=") + 1));
  });
});

describe("hooks.json", () => {
  const config = hooksConfig();

  it("is in Claude Code's shape, with no matcher on Stop or UserPromptSubmit", () => {
    for (const [event, groups] of Object.entries(config.hooks)) {
      assert.ok(Array.isArray(groups) && groups.length, event);
      for (const group of groups as Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>) {
        if (event === "Stop" || event === "UserPromptSubmit") assert.equal("matcher" in group, false, `${event} has a matcher`);
        assert.ok(group.hooks.length);
        for (const hook of group.hooks) {
          assert.equal(hook.type, "command");
          const [bin, script, ...rest] = hook.command.split(" ");
          assert.equal(bin, "node");
          assert.deepEqual(rest, []);
          assert.ok(script!.startsWith(`${HOOKS_DIR}/`), "scripts live outside the product");
          assert.ok(path.basename(script!) in HOOK_SCRIPTS, `${script} is written`);
        }
      }
    }
    assert.deepEqual(Object.keys(config.hooks), ["PreToolUse", "PostToolUse", "PostToolBatch", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "StopFailure"]);
    assert.equal(config.hooks.PreToolUse[0]!.matcher, ".*");
  });

  it("points .mcp.json at the build MCP with the token left as a ${VAR} for the runner to fill", () => {
    assert.deepEqual(mcpConfig("https://musemuse.example/api/build-mcp"), {
      mcpServers: {
        musemuse: {
          type: "http",
          url: "https://musemuse.example/api/build-mcp",
          headers: { Authorization: `Bearer \${${BUILD_MCP_TOKEN_ENV}}` },
          mode: "optional",
        },
      },
    });
  });

  it("writes everything, replacing what's there, and removes .mcp.json when the platform can't be reached", () => {
    const withMcp = museConfigFiles({ mcpUrl: "https://musemuse.example/api/build-mcp" });
    assert.deepEqual(withMcp.remove, [
      "/vercel/app/.muse/hooks.json",
      "/vercel/app/.mcp.json",
      ...Object.keys(HOOK_SCRIPTS).map((s) => `${HOOKS_DIR}/${s}`),
    ]);
    assert.deepEqual(
      withMcp.write.map((f) => f.path),
      [...Object.keys(HOOK_SCRIPTS).map((s) => `${HOOKS_DIR}/${s}`), "/vercel/app/.muse/hooks.json", "/vercel/app/.mcp.json"],
    );
    assert.deepEqual(JSON.parse(withMcp.write.find((f) => f.path.endsWith("hooks.json"))!.content), config);
    const offline = museConfigFiles({ mcpUrl: null });
    assert.ok(offline.remove.includes("/vercel/app/.mcp.json"));
    assert.ok(!offline.write.some((f) => f.path.endsWith(".mcp.json")));
    for (const f of withMcp.write) assert.ok(!f.content.includes("\u2014"), `${f.path} has an em dash`);
  });
});

describe("the guard hook", () => {
  const deny = (input: unknown) => {
    const out = runHook("guard.mjs", input).json as { hookSpecificOutput?: Record<string, string> } | null;
    return out?.hookSpecificOutput ?? null;
  };
  const write = (p: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: "/vercel/app",
    tool_name: "write_file",
    tool_input: { path: p, content: "x" },
    ...extra,
  });

  it("refuses writes to the platform's files, env files, its Muse Code config and its own folder", () => {
    for (const p of [...PLATFORM_FILES, ".env.local", "app/.env", ".muse/hooks.json", ".mcp.json", "/vercel/musemuse/hooks/guard.mjs", "/vercel/app/scripts/verify.mjs"]) {
      const out = deny(write(p));
      assert.equal(out?.hookEventName, "PreToolUse", p);
      assert.equal(out?.permissionDecision, "deny", p);
      assert.ok(out?.permissionDecisionReason && /can't change it/.test(out.permissionDecisionReason), p);
    }
    assert.match(deny(write("scripts/verify.mjs"))!.permissionDecisionReason!, /^scripts\/verify\.mjs belongs to the Muse Muse platform/);
    assert.ok(deny({ ...write(""), tool_name: "edit_file", tool_input: JSON.stringify({ path: "playwright.config.ts", old: "a", new: "b" }) }), "edits, with the input as a JSON string");
    assert.ok(deny({ ...write(""), tool_input: { path: "../app/.env.local" }, cwd: "/vercel/app/app" }), "paths resolve from the hook's cwd");
  });

  it("lets everything else through, saying nothing", () => {
    for (const input of [
      write("app/page.tsx"),
      write("BUILD_NOTES.md"),
      write(".muse/worktrees/subagent-v2-1/app/page.tsx"),
      write("scripts/seed.mjs"),
      { ...write("scripts/verify.mjs"), tool_name: "read_file" },
      { ...write("scripts/verify.mjs"), tool_name: "bash", tool_input: { command: "cat scripts/verify.mjs" } },
    ]) {
      assert.equal(runHook("guard.mjs", input).stdout, "", JSON.stringify(input));
    }
    // A subagent's worktree is a copy of the product, with the same platform files.
    assert.ok(deny(write(".muse/worktrees/subagent-v2-1/scripts/verify.mjs")));
  });

  it("never fails the run on input it can't read", () => {
    for (const input of ["", "not json", "[]", JSON.stringify({ tool_name: "write_file", tool_input: 7 })]) {
      assert.equal(runHook("guard.mjs", input).stdout, "");
    }
  });
});

describe("the notes hook", () => {
  function notes(...texts: string[]) {
    const dir = freshDir("notes");
    texts.forEach((text, i) => writeFileSync(path.join(dir, `2026-10-31T00:00:0${i}.000Z-n${i}.json`), JSON.stringify({ id: `n${i}`, text })));
    return dir;
  }

  it("hands every unread note to the main agent once, in order, as additional context", () => {
    const dir = notes("Make the header blue.", "Then add a footer link.");
    writeFileSync(path.join(dir, ".session"), "main-session\n");
    const first = runHook("notes.mjs", { hook_event_name: "PostToolUse", session_id: "main-session" }, { MUSEMUSE_NOTES_DIR: dir });
    assert.deepEqual(first.json, {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "A note from this build's owner: Make the header blue.\n\nA note from this build's owner: Then add a footer link.",
      },
    });
    assert.deepEqual(readdirSync(path.join(dir, "read")).sort(), ["2026-10-31T00:00:00.000Z-n0.json", "2026-10-31T00:00:01.000Z-n1.json"]);
    assert.equal(runHook("notes.mjs", { hook_event_name: "PostToolBatch", session_id: "main-session" }, { MUSEMUSE_NOTES_DIR: dir }).stdout, "");
  });

  it("answers under the event it ran for, and leaves notes for the main agent alone in a subagent's call", () => {
    const dir = notes("Use larger type.");
    writeFileSync(path.join(dir, ".session"), "main-session");
    assert.equal(runHook("notes.mjs", { hook_event_name: "PostToolUse", session_id: "child-session" }, { MUSEMUSE_NOTES_DIR: dir }).stdout, "");
    assert.ok(existsSync(path.join(dir, "2026-10-31T00:00:00.000Z-n0.json")));
    const batch = runHook("notes.mjs", { hook_event_name: "PostToolBatch", session_id: "main-session" }, { MUSEMUSE_NOTES_DIR: dir });
    assert.equal((batch.json!.hookSpecificOutput as Record<string, string>).hookEventName, "PostToolBatch");
  });

  it("says nothing with no notes, no folder or a note it can't read", () => {
    assert.equal(runHook("notes.mjs", { hook_event_name: "PostToolUse" }, { MUSEMUSE_NOTES_DIR: path.join(tmp, "missing") }).stdout, "");
    const dir = freshDir("notes");
    writeFileSync(path.join(dir, "2026-10-31T00:00:00.000Z-x.json"), "{broken");
    assert.equal(runHook("notes.mjs", { hook_event_name: "PostToolUse" }, { MUSEMUSE_NOTES_DIR: dir }).stdout, "");
    assert.equal(NOTES_DIR, "/vercel/musemuse/notes");
  });
});

describe("the stop gate", () => {
  /** A product whose tsc prints `output` and exits `code`, after `sleep` seconds. */
  function product(opts: { output?: string; code?: number; sleep?: number; tsc?: boolean } = {}) {
    const dir = freshDir("product");
    const bin = path.join(dir, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    if (opts.tsc !== false) {
      writeFileSync(path.join(dir, "tsc-output.txt"), opts.output ?? "");
      writeFileSync(path.join(bin, "tsc"), `#!/bin/bash\n${opts.sleep ? `sleep ${opts.sleep}\n` : ""}cat tsc-output.txt\nexit ${opts.code ?? 0}\n`, { mode: 0o755 });
    }
    writeFileSync(path.join(bin, "next"), "#!/bin/bash\n[ \"$1\" = typegen ] && touch typegen-ran\nexit 0\n", { mode: 0o755 });
    return dir;
  }
  const stop = { hook_event_name: "Stop", session_id: "s1" };

  it("sends Muse Code back with the first type errors while the product doesn't typecheck", () => {
    const errors = [
      "app/page.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ".muse/worktrees/subagent-v2-1/app/page.tsx(1,1): error TS2304: Cannot find name 'x'.",
      "lib/meta/a.ts(9,1): error TS2304: Cannot find name 'y'.",
    ].join("\n");
    const dir = product({ output: `${errors}\n`, code: 2 });
    const out = runHook("stop-gate.mjs", stop, { MUSEMUSE_PRODUCT_DIR: dir }).json as { decision: string; reason: string };
    assert.equal(out.decision, "block");
    assert.match(out.reason, /^The product does not typecheck yet \(2 type errors\)\. Fix these, then check again before you stop:\n/);
    assert.ok(out.reason.includes("app/page.tsx(3,7): error TS2322"));
    assert.ok(out.reason.includes("lib/meta/a.ts(9,1)"));
    assert.ok(!out.reason.includes(".muse/"), "a subagent's worktree copy isn't the product");
    assert.ok(existsSync(path.join(dir, "typegen-ran")), "route types first, as verify does");
  });

  it("lets Muse Code stop when the typecheck passes, can't run or runs out of time", () => {
    assert.equal(runHook("stop-gate.mjs", stop, { MUSEMUSE_PRODUCT_DIR: product() }).stdout, "");
    assert.equal(runHook("stop-gate.mjs", stop, { MUSEMUSE_PRODUCT_DIR: product({ tsc: false }) }).stdout, "");
    assert.equal(runHook("stop-gate.mjs", stop, { MUSEMUSE_PRODUCT_DIR: product({ output: ".muse/worktrees/x/a.ts(1,1): error TS1: x\n", code: 2 }) }).stdout, "");
    const slow = product({ output: "a.ts(1,1): error TS1: late\n", code: 2, sleep: 5 });
    assert.equal(runHook("stop-gate.mjs", stop, { MUSEMUSE_PRODUCT_DIR: slow, MUSEMUSE_STOP_GATE_MS: "2500" }).stdout, "");
  });
});

describe("the event logger hook", () => {
  it("appends one JSON line per event, without the heavy fields", () => {
    const log = path.join(freshDir("logs"), "nested/hooks.jsonl");
    runHook("log.mjs", { hook_event_name: "SubagentStart", session_id: "s1", agent_id: "scout", messages: [{ role: "user" }] }, { MUSEMUSE_HOOK_LOG: log });
    runHook("log.mjs", { hook_event_name: "PreCompact", session_id: "s1", summary: "x".repeat(5000) }, { MUSEMUSE_HOOK_LOG: log });
    runHook("log.mjs", "not json", { MUSEMUSE_HOOK_LOG: log });
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.hook_event_name, "SubagentStart");
    assert.equal(lines[0]!.agent_id, "scout");
    assert.equal("messages" in lines[0]!, false);
    assert.equal(typeof lines[0]!.t, "number");
    assert.equal(String(lines[1]!.summary).length, 2001);
  });

  it("has no em dashes in any script", () => {
    for (const [name, source] of Object.entries(HOOK_SCRIPTS)) assert.ok(!source.includes("\u2014"), name);
  });
});

describe("noteStatusScript", () => {
  const ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  const OTHER = "01a18fef-c533-74a3-b49d-da9cf5ff74b8";
  const run = (dir: string, engine: "exec" | "serve", done: boolean) =>
    parseNoteStatus(execFileSync("bash", ["-c", noteStatusScript(dir, engine, done)], { encoding: "utf8" }));

  it("tells each read note once, and waiting notes only once the round is done", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "notes-"));
    try {
      mkdirSync(path.join(dir, "read"));
      writeFileSync(path.join(dir, "read", `2026-11-01T10-00-00-${ID}.json`), "{}");
      writeFileSync(path.join(dir, `2026-11-01T10-00-01-${OTHER}.json`), "{}");
      assert.deepEqual(run(dir, "exec", false), [{ id: ID, status: "read" }]);
      assert.deepEqual(run(dir, "exec", false), []);
      assert.deepEqual(run(dir, "exec", true), [{ id: OTHER, status: "late" }]);
      assert.deepEqual(run(dir, "exec", true), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the bridge's done folder alone, and says nothing for a folder that isn't there", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mailbox-"));
    try {
      mkdirSync(path.join(dir, "done"));
      writeFileSync(path.join(dir, "done", `a-${ID}.json`), "{}");
      assert.deepEqual(run(dir, "serve", true), []);
      assert.deepEqual(run(path.join(dir, "missing"), "exec", true), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
