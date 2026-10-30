/**
 * Docs code highlighting: CSS-variable colors in the dev.meta.ai scheme, and plain text for fences shiki doesn't load.
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/highlight.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grammarFor, highlightCode, plainCodeHtml } from "@/lib/docs/highlight";

const colored = (html: string, token: string) => new RegExp(`color:var\\(--docs-syn-${token}\\)">[^<]*`, "g").test(html);

describe("highlightCode", () => {
  it("colors JSON keys, strings and numbers with the docs variables", async () => {
    const html = await highlightCode('{"model": "muse-spark-1.3", "n": 2, "ok": true}', "json");
    assert.match(html, /^<pre class="shiki docs"/);
    assert.ok(html.includes('color:var(--docs-syn-property)">"model"'));
    assert.ok(html.includes('color:var(--docs-syn-string)"> "muse-spark-1.3"'));
    assert.ok(html.includes('color:var(--docs-syn-number)"> 2'));
    assert.ok(colored(html, "number"));
  });

  it("keeps shell commands plain and colors pipes, strings and comments", async () => {
    const html = await highlightCode('curl -fsSL https://dev.meta.ai/install.sh | sh  # install\nexport K="v"', "bash");
    assert.ok(html.includes('color:var(--docs-syn-fg)">curl'));
    assert.ok(html.includes('color:var(--docs-syn-operator)"> |'));
    assert.ok(html.includes('color:var(--docs-syn-comment)"># install'));
    assert.ok(html.includes('color:var(--docs-syn-string)">"v"'));
  });

  it("colors Python and TypeScript like dev.meta.ai: blue keywords, gray punctuation, class names as types", async () => {
    const py = await highlightCode('from openai import OpenAI\n\nclient = OpenAI(base_url="https://api.meta.ai/v1")\nprint(client.models.list())', "python");
    assert.ok(py.includes('color:var(--docs-syn-keyword)">import'));
    assert.ok(py.includes('color:var(--docs-syn-type)">OpenAI'), "the imported class");
    assert.equal(py.match(/color:var\(--docs-syn-type\)">OpenAI</g)?.length, 2, "and the constructor call");
    assert.ok(py.includes('color:var(--docs-syn-punct-code)">('));
    assert.ok(py.includes('color:var(--docs-syn-punct-code)">.'));
    assert.ok(py.includes('color:var(--docs-syn-string)">"https://api.meta.ai/v1"'), "quotes keep the string color");
    assert.ok(py.includes('color:var(--docs-syn-function)">list'));
    const ts = await highlightCode("const r = await client.responses.create({ model: 'muse-spark-1.3' });\nconsole.log(JSON.stringify(r));", "typescript");
    assert.ok(ts.includes('color:var(--docs-syn-property)"> model'));
    assert.ok(ts.includes('color:var(--docs-syn-punct-code)">:'), "an object's colon is punctuation, not an operator");
    assert.ok(ts.includes('color:var(--docs-syn-string)"> \'muse-spark-1.3\''));
    assert.ok(!ts.includes('color:var(--docs-syn-type)">JSON'), "all-caps names stay as they are");
    // JSON keeps its dark punctuation.
    const json = await highlightCode('{"a": [1]}', "json");
    assert.ok(json.includes('color:var(--docs-syn-punct)">{'));
    assert.ok(!json.includes("punct-code"));
  });

  it("shows other fences as escaped plain text in the same markup", async () => {
    assert.equal(grammarFor("text"), null);
    assert.equal(grammarFor("Shell"), "shellscript");
    const html = await highlightCode("a <b> & c\nnext", "text");
    assert.equal(html, plainCodeHtml("a <b> & c\nnext"));
    assert.equal(html, '<pre class="shiki docs" tabindex="0"><code><span class="line">a &lt;b&gt; &amp; c</span>\n<span class="line">next</span></code></pre>');
  });
});
