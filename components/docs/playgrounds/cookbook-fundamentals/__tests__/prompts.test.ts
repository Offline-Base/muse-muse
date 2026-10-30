/**
 * Every cookbook-fundamentals page has a demo, and its copy prompt is what the docs promise: built by
 * buildAgentPrompt for each language, under the length limit with nothing trimmed, no em dashes, naming
 * muse-spark-1.3-contributor (never muse-spark-1.3 itself), with a snippet per language and plain-JSON props. With
 * "Include what I just ran" on, even an agent loop's large recorded request only trims the record: the task, every
 * fact and the starter code stay whole. Every curl snippet is valid shell with a JSON body.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-fundamentals/__tests__/prompts.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { describe, it } from "node:test";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const EM_DASH = String.fromCharCode(0x2014);
const RETIRED = /muse-spark-1\.3(?!-contributor)/;
const LANGUAGES = ["python", "typescript", "curl"] as const;

/**
 * The -d argument of a curl snippet as the shell reads it: single-quoted runs taken literally, a backslash escaping
 * the next character (the '\'' a quote inside the body needs), until the first unquoted space.
 */
function curlDataArg(snippet: string): string {
  const at = snippet.indexOf("-d '");
  assert.ok(at >= 0, "the snippet sends a -d body");
  let out = "";
  let i = at + 3;
  while (i < snippet.length && !/\s/.test(snippet[i])) {
    if (snippet[i] === "'") {
      const end = snippet.indexOf("'", i + 1);
      assert.ok(end > i, "every single quote is closed");
      out += snippet.slice(i + 1, end);
      i = end + 1;
    } else if (snippet[i] === "\\") {
      out += snippet[i + 1] ?? "";
      i += 2;
    } else {
      out += snippet[i];
      i += 1;
    }
  }
  return out;
}

const HAS_BASH = !spawnSync("bash", ["--version"], { encoding: "utf8" }).error;

describe("cookbook-fundamentals demos", async () => {
  const { DEMO_GROUPS, demoFor } = await import("@/lib/docs/demos");
  const { buildAgentPrompt, CODING_AGENTS, PROMPT_MAX_CHARS } = await import("@/lib/docs/agent-prompt");
  const { docsPage } = await import("@/lib/docs/pages");
  const { trimForRecord } = await import("@/lib/docs/client/record");
  const { responsesBody } = await import("@/lib/docs/client/body");
  const { loopTools, migrationTools, ProjectFs } = await import("@/components/docs/playgrounds/cookbook-fundamentals/agent");
  const { PROJECTS } = await import("@/components/docs/playgrounds/cookbook-fundamentals/projects");
  const slugs = DEMO_GROUPS["cookbook-fundamentals"];

  const pageOf = (slug: string) => {
    const page = docsPage(slug)!;
    return { slug, title: page.title, description: page.description, sourceUrl: page.sourceUrl, markdownUrl: page.markdownUrl };
  };

  /**
   * What useDocsRun records for one turn of the agent demos (AgentLoopDemo through useToolLoop): a Responses
   * continuation with the instructions, every tool definition and a file's text as the function_call_output.
   */
  const toolLoopRecord = (migration: boolean) => {
    const project = PROJECTS[migration ? "callback-target" : "agent-loop-target"];
    const fs = new ProjectFs(project.files);
    const run = async () => ({ results: [], passed: 0, failed: 0, loadErrors: [], logs: [], timedOut: false, ms: 0 });
    const tools = (migration ? migrationTools(fs, run, () => []) : loopTools(fs, run)).map((t) => t.def);
    const body = {
      ...responsesBody({
        model: "muse-spark-1.3-contributor",
        system:
          "You are a coding agent working in a small JavaScript project. Each turn: think briefly, call exactly one tool, read the result, then decide whether the task is done. Use list_files and read_file to gather context, write_file to change a file, and run_tests to check your work.",
        messages: [{ role: "user", content: project.tasks[0].prompt }],
        tools,
        parallelToolCalls: migration ? undefined : false,
        effort: migration ? "high" : "low",
        summary: migration ? "auto" : null,
        previousResponseId: "resp_6ae467033ba9300372864d28",
      }),
      input: [{ type: "function_call_output", call_id: "call_8c1f2b7a9d", output: Object.values(project.files)[0] }],
    };
    return {
      method: "POST" as const,
      path: "responses",
      body: trimForRecord(body),
      status: 200,
      outcome: 'tool calls: write_file({"path":"src/pagination.js","content":"function paginate(items, pageSize) {..."})',
    };
  };

  const smallRecord = {
    method: "POST" as const,
    path: "chat/completions",
    body: { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "In two sentences, what is the Meta Model API?" }], reasoning_effort: "minimal" },
    status: 200,
    outcome: "content: The Meta Model API is Meta's hosted API for its Muse models.",
  };

  it("covers every page in the group", () => {
    assert.equal(slugs.length, 17);
    for (const slug of slugs) assert.ok(demoFor(slug), `${slug} has a demo`);
  });

  for (const slug of slugs) {
    it(`${slug}: title, blurb, JSON props and a prompt that fits`, () => {
      const spec = demoFor(slug)!;
      const page = docsPage(slug)!;
      assert.ok(spec.title.length > 10 && spec.title.length < 80, spec.title);
      assert.ok(spec.blurb && spec.blurb.length < 400, `${slug} blurb length ${spec.blurb?.length}`);
      assert.deepEqual(JSON.parse(JSON.stringify(spec.props)), spec.props, "props are plain JSON");
      const text = JSON.stringify([spec.title, spec.blurb, spec.props, spec.agentPrompt]);
      assert.equal(text.includes(EM_DASH), false, "no em dash");
      assert.doesNotMatch(JSON.stringify(spec.props), RETIRED, "demos never run muse-spark-1.3");
      const p = spec.agentPrompt;
      assert.ok(p.task.length <= 600, `${slug} task is ${p.task.length} characters`);
      assert.ok((p.facts ?? []).map((f) => `- ${f}`).join("\n").length <= 900, `${slug} facts are too long`);
      assert.ok(p.checklist?.length, "a checklist");
      for (const language of LANGUAGES) {
        const snippet = p.snippets?.[language] ?? "";
        assert.ok(snippet.length > 40, `${slug} has a ${language} snippet`);
        // 1,000 is what buildAgentPrompt keeps of starter code once a large recorded run is included.
        assert.ok(snippet.length <= 1000, `${slug} ${language} snippet is ${snippet.length} characters`);
        assert.doesNotMatch(snippet, RETIRED, `${slug} ${language} snippet uses the Contributor id`);
        const prompt = buildAgentPrompt({ page: pageOf(slug), spec: p, agent: "claude-code", language, lastRequest: null });
        assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${slug} ${language}: ${prompt.length} characters`);
        assert.equal(prompt.includes("(trimmed)"), false, `${slug} ${language}: nothing trimmed`);
        assert.equal(prompt.includes(EM_DASH), false);
        assert.match(prompt, /muse-spark-1\.3-contributor/);
        assert.match(prompt, new RegExp(page.markdownUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });

    it(`${slug}: "Include what I just ran" trims only the record, even for an agent loop's turn`, () => {
      const p = demoFor(slug)!.agentPrompt;
      const records = [
        ["a short chat call", smallRecord],
        ["a basic-loop turn", toolLoopRecord(false)],
        ["a migration turn", toolLoopRecord(true)],
      ] as const;
      // Every agent: Muse Code's introduction is the longest, so it leaves the least room.
      for (const { id: agent } of CODING_AGENTS) {
        for (const language of LANGUAGES) {
          for (const [name, lastRequest] of records) {
            const prompt = buildAgentPrompt({ page: pageOf(slug), spec: p, agent, language, lastRequest });
            const where = `${slug} ${language} for ${agent} with ${name}`;
            assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${where}: ${prompt.length} characters`);
            assert.match(prompt, /What I just ran in the docs/, where);
            assert.ok(prompt.includes(p.task), `${where}: the task is whole`);
            for (const fact of p.facts ?? []) assert.ok(prompt.includes(`- ${fact}`), `${where}: fact kept whole: ${fact.slice(0, 50)}`);
            assert.ok(prompt.includes(p.snippets![language]!.trim()), `${where}: the starter code is whole`);
          }
        }
      }
    });
  }

  it("every curl snippet is valid shell, and its -d body is the JSON the API gets", () => {
    for (const slug of slugs) {
      const snippet = demoFor(slug)!.agentPrompt.snippets!.curl!;
      const body = curlDataArg(snippet);
      assert.doesNotThrow(() => JSON.parse(body), `${slug}: the -d body parses as JSON: ${body.slice(0, 80)}`);
      if (HAS_BASH) {
        const check = spawnSync("bash", ["-n"], { input: snippet, encoding: "utf8" });
        assert.equal(check.status, 0, `${slug}: bash -n says ${check.stderr}`);
      }
    }
    // The apostrophe in "What's" is closed, escaped and reopened, as the kit's codegen writes it.
    const tool = demoFor("cookbook/tool-function-calling")!.agentPrompt.snippets!.curl!;
    assert.match(tool, /What'\\''s the temperature/);
    assert.match(curlDataArg(tool), /"What's the temperature in Paris right now\?"/);
  });
});
