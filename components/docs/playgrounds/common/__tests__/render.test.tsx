/**
 * The text playgrounds server-rendered with their JSON props, the way a DemoSpec mounts them: the controls each one
 * shows before anything runs, the Contributor notice, the request the code view would copy, and the page context the
 * Ask panel reads its starter questions from. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/common/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";

let html: (el: ReactElement) => string;
let pg: typeof import("@/components/docs/playgrounds/common");
let ctx: typeof import("@/components/docs/kit/DocsPageContext");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (el) => clean(renderToString(el).replace(/<!-- -->/g, ""));
  pg = await import("@/components/docs/playgrounds/common");
  ctx = await import("@/components/docs/kit/DocsPageContext");
});

function clean(out: string) {
  assert.equal(out.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY/, "no key-like strings");
  return out;
}

const el = <P extends object>(c: ComponentType<P>, props: P) => createElement(c as ComponentType<object>, props);
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

describe("ChatPlayground", () => {
  it("starts on Contributor with low effort and streaming, the protocol switch, presets and the prompt", () => {
    const out = html(
      el(pg.ChatPlayground, {
        slug: "protocols",
        protocols: ["responses", "chat", "messages"],
        prompt: "What is the capital of France?",
        presets: [{ label: "Population", prompt: "What is the population of Paris?" }],
      }),
    );
    assert.match(out, /role="radiogroup" aria-label="Protocol">.*aria-checked="true"[^>]*>Responses<\/button>.*>Chat Completions<\/button>.*>Messages<\/button>/);
    assert.match(out, /<option value="muse-spark-1\.3-contributor" selected="">Muse Spark 1\.3 Contributor<\/option>/);
    assert.match(out, NOTICE);
    assert.match(out, /<option value="low" selected="">Low<\/option>/);
    assert.doesNotMatch(out, /<option value="max"/, "Contributor has no max effort");
    assert.match(out, /role="switch"[^>]*aria-checked="false"[^>]*><\/button><label[^>]*>Reasoning summary<\/label>/);
    assert.match(out, /role="switch"[^>]*aria-checked="true"[^>]*><\/button><label[^>]*>Stream<\/label>/);
    assert.match(out, /aria-pressed="false"[^>]*>Population<\/button>/);
    assert.match(out, /<textarea[^>]*placeholder="Ask something"[^>]*>What is the capital of France\?<\/textarea>/);
    assert.match(out, /<span>Run<\/span>/);
    assert.match(out, />Show code<\/label>/);
    assert.doesNotMatch(out, /pg-response/, "no reply view before a run");
  });

  it("hides the switch for one protocol and the summary toggle off Responses, and takes a Standard model", () => {
    const out = html(el(pg.ChatPlayground, { slug: "x", protocol: "chat", model: "muse-wonder-1.0", effort: "max", showSystem: false }));
    assert.doesNotMatch(out, /aria-label="Protocol"/);
    assert.doesNotMatch(out, /Reasoning summary/);
    assert.doesNotMatch(out, /pg-notice/);
    assert.match(out, /<option value="max" selected="">Max<\/option>/);
    assert.doesNotMatch(out, /Instructions/);
  });
});

describe("AskPagePanel", () => {
  it("suggests three questions from the page's title and asks with a short model menu", () => {
    const page = {
      slug: "tool-calling",
      title: "Tool calling",
      description: "Call your functions.",
      sourceUrl: "https://dev.meta.ai/docs/tool-calling",
      markdownUrl: "https://dev.meta.ai/docs/tool-calling.md",
    };
    const out = html(createElement(ctx.DocsPageProvider, { page, children: el(pg.AskPagePanel, { slug: "tool-calling" }) }));
    assert.match(out, /aria-label="Starter questions"/);
    assert.match(out, />Summarize &quot;Tool calling&quot; in three bullet points\.<\/button>/);
    assert.match(out, />Show me the smallest working request for &quot;Tool calling&quot;\.<\/button>/);
    assert.match(out, />What limits or gotchas does &quot;Tool calling&quot; mention\?<\/button>/);
    assert.equal((out.match(/<option /g) ?? []).length, 3, "Contributor, Spark 1.2 and Wonder");
    assert.match(out, NOTICE);
    assert.match(out, /placeholder="Ask about &quot;Tool calling&quot;"/);
    assert.match(out, /<span>Ask<\/span>/);
    assert.match(out, />Show code<\/label>/);
  });

  it("shows a reader how to build the same thing on the Responses API", async () => {
    const { askCodeBody } = await import("@/components/docs/playgrounds/common/AskPagePanel");
    const body = askCodeBody("muse-spark-1.3-contributor", "https://dev.meta.ai/docs/tool-calling.md", [{ question: "What is it?", answer: "A loop." }], "Does it stream?");
    assert.equal(body.model, "muse-spark-1.3-contributor");
    assert.match(body.instructions, /<the Markdown of https:\/\/dev\.meta\.ai\/docs\/tool-calling\.md>$/);
    assert.deepEqual(body.input, [
      { role: "user", content: "What is it?" },
      { role: "assistant", content: [{ type: "output_text", text: "A loop." }] },
      { role: "user", content: "Does it stream?" },
    ]);
    assert.equal(askCodeBody("m", "u", [], "Hi").input, "Hi");
  });

  it("names the page from its slug outside a docs page", () => {
    const out = html(el(pg.AskPagePanel, { slug: "api-reference/files/upload-file" }));
    assert.match(out, /What does a request to &quot;Upload file&quot; need\?/);
  });
});

describe("ApiConsole", () => {
  it("edits a Responses request: Spark 1.3 shown as Contributor, the model menu, the stream switch", () => {
    const out = html(
      el(pg.ApiConsole, {
        method: "POST",
        path: "responses",
        body: { model: "muse-spark-1.3", input: "What is the capital of France?" },
        title: "POST /v1/responses",
      }),
    );
    assert.match(out, /<span class="pg-method pg-method-post">POST<\/span>/);
    assert.match(out, /<span class="pg-path-prefix" aria-hidden="true">\/v1\/<\/span><input type="text" class="pg-input pg-path-input" id="[^"]+" spellCheck="false" value="responses"\/>/);
    assert.match(out, /&quot;model&quot;: &quot;muse-spark-1\.3-contributor&quot;/, "the editor holds the model that runs");
    assert.match(out, /<option value="muse-spark-1\.3-contributor" selected="">/);
    assert.match(out, NOTICE);
    assert.match(out, /role="switch"[^>]*aria-checked="false"[^>]*><\/button><label[^>]*>Stream the reply<\/label>/);
    assert.match(out, /Valid JSON/);
    assert.match(out, /<span>Send<\/span>/);
  });

  it("offers file pickers for body slots and multipart files, and form fields for the rest", () => {
    const out = html(
      el(pg.ApiConsole, {
        method: "POST",
        path: "asr/transcribe",
        form: [
          { name: "request", value: '{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}' },
          { name: "audio", file: { label: "Audio to upload (recording.wav)", accept: "audio/wav", as: "file" } },
        ],
      }),
    );
    assert.match(out, /<code>request<\/code><\/label><textarea/);
    assert.match(out, /Audio to upload \(recording\.wav\)/);
    assert.match(out, /<input [^>]*type="file" class="sr-only" accept="audio\/wav"/);
    assert.match(out, /Sent as the audio part\./);
    assert.doesNotMatch(out, /Request body/, "a multipart request has no JSON editor");
    assert.match(out, /pg-model-fixed">Muse Voice Transcribe 1\.0|<textarea/);

    const slots = html(
      el(pg.ApiConsole, {
        method: "POST",
        path: "responses",
        body: { model: "muse-spark-1.3-contributor", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/jpeg;base64,<BASE64>" }] }] },
        fileSlots: [{ pointer: "/input/0/content/0/image_url", label: "Image for image_url", accept: "image/*", as: "dataUrl" }],
      }),
    );
    assert.match(slots, /Image for image_url/);
    assert.match(slots, /Goes into the body at \/input\/0\/content\/0\/image_url as a data URL\./);
  });

  it("says when a path isn't one the demos can call, and when it holds an example id", () => {
    assert.match(html(el(pg.ApiConsole, { method: "DELETE", path: "models/muse-spark-1.2" })), /The live demos can&#x27;t send DELETE \/v1\/models\/muse-spark-1\.2\./);
    const retrieve = html(el(pg.ApiConsole, { method: "GET", path: "responses/resp_abc123" }));
    assert.match(retrieve, /This path holds an example id\. Create a response first/);
    assert.match(retrieve, /<span class="pg-method pg-method-get">GET<\/span>/);
    assert.doesNotMatch(retrieve, /Request body/);
  });

  it("leaves the upload hint to a host that offers the upload itself (the Run panel)", () => {
    const hint = /This path holds an example id\. Upload a file \(POST \/v1\/files\)/;
    assert.match(html(el(pg.ApiConsole, { method: "GET", path: "files/file_abc123" })), hint);
    assert.doesNotMatch(html(el(pg.ApiConsole, { method: "GET", path: "files/file_abc123", hideIdHint: true })), hint);
  });
});

const ADDRESS = {
  type: "object",
  properties: { street: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" } },
  required: ["street", "city", "state", "zip"],
};

describe("StructuredOutputPlayground", () => {
  it("loads the first preset and warns when strict mode would reject its schema", () => {
    const out = html(
      el(pg.StructuredOutputPlayground, {
        slug: "structured-output",
        protocols: ["responses", "chat"],
        presets: [
          { label: "Address", name: "Address", schema: ADDRESS, prompt: "Please format this address: 1 Hacker Wy Menlo Park CA 94025" },
          { label: "Strict address", name: "Address", schema: { ...ADDRESS, additionalProperties: false }, prompt: "1 Hacker Way" },
        ],
      }),
    );
    assert.match(out, /aria-label="Schema">.*aria-pressed="true"[^>]*>Address<\/button>.*aria-pressed="false"[^>]*>Strict address<\/button>/);
    assert.match(out, /value="Address"/);
    assert.match(out, /&quot;required&quot;: \[/);
    assert.match(out, /With strict on, the API would reject this schema \(HTTP 400\):/);
    assert.match(out, /needs &quot;additionalProperties&quot;: false\./);
    assert.match(out, /Sent as text\.format with strict: true/);
    assert.match(out, />Please format this address: 1 Hacker Wy Menlo Park CA 94025<\/textarea>/);
    assert.match(out, NOTICE);
  });
});

describe("ToolLoopPlayground", () => {
  it("lists the tools with where their answers come from, and offers Step and Run all", () => {
    const out = html(
      el(pg.ToolLoopPlayground, {
        slug: "tool-calling",
        prompt: "What is the weather in Seattle and Tokyo?",
        tools: ["get_weather", "calculator", { name: "book_table", description: "Book a table.", parameters: { type: "object", properties: {} } }],
        results: { calculator: { result: 42 } },
        protocols: ["responses", "chat"],
      }),
    );
    assert.match(out, /Tools the model can call/);
    assert.match(out, /<code class="pg-toolcall-name">get_weather<\/code><span class="pg-muted"> Return current weather for the given location\.<\/span><span class="pg-badge">mock<\/span>/);
    assert.match(out, /calculator<\/code>.*<span class="pg-badge">fixed result<\/span>/);
    assert.match(out, /book_table<\/code>.*<span class="pg-badge">echoes its arguments<\/span>/);
    assert.match(out, /send_email only pretends/);
    assert.match(out, />Call the model<\/button>/);
    assert.match(out, /<span>Run all<\/span>/);
    assert.match(out, /role="switch"[^>]*aria-checked="true"[^>]*><\/button><label[^>]*>Parallel calls<\/label>/);
    assert.match(out, />What is the weather in Seattle and Tokyo\?<\/textarea>/);
    assert.match(out, NOTICE);
  });
});
