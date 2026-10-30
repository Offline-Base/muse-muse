/**
 * The kit's components server-rendered with react-dom/server, outside Next: the Contributor notice and model menu,
 * Run and Stop, usage and cost, error explanations, the code view, the JSON editor and tree, the response view and
 * the stream view. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/kit/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import type { DocsResult } from "@/lib/docs/client/api";
import { collectReply } from "@/lib/docs/client/stream";

let render: (c: ComponentType<never>, props: object) => string;
let kit: typeof import("@/components/docs/kit");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  kit = await import("@/components/docs/kit");
});

const NOTICE = "Runs on Muse Spark 1.3 Contributor: Meta may use what you send to train future models. Don&#x27;t send anything private.";

/** Every render: no em dash, and nothing that looks like a key. */
function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY/, "no key-like strings");
  return html;
}

const C = <T,>(c: T) => c as unknown as ComponentType<never>;

function result(over: Partial<DocsResult> = {}): DocsResult {
  return {
    ok: true,
    status: 200,
    json: null,
    text: "",
    blob: null,
    headers: { "content-type": "application/json", "x-docs-model": "muse-spark-1.3-contributor", "x-request-id": "req_123" },
    error: null,
    model: "muse-spark-1.3-contributor",
    note: null,
    elapsedMs: 1432,
    ...over,
  };
}

describe("ContributorNotice and ModelSelect", () => {
  it("shows the contract's notice for Contributor models only, Spark 1.3 included", () => {
    assert.match(clean(render(C(kit.ContributorNotice), { model: "muse-spark-1.3-contributor" })), new RegExp(`role="note".*${NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(render(C(kit.ContributorNotice), { model: "muse-spark-1.3" }), /Runs on Muse Spark 1\.3 Contributor:/);
    assert.match(render(C(kit.ContributorNotice), { model: "muse-spark-1.2-contributor" }), /Runs on Muse Spark 1\.2 Contributor:/);
    assert.equal(render(C(kit.ContributorNotice), { model: "muse-spark-1.2" }), "");
    assert.equal(render(C(kit.ContributorNotice), { model: "muse-wonder-1.0" }), "");
    assert.equal(kit.contributorNoticeText("Muse Spark 1.3 Contributor"), NOTICE.replace("&#x27;", "'"));
  });

  it("groups text models by mode, picks Contributor by default, and offers Standard under the notice", () => {
    const html = clean(render(C(kit.ModelSelect), { kind: "text", value: kit.DEFAULT_TEXT_MODEL, onChange() {} }));
    assert.match(html, /<label class="pg-label" for="([^"]+)">Model<\/label>.*<select id="\1" class="select pg-select">/);
    assert.match(html, /<optgroup label="Contributor mode"><option value="muse-spark-1\.3-contributor" selected="">Muse Spark 1\.3 Contributor<\/option><option value="muse-spark-1\.2-contributor">Muse Spark 1\.2 Contributor<\/option><\/optgroup>/);
    assert.match(html, /<optgroup label="Standard mode"><option value="muse-spark-1\.2">Muse Spark 1\.2<\/option><option value="muse-wonder-1\.0">Muse Wonder 1\.0<\/option><option value="muse-spark-1\.1">Muse Spark 1\.1<\/option><\/optgroup>/);
    assert.match(html, /For Standard mode, pick Muse Spark 1\.2, Muse Wonder 1\.0 or Muse Spark 1\.1 in the model menu\./, "the menu's Standard models, in its order");
    assert.doesNotMatch(html, /value="muse-spark-1\.3"/, "Muse Spark 1.3 itself is never offered");
  });

  it("names only the Standard models the menu offers, and nothing without a menu", () => {
    const sparkOnly = clean(render(C(kit.ModelSelect), { kind: "text", value: kit.DEFAULT_TEXT_MODEL, allow: ["muse-spark-1.3-contributor", "muse-spark-1.2"], onChange() {} }));
    assert.match(sparkOnly, /For Standard mode, pick Muse Spark 1\.2 in the model menu\./);
    assert.doesNotMatch(sparkOnly, /pick[^.]*Muse Wonder/, "no Muse Wonder where the menu has none");
    const contributorOnly = render(C(kit.ModelSelect), { kind: "text", value: kit.DEFAULT_TEXT_MODEL, allow: ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"], onChange() {} });
    assert.match(contributorOnly, new RegExp(NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(contributorOnly, /For Standard mode/, "no hint when the menu has no Standard model");
    assert.doesNotMatch(render(C(kit.ContributorNotice), { model: "muse-spark-1.3-contributor" }), /For Standard mode/, "no menu, no hint");
    assert.match(render(C(kit.ContributorNotice), { model: "muse-spark-1.3-contributor", menu: ["muse-wonder-1.0", "muse-spark-1.3-contributor"] }), /For Standard mode, pick Muse Wonder 1\.0 in the model menu\./);
    assert.equal(kit.standardHintText(["muse-spark-1.3", "muse-spark-1.2-contributor"]), null, "muse-spark-1.3 runs as Contributor, so it isn't a Standard choice");
    assert.equal(kit.standardHintText(["muse-spark-1.2", "muse-spark-1.1", "muse-spark-1.2"]), "For Standard mode, pick Muse Spark 1.2 or Muse Spark 1.1 in the model menu.");
  });

  it("shows muse-spark-1.3 as the Contributor model it runs as, and hides the notice for Standard", () => {
    assert.match(render(C(kit.ModelSelect), { kind: "text", value: "muse-spark-1.3", onChange() {} }), /<option value="muse-spark-1\.3-contributor" selected="">/);
    assert.doesNotMatch(render(C(kit.ModelSelect), { kind: "text", value: "muse-spark-1.2", onChange() {} }), /pg-notice/);
  });

  it("limits the menu with allow, and shows a single-model kind as text", () => {
    const allowed = render(C(kit.ModelSelect), { kind: "text", value: "muse-spark-1.2", allow: ["muse-spark-1.2", "muse-wonder-1.0"], onChange() {} });
    assert.equal((allowed.match(/<option /g) ?? []).length, 2);
    assert.doesNotMatch(allowed, /optgroup/);
    const image = clean(render(C(kit.ModelSelect), { kind: "image", value: "muse-image-1.0", onChange() {} }));
    assert.match(image, /<span class="pg-model-fixed">Muse Image 1\.0<\/span>/);
    assert.doesNotMatch(image, /<select/);
  });
});

describe("RunButton", () => {
  it("is a blue Run pill, Running while busy without Stop, and Stop with it", () => {
    assert.match(render(C(kit.RunButton), { running: false, onRun() {} }), /<button type="button" class="btn btn-primary pg-run">.*<span>Run<\/span><\/button>/);
    assert.match(render(C(kit.RunButton), { running: true, onRun() {} }), /disabled="".*aria-busy="true".*class="spinner".*<span>Running<\/span>/);
    assert.match(render(C(kit.RunButton), { running: true, onRun() {}, onStop() {} }), /class="btn btn-outline pg-run pg-stop".*<span>Stop<\/span>/);
    assert.match(render(C(kit.RunButton), { running: false, onRun() {}, label: "Send", disabled: true }), /disabled="".*<span>Send<\/span>/);
  });
});

describe("UsageLine", () => {
  it("shows tokens and an estimated cost from any usage shape", () => {
    const html = clean(
      render(C(kit.UsageLine), {
        model: "muse-spark-1.3-contributor",
        usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1792 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 } },
      }),
    );
    // At the Contributor rates (cached input $0.002 per million) this comes to about $0.00008.
    assert.match(html, /2,000 in, 1,792 cached · 300 out, 250 reasoning · under \$0\.0001 est\./);
    assert.match(render(C(kit.UsageLine), { model: "muse-spark-1.2", usage: { prompt_tokens: 25, completion_tokens: 19 } }), /25 in · 19 out · /);
    assert.match(render(C(kit.UsageLine), { model: "muse-image-1.0", usage: { input_tokens: 9, output_tokens: 9 }, images: 2 }), /2 images · \$0\.02 est\./);
    assert.equal(render(C(kit.UsageLine), { model: "m", usage: null }), "");
  });
});

describe("ErrorBox", () => {
  it("explains a rate limit and counts down retry-after", () => {
    const html = clean(render(C(kit.ErrorBox), { error: { type: "rate_limit_error", code: "rate_limited", message: "Live demos are limited to 20 runs a minute. Try again in 12 s.", retryAfterSec: 12 } }));
    assert.match(html, /role="alert"/);
    assert.match(html, /<p class="pg-error-title">Too many runs at once<\/p>/);
    assert.match(html, /Live demos are limited to 20 runs a minute\. Try again in 12 s\./);
    assert.match(html, /You can try again in 12 s\./);
  });

  it("explains budgets and pauses, and shows nothing for a stopped run", () => {
    assert.match(render(C(kit.ErrorBox), { error: { type: "insufficient_quota", code: "budget_exceeded", message: "This visitor used today's $2.00." } }), /Today&#x27;s live demo budget is used up/);
    assert.match(render(C(kit.ErrorBox), { error: { code: "docs_paused", message: "Paused." } }), /Live demos are paused/);
    assert.equal(render(C(kit.ErrorBox), { error: { code: "aborted", message: "Stopped." } }), "");
    assert.equal(render(C(kit.ErrorBox), { error: null }), "");
  });
});

describe("CodeView", () => {
  /** The code as text, without the color spans. */
  const codeText = (html: string) => (html.match(/<code>([\s\S]*?)<\/code><\/pre>/)?.[1] ?? "").replace(/<[^>]+>/g, "");

  it("opens on curl with tabs for Python and TypeScript, a copy button, and the key from the environment", () => {
    const html = clean(render(C(kit.CodeView), { method: "POST", path: "responses", body: { model: "muse-spark-1.2", input: "Hi" } }));
    assert.match(html, /role="tablist" aria-label="Language">.*>curl<\/span><\/button>.*>Python<\/span><\/button>.*>TypeScript<\/span><\/button>/);
    // The tabs sit inside the block's frame, like the mirrored code groups, with the syntax in its header.
    assert.match(html, /<div class="docs-code docs-code-grouped pg-codeview-block"><div class="docs-tabs" role="tablist"/);
    assert.match(html, /<span class="docs-code-label">bash<\/span>/);
    assert.match(codeText(html), /curl -X POST &quot;https:\/\/api\.meta\.ai\/v1\/responses&quot;/);
    assert.match(codeText(html), /Bearer \$MODEL_API_KEY/);
    assert.match(html, /aria-label="Copy the curl code"|title="Copy the curl code"/);
    assert.match(html, /Set <code>MODEL_API_KEY<\/code> to your own Model API key/);
  });

  it("colors the code with the docs' syntax colors", () => {
    const html = render(C(kit.CodeView), { method: "POST", path: "responses", body: { model: "muse-spark-1.2", input: "Hi", stream: false } });
    assert.match(html, /<span class="pg-tok pg-tok-string">&quot;https:\/\/api\.meta\.ai\/v1\/responses&quot;<\/span>/);
    assert.match(html, /<span class="pg-tok pg-tok-string">&#x27;\{/, "the JSON body is one shell string, as on the mirrored blocks");
  });

  it("never hands out muse-spark-1.3: the code calls muse-spark-1.3-contributor and says what that means", () => {
    for (const model of ["muse-spark-1.3", "muse-spark-1.3-contributor"]) {
      const html = render(C(kit.CodeView), { method: "POST", path: "responses", body: { model, input: "Hi" } });
      assert.match(codeText(html), /&quot;model&quot;: &quot;muse-spark-1\.3-contributor&quot;/);
      assert.doesNotMatch(codeText(html), /&quot;muse-spark-1\.3&quot;/);
      assert.match(html, /This code uses Contributor mode: Meta may use what you send to train future models\. Drop -contributor from the model for Standard mode\./);
    }
    // Standard models stay as they are, with no Contributor note.
    const plain = render(C(kit.CodeView), { method: "POST", path: "responses", body: { model: "muse-spark-1.2", input: "Hi" } });
    assert.match(codeText(plain), /muse-spark-1\.2/);
    assert.doesNotMatch(plain, /Contributor mode/);
  });

  it("shortens base64 in the code and says so", () => {
    const html = render(C(kit.CodeView), {
      method: "POST",
      path: "responses",
      body: { model: "m", input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(3000)}` }] }] },
    });
    assert.match(html, /data:image\/png;base64,&lt;BASE64&gt;/);
    assert.match(html, /Long base64 values are shortened/);
    assert.doesNotMatch(html, /A{200}/);
  });
});

describe("JsonEditor and JsonTree", () => {
  it("says when the body is valid and where it breaks", () => {
    assert.match(render(C(kit.JsonEditor), { id: "b", value: '{"a": 1}', onChange() {} }), /aria-invalid="false".*Valid JSON/);
    const bad = render(C(kit.JsonEditor), { id: "b", value: '{\n  "a": }', onChange() {}, resetTo: '{"a": 1}' });
    assert.match(bad, /aria-invalid="true"/);
    assert.match(bad, /Line 2, column \d+: Unexpected token/);
    assert.match(bad, />Reset<\/button>/);
    assert.match(bad, /<button type="button" class="btn btn-sm btn-outline" disabled="">Format<\/button>/);
  });

  it("colors values, folds deep nodes and shortens base64", () => {
    const html = clean(render(C(kit.JsonTree), { value: { id: "resp_1", n: 3, ok: true, none: null, a: { b: { c: { d: 1 } } }, image: "Q".repeat(5000) } }));
    assert.match(html, /<span class="pg-json-key">&quot;id&quot;<\/span><span class="pg-json-punct">: <\/span><span class="pg-json-str">&quot;resp_1&quot;<\/span>/);
    assert.match(html, /<span class="pg-json-num">3<\/span>/);
    assert.match(html, /<span class="pg-json-bool">true<\/span>/);
    assert.match(html, /<span class="pg-json-null">null<\/span>/);
    assert.match(html, /\(4 KB of base64\)/);
    assert.doesNotMatch(html, /Q{200}/);
    const opens = (html.match(/<details class="pg-json-node" open=""/g) ?? []).length;
    const all = (html.match(/<details class="pg-json-node"/g) ?? []).length;
    assert.equal(all, 4);
    assert.equal(opens, 3, "the node at depth 3 starts folded");
  });

  it("names a folded object by its id, name or type, so a list of models reads at a glance", async () => {
    const models = { object: "list", data: [{ id: "muse-spark-1.3", object: "model", created: 1, owned_by: "meta" }, { name: "x" }, { a: 1 }] };
    const html = render(C(kit.JsonTree), { value: models, openDepth: 2 });
    assert.match(
      html,
      /<span class="pg-json-fold"> <span class="pg-json-key">id<\/span><span class="pg-json-punct">: <\/span><span class="pg-json-str">&quot;muse-spark-1\.3&quot;<\/span><span class="pg-json-punct">, <\/span>4 keys \}/,
    );
    assert.match(html, /<span class="pg-json-key">name<\/span><span class="pg-json-punct">: <\/span><span class="pg-json-str">&quot;x&quot;/);
    assert.match(html, /<span class="pg-json-fold"> 1 key \}<\/span>/, "an object with no name says only its size");
    const { nameOf } = await import("@/components/docs/kit/JsonTree");
    assert.deepEqual(nameOf({ type: "message", id: 7 }), ["id", 7], "id first");
    assert.deepEqual(nameOf({ type: "message", content: [] }), ["type", "message"]);
    assert.equal(nameOf({ id: "x".repeat(61) }), null, "a long value would crowd the summary");
  });
});

describe("ResponseView", () => {
  const body = {
    id: "resp_abc123",
    object: "response",
    status: "completed",
    model: "muse-spark-1.3-contributor",
    output: [{ type: "message", content: [{ type: "output_text", text: "The capital of France is **Paris**.", annotations: [] }] }],
    usage: { input_tokens: 69, output_tokens: 163, total_tokens: 232 },
  };

  it("shows the status, the model that ran, latency, usage, the proxy's note and the three tabs", () => {
    const html = clean(render(C(kit.ResponseView), { result: result({ json: body, note: "max_output_tokens set to 16,384 for the live demo." }) }));
    assert.match(html, /<span class="pg-status pg-status-ok">.*200 OK<\/span>/);
    assert.match(html, /<span class="pg-meta">Muse Spark 1\.3 Contributor<\/span><span class="pg-meta">1\.4 s<\/span>/);
    // 69 in and 163 out on Contributor rates is $0.00004.
    assert.match(html, /69 in · 163 out · under \$0\.0001 est\./);
    assert.match(html, /max_output_tokens set to 16,384 for the live demo\./);
    assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>Output<\/button>.*>JSON<\/button>.*>Headers<span class="pg-tab-count">3<\/span><\/button>/);
    assert.match(html, /The capital of France is \*\*Paris\*\*\./);
  });

  it("explains failures, runs and stops", () => {
    const failed = render(C(kit.ResponseView), { result: result({ ok: false, status: 429, error: { message: "Slow down" } }) });
    assert.match(failed, /pg-status-bad.*429 Too Many Requests/);
    assert.match(render(C(kit.ResponseView), { result: null, running: true, elapsedMs: 800 }), /Running.*800 ms/);
    assert.match(render(C(kit.ResponseView), { result: result({ ok: false, status: 0, error: { code: "aborted", message: "x" } }) }), /Stopped/);
    assert.equal(render(C(kit.ResponseView), { result: null }), "");
  });

  it("shows a transcript and images from replies that aren't text protocols", () => {
    assert.match(render(C(kit.ResponseView), { result: result({ json: { sessionId: "s", transcript: "Hello world​", audioDurationMs: 2000, turns: [] }, model: "muse-voice-transcribe-1.0" }) }), /<div class="pg-stream-text">Hello world<\/div>/);
    assert.match(render(C(kit.ResponseView), { result: result({ json: { data: [{ b64_json: "UklGRgAAAA" }] }, model: "muse-image-1.0" }) }), /<img src="data:image\/webp;base64,UklGRgAAAA" alt="Generated image 1"\/>/);
  });
});

describe("StreamView and ReplyView", () => {
  it("renders text as text, never HTML, with the reasoning summary, sources and tool calls", () => {
    const reply = collectReply("responses", {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Checked two sources." }] },
        { type: "web_search_call", id: "ws_1", status: "completed", action: { query: "F1 winner" } },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "<script>alert(1)</script> Leclerc won.",
              annotations: [{ type: "url_citation", url: "https://en.wikipedia.org/wiki/2026_British_Grand_Prix", title: "2026 British Grand Prix", start_index: 0, end_index: 10 }],
            },
          ],
        },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"location":"Seattle"}' },
      ],
    });
    const html = clean(render(C(kit.ReplyView), { reply }));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Leclerc won\./);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /<summary>Reasoning summary<\/summary><p class="pg-reasoning-text">Checked two sources\.<\/p>/);
    assert.match(html, /Web search: <q>F1 winner<\/q>/);
    assert.match(html, /<a href="https:\/\/en\.wikipedia\.org\/wiki\/2026_British_Grand_Prix" target="_blank" rel="noopener noreferrer">2026 British Grand Prix<\/a><span class="pg-citation-host">en\.wikipedia\.org<\/span>/);
    assert.match(html, /<code class="pg-toolcall-name">get_weather<\/code>/);
    assert.match(html, /&quot;location&quot;: &quot;Seattle&quot;/);
  });

  it("shows a caret and a wait note while the first words are coming", () => {
    const html = render(C(kit.StreamView), { text: "", running: true });
    assert.match(html, /aria-busy="true"><span class="pg-caret" aria-hidden="true"><\/span>/);
    assert.match(html, /The model reasons before it writes/);
    assert.match(render(C(kit.StreamView), { text: "", running: false }), /The answer appears here\./);
  });
});
