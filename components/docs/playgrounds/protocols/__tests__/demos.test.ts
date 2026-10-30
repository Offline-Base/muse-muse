/**
 * The protocols group's DemoSpecs (lib/docs/demos/protocols.ts) as data: every page has one, props survive the trip
 * to a client component as plain JSON, every request goes to an endpoint the docs proxy forwards on a model it runs
 * (never muse-spark-1.3 itself), the flows only read replies of steps before them, the schema explorers' targets name
 * real schemas and examples, nothing has an em dash, and every copy prompt fits without being trimmed. No network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/protocols/__tests__/demos.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { before, describe, it } from "node:test";
import type { FlowSpec, FlowStep } from "@/components/docs/playgrounds/protocols/flow";
import type { SchemaExample, SchemaTarget } from "@/components/docs/playgrounds/protocols/SchemaExplorer";
import { DEMO_GROUPS } from "@/lib/docs/demos/groups";
import type { DemoMap } from "@/lib/docs/demos/types";

// The demo file imports client components, which import a CSS module: hand back class names as themselves.
const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const EM_DASH = String.fromCharCode(0x2014);
const TEXT_MODELS = ["muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.1", "muse-wonder-1.0"];

let demos: DemoMap;
/** The group's slugs as DEMO_GROUPS lists them (lib/docs/demos/groups.ts imports nothing, so other groups' demos don't load). */
function groupSlugs(): string[] {
  return [...DEMO_GROUPS.protocols];
}
let flowLib: typeof import("@/components/docs/playgrounds/protocols/flow");
let endpoints: typeof import("@/lib/docs/client/endpoints");
let prompt: typeof import("@/lib/docs/agent-prompt");
let pages: typeof import("@/lib/docs/pages");
let parse: typeof import("@/components/docs/playgrounds/protocols/schema-parse");

before(async () => {
  ({ protocolsDemos: demos } = await import("@/lib/docs/demos/protocols"));
  flowLib = await import("@/components/docs/playgrounds/protocols/flow");
  endpoints = await import("@/lib/docs/client/endpoints");
  prompt = await import("@/lib/docs/agent-prompt");
  pages = await import("@/lib/docs/pages");
  parse = await import("@/components/docs/playgrounds/protocols/schema-parse");
});

type Json = Record<string, unknown>;

/** Every request a page's demo can send: flow steps, console presets, schema examples. */
function requests(props: Json): Array<{ where: string; method: string; path: string; body?: unknown }> {
  const out: Array<{ where: string; method: string; path: string; body?: unknown }> = [];
  const fromFlow = (where: string, f: FlowSpec | { steps: FlowStep[] }) => {
    for (const s of f.steps) out.push({ where: `${where}/${s.id}`, method: flowLib.methodOf(s), path: s.path, body: s.body });
  };
  for (const tab of (props.tabs as Array<{ id: string; kind: string; props: Json }> | undefined) ?? []) {
    if (tab.kind === "flow") fromFlow(tab.id, tab.props as unknown as FlowSpec);
    if (tab.kind === "console") {
      for (const p of tab.props.presets as Array<{ label: string; console: { method: string; path: string; body?: unknown } }>) {
        out.push({ where: `${tab.id}/${p.label}`, method: p.console.method, path: p.console.path, body: p.console.body });
      }
    }
  }
  for (const p of (props.presets as Array<{ label: string; console?: { method: string; path: string; body?: unknown } }> | undefined) ?? []) {
    if (p.console) out.push({ where: p.label, method: p.console.method, path: p.console.path, body: p.console.body });
  }
  for (const ex of (props.examples as SchemaExample[] | undefined) ?? []) fromFlow(`example ${ex.id}`, ex);
  return out;
}

/** A template-free path for the endpoint check: ids become a stand-in id. */
function concretePath(p: string): string {
  return p.replace(/\{\{[^}]+\}\}/g, "resp_test123").replace(/\{response_id\}/g, "resp_test123");
}

describe("protocols DemoSpecs", () => {
  it("covers exactly the group's pages", () => {
    assert.deepEqual(Object.keys(demos).sort(), groupSlugs().sort());
    assert.equal(Object.keys(demos).length, 18);
  });

  it("has a title, a one-line blurb and plain JSON props on every page", () => {
    for (const [slug, d] of Object.entries(demos)) {
      assert.ok(d.title.length > 10, slug);
      assert.ok(d.blurb && d.blurb.length > 40 && !d.blurb.includes("\n"), `${slug} blurb`);
      assert.deepEqual(JSON.parse(JSON.stringify(d.props)), d.props, `${slug} props are plain JSON`);
      assert.ok(typeof d.Component === "function", `${slug} component`);
    }
  });

  it("writes no em dash anywhere", () => {
    for (const [slug, d] of Object.entries(demos)) {
      const text = JSON.stringify({ t: d.title, b: d.blurb, p: d.props, a: d.agentPrompt });
      assert.equal(text.includes(EM_DASH), false, slug);
      assert.equal(text.includes("\\u2014"), false, slug);
    }
  });

  it("sends only to endpoints the proxy forwards, on models it runs, never muse-spark-1.3 itself", () => {
    for (const [slug, d] of Object.entries(demos)) {
      for (const r of requests(d.props as Json)) {
        const p = concretePath(r.path);
        assert.ok(endpoints.isAllowedEndpoint(r.method as "GET", p), `${slug} ${r.where}: ${r.method} ${p}`);
        const model = (r.body as Json | undefined)?.model;
        if (model !== undefined) assert.ok(model === "{{model}}" || TEXT_MODELS.includes(String(model)), `${slug} ${r.where}: ${String(model)}`);
      }
      assert.doesNotMatch(JSON.stringify(d.props), /"muse-spark-1\.3"/, slug);
    }
  });

  it("keeps output limits cheap: at least 400 tokens, at most 3,000 (6,000 for a background story), except the documented minimum", () => {
    for (const [slug, d] of Object.entries(demos)) {
      for (const r of requests(d.props as Json)) {
        const b = (r.body ?? {}) as Json;
        for (const key of ["max_output_tokens", "max_completion_tokens", "max_tokens"]) {
          const v = b[key];
          if (typeof v !== "number") continue;
          if (v < 400) assert.ok([15, 16].includes(v), `${slug} ${r.where}: ${key} ${v} is a documented limit check`);
          else assert.ok(v <= (b.background === true ? 6000 : 3000), `${slug} ${r.where}: ${key} ${v}`);
        }
      }
    }
  });

  it("stays inside the per-minute limits: check lists are paced, polls wait at least 3 s, and a run sends at most 20 requests", () => {
    for (const [slug, d] of Object.entries(demos)) {
      for (const tab of ((d.props as Json).tabs as Array<{ id: string; kind: string; props: FlowSpec }> | undefined) ?? []) {
        if (tab.kind !== "flow") continue;
        const flow = tab.props;
        const checks = flow.steps.filter((s) => flowLib.expectsError(s) && s.independent).length;
        if (checks >= 5) assert.ok((flow.paceMs ?? 0) >= 1000, `${slug}/${tab.id}: ${checks} checks in a row are paced`);
        for (const s of flow.steps) {
          if (s.poll) assert.ok((s.poll.everyMs ?? 1500) >= 3000, `${slug}/${tab.id}/${s.id}: polls at most 20 times a minute`);
        }
        const sends = flow.steps.filter((s) => !s.poll).length;
        assert.ok(sends <= 16, `${slug}/${tab.id}: ${sends} requests, leaving room under 20 a minute`);
      }
    }
  });

  it("checks that every documented error names its field, and keeps checks and clean-ups out of the copy prompt", () => {
    for (const [slug, d] of Object.entries(demos)) {
      for (const tab of ((d.props as Json).tabs as Array<{ id: string; kind: string; props: FlowSpec }> | undefined) ?? []) {
        if (tab.kind !== "flow") continue;
        for (const s of tab.props.steps) {
          if (s.title === "Clean up") assert.equal(s.cleanup, true, `${slug}/${tab.id}/${s.id} is marked as clean-up`);
          const expected = flowLib.expectedStatuses(s) ?? [];
          if (!expected.length || expected.some((x) => x < 400)) continue;
          assert.ok(flowLib.skipsRecord(s), `${slug}/${tab.id}/${s.id}: a documented-error check isn't recorded`);
          if (!expected.includes(400)) continue;
          const named = (s.expect?.checks ?? []).some((c) => (c.path === "error.param" || c.path === "error.message") && c.matches);
          assert.ok(named, `${slug}/${tab.id}/${s.id}: the 400 check names its field or reason`);
        }
      }
    }
  });

  it("builds flows that read only earlier steps, with unique ids and valid checks", () => {
    for (const [slug, d] of Object.entries(demos)) {
      const flows: Array<{ where: string; steps: FlowStep[] }> = [];
      for (const tab of ((d.props as Json).tabs as Array<{ id: string; kind: string; props: FlowSpec }> | undefined) ?? []) {
        if (tab.kind === "flow") flows.push({ where: tab.id, steps: tab.props.steps });
      }
      for (const ex of ((d.props as Json).examples as SchemaExample[] | undefined) ?? []) flows.push({ where: ex.id, steps: ex.steps });
      for (const f of flows) {
        const ids = f.steps.map((s) => s.id);
        assert.equal(new Set(ids).size, ids.length, `${slug} ${f.where}: unique step ids`);
        f.steps.forEach((s, i) => {
          for (const ref of flowLib.stepRefs({ ...s, path: `${s.path} ${JSON.stringify(s.expect ?? {})}` }, ids)) {
            assert.ok(ids.indexOf(ref) < i, `${slug} ${f.where}/${s.id} reads ${ref}, which must come first`);
          }
          for (const e of flowLib.templateExprs([s.path, s.body])) {
            const known = e === "model" || e.startsWith("vars.") || e.startsWith("sample") || ids.includes(e.split(".")[0]);
            assert.ok(known, `${slug} ${f.where}/${s.id}: unknown template ${e}`);
          }
          if (s.stream) assert.equal((s.body as Json | undefined)?.stream, true, `${slug} ${f.where}/${s.id}: a streamed step asks for stream`);
        });
      }
    }
  });

  it("points every schema target at a real schema on its page and a real example", () => {
    for (const slug of ["api-reference/responses/schemas", "api-reference/chat-completions/schemas", "api-reference/messages/schemas"]) {
      const props = demos[slug].props as { source: string; examples: SchemaExample[]; targets: Record<string, SchemaTarget>; starters: string[] };
      assert.equal(props.source, slug);
      const page = parse.parseSchemaPage(readFileSync(path.join(ROOT, "content/meta-docs/pages", `${slug}.md`), "utf8"));
      const exampleIds = new Set(props.examples.map((e) => e.id));
      for (const [anchor, t] of Object.entries(props.targets)) {
        assert.ok(page.byAnchor[anchor], `${slug}: ${anchor} is a schema on the page`);
        assert.ok(exampleIds.has(t.example), `${slug}: ${anchor} names example ${t.example}`);
        const ex = props.examples.find((e) => e.id === t.example)!;
        if (t.step) assert.ok(ex.steps.some((s) => s.id === t.step), `${slug}: ${anchor} step ${t.step}`);
        if (t.at === "event") {
          assert.ok(t.event, `${slug}: ${anchor} names its event`);
          assert.ok(ex.steps.some((s) => s.stream), `${slug}: ${anchor} reads events from a streamed example`);
        }
      }
      for (const a of props.starters) assert.ok(page.byAnchor[a], `${slug}: starter ${a}`);
      const used = new Set(Object.values(props.targets).map((t) => t.example));
      for (const id of exampleIds) assert.ok(used.has(id), `${slug}: example ${id} is used by a schema`);
    }
  });

  it("writes a copy prompt for every page that fits, untrimmed, for every agent and language", () => {
    for (const [slug, d] of Object.entries(demos)) {
      const page = pages.docsPage(slug);
      assert.ok(page, slug);
      for (const { id: agent } of prompt.CODING_AGENTS) {
        for (const language of ["python", "typescript", "curl"] as const) {
          const text = prompt.buildAgentPrompt({
            page: { slug, title: page.title, description: page.description, sourceUrl: page.sourceUrl, markdownUrl: page.markdownUrl },
            spec: d.agentPrompt,
            agent,
            language,
            lastRequest: null,
          });
          assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${agent} ${language}: ${text.length} characters`);
          assert.equal(text.includes("(trimmed)"), false, `${slug} ${agent} ${language} is trimmed (${text.length})`);
          assert.equal(text.includes(EM_DASH), false);
          assert.match(text, /muse-spark-1\.3-contributor/, `${slug} ${language} names the Contributor model`);
          assert.doesNotMatch(text, /muse-spark-1\.3(?!-contributor)[^.\d]/, `${slug} ${language} never names muse-spark-1.3 alone`);
        }
      }
      assert.ok(d.agentPrompt.task.length > 80 && d.agentPrompt.task.length < 700, `${slug} task length`);
      assert.ok((d.agentPrompt.checklist ?? []).length >= 1, `${slug} checklist`);
      for (const language of ["python", "typescript", "curl"] as const) assert.ok(d.agentPrompt.snippets?.[language], `${slug} ${language} snippet`);
    }
  });

  it("sets up the Messages pages with the Anthropic SDK and the base host, and the others with the OpenAI SDK", () => {
    for (const slug of Object.keys(demos)) {
      const page = pages.docsPage(slug)!;
      const build = (language: "python" | "typescript" | "curl") =>
        prompt.buildAgentPrompt({
          page: { slug, title: page.title, description: page.description, sourceUrl: page.sourceUrl, markdownUrl: page.markdownUrl },
          spec: demos[slug].agentPrompt,
          agent: "claude-code",
          language,
          lastRequest: null,
        });
      const setup = (text: string) => text.slice(text.indexOf("Setup"), text.indexOf("\n\n", text.indexOf("Setup")));
      const python = setup(build("python"));
      const typescript = setup(build("typescript"));
      if (/(^|\/)messages(\/|$)/.test(slug)) {
        assert.match(python, /the Anthropic SDK \(pip install anthropic\) with base_url="https:\/\/api\.meta\.ai" \(no \/v1\) and auth_token/, `${slug}: python setup`);
        assert.match(typescript, /the Anthropic SDK \(npm install @anthropic-ai\/sdk\) with baseURL "https:\/\/api\.meta\.ai" \(no \/v1\) and authToken/, `${slug}: typescript setup`);
        assert.doesNotMatch(python + typescript, /OpenAI SDK/, `${slug}: no OpenAI SDK in the setup`);
        assert.match(python, /the Anthropic SDK takes https:\/\/api\.meta\.ai/, `${slug}: the base URL line says the SDK's host`);
      } else {
        assert.match(python, /the OpenAI SDK \(pip install openai\) with base_url="https:\/\/api\.meta\.ai\/v1"/, `${slug}: python setup`);
        assert.doesNotMatch(python, /Anthropic/, `${slug}: python setup`);
      }
    }
  });

  it("keeps the snippets free of keys and placeholder ids, and on the right base URLs", () => {
    for (const [slug, d] of Object.entries(demos)) {
      for (const [lang, code] of Object.entries(d.agentPrompt.snippets ?? {})) {
        assert.doesNotMatch(code, /sk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY/, `${slug} ${lang}`);
        // A snippet runs as it is: it works on an id it made, never on the docs' example id.
        assert.doesNotMatch(code, /resp_abc123/, `${slug} ${lang} uses a placeholder id`);
        // Snippets that call the API read the key from the environment; type definitions call nothing.
        if (/api\.meta\.ai|OpenAI\(|Anthropic\(/.test(code)) assert.match(code, /MODEL_API_KEY/, `${slug} ${lang} reads the key from the environment`);
        if (/Anthropic\(/.test(code)) assert.match(code, /base_url="https:\/\/api\.meta\.ai"/, `${slug} ${lang}: the Anthropic SDK takes the base host`);
        if (/OpenAI\(/.test(code)) assert.match(code, /https:\/\/api\.meta\.ai\/v1/, `${slug} ${lang}: the OpenAI SDK takes /v1`);
      }
    }
  });
});
