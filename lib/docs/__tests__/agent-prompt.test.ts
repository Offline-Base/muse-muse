/**
 * "Copy prompt for your coding agent": no em dashes, always the page's Markdown URL, the last request only when one
 * is passed, and never longer than PROMPT_MAX_CHARS however big the inputs get.
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/agent-prompt.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentPrompt, CODING_AGENTS, codeForRequest, PROMPT_LANGUAGES, PROMPT_MAX_CHARS, trimBody } from "@/lib/docs/agent-prompt";
import type { AgentPromptSpec } from "@/lib/docs/demos/types";

const page = {
  slug: "tool-calling",
  title: "Tool calling",
  description: "Connect the model to your APIs \u2014 parallel, streamed tool calls.",
  sourceUrl: "https://dev.meta.ai/docs/tool-calling",
  markdownUrl: "https://dev.meta.ai/docs/tool-calling.md",
};

const spec: AgentPromptSpec = {
  task: "Add tool calling to my app with the Responses API \u2014 define get_weather and send the result back.",
  facts: ["Return results as function_call_output items with the call_id.", "Names allow at most one dot."],
  checklist: ["The script prints the model's final answer about the weather."],
  snippets: { python: 'from openai import OpenAI\nclient = OpenAI(base_url="https://api.meta.ai/v1")' },
};

const ran = {
  method: "POST" as const,
  path: "responses",
  body: { model: "muse-spark-1.3-contributor", input: "What's the weather in Paris?", tools: [{ type: "function", name: "get_weather" }] },
  model: "muse-spark-1.3-contributor",
  status: 200,
  outcome: "function_call get_weather {\"location\":\"Paris\"}",
};

describe("buildAgentPrompt", () => {
  it("has no em dash and includes the Markdown URL, for every agent and language", () => {
    for (const agent of CODING_AGENTS) {
      for (const language of PROMPT_LANGUAGES) {
        for (const lastRequest of [null, ran]) {
          for (const s of [spec, null]) {
            const text = buildAgentPrompt({ page, spec: s, agent: agent.id, language: language.id, lastRequest });
            assert.ok(!text.includes("\u2014"), `em dash for ${agent.id}/${language.id}`);
            assert.ok(text.includes(page.markdownUrl), "names the page's Markdown URL");
            assert.ok(text.includes("https://api.meta.ai/v1"));
            assert.ok(text.includes("MODEL_API_KEY"));
            assert.ok(text.length <= PROMPT_MAX_CHARS, `${text.length} characters`);
          }
        }
      }
    }
  });

  it("includes the last request only when one is passed", () => {
    const without = buildAgentPrompt({ page, spec, agent: "codex", language: "python", lastRequest: null });
    const withRun = buildAgentPrompt({ page, spec, agent: "codex", language: "python", lastRequest: ran });
    assert.ok(!without.includes("What I just ran"));
    assert.ok(!without.includes("What's the weather in Paris?"));
    assert.ok(withRun.includes("What I just ran in the docs"));
    assert.ok(withRun.includes("POST /v1/responses returned HTTP 200 on muse-spark-1.3-contributor."));
    assert.ok(withRun.includes("What's the weather in Paris?"));
    assert.ok(withRun.includes("Contributor mode"), "says what contributor mode means");
  });

  it("uses the page's task and snippet, or a generic task from the title and description", () => {
    const fromSpec = buildAgentPrompt({ page, spec, agent: "claude-code", language: "python", lastRequest: null });
    assert.ok(fromSpec.startsWith("You're Claude Code"));
    assert.ok(fromSpec.includes("Add tool calling to my app with the Responses API, define get_weather"));
    assert.ok(fromSpec.includes("Starter code (Python)\nfrom openai import OpenAI"));
    assert.ok(fromSpec.includes("Names allow at most one dot."));
    assert.ok(fromSpec.includes("The script prints the model's final answer about the weather."));

    const generic = buildAgentPrompt({ page, spec: null, agent: "other", language: "typescript", lastRequest: null });
    assert.ok(generic.includes('Use Meta Model API to apply "Tool calling" in this project. Connect the model to your APIs, parallel, streamed tool calls.'));
    assert.ok(generic.includes("Start from the page's TypeScript example"));
    assert.ok(generic.includes("Model: muse-spark-1.3"));
  });

  it("writes starter code from the last request when the page has none for the language", () => {
    const ts = buildAgentPrompt({ page, spec, agent: "cursor", language: "typescript", lastRequest: ran });
    assert.ok(ts.includes('const response = await fetch("https://api.meta.ai/v1/responses", {'));
    assert.ok(ts.includes("Authorization: `Bearer ${process.env.MODEL_API_KEY}`"));
  });

  it("stays under the cap with huge inputs and trims the body of the last request", () => {
    const huge = {
      ...ran,
      body: { model: "m", input: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(2_000_000)}` }], text: "x".repeat(50_000) },
      outcome: "y".repeat(20_000),
    };
    const bigSpec: AgentPromptSpec = {
      task: "t".repeat(5000),
      facts: Array.from({ length: 80 }, (_, i) => `Fact ${i} ${"f".repeat(80)}`),
      checklist: ["c"],
      snippets: { curl: "line\n".repeat(3000) },
    };
    const text = buildAgentPrompt({ page, spec: bigSpec, agent: "muse-code", language: "curl", lastRequest: huge });
    assert.ok(text.length <= PROMPT_MAX_CHARS, `${text.length} characters`);
    assert.ok(text.includes(page.markdownUrl));
    assert.ok(!text.includes("AAAAAAAAAAAAAAAAAAAA"), "the data URL is summarized, not pasted");
  });
});

describe("the model and the page's kind", () => {
  const pageOf = (slug: string, title: string, description: string) => ({
    slug,
    title,
    description,
    sourceUrl: `https://dev.meta.ai/docs/${slug}`,
    markdownUrl: `https://dev.meta.ai/docs/${slug}.md`,
  });

  it("names muse-spark-1.3 for the reader's own code, though the docs ran its Contributor stand-in", () => {
    // What the Run panel records: the body as sent (already swapped) and the model the proxy reports.
    for (const lastRequest of [
      { ...ran, body: { ...ran.body, model: "muse-spark-1.3-contributor" }, model: "muse-spark-1.3-contributor" },
      { ...ran, body: { ...ran.body, model: "muse-spark-1.3" }, model: "muse-spark-1.3-contributor" },
    ]) {
      for (const language of ["python", "typescript", "curl"] as const) {
        const text = buildAgentPrompt({ page, spec: null, agent: "claude-code", language, lastRequest });
        assert.ok(text.includes("Model: muse-spark-1.3\n"), `${language}: Setup names the Standard model`);
        assert.ok(!/Model: muse-spark-1\.3-contributor/.test(text));
        assert.ok(text.includes("The docs ran it on muse-spark-1.3-contributor (Contributor mode, on Muse Muse's key). Use muse-spark-1.3 in my code."));
        const starter = text.slice(text.indexOf("Starter code"));
        assert.ok(starter.includes('"model": "muse-spark-1.3"'), `${language}: the starter code sends the Standard model`);
        assert.ok(!starter.includes("muse-spark-1.3-contributor"), `${language}: and never the Contributor one`);
      }
    }
    // A Contributor model the reader picked on purpose stays, with what Contributor mode means.
    const picked = { ...ran, body: { ...ran.body, model: "muse-spark-1.2-contributor" }, model: "muse-spark-1.2-contributor" };
    const text = buildAgentPrompt({ page, spec: null, agent: "codex", language: "python", lastRequest: picked });
    assert.match(text, /Model: muse-spark-1\.2-contributor \(Contributor mode/);
    assert.equal(codeForRequest({ method: "POST", path: "responses", body: { model: "muse-spark-1.3-contributor" } }, "curl").includes('"model": "muse-spark-1.3"'), true);
  });

  it("fits the task and the checks to the kind of page when it has no agentPrompt of its own", () => {
    const prompt = (slug: string, title: string, description: string) =>
      buildAgentPrompt({ page: pageOf(slug, title, description), spec: null, agent: "other", language: "python", lastRequest: null });
    const apiCall = "Running it once makes a real call to the API";

    const changelog = prompt("muse-code/changelog", "Changelog", "What's new, improved, and fixed in each Muse Code release.");
    assert.match(changelog, /against the latest release notes on this page/);
    assert.ok(!changelog.includes('apply "Changelog"'));
    assert.ok(!changelog.includes(apiCall));

    const muse = prompt("muse-code/configuration", "Configuration", "Configure Muse Code with settings files.");
    assert.match(muse, /Set up Muse Code in this project as this page describes \("Configuration"\)/);
    assert.match(muse, /muse runs in this project/);
    assert.ok(!muse.includes(apiCall));

    const local = prompt("muse-glimmer/deploy", "Deploy", "Serve Muse Glimmer with vLLM, SGLang or llama.cpp.");
    assert.match(local, /Self-host the open-weight model/);
    assert.match(local, /local OpenAI-compatible endpoint answers/);
    assert.ok(!local.includes(apiCall));

    const index = prompt("cookbook", "Cookbook", "Recipes for building with Muse models.");
    assert.match(index, /Pick the recipe on this page \(Meta's cookbook index\) that fits this project best/);

    const endpoint = prompt("api-reference/responses/create-response", "Create a response", "Generate a model response.");
    assert.match(endpoint, /Call POST \/v1\/responses from this project as this API reference page/);
    assert.match(endpoint, /A real call to POST \/v1\/responses succeeds, and its response has the fields this page lists\./);

    const schemas = prompt("api-reference/responses/schemas", "Responses schemas", "The full schema definitions.");
    assert.match(schemas, /Type the requests this project sends and the responses it reads/);

    const recipe = prompt("cookbook/streaming-responses", "Streaming responses", "Stream tokens as they generate.");
    assert.match(recipe, /Build the "Streaming responses" recipe from Meta's cookbook in this project/);

    // A description that opens with the title says it once.
    const overview = prompt("overview", "Build with Meta Model API and Muse Code", "Build with Meta Model API and Muse Code: call Muse Wonder for hard tasks.");
    assert.equal(overview.match(/Build with Meta Model API and Muse Code/g)?.length, 2, "once in the task, once in Read this first");
    assert.ok(overview.includes("Build with Meta Model API and Muse Code: call Muse Wonder for hard tasks. Apply it in this project"));

    for (const text of [changelog, muse, local, index, endpoint, schemas, recipe, overview]) {
      assert.ok(!text.includes("\u2014"));
      assert.ok(text.length <= PROMPT_MAX_CHARS);
    }
  });
});

describe("helpers", () => {
  it("trimBody summarizes data URLs and long strings and arrays", () => {
    const out = trimBody({ img: `data:image/jpeg;base64,${"B".repeat(4096)}`, long: "z".repeat(500), list: Array.from({ length: 12 }, (_, i) => i) }) as Record<string, unknown>;
    assert.equal(out.img, "data:image/jpeg;base64,<3 KB of base64, trimmed>");
    assert.match(String(out.long), /^z{120}\.\.\. \(380 more characters\)$/);
    assert.deepEqual(out.list, [0, 1, 2, 3, 4, 5, 6, 7, "... 4 more"]);
  });

  it("codeForRequest writes Python with True/False/None and curl with the key from the environment", () => {
    const req = { method: "POST" as const, path: "chat/completions", body: { stream: false, stop: null, n: 1 } };
    const py = codeForRequest(req, "python");
    assert.ok(py.includes('"stream": False'));
    assert.ok(py.includes('"stop": None'));
    assert.ok(py.includes("requests.post("));
    const curl = codeForRequest({ method: "GET", path: "models" }, "curl");
    assert.equal(curl, 'curl -X GET "https://api.meta.ai/v1/models" \\\n  -H "Authorization: Bearer $MODEL_API_KEY"');
  });
});
