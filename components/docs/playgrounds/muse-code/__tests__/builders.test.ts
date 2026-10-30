/**
 * The configuration, extending, changelog, coding-agents and agent-frameworks builders against their pages, with
 * real replies from the docs proxy as fixtures (trimmed, no keys): settings checks, instruction-file order, memory and
 * launch flags, subagent capacity and toolsets, the changelog parser on the mirrored page, the agent configs and their
 * checks, the mini agent loop's tools and requests, the generated SDK and app-server code, and the stand-in judge.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code/__tests__/builders.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import {
  baseUrlProblems,
  claudeCheck,
  claudeEnv,
  claudeModels,
  codexInline,
  codexToml,
  CONTRIBUTOR_NOTE,
  genericCheck,
  openCodeCheck,
  openCodeConfig,
  readCheck,
} from "@/components/docs/playgrounds/muse-code/agent-configs";
import { callWithRetries, firstBody, isTransient, nextBody, pausable, readReply, REPO, RETRY_DELAYS_MS, retryMessage, runTests, runTool, toolDefs, initialHistory, type RetryableResult } from "@/components/docs/playgrounds/muse-code/agent-loop";
import { filterChangelog, inlineParts, ITEM_TYPES, parseChangelog, toMarkdown, versionAnchor } from "@/components/docs/playgrounds/muse-code/changelog";
import { hookRisk, leadPrompt, resumeCommands, sessionIdProblem, skillFiles, subagentCapacity, toolsetMatch } from "@/components/docs/playgrounds/muse-code/extending";
import { classifyStage, parseCommand } from "@/components/docs/playgrounds/muse-code/permissions";
import { claudeSdkCode, codexCatalog, codexDriver, rpcSequence } from "@/components/docs/playgrounds/muse-code/frameworks";
import { judgeBody, parseJudgeReply } from "@/components/docs/playgrounds/muse-code/judge";
import { buildLaunch, buildSettings, checkSettings, checkSettingsText, memoryLayout, resolveInstructions, type LaunchDraft } from "@/components/docs/playgrounds/muse-code/settings";

const fixture = (name: string) => JSON.parse(readFileSync(`components/docs/playgrounds/muse-code/__tests__/fixtures/${name}`, "utf8"));
const page = (slug: string) => readFileSync(`content/meta-docs/pages/${slug}.md`, "utf8");

describe("settings", () => {
  it("fails without schema_version 1, as startup does", () => {
    assert.match(checkSettings({}).errors.join(" "), /malformed settings file/);
    assert.match(checkSettings({ schema_version: 2 }).errors.join(" "), /unsupported settings schema version/);
    assert.deepEqual(checkSettings({ schema_version: 1 }).errors, []);
    assert.deepEqual(checkSettingsText("").errors, []);
    assert.match(checkSettingsText('{ "schema_version": 1,, }').errors[0], /line 1, column/);
  });

  it("checks MCP servers, capacity and unknown keys", () => {
    const bad = checkSettings({
      schema_version: 1,
      agents: { execution_capacity: 100 },
      mcp_servers: { docs: { transport: "streamable_http", url: "https://x", framing: "content-length" }, local: { transport: "stdio" }, odd: { transport: "ws" } },
      model_default: "x",
    });
    assert.match(bad.errors.join(" "), /1 through 64/);
    assert.match(bad.warnings.join(" "), /framing is for stdio/);
    assert.doesNotMatch(bad.errors.join(" "), /framing/, "only a non-default value fails, and the default isn't documented");
    assert.match(bad.errors.join(" "), /"local" \(stdio\) needs a command/);
    assert.match(bad.errors.join(" "), /"odd" needs a transport/);
    assert.match(bad.warnings.join(" "), /"model_default" isn't a key/);
    assert.match(checkSettings({ schema_version: 1, mcp_servers: { a: { transport: "streamable_http", url: "u", headers: { Authorization: "Bearer abcdefghijklmnop" } } } }).warnings.join(" "), /literal secret/);
  });

  it("writes only what's set", () => {
    const s = buildSettings({
      schemaVersion: true,
      defaultProfile: ":ask-me",
      retentionDays: 14,
      showReasoning: false,
      terminalBackground: "dark",
      executionCapacity: null,
      managedHooksPath: "",
      oauthDynamicRegistration: false,
      mcpServers: [{ name: "docs", transport: "stdio", command: "my-mcp-server", args: "--port 1", env: "A=1", url: "", headers: "", enabled: true, mode: "optional", toolTimeoutSec: null, startupTimeoutSec: 30 }],
    });
    assert.deepEqual(s, {
      schema_version: 1,
      permissions: { default_profile: ":ask-me" },
      session_retention_days: 14,
      tui: { terminal_background: "dark" },
      mcp_oauth_dynamic_client_registration: false,
      mcp_servers: { docs: { transport: "stdio", command: "my-mcp-server", args: ["--port", "1"], env: { A: "1" }, mode: "optional", startup_timeout_sec: 30 } },
    });
    assert.deepEqual(checkSettings(s).errors, []);
  });

  it("loads instruction files in the page's order", () => {
    const levels = [
      { dir: "/repo", present: ["AGENTS.md" as const, ".claude/CLAUDE.md" as const] },
      { dir: "/repo/api", present: ["CLAUDE.md" as const] },
    ];
    const r = resolveInstructions(levels, true, true);
    assert.deepEqual(r.loaded.map((x) => x.path), ["/repo/api/CLAUDE.md", "/repo/AGENTS.md", "Your machine-wide user rules"]);
    assert.deepEqual(r.ignored.map((x) => x.path), ["/repo/.claude/CLAUDE.md"]);
    const untrusted = resolveInstructions(levels, false, true);
    assert.deepEqual(untrusted.loaded.map((x) => x.path), ["Your machine-wide user rules"]);
  });

  it("lays out memory and warns past 48 files", () => {
    const m = memoryLayout(["Deploy: how we ship", "Flaky tests"], "project");
    assert.match(m.index, /- \[Deploy\]\(deploy\.md\): how we ship/);
    assert.match(m.tree, /^\.agents\/memory\//);
    assert.match(m.warnings.join(" "), /untrusted workspace/);
    assert.ok(memoryLayout(Array.from({ length: 48 }, (_, i) => `t${i}`), "personal").warnings.some((w) => /48/.test(w)));
  });

  const launch = (p: Partial<LaunchDraft>): LaunchDraft => ({
    surface: "interactive", model: "", effort: "", approvalMode: "", approvalJudge: "", sandboxNetwork: "", disableSandbox: false, disableApproval: false, yolo: false,
    trustWorkspace: false, workspace: "", noSessionLog: false, contributor: "", json: false, promptFile: "", maxSteps: null, prompt: "go", trace: false, retentionDays: null, ...p,
  });

  it("builds both launch surfaces and flags what doesn't belong", () => {
    assert.equal(buildLaunch(launch({ model: "muse-spark-1.2", effort: "medium" })).command, "muse --model muse-spark-1.2 --reasoning-effort medium");
    assert.equal(buildLaunch(launch({ surface: "headless", json: true, maxSteps: 30, prompt: "Run the tests." })).command, 'muse exec --json --max-model-steps 30 "Run the tests."');
    assert.match(buildLaunch(launch({ json: true })).errors.join(" "), /headless only/);
    assert.match(buildLaunch(launch({ effort: "none" })).warnings.join(" "), /doesn't accept none/);
    assert.match(buildLaunch(launch({ disableSandbox: true, sandboxNetwork: "restricted" })).warnings.join(" "), /overrides --sandbox-network/);
    assert.match(buildLaunch(launch({ trace: true, retentionDays: 7 })).command, /^MUSE_TRANSPORT_TRACE=1 muse -c session_retention_days=7$/);
  });
});

describe("extending", () => {
  it("counts the root in the tree's capacity and rejects spawns past it", () => {
    assert.deepEqual(subagentCapacity(null, "default", 10), { capacity: 8, source: "the default: eight agents at once, the root included", childSlots: 7, running: 7, rejected: 3 });
    assert.equal(subagentCapacity(null, "ultra", 100).capacity, 64);
    assert.equal(subagentCapacity(200, "default", 1).capacity, 64);
    assert.match(leadPrompt({ task: "Upgrade logging", children: [{ task: "updates packages/api", writes: true }, { task: "reviews the changelog", writes: false }] }), /isolated worktree[\s\S]*read-only in the shared checkout/);
  });

  it("matches named toolsets by full name or a trailing *", () => {
    const r = toolsetMatch(["mcp__docs__search*", "mcp__github__create_issue", "bad*name"], ["mcp__docs__search", "mcp__docs__search_pages", "mcp__docs__fetch"]);
    assert.deepEqual(r.tools.map((t) => t.matchedBy), ["mcp__docs__search*", "mcp__docs__search*", null]);
    assert.deepEqual(r.missing, ["mcp__github__create_issue"]);
    assert.deepEqual(r.invalid, ["bad*name"]);
  });

  it("reviews a hook's command as running outside the sandbox", () => {
    const [npx, curl] = parseCommand("npx prettier --check . && curl -fsS https://hooks.example.com/notify").stages.map((s) => hookRisk(classifyStage(s)));
    assert.equal(npx, "Runs code the shell can't review, and no approval will hold it; reaches registry.npmjs.org directly.");
    assert.equal(curl, "Read-only; reaches hooks.example.com directly.");
    assert.match(hookRisk(classifyStage(parseCommand("rm -rf ~/.cache > ~/log.txt").stages[0])), /^Destructive[\s\S]*writes ~\/log\.txt/);
  });

  it("writes skill files and the resume commands", () => {
    const s = skillFiles("release-notes", "project", "Draft notes", "1. Do it", "Release notes");
    assert.equal(s.dir, ".agents/skills/release-notes");
    assert.match(s.skillMd, /^---\nname: release-notes\ndescription: Draft notes\nmetadata:\n {2}display-name: Release notes\n---/);
    // Every command points at the folder the SKILL.md is written in.
    assert.match(s.commands, /^muse skills validate \.\/\.agents\/skills\/release-notes /);
    assert.doesNotMatch(s.commands, /install/, "a project skill is committed, not installed");
    const user = skillFiles("release-notes", "user", "Draft notes", "1. Do it");
    assert.equal(user.dir, "./release-notes");
    assert.match(user.commands, /^muse skills validate \.\/release-notes /);
    assert.match(user.commands, /\nmuse skills install \.\/release-notes --scope user /);
    assert.doesNotMatch(user.commands, /\.agents\/skills/);
    assert.equal(resumeCommands("", "", true), 'muse exec --session-id <uuid> --allow-workspace-switch "Continue the task."\nmuse export --session <uuid> --out run.json');
    assert.ok(sessionIdProblem("abc"));
    assert.equal(sessionIdProblem("6f1c2b7a-41d2-4e8b-9a3c-0d5e7f9a1b24"), null);
  });
});

describe("changelog", () => {
  const raw = page("muse-code/changelog");
  const releases = parseChangelog(raw);

  it("parses every release with the page's own anchors", () => {
    const headings = [...raw.matchAll(/^## (.+?) \{#([^}]+)\}$/gm)].map((m) => [m[1], m[2]]);
    assert.deepEqual(releases.map((r) => [r.version, r.anchor]), headings);
    const sectionAnchors = [...raw.matchAll(/^### .+? \{#([^}]+)\}$/gm)].map((m) => m[1]);
    assert.deepEqual(releases.flatMap((r) => r.sections.filter((s) => s.type !== "Notes").map((s) => s.anchor)), sectionAnchors);
    assert.equal(versionAnchor("1.0.x"), "v1-0-x");
    const bullets = raw.split("\n").filter((l) => l.startsWith("- ")).length;
    const items = releases.flatMap((r) => r.sections.flatMap((s) => s.items)).length;
    assert.equal(items, bullets + 2, "every bullet, plus the two patch-note paragraphs");
  });

  it("parses the copy route's Markdown (anchors removed) the same way", () => {
    const stripped = raw.replace(/\s*\{#[^}\s]+\}\s*$/gm, "");
    assert.deepEqual(parseChangelog(stripped).map((r) => r.anchor), releases.map((r) => r.anchor));
  });

  it("filters by version range, type, security and words", () => {
    const all = filterChangelog(releases, { newest: 0, oldest: releases.length - 1, types: ITEM_TYPES, securityOnly: false, query: "" });
    const latest = filterChangelog(releases, { newest: 0, oldest: 0, types: ITEM_TYPES, securityOnly: false, query: "" });
    assert.ok(latest.total > 0 && latest.total < all.total);
    assert.deepEqual(latest.results.map((r) => r.release.version), [releases[0].version]);
    const security = filterChangelog(releases, { newest: 0, oldest: releases.length - 1, types: ITEM_TYPES, securityOnly: true, query: "" });
    assert.ok(security.results.every((r) => r.sections.every((s) => s.items.every((i) => i.startsWith("**Security")))));
    const fixes = filterChangelog(releases, { newest: 0, oldest: releases.length - 1, types: ["Fixes"], securityOnly: false, query: "sandbox windows" });
    assert.ok(fixes.total > 0);
    assert.ok(fixes.results.every((r) => r.sections.every((s) => s.section.type === "Fixes" && s.items.every((i) => /sandbox/i.test(i) && /windows/i.test(i)))));
    assert.match(toMarkdown(latest.results), new RegExp(`^## ${releases[0].version.replace(/\./g, "\\.")} \\(https://dev\\.meta\\.ai/docs/muse-code/changelog#${releases[0].anchor}\\)`));
  });

  it("keeps em dashes out of prose and reads inline Markdown", () => {
    const prose = releases.flatMap((r) => r.sections.flatMap((s) => s.items)).map((i) => i.replace(/`[^`]*`/g, ""));
    assert.equal(prose.filter((p) => p.includes("\u2014")).length, 0);
    assert.deepEqual(inlineParts("**Security:** `muse serve` fixed, see [docs](https://dev.meta.ai/docs/x)"), [
      { kind: "strong", text: "Security:" },
      { kind: "text", text: " " },
      { kind: "code", text: "muse serve" },
      { kind: "text", text: " fixed, see " },
      { kind: "link", text: "docs", href: "https://dev.meta.ai/docs/x" },
    ]);
  });
});

describe("coding-agent configs", () => {
  it("writes the page's OpenCode config with Contributor in place of muse-spark-1.3", () => {
    const out = openCodeConfig({ adapter: "responses", model: "muse-spark-1.3-contributor", effort: "high", summary: true, encrypted: true, modalities: true });
    const json = JSON.parse(out.code);
    const m = json.provider.meta.models["muse-spark-1.3-contributor"];
    assert.equal(json.provider.meta.npm, "@ai-sdk/openai");
    assert.equal(json.provider.meta.options.baseURL, "https://api.meta.ai/v1");
    assert.deepEqual(m.options, { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] });
    assert.deepEqual(m.limit, { context: 1048576, output: 131072 });
    // The live check under the config shows the kit's Contributor notice, so the warnings don't repeat it.
    assert.deepEqual(out.warnings, []);
    const toml = codexToml({ model: "muse-spark-1.3-contributor", effort: "high", summary: true, keyEnv: "MODEL_API_KEY" }).code;
    assert.ok(toml.startsWith(`# muse-spark-1.3-contributor: ${CONTRIBUTOR_NOTE}\nmodel = "muse-spark-1.3-contributor"`), "the generated config carries the note as a comment");
    assert.ok(!codexToml({ model: "muse-wonder-1.0", effort: "high", summary: true, keyEnv: "MODEL_API_KEY" }).code.includes("Contributor"));
    assert.match(openCodeConfig({ adapter: "chat", model: "muse-wonder-1.0", effort: "high", summary: false, encrypted: false, modalities: false }).warnings.join(" "), /doesn't preserve reasoning/);
    assert.match(openCodeConfig({ adapter: "responses", model: "muse-spark-1.3-contributor", effort: "max", summary: true, encrypted: true, modalities: true }).warnings.join(" "), /not on muse-spark-1\.3-contributor/);
  });

  it("writes Codex and Claude Code configs like the page's", () => {
    const md = page("coding-agents");
    const toml = codexToml({ model: "muse-wonder-1.0", effort: "high", summary: true, keyEnv: "MODEL_API_KEY" }).code;
    for (const line of ['model = "muse-wonder-1.0"', 'model_provider = "meta"', 'base_url = "https://api.meta.ai/v1"', 'env_key = "MODEL_API_KEY"', 'wire_api = "responses"', "model_auto_compact_token_limit = 900000"]) {
      assert.ok(toml.includes(line), line);
      assert.ok(md.includes(line), `page has ${line}`);
    }
    assert.match(codexInline({ model: "muse-wonder-1.0", effort: "xhigh", summary: true, keyEnv: "MODEL_API_KEY" }), /^export MODEL_API_KEY=[\s\S]*CODEX_HOME=\/tmp\/codex-modelapi codex \\\n {2}-m muse-wonder-1\.0/);
    const env = claudeEnv({ main: "muse-wonder-1.0", opus: "muse-wonder-1.0", sonnet: "muse-spark-1.3-contributor", haiku: "muse-spark-1.3-contributor", subagent: "muse-spark-1.3-contributor", toolSearch: true, shell: "posix", keyEnv: "MODEL_API_KEY" }).code;
    assert.match(env, /^# muse-spark-1\.3-contributor: Contributor mode: Meta may use what you send[^\n]*\nexport ANTHROPIC_BASE_URL="https:\/\/api\.meta\.ai"\nexport ANTHROPIC_AUTH_TOKEN="\$MODEL_API_KEY"/);
    assert.match(env, /export ENABLE_TOOL_SEARCH="true"$/);
    assert.doesNotMatch(env, /muse-spark-1\.3"/);
    assert.deepEqual(claudeModels({ main: "a", opus: "a", sonnet: "b", haiku: "b", subagent: "b" }), ["a", "b"]);
    assert.match(claudeEnv({ main: "m", opus: "m", sonnet: "m", haiku: "m", subagent: "m", toolSearch: false, shell: "powershell", keyEnv: "MODEL_API_KEY" }).code, /^\$env:ANTHROPIC_BASE_URL = "https:\/\/api\.meta\.ai"\n\$env:ANTHROPIC_AUTH_TOKEN = \$env:MODEL_API_KEY/);
  });

  it("checks base URLs the way the troubleshooting table does", () => {
    assert.deepEqual(baseUrlProblems("https://api.meta.ai/v1"), []);
    assert.match(baseUrlProblems("https://api.meta.ai/v1/").join(" "), /trailing slash/);
    assert.match(baseUrlProblems("https://api.meta.ai/v1/chat/completions").join(" "), /endpoint, not the base/);
    assert.match(baseUrlProblems("https://api.meta.ai/v1", true).join(" "), /no \/v1/);
  });

  it("reads real check replies from the proxy", () => {
    const oc = openCodeCheck({ adapter: "responses", model: "muse-spark-1.3-contributor", effort: "high", summary: true, encrypted: true, modalities: true });
    assert.deepEqual(oc.body.include, ["reasoning.encrypted_content"]);
    const lines = readCheck(oc, 200, fixture("check-oc-responses.json"), "muse-spark-1.3-contributor");
    assert.ok(lines.every((l) => l.ok), JSON.stringify(lines));
    assert.ok(lines.some((l) => /Encrypted reasoning came back/.test(l.text)));
    assert.ok(readCheck(genericCheck("chat", "muse-spark-1.3-contributor"), 200, fixture("check-oc-chat.json"), "muse-spark-1.3-contributor").every((l) => l.ok));
    const claude = readCheck(claudeCheck("muse-spark-1.3-contributor"), 200, fixture("check-claude.json"), "muse-spark-1.3-contributor");
    assert.ok(claude.some((l) => l.text === "stop_reason: end_turn"));
    assert.equal(readCheck(claudeCheck("x"), 401, { error: { message: "no" } }, null)[0].ok, false);
    assert.equal(claudeCheck("muse-wonder-1.0").body.max_tokens, 800);
  });
});

describe("mini agent loop", () => {
  it("defines the three tools in each wire format", () => {
    assert.deepEqual(toolDefs("messages").map((t) => t.name), ["Read", "Edit", "Bash"]);
    assert.ok(toolDefs("messages").every((t) => "input_schema" in t));
    assert.deepEqual(toolDefs("responses").map((t) => [t.type, t.name]), [["function", "read_file"], ["function", "edit_file"], ["function", "exec_command"]]);
  });

  it("runs reads, edits, shell commands and the simulated tests", () => {
    assert.match(runTool("messages", "Read", { file_path: "src/signup.js" }, REPO).output, /^ {3}1\t\/\/ Registers a user/);
    assert.equal(runTool("responses", "read_file", { path: "nope.js" }, REPO).isError, true);
    const edit = runTool("messages", "Edit", { file_path: "src/signup.js", old_string: "  const user", new_string: '  if (!String(body.email).includes("@") || String(body.password ?? "").length < 8) return { status: 400, body: { error: "invalid" } };\n  const user' }, REPO);
    assert.equal(edit.isError, false);
    assert.equal(runTests(REPO).failed, 2);
    assert.equal(runTests(edit.files).failed, 0);
    assert.match(runTool("messages", "Bash", { command: "npm test 2>&1 | head -n 30" }, edit.files).output, /# pass 3/);
    assert.match(runTool("messages", "Bash", { command: "ls -R; echo ---; git status" }, edit.files).output, /src\/signup\.js[\s\S]*---[\s\S]* M src\/signup\.js/);
    const heredoc = runTool("responses", "exec_command", { command: "cat > notes.md <<'EOF'\nhello\nEOF" }, REPO);
    assert.equal(heredoc.files["notes.md"], "hello\n");
    assert.equal(runTool("messages", "Bash", { command: "rm -rf /" }, REPO).isError, true);
  });

  it("reads real tool-call replies and builds the next request", () => {
    const cfg = { protocol: "messages" as const, model: "muse-spark-1.3-contributor", system: "s", prompt: "p", maxTokens: 1500 };
    const m = readReply("messages", fixture("loop-messages.json"));
    assert.equal(m.calls[0].name, "Read");
    assert.equal(m.stop, "tool_use");
    const next = nextBody(cfg, initialHistory(cfg), m, [{ callId: m.calls[0].id, output: "x", isError: false }]);
    const msgs = next.body.messages as Array<{ role: string; content: unknown }>;
    assert.deepEqual(msgs.map((x) => x.role), ["user", "assistant", "user"]);
    assert.deepEqual((msgs[2].content as Array<Record<string, unknown>>)[0], { type: "tool_result", tool_use_id: m.calls[0].id, content: "x" });
    const r = readReply("responses", fixture("loop-responses.json"));
    assert.equal(r.calls[0].name, "read_file");
    const rcfg = { ...cfg, protocol: "responses" as const };
    const rn = nextBody(rcfg, [], r, [{ callId: r.calls[0].id, output: "y", isError: true }]).body;
    assert.equal(rn.previous_response_id, r.responseId);
    assert.deepEqual(rn.input, [{ type: "function_call_output", call_id: r.calls[0].id, output: "y" }]);
    assert.equal(firstBody(rcfg).input, "p");
  });

  it("retries only transient errors", () => {
    assert.equal(isTransient(503, undefined, "persistence service error", true), true);
    assert.equal(isTransient(400, undefined, "referenced response not found or expired", true), true);
    assert.equal(isTransient(400, undefined, "referenced response not found or expired", false), false);
    assert.equal(isTransient(503, "paid_paused", "", false), false);
    assert.equal(isTransient(429, undefined, "slow down", false), false);
    // A call the reader stopped comes back as status 0 with code "aborted": never a dropped connection to retry.
    assert.equal(isTransient(0, "aborted", "Stopped before the reply finished.", true), false);
    assert.equal(isTransient(0, undefined, "Failed to fetch", false), true);
  });

  describe("callWithRetries", () => {
    const ok: RetryableResult = { ok: true, status: 200 };
    const busy: RetryableResult = { ok: false, status: 503, error: { message: "persistence service error" } };
    const aborted: RetryableResult = { ok: false, status: 0, error: { code: "aborted", message: "Stopped before the reply finished." } };
    /** A call that answers from a script, and a sleep that records its waits instead of waiting. */
    const harness = (replies: RetryableResult[], onSleep?: (ms: number) => void) => {
      let calls = 0;
      const waits: number[] = [];
      let stopped = false;
      const call = async () => replies[Math.min(calls++, replies.length - 1)];
      const hooks = {
        stopped: () => stopped,
        sleep: async (ms: number) => {
          waits.push(ms);
          onSleep?.(ms);
        },
      };
      return { call, hooks, calls: () => calls, waits, stop: () => (stopped = true) };
    };

    it("retries a transient failure with backoff until it clears", async () => {
      const h = harness([busy, busy, ok]);
      const notes: string[] = [];
      const res = await callWithRetries(h.call, true, { ...h.hooks, onRetry: (a, ms, f) => notes.push(retryMessage(a, ms, f)) });
      assert.equal(res.ok, true);
      assert.equal(h.calls(), 3);
      assert.deepEqual(h.waits, [2000, 5000]);
      assert.match(notes[0], /^The API answered 503 \(persistence service error\), which usually clears on a retry\. Trying again in 2 s \(attempt 2 of 4\)\. Stop cancels it\.$/);
    });

    it("gives up after the last delay", async () => {
      const h = harness([busy]);
      const res = await callWithRetries(h.call, true, h.hooks);
      assert.equal(res.status, 503);
      assert.equal(h.calls(), RETRY_DELAYS_MS.length + 1);
    });

    it("never re-sends a stopped call", async () => {
      const h = harness([aborted, ok]);
      const res = await callWithRetries(h.call, true, h.hooks);
      assert.equal(res.error?.code, "aborted");
      assert.equal(h.calls(), 1, "Stop (status 0, aborted) is not a dropped connection");
      assert.deepEqual(h.waits, []);
    });

    it("starts nothing new once Stop is pressed, even during the wait", async () => {
      let stop = () => {};
      const h = harness([busy, ok], () => stop());
      stop = h.stop;
      const res = await callWithRetries(h.call, true, h.hooks);
      assert.equal(res.status, 503);
      assert.equal(h.calls(), 1, "the retry after the wait never went out");
      const before = harness([busy, ok]);
      before.stop();
      await callWithRetries(before.call, true, before.hooks);
      assert.equal(before.calls(), 1);
      assert.deepEqual(before.waits, []);
    });

    it("doesn't retry errors that aren't transient", async () => {
      const h = harness([{ ok: false, status: 429, error: { code: "rate_limited", message: "slow down" } }, ok]);
      await callWithRetries(h.call, false, h.hooks);
      assert.equal(h.calls(), 1);
    });

    it("lets Stop cut a pause short", async () => {
      const p = pausable(60_000);
      const t0 = Date.now();
      p.cancel();
      await p.done;
      assert.ok(Date.now() - t0 < 1000);
    });
  });
});

describe("agent frameworks", () => {
  const sdk = {
    prompt: "Add input validation to the signup handler and run the tests.",
    cwd: "/path/to/workspace",
    systemPrompt: "You are a coding agent.",
    tools: ["Read", "Edit", "Bash"],
    bypass: true,
    hermetic: true,
    main: "muse-wonder-1.0",
    opus: "muse-wonder-1.0",
    sonnet: "muse-spark-1.3-contributor",
    haiku: "muse-spark-1.3-contributor",
    subagent: "muse-spark-1.3-contributor",
  };

  it("generates Claude Agent SDK code that compiles, with every alias pinned", () => {
    for (const production of [false, true]) {
      const code = claudeSdkCode({ ...sdk, lang: "typescript", production });
      const out = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      assert.equal(out.diagnostics?.length ?? 0, 0);
      assert.match(code, /ANTHROPIC_BASE_URL: "https:\/\/api\.meta\.ai",/);
      assert.match(code, /CLAUDE_CODE_SUBAGENT_MODEL: "muse-spark-1\.3-contributor"/);
      assert.match(code, /permissionMode: "bypassPermissions"/);
    }
    assert.match(claudeSdkCode({ ...sdk, lang: "typescript", production: true }), /The agent finished without a result message/);
    const py = claudeSdkCode({ ...sdk, lang: "python", production: true });
    assert.match(py, /with anyio\.fail_after\(OVERALL_S\):/);
    assert.match(py, /"ANTHROPIC_AUTH_TOKEN": os\.environ\["MODEL_API_KEY"\]/);
    assert.doesNotMatch(claudeSdkCode({ ...sdk, lang: "python", production: false, bypass: false }), /bypassPermissions/);
  });

  it("generates the app-server catalog, driver and JSON-RPC sequence", () => {
    const input = { model: "muse-wonder-1.0", displayName: "Muse Wonder", defaultLevel: "xhigh" as const, levels: ["low", "medium", "high", "xhigh"] as Array<"low" | "medium" | "high" | "xhigh">, baseInstructions: "b", prompt: "Summarize this repo.", sandbox: "workspace-write" as const, optOutDeltas: true, images: true };
    const catalog = codexCatalog(input).models as Array<Record<string, unknown>>;
    assert.equal(catalog[0].slug, "muse-wonder-1.0");
    assert.equal(catalog[0].default_reasoning_level, "xhigh");
    const driver = codexDriver(input);
    const out = ts.transpileModule(driver, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    assert.equal(out.diagnostics?.length ?? 0, 0);
    assert.match(driver, /"-c", "model_providers\.meta\.requires_openai_auth=false",/);
    assert.match(driver, /"-c", `model_catalog_json="\$\{catalogPath\}"`,/);
    assert.deepEqual(rpcSequence(input).map((s) => s.title), ["initialize", "initialized", "thread/start", "thread started", "turn/start", "turn accepted", "item/completed", "turn/completed"]);
  });
});

describe("stand-in judge", () => {
  it("asks for a strict decision and reads the real reply", () => {
    const body = judgeBody({ model: "muse-spark-1.3-contributor", task: "t", command: "a && rm -rf x", stageNumber: 2, stageCount: 2, stage: "rm -rf x", why: "Destructive removal.", sandbox: "on" });
    assert.equal((body.text as { format: { strict: boolean } }).format.strict, true);
    assert.ok((body.max_output_tokens as number) >= 1000, "room for reasoning before the JSON");
    const reply = fixture("judge-reply.json");
    const text = reply.output.find((o: { type: string }) => o.type === "message").content[0].text;
    assert.equal(parseJudgeReply(text)?.decision, "allow");
    assert.equal(parseJudgeReply("not json"), null);
    assert.equal(parseJudgeReply('{"decision":"maybe","reason":"x"}'), null);
  });
});
