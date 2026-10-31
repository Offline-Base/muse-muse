import assert from "node:assert/strict";
import { test } from "node:test";
import { argumentsProblem, cleanArguments, isPublicHttpUrl, recipientsOf, urlsInInput } from "@/lib/tools/args";
import { findFunction } from "@/lib/tools/catalog";

function problem(slug: string, args: Record<string, unknown>, userInput: string | null = null) {
  const found = findFunction(slug);
  assert.ok(found, slug);
  return argumentsProblem(found.tool, found.fn, args, userInput);
}

const SEND = "GMAIL_SEND_EMAIL";
const PAGE = "FIRECRAWL_SCRAPE";

test("arguments outside the catalog are refused, not dropped: what the spike found", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [PAGE, { url: "https://a.example/x", actions: [{ type: "click" }] }],
    [PAGE, { url: "https://a.example/x", jsonOptions: { prompt: "x" } }],
    ["SLACK_SEND_MESSAGE", { channel: "C1", markdown_text: "hi", blocks: [] }],
    ["SLACK_SEND_MESSAGE", { channel: "C1", markdown_text: "hi", reply_broadcast: true }],
    ["SLACK_SEND_MESSAGE", { channel_id: "C1", markdown_text: "hi" }],
    [SEND, { recipient_email: "a@example.com", to: "b@example.com" }],
    [SEND, { recipient_email: "a@example.com", user_id: "someone@example.com" }],
    ["SERPAPI_SCHOLAR_SEARCH", { query: "x", api_key: "k" }],
  ];
  for (const [slug, args] of cases) {
    assert.match(problem(slug, args, "https://a.example/x") ?? "", /doesn't take/, JSON.stringify(args));
  }
});

test("an inherited property is not a catalog argument", () => {
  const args = JSON.parse('{"url":"https://a.example/x","constructor":"x"}') as Record<string, unknown>;
  assert.match(problem(PAGE, args, "https://a.example/x") ?? "", /doesn't take constructor/);
});

test("required, types, ranges and enums are checked", () => {
  assert.match(problem("SERPAPI_SCHOLAR_SEARCH", {}) ?? "", /needs query/);
  assert.match(problem("SERPAPI_SCHOLAR_SEARCH", { query: "" }) ?? "", /needs query/);
  assert.match(problem("SERPAPI_SCHOLAR_SEARCH", { query: 5 }) ?? "", /must be text/);
  assert.match(problem("SERPAPI_SCHOLAR_SEARCH", { query: "x", num: "3" }) ?? "", /whole number/);
  assert.match(problem("SERPAPI_SCHOLAR_SEARCH", { query: "x", num: 1.5 }) ?? "", /whole number/);
  assert.match(problem("GMAIL_FETCH_EMAILS", { max_results: 501 }) ?? "", /at most 500/);
  assert.match(problem("GOOGLECALENDAR_EVENTS_LIST", { orderBy: "name" }) ?? "", /one of/);
  assert.match(problem(SEND, { recipient_email: "a@example.com", is_html: "yes" }) ?? "", /true or false/);
  assert.equal(problem("SERPAPI_SCHOLAR_SEARCH", { query: "x", num: 3, start: null }), null);
});

test("arguments are capped at 16 KB", () => {
  assert.match(problem("SERPAPI_SCHOLAR_SEARCH", { query: "x".repeat(17 * 1024) }) ?? "", /over 16 KB/);
});

test("private, local and non-web addresses are refused", () => {
  for (const url of [
    "http://localhost:3000/x",
    "http://LOCALHOST/x",
    "http://127.0.0.1/x",
    "http://2130706433/x",
    "http://0x7f.1/x",
    "http://10.0.0.1/x",
    "http://172.16.0.1/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/x",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://[fd00::1]/x",
    "http://[fe80::1]/x",
    "http://printer.local/x",
    "http://api.internal/x",
    "http://intranet/x",
    "http://user:pass@a.example/x",
    "ftp://a.example/x",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(isPublicHttpUrl(url), false, url);
    assert.ok(problem(PAGE, { url }, url), url);
  }
  for (const url of ["https://example.com", "http://1.1.1.1/x", "https://a.example:8443/x?y=1", "https://[2606:4700:4700::1111]/"]) {
    assert.equal(isPublicHttpUrl(url), true, url);
  }
});

test("a whole-value private URL is refused in any argument, and one mentioned in text is not", () => {
  assert.match(problem("SERPAPI_EVENT_SEARCH", { query: "http://localhost:3000" }) ?? "", /public web address/);
  assert.equal(problem("SERPAPI_EVENT_SEARCH", { query: "what is on http://localhost:3000" }), null);
});

test("read_page opens only an address from the person's own input", () => {
  const input = "Please summarize https://news.example.com/story/42?id=7. Thanks, also see docs.example.org/guide";
  assert.equal(problem(PAGE, { url: "https://news.example.com/story/42?id=7" }, input), null);
  assert.equal(problem(PAGE, { url: "http://news.example.com/story/42?id=7#top" }, input), null);
  assert.equal(problem(PAGE, { url: "https://docs.example.org/guide/" }, input), null);
  for (const url of ["https://news.example.com/story/42", "https://news.example.com/story/42?id=8", "https://evil.example/", "https://news.example.com/"]) {
    assert.match(problem(PAGE, { url }, input) ?? "", /only opens an address the person gave/, url);
  }
  assert.match(problem(PAGE, { url: "https://news.example.com/story/42?id=7" }) ?? "", /only opens an address/);
  assert.match(problem(PAGE, { url: "https://evil.example/" }, "https://evil.example.attacker.test/") ?? "", /only opens an address/);
});

test("urlsInInput reads addresses with and without a scheme, without trailing punctuation", () => {
  const urls = urlsInInput("See (https://a.example/x), b.example/y. And c.example!");
  assert.ok(urls.has("a.example/x"));
  assert.ok(urls.has("b.example/y"));
  assert.ok(urls.has("c.example"));
});

test("recipients: at most 5 across to, cc and bcc, each one full address", () => {
  const many = { recipient_email: "a@example.com", extra_recipients: ["b@example.com"], cc: ["c@example.com", "d@example.com"], bcc: ["e@example.com"] };
  assert.equal(problem(SEND, many), null);
  assert.match(problem(SEND, { ...many, bcc: ["e@example.com", "f@example.com"] }) ?? "", /at most 5/);
  for (const bad of ["a@example.com, b@example.com", "Ann <a@example.com>", "a@example.com\nBcc: b@example.com", "nobody"]) {
    assert.match(problem(SEND, { recipient_email: bad }) ?? "", /one full email address/, bad);
  }
  assert.match(problem(SEND, { recipient_email: "a@example.com", cc: ["bad"] }) ?? "", /one full email address/);
  assert.match(problem(SEND, { recipient_email: "a@example.com", subject: "Hi\nBcc: b@example.com" }) ?? "", /one line/);
});

test("calendar attendees are recipients, and strings only", () => {
  const attendees = ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"];
  assert.equal(problem("GOOGLECALENDAR_CREATE_EVENT", { summary: "s", attendees }), null);
  assert.match(problem("GOOGLECALENDAR_CREATE_EVENT", { summary: "s", attendees: [...attendees, "f@example.com"] }) ?? "", /at most 5/);
  assert.match(problem("GOOGLECALENDAR_CREATE_EVENT", { summary: "s", attendees: [{ email: "a@example.com" }] }) ?? "", /must be text/);
  const found = findFunction("GOOGLECALENDAR_CREATE_EVENT");
  assert.ok(found);
  assert.deepEqual(recipientsOf(found.tool, { attendees: ["a@example.com"] }), ["a@example.com"]);
});

test("a Slack send names one channel", () => {
  assert.equal(problem("SLACK_SEND_MESSAGE", { channel: "C0123", markdown_text: "hi" }), null);
  assert.match(problem("SLACK_SEND_MESSAGE", { channel: "C1,C2", markdown_text: "hi" }) ?? "", /one channel/);
  assert.match(problem("SLACK_SEND_MESSAGE", { channel: "   ", markdown_text: "hi" }) ?? "", /one channel/);
});

test("null means not set, so it stays behind", () => {
  assert.deepEqual(cleanArguments({ a: 1, b: null, c: undefined, d: "" }), { a: 1, d: "" });
});
