/**
 * The muse-code group's DemoSpecs as the docs page uses them: every page in the group has one, its props are plain
 * JSON, its copy prompt fits in every language without trimming, never names muse-spark-1.3 on its own and has no
 * em dash, and its component server-renders with its props (the controls each demo shows before anything runs, the
 * Contributor notice where it sends to a Contributor model). CSS modules load through a tiny hook that hands back
 * class names, as the media kit's render test does. Nothing reaches the network: effects don't run on the server.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code/__tests__/demos.test.tsx
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";
import ts from "typescript";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const EM_DASH = String.fromCharCode(0x2014);
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

let html: (el: ReactElement) => string;
let demos: typeof import("@/lib/docs/demos/muse-code");
let index: typeof import("@/lib/docs/demos/groups");
let prompt: typeof import("@/lib/docs/agent-prompt");
let pages: typeof import("@/lib/docs/pages");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (el) => {
    const out = renderToString(el).replace(/<!-- -->/g, "");
    assert.equal(out.includes(EM_DASH), false, "no em dash in the rendered demo");
    assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{16}/, "no key-like strings");
    return out;
  };
  demos = await import("@/lib/docs/demos/muse-code");
  index = await import("@/lib/docs/demos/groups");
  prompt = await import("@/lib/docs/agent-prompt");
  pages = await import("@/lib/docs/pages");
});

const el = (c: ComponentType<object>, props: object) => createElement(c, props);

describe("muse-code demos", () => {
  it("gives every page in the group a DemoSpec", () => {
    const slugs = index.DEMO_GROUPS["muse-code"];
    assert.deepEqual(Object.keys(demos.museCodeDemos).sort(), [...slugs].sort());
    for (const slug of slugs) {
      const d = demos.museCodeDemos[slug];
      assert.ok(d.title && d.blurb, slug);
      assert.ok(pages.docsPage(slug), `${slug} is a mirrored page`);
      assert.deepEqual(JSON.parse(JSON.stringify(d.props)), d.props, `${slug} props are plain JSON`);
      for (const text of [d.title, d.blurb ?? "", d.agentPrompt.task, ...(d.agentPrompt.facts ?? []), ...(d.agentPrompt.checklist ?? []), ...Object.values(d.agentPrompt.snippets ?? {})]) {
        assert.equal(text.includes(EM_DASH), false, `${slug}: no em dash`);
        assert.doesNotMatch(text, /muse-spark-1\.3(?!-contributor)/, `${slug}: muse-spark-1.3 appears only as its Contributor variant`);
      }
    }
  });

  it("builds a copy prompt that fits, in every language and for every agent, without trimming", () => {
    for (const [slug, d] of Object.entries(demos.museCodeDemos)) {
      const info = pages.docsPage(slug)!;
      for (const language of ["python", "typescript", "curl"] as const) {
        assert.ok(d.agentPrompt.snippets?.[language], `${slug} has a ${language} snippet`);
        for (const { id: agent } of prompt.CODING_AGENTS) {
          const text = prompt.buildAgentPrompt({
            page: { slug, title: info.title, description: info.description, sourceUrl: info.sourceUrl, markdownUrl: info.markdownUrl },
            spec: d.agentPrompt,
            agent,
            language,
            lastRequest: null,
          });
          assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${language} ${agent}: ${text.length} chars`);
          assert.doesNotMatch(text, /\(trimmed\)/, `${slug} ${language} ${agent} was trimmed (${text.length} chars)`);
          assert.equal(text.includes(EM_DASH), false);
          assert.ok(text.includes(d.agentPrompt.task.slice(0, 60)), `${slug}: the task leads`);
        }
      }
    }
  });

  it("hands out TypeScript starter code that parses", () => {
    for (const [slug, d] of Object.entries(demos.museCodeDemos)) {
      const code = d.agentPrompt.snippets?.typescript ?? "";
      const out = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      assert.deepEqual(out.diagnostics?.map((x) => ts.flattenDiagnosticMessageText(x.messageText, "\n")) ?? [], [], slug);
    }
  });

  it("tells the agent about muse's own credential on the CLI pages, and the API's where the code calls it", () => {
    const build = (slug: string, language: "python" | "typescript" | "curl") => {
      const info = pages.docsPage(slug)!;
      return prompt.buildAgentPrompt({
        page: { slug, title: info.title, description: info.description, sourceUrl: info.sourceUrl, markdownUrl: info.markdownUrl },
        spec: demos.museCodeDemos[slug].agentPrompt,
        agent: "claude-code",
        language,
        lastRequest: null,
      });
    };
    for (const slug of index.DEMO_GROUPS["muse-code"]) {
      const callsApi = slug === "muse-code/rewind" || !slug.startsWith("muse-code");
      for (const language of ["python", "typescript", "curl"] as const) {
        const text = build(slug, language);
        if (callsApi) {
          assert.match(text, /Auth: send Authorization: Bearer \$MODEL_API_KEY/, `${slug} ${language}: the API setup`);
          assert.match(text, /The key comes from MODEL_API_KEY/);
        } else {
          assert.match(text, /Auth: muse reads META_API_KEY/, `${slug} ${language}: Muse Code's setup`);
          assert.match(text, /The key comes from META_API_KEY or a stored sign-in/);
          assert.doesNotMatch(text, /Bearer \$MODEL_API_KEY|Base URL: https:\/\/api\.meta\.ai/, `${slug} ${language}: no Model API setup for a CLI task`);
          if (language === "curl") assert.match(text, /Starter code \(shell\)/);
        }
      }
    }
  });

  it("server-renders each demo with its props, before anything runs", () => {
    const expect: Record<string, RegExp[]> = {
      "muse-code": [/Install and first run/, /curl -fsSL https:\/\/dev\.meta\.ai\/install\.sh \| sh/, /What differs by platform/, /aarch64-apple-darwin/],
      "muse-code/auth": [/Which credential wins/, /META_API_KEY is exported/, /Run muse logout/],
      "muse-code/subscriptions": [/Pick a plan/, /Everyday Usage/, /Maximum Usage/, /Contributor mode for a run/],
      "muse-code/permissions": [/Stage 3 of 3/, /rm -rf report\.log/, /Holds for review/, /Ask the stand-in judge/, NOTICE],
      "muse-code/interactive": [/Find a command/, /\/compact/, /\/loop/, /Steer a running turn/],
      "muse-code/workflows": [/Use a workflow to review this service\./, /Save a workflow/, /Control room/, /\/workflows/, /resumeFromRunId/, /muse workflows recover &lt;run-id&gt; --session &lt;session-id&gt; --apply/, /Run the workflow/, NOTICE],
      "muse-code/session-messaging": [/implementation-482731/, /api-review-482731/, /Let 30 minutes pass/, NOTICE],
      "muse-code/rewind": [/Rewind a live conversation/, /Play A, B, C/, /\/rewind/, NOTICE],
      "muse-code/configuration": [/settings\.json/, /&quot;schema_version&quot;: 1/, /Instruction files/, /Reasoning effort, live/],
      "muse-code/extending": [/Subagents/, /8 agents at once, root included/, /MCP servers/, /Headless and CI/],
      "muse-code/changelog": [/Loading the changelog/],
      "coding-agents": [/OpenCode/, /@ai-sdk\/openai/, /Check this config live/, NOTICE],
      "agent-frameworks": [/Claude Agent SDK/, /claude-agent-sdk/, /Run a mini agent loop/],
    };
    for (const [slug, d] of Object.entries(demos.museCodeDemos)) {
      const out = html(el(d.Component as ComponentType<object>, { ...d.props, slug }));
      // Code blocks color their tokens with spans, so text checks read the markup with its tags removed.
      const text = out.replace(/<[^>]+>/g, "");
      for (const re of expect[slug] ?? []) assert.ok(re.test(out) || re.test(text), `${slug} shows ${re}`);
    }
  });
});
