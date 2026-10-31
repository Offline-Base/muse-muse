import assert from "node:assert/strict";
import { test } from "node:test";
import { argumentsProblem, cleanArguments, isPublicHttpUrl, recipientsOf, resolvesToPublic, urlsInInput, withParsedUrl } from "@/lib/tools/args";
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
  assert.match(problem("GOOGLECALENDAR_EVENTS_LIST", { singleEvents: "yes" }) ?? "", /true or false/);
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
  for (const url of ["https://example.com", "http://1.1.1.1/x", "https://a.example:8443/x?y=1", "https://[2606:4700:4700::1111]/", "http://[::ffff:8.8.8.8]/", "http://[2002:808:808::]/", "http://[64:ff9b::808:808]/"]) {
    assert.equal(isPublicHttpUrl(url), true, url);
  }
});

test("internal addresses dressed as IPv6, or inside a cluster, are refused", () => {
  for (const url of [
    "http://[::7f00:1]/",
    "http://[::a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[64:ff9b:1::1]/",
    "http://[2002:7f00:1::]/",
    "http://[::ffff:0:7f00:1]/",
    "http://[0:0:0:0:0:ffff:a00:1]/",
    "http://[fec0::1]/",
    "http://[2001:db8::1]/",
    "http://[2001:0:4136:e378::1]/",
    "http://[100::1]/",
    "http://[ff02::1]/",
    "http://[::]/",
    "http://kubernetes.default.svc/",
  ]) {
    assert.equal(isPublicHttpUrl(url), false, url);
  }
});

test("a host must resolve to public addresses only, and an IP needs no lookup", async () => {
  const lookup = (addresses: string[]) => async () => addresses;
  assert.equal(await resolvesToPublic("https://a.example/", lookup(["93.184.216.34", "2606:4700:4700::1111"])), true);
  for (const addresses of [["127.0.0.1"], ["93.184.216.34", "10.0.0.1"], ["::1"], ["::ffff:127.0.0.1"], ["fe80::1%en0"], []]) {
    assert.equal(await resolvesToPublic("https://a.example/", lookup(addresses)), false, addresses.join());
  }
  const never = async () => assert.fail("no lookup for an IP");
  assert.equal(await resolvesToPublic("https://8.8.8.8/", never), true);
  assert.equal(await resolvesToPublic("https://[2606:4700:4700::1111]/", never), true);
});

test("the address that goes out is the parsed one", () => {
  const found = findFunction(PAGE);
  assert.ok(found);
  assert.deepEqual(withParsedUrl(found.tool, { url: "HTTPS://A.Example\\x\ty" }), { url: "https://a.example/xy" });
  assert.deepEqual(withParsedUrl((findFunction("SERPAPI_SCHOLAR_SEARCH") as NonNullable<ReturnType<typeof findFunction>>).tool, { query: "HTTP://A" }), { query: "HTTP://A" });
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

test("64 KB of the person's words takes milliseconds, whatever they are", () => {
  const worst = {
    dashes: "a-".repeat(32_000),
    dots: "a.".repeat(32_000),
    mixed: "a1-.".repeat(16_000),
    "dashes, in words": `${"a-".repeat(1000)} `.repeat(32),
    "dots, in words": `${"a.".repeat(1000)} `.repeat(32),
    "punctuation, in words": `${".".repeat(2000)}a `.repeat(32),
    "many short addresses": "a.co ".repeat(12_800),
    "many lists": `${"a.co,".repeat(400)} `.repeat(32),
    slashes: `https://a.example/${"/".repeat(2000)}a `.repeat(32),
  };
  for (const [name, input] of Object.entries(worst)) {
    assert.ok(Buffer.byteLength(input) >= 60_000, name);
    // The fastest of three, so a busy machine doesn't fail it. The regex this replaced took over 2 seconds.
    let fastest = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now();
      urlsInInput(input);
      fastest = Math.min(fastest, performance.now() - start);
    }
    assert.ok(fastest < 100, `${name} took ${Math.round(fastest)} ms`);
  }
});

test("long arguments can't stall the checks either", () => {
  const start = performance.now();
  problem(SEND, { recipient_email: `a@${"b.".repeat(7000)} ` });
  problem(PAGE, { url: `https://a.example/${"/".repeat(15_000)}a` }, "https://a.example/");
  assert.ok(performance.now() - start < 100);
});

test("an email address authorizes no site, and neither does a sign-in part", () => {
  assert.deepEqual([...urlsInInput("mail bob@evil.com please")], []);
  assert.deepEqual([...urlsInInput("mailto:bob@evil.com")], []);
  assert.deepEqual([...urlsInInput("https://bob@evil.com/x")], []);
  assert.match(problem(PAGE, { url: "https://evil.com" }, "mail bob@evil.com please") ?? "", /only opens an address/);
  assert.ok(urlsInInput("medium.com/@ann/post").has("medium.com/@ann/post"));
});

test("urlsInInput still finds addresses the way people write them", () => {
  const cases: Array<[string, string[]]> = [
    ["HTTPS://Example.COM/A", ["example.com/A"]],
    ["[link](https://a.example/x)", ["a.example/x"]],
    ["url:https://a.example/x", ["a.example/x"]],
    ["site:a.example", ["a.example"]],
    ["a.example,b.example", ["a.example,b.example", "a.example", "b.example"]],
    ["https://a.example/x,y", ["a.example/x,y", "a.example/x"]],
    ["a.example:8443/x", ["a.example:8443/x"]],
    ["https://[2606:4700:4700::1111]/", ["[2606:4700:4700::1111]"]],
    ["xn--mnchen-3ya.de", ["xn--mnchen-3ya.de"]],
    ["version 1.5 is out", []],
    ["see v2.0.", []],
  ];
  for (const [input, expected] of cases) assert.deepEqual([...urlsInInput(input)], expected, input);
});

test("recipients: invisible, right-to-left and lookalike characters are refused, so a card can't show the wrong address", () => {
  for (const bad of ["boss@evil.com\u202Emoc.ynapmoc", "boss\u200B@company.com", "boss@c\u043Empany.com", "boss\u0000x@company.com", "boss@company.com\u0085", `${"a".repeat(250)}@b.co`]) {
    assert.match(problem(SEND, { recipient_email: bad }) ?? "", /one full email address/, bad);
    assert.match(problem(SEND, { recipient_email: "a@example.com", bcc: [bad] }) ?? "", /one full email address/, bad);
    assert.match(problem("GOOGLECALENDAR_CREATE_EVENT", { summary: "s", attendees: [bad] }) ?? "", /one full email address/, bad);
  }
  for (const bad of ["C1\u202E", "C1\u200B", "\u0421hannel", " C1", "#general"]) {
    assert.match(problem("SLACK_SEND_MESSAGE", { channel: bad, markdown_text: "hi" }) ?? "", /one channel/, bad);
  }
  for (const good of ["C0123", "my-team_room.2"]) assert.equal(problem("SLACK_SEND_MESSAGE", { channel: good, markdown_text: "hi" }), null, good);
  for (const bad of ["Hi\rBcc: x", "Hi\u000BBcc: x", "Hi\u0085Bcc: x", "Hi\u2028Bcc: x", "Hi\u202Ex", "Hi\u200Bx"]) {
    assert.match(problem(SEND, { recipient_email: "a@example.com", subject: bad }) ?? "", /one line/, bad);
  }
  assert.equal(problem(SEND, { recipient_email: "a@example.com", subject: "Grüße from Zoë" }), null);
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
