/**
 * Every muse-code-cookbook DemoSpec server-rendered the way the docs page mounts it (its JSON props plus the slug):
 * what each demo shows before anything runs, the Contributor notice wherever a live call can go out, and no em dash
 * or key-like string anywhere. The CSS module is the one stand-in: a load hook turns *.module.css into an object whose
 * every class name is itself, as the media kit's tests do. Effects don't run in a server render, so nothing reaches
 * the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

let html: (el: ReactElement) => string;
let demos: typeof import("@/lib/docs/demos/muse-code-cookbook").museCodeCookbookDemos;
let groups: typeof import("@/lib/docs/demos").DEMO_GROUPS;

function clean(out: string): string {
  assert.equal(out.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
  return out;
}

/** The rendered text without tags, for output that spans several elements (terminal lines). */
function textOf(out: string): string {
  return out.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

function render(slug: string): string {
  const spec = demos[slug];
  assert.ok(spec, `a DemoSpec for ${slug}`);
  return html(createElement(spec.Component as ComponentType<object>, { ...spec.props, slug }));
}

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (e) => clean(renderToString(e).replace(/<!-- -->/g, ""));
  demos = (await import("@/lib/docs/demos/muse-code-cookbook")).museCodeCookbookDemos;
  groups = (await import("@/lib/docs/demos")).DEMO_GROUPS;
});

describe("the group's specs", () => {
  it("cover every page in the group, with plain JSON props and no em dashes", () => {
    assert.deepEqual(Object.keys(demos).sort(), [...groups["muse-code-cookbook"]].sort());
    for (const [slug, spec] of Object.entries(demos)) {
      assert.deepEqual(JSON.parse(JSON.stringify(spec.props)), spec.props, `${slug} props are plain JSON`);
      const text = JSON.stringify({ title: spec.title, blurb: spec.blurb, prompt: spec.agentPrompt });
      assert.equal(text.includes(String.fromCharCode(0x2014)), false, `${slug} has no em dash`);
      assert.doesNotMatch(text, /muse-spark-1\.3(?!-contributor)/, `${slug} never names muse-spark-1.3 on its own`);
      assert.ok(spec.title && spec.blurb && spec.agentPrompt.task, `${slug} has a title, blurb and task`);
      assert.ok(spec.agentPrompt.snippets?.python && spec.agentPrompt.snippets?.typescript && spec.agentPrompt.snippets?.curl, `${slug} has all three snippets`);
    }
  });
});

describe("each demo before anything runs", () => {
  it("shows the Contributor notice on every page, since each has a live call", () => {
    for (const slug of Object.keys(demos)) assert.match(render(slug), NOTICE, slug);
  });

  it("cookbook/muse-code lists the ten recipes with links here", () => {
    const out = render("cookbook/muse-code");
    assert.equal((out.match(/href="\/docs\/cookbook\//g) ?? []).length, 10);
    assert.match(out, /Showing 10 of 10 recipes/);
    assert.match(out, /<span>Find recipes<\/span>/);
  });

  it("cookbook/audit-agent-sessions opens the real log on its timeline", () => {
    const out = render("cookbook/audit-agent-sessions");
    assert.match(out, /aria-checked="true"[^>]*>Real run<\/button>/);
    assert.match(out, /Kill the process after record 89 of 89/);
    assert.match(out, /Intent: tool:edit_file, authorized allow:policy/);
    assert.match(out, /<span>Review this session<\/span>/);
  });

  it("cookbook/deterministic-replay replays the committed fixture clean", () => {
    const out = textOf(render("cookbook/deterministic-replay"));
    assert.match(out, /Trace: checkout_probe\nResult: completed\nRecords: run=6 task=0\nDiffs:\n {2}none/);
    assert.match(out, /PASS {2}checkout_probe/);
    assert.match(out, /Zero diffs: the check passes/);
    assert.match(out, /inspect prints run=7 there and run=6 here/, "says why its record count differs from the recipe's");
  });

  it("cookbook/contained-execution starts on boundary 1, blocked", () => {
    const out = textOf(render("cookbook/contained-execution"));
    assert.match(out, /\/bin\/bash: line 1: \/home\/you\/sandbox_escape_probe\.txt: Read-only file system\nExit code: 1/);
    assert.match(out, /Security: approval disabled · sandbox normal · from CLI flag/);
    assert.match(out, /2\. PROBE/);
  });

  it("cookbook/immutable-guardrails holds the AGENTS.md edit with only two choices", () => {
    const out = render("cookbook/immutable-guardrails");
    assert.match(out, /Held for review/);
    assert.match(out, /Yes, allow this one write/);
    assert.match(out, /No \(esc\)/);
    assert.doesNotMatch(out, />Always allow in this workspace/);
  });

  it("cookbook/staged-approvals stages the recipe's command and holds stage 3", () => {
    const out = render("cookbook/staged-approvals");
    assert.match(out, /known_safe[\s\S]*known_safe[\s\S]*unresolved/);
    assert.match(out, /Stage 3\/3 needs your answer/);
    assert.match(out, /Always allow in this workspace: rm \.\.\./);
    assert.match(out, /Abort the entire command/);
    // argv cells break only between words: each word is unbreakable, with a <wbr> after each comma.
    assert.match(out, /<code class="argv"><span class="argvWord">\[&quot;rm&quot;,<\/span><wbr\/><span class="argvWord">&quot;-rf&quot;,<\/span>/);
  });

  it("cookbook/subagent-fanout shows the recipe's six children running", () => {
    const out = render("cookbook/subagent-fanout");
    assert.equal((out.match(/>running<\/span>/g) ?? []).length, 6);
    assert.match(out, /Concurrency limit 6/);
    assert.match(out, /\.muse\/worktrees\/subagent-v2-\.\.\.-subagent-6/);
  });

  it("cookbook/goal-tracking pins the Perigord goal", () => {
    const out = render("cookbook/goal-tracking");
    assert.match(out, /Goal\(Migrate the Perigord API gateway from the\.\.\.\)/);
    assert.match(out, /<span>Call update_goal<\/span>/);
  });

  it("cookbook/bundled-skills opens on /plan with the contract and the sample project", () => {
    const out = render("cookbook/bundled-skills");
    assert.match(out, /aria-checked="true"[^>]*>\/plan<\/button>/);
    assert.match(out, /1\. CATALOG/);
    assert.match(out, /class SnorkelLedger/);
    assert.match(out, /<span>Run \/plan<\/span>/);
  });

  it("cookbook/loop-and-cron describes the default job and waits for the browser's clock", () => {
    const out = render("cookbook/loop-and-cron");
    assert.match(out, /At 8:00 AM, every day/);
    assert.match(out, /Working out the next fire times in your timezone/);
  });

  it("cookbook/immutable-guardrails draws a workspace narrow enough for half the card", () => {
    const tree = textOf(render("cookbook/immutable-guardrails")).match(/\/tmp\/rule12_demo\n[\s\S]*?\(a symlink to \.git\/config\)/)?.[0] ?? "";
    assert.ok(tree, "the tree is drawn");
    for (const line of tree.split("\n")) assert.ok(line.length <= 34, `"${line}" fits without scrolling`);
  });

  it("cookbook/side-chats asks the recipe's check about a side-only topic", async () => {
    const { MAIN_PRESETS } = await import("@/components/docs/playgrounds/muse-code-cookbook/SideChat");
    const check = MAIN_PRESETS.find((p) => p.label === "The recipe's check");
    assert.ok(check);
    assert.match(check.prompt, /a reading of 2\.0/);
    assert.doesNotMatch(check.prompt, /Wozzle/, "the main thread read widget.py itself, whose docstring names the Wozzle constant");
    assert.match(MAIN_PRESETS[0].prompt, /Wozzle constant/, "which is why");
  });

  it("cookbook/side-chats starts with an empty main thread", () => {
    const out = render("cookbook/side-chats");
    assert.match(out, /Main thread/);
    assert.match(out, />\/side<\/button>/);
    assert.match(out, />\/btw<\/button>/);
  });
});
