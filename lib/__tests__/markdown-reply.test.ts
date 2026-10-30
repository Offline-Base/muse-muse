import assert from "node:assert/strict";
import { test } from "node:test";
import { closePartialMarkdown, jsonReply, safeHref } from "@/lib/markdown-reply";

test("safeHref allows http, https and mailto only", () => {
  assert.equal(safeHref("https://a.test/x"), "https://a.test/x");
  assert.equal(safeHref(" http://a.test "), "http://a.test");
  assert.equal(safeHref("mailto:a@b.test"), "mailto:a@b.test");
  for (const bad of ["javascript:alert(1)", " JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "/dashboard", "#top", "", null, undefined]) {
    assert.equal(safeHref(bad), null, String(bad));
  }
});

test("jsonReply pretty-prints whole JSON and leaves prose and links alone", () => {
  assert.equal(jsonReply('{"a":1}', false), '{\n  "a": 1\n}');
  assert.equal(jsonReply('[{"a":1}]', false), '[\n  {\n    "a": 1\n  }\n]');
  assert.equal(jsonReply("[a link](https://a.test) says", false), null);
  assert.equal(jsonReply("Here it is: {}", false), null);
  assert.equal(jsonReply('{"broken": ', false), null);
});

test("jsonReply shows JSON that is still arriving as it arrived", () => {
  assert.equal(jsonReply('{"a": 1, "b_c": ', true), '{"a": 1, "b_c":');
  assert.equal(jsonReply("[a link](https", true), null);
});

test("closePartialMarkdown closes the last block's markers and nothing else", () => {
  assert.equal(closePartialMarkdown("a **b"), "a **b**");
  assert.equal(closePartialMarkdown("a **b** c"), "a **b** c");
  assert.equal(closePartialMarkdown("a `b"), "a `b`");
  assert.equal(closePartialMarkdown("a **"), "a ");
  assert.equal(closePartialMarkdown("a `**` b"), "a `**` b");
  assert.equal(closePartialMarkdown("**a\n\nb"), "**a\n\nb");
});

test("closePartialMarkdown leaves an open code fence to the parser", () => {
  assert.equal(closePartialMarkdown("```js\nconst a = `b"), "```js\nconst a = `b");
  assert.equal(closePartialMarkdown("```js\ncode\n```\n\nnow **bold"), "```js\ncode\n```\n\nnow **bold**");
});
