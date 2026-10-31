import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "@/components/markdown/MarkdownText";

const html = (text: string, props: { streaming?: boolean; links?: boolean; docsLinks?: boolean } = {}) =>
  renderToStaticMarkup(<MarkdownText text={text} {...props} />);

test("the common Markdown a model writes renders as elements", () => {
  const out = html(
    [
      "# Title",
      "",
      "Some **bold**, *italic*, ~~gone~~ and `code`.",
      "",
      "- one",
      "- two",
      "",
      "3. three",
      "4. four",
      "",
      "> a quote",
      "",
      "---",
      "",
      "| A | B |",
      "|---|:-:|",
      "| 1 | 2 |",
    ].join("\n"),
  );
  assert.match(out, /<h3>Title<\/h3>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<del>gone<\/del>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<ul><li>.*one.*<\/li><li>.*two.*<\/li><\/ul>/);
  assert.match(out, /<ol start="3">/);
  assert.match(out, /<blockquote>/);
  assert.match(out, /<hr\/>/);
  assert.match(out, /<th>A<\/th>/);
  assert.match(out, /<td style="text-align:center">2<\/td>/);
});

test("a fenced block shows its language and its code exactly, with a copy button", () => {
  const out = html("```python\nprint(1 < 2 and '**x**')\n```");
  assert.match(out, /<span>python<\/span>/);
  assert.match(out, /print\(1 &lt; 2 and &#x27;\*\*x\*\*&#x27;\)/);
  assert.doesNotMatch(out, /<strong>/);
  assert.match(out, /Copy the code/);
});

test("a single newline stays a line break", () => {
  assert.match(html("first\nsecond"), /first<br\/>second/);
});

test("entities read as the characters they stand for, without becoming markup", () => {
  const out = html("AT&amp;T &lt;img src=x onerror=alert(1)&gt;");
  assert.match(out, /AT&amp;T/);
  assert.doesNotMatch(out, /<img/);
});

test("raw HTML from a model stays text", () => {
  for (const attack of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<iframe src=https://evil.test></iframe>", "text <b onclick=alert(1)>bold</b>"]) {
    const out = html(attack);
    assert.doesNotMatch(out, /<(script|img|iframe|b)\b/, attack);
    assert.match(out, /&lt;/, attack);
  }
});

test("only http, https and mailto links open, and they open safely", () => {
  const good = html("[site](https://example.com/a?b=1)");
  assert.match(good, /<a href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener noreferrer nofollow">site<\/a>/);
  assert.match(html("[mail](mailto:a@example.com)"), /href="mailto:a@example.com"/);
  for (const bad of ["[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](data:text/html,hi)", "[x](/dashboard)", "[x](//evil.test)"]) {
    assert.doesNotMatch(html(bad), /<a /, bad);
  }
});

test("an image never loads: it becomes a link, or text when its URL isn't safe", () => {
  const out = html("![a cat](https://evil.test/p.png?secret=1)");
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /<a href="https:\/\/evil.test\/p.png\?secret=1"[^>]*>Image: a cat<\/a>/);
  assert.doesNotMatch(html("![a cat](javascript:alert(1))"), /<a |<img/);
});

test("links: false keeps every link and image as its text", () => {
  const out = html("[site](https://example.com) and ![pic](https://example.com/a.png) and https://example.com", { links: false });
  assert.doesNotMatch(out, /<a |<img/);
  assert.match(out, /site/);
});

test("a JSON reply is code, so its underscores and asterisks are never emphasis", () => {
  const out = html('{"first_name":"a_b_c","note":"**not bold**"}');
  assert.match(out, /<span>json<\/span>/);
  assert.match(out, /&quot;first_name&quot;: &quot;a_b_c&quot;/);
  assert.doesNotMatch(out, /<strong>|<em>/);
});

test("a task list shows disabled checkboxes", () => {
  const out = html("- [x] done\n- [ ] not yet");
  assert.match(out, /<input type="checkbox"[^>]*disabled=""[^>]*aria-label="Done" checked=""\/>/);
  assert.match(out, /aria-label="Not done"\/>/);
  assert.match(out, /done/);
});

test("while streaming, an unfinished reply still reads well", () => {
  assert.match(html("Total: **Sum", { streaming: true }), /<strong>Sum<\/strong>/);
  assert.match(html("run `npm", { streaming: true }), /<code>npm<\/code>/);
  assert.match(html("```js\nconst a = 1", { streaming: true }), /const a = 1/);
  assert.match(html("", { streaming: true }), /data-streaming="true"/);
  assert.doesNotMatch(html("Total: **Sum"), /<strong>/);
});

test("a huge reply stays plain text instead of stalling the tab", () => {
  const out = html(`**${"x".repeat(200_001)}**`);
  assert.match(out, /md-plain/);
  assert.doesNotMatch(out, /<strong>/);
});

test("an empty reply renders nothing inside the wrapper", () => {
  assert.equal(html(""), '<div class="md"></div>');
});

test("docsLinks opens docs pages in place, and nothing else that's relative", () => {
  assert.match(html("[Tool calling](/docs/tool-calling#strict)", { docsLinks: true }), /<a href="\/docs\/tool-calling#strict">Tool calling<\/a>/);
  assert.doesNotMatch(html("[Tool calling](/docs/tool-calling)"), /<a /);
  for (const bad of ["/dashboard", "/docs/../admin", "//evil.test/docs/x", "/api/docs/ask"]) {
    assert.doesNotMatch(html(`[x](${bad})`, { docsLinks: true }), /<a /, bad);
  }
});
