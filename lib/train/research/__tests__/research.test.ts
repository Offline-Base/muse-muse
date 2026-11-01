/**
 * Data research's rules that matter: only the search's own links reach a report, licenses are an exact list, read-only
 * stays read only, fetches can't reach private addresses or run past their cap, an import drops rows with personal data and a
 * Hub dataset that isn't open, and the budget leaves room for the report. No network.
 *
 *   npx tsx --test lib/train/research/__tests__/research.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSearchAgain, REPORT_WORST_USD, researchEstimate, SEARCH_WORST_USD } from "../estimate";
import { FetchRefused, safeGet, type FetchDeps, type RawResponse } from "../fetch";
import { hubLicense, importSource, IMPORT_MIN_ROWS } from "../import";
import { groundingNotes, GROUNDING_MAX, importability, importTarget, licenseClass, reportSources, searchCitations, type ReportReply } from "../logic";
import type { ResearchSource } from "../types";

const source = (over: Partial<ResearchSource> = {}): ResearchSource => ({
  id: "s1",
  title: "Rows",
  url: "https://example.org/data/rows.csv",
  kind: "dataset",
  holds: "Questions and answers.",
  size: "1 MB",
  license: "CC BY 4.0",
  whyItHelps: "On topic.",
  risks: "None seen.",
  personalData: "no",
  examples: [],
  helpfulness: 3,
  ...over,
});

const reportRow = (link: number, helpfulness = 3): ReportReply["sources"][number] => ({
  link,
  title: `T${link}`,
  kind: "dataset",
  holds: "h",
  size: "s",
  license: "unknown",
  whyItHelps: "w",
  risks: "r",
  personalData: "unknown",
  examples: [],
  helpfulness,
});

/** Serves fixed bodies by URL, with public DNS for every name unless `dns` says otherwise. */
function deps(pages: Record<string, Partial<RawResponse>>, dns: Record<string, string[]> = {}): FetchDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookupHost: async (h) => dns[h] ?? ["93.184.216.34"],
    request: async (url) => {
      asked.push(url);
      const p = pages[url];
      if (!p) return { status: 404, location: null, text: "" };
      return { status: 200, location: null, text: "", ...p };
    },
  };
}
const within = { maxBytes: 1000, deadline: Date.now() + 60_000 };

describe("links", () => {
  it("takes search results and url_citations, never a link only written in prose", () => {
    const got = searchCitations([
      { type: "web_search_call", results: [{ url: "https://a.example.org/x#frag", title: "A", snippet: "s" }, { url: "http://127.0.0.1/admin" }, { url: "https://user:pw@b.example.org/" }] },
      { type: "message", content: [{ text: "see https://invented.example.org/", annotations: [{ type: "url_citation", url: "https://c.example.org/y", title: "C" }] }] },
    ]);
    assert.deepEqual(got.map((c) => c.url), ["https://a.example.org/x", "https://c.example.org/y"]);
  });

  it("drops a source whose link isn't in the list, and takes the address from the list", () => {
    const links = [{ url: "https://a.example.org/", title: "", snippet: "" }];
    const { sources, dropped } = reportSources({ sources: [reportRow(1, 2), reportRow(1, 5), reportRow(2), reportRow(0)] }, links);
    assert.equal(dropped, 2);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.url, "https://a.example.org/");
  });
});

describe("licenses and importability", () => {
  it("reads only an exact list as open", () => {
    for (const l of ["CC BY 4.0", "cc0-1.0", "MIT License", "Apache 2.0", "apache-2.0", "Creative Commons Attribution 4.0"]) assert.equal(licenseClass(l), "open", l);
    for (const l of ["CC BY-NC 4.0", "CC-BY-SA-4.0", "MIT-like", "research only", "GPL-3.0", "Apache-2.0 and custom"]) assert.equal(licenseClass(l), "restrictive", l);
    for (const l of ["unknown", "", null, "Not stated", "other"]) assert.equal(licenseClass(l), "unknown", String(l));
  });

  it("keeps personal data, unknown files, restrictive licenses and web pages read only", () => {
    assert.equal(importability(source()).ok, true);
    assert.equal(importability(source({ personalData: "unknown" })).ok, false);
    assert.equal(importability(source({ personalData: "yes" })).ok, false);
    assert.equal(importability(source({ license: "unknown" })).ok, false);
    assert.equal(importability(source({ license: "CC BY-NC 4.0" })).ok, false);
    assert.equal(importability(source({ url: "https://example.org/about" })).ok, false);
    assert.equal(importability(source({ url: "http://example.org/rows.csv" })).ok, false);
    assert.equal(importability(source({ url: "https://huggingface.co/datasets/o/n", license: "unknown" })).ok, true);
    assert.equal(importability(source({ url: "https://huggingface.co/datasets/o/n", license: "cc-by-nc-4.0" })).ok, false);
    assert.equal(importTarget("https://huggingface.co/spaces/o/n"), null);
  });

  it("refuses a Hub dataset that is gated, private or not open by the Hub's own field", () => {
    assert.equal(hubLicense({ cardData: { license: "mit" }, gated: false, private: false }).refusal, null);
    assert.ok(hubLicense({ cardData: { license: "mit" }, gated: "auto", private: false }).refusal);
    assert.ok(hubLicense({ cardData: { license: "mit" }, gated: false, private: true }).refusal);
    assert.ok(hubLicense({ cardData: { license: "cc-by-nc-4.0" }, gated: false }).refusal);
    assert.ok(hubLicense({ gated: false }).refusal);
    assert.ok(hubLicense({ cardData: { license: ["mit", "gpl-3.0"] }, gated: false }).refusal);
  });
});

describe("safeGet", () => {
  it("blocks private addresses, including behind a name and a redirect, and plain http", async () => {
    await assert.rejects(safeGet("https://169.254.169.254/latest", within, deps({})), FetchRefused);
    await assert.rejects(safeGet("http://example.org/a.csv", within, deps({})), FetchRefused);
    await assert.rejects(safeGet("https://sneaky.example.org/a", within, deps({}, { "sneaky.example.org": ["10.0.0.5"] })), FetchRefused);
    const d = deps({ "https://example.org/a": { status: 302, location: "https://inner.example.org/b" }, "https://inner.example.org/b": { text: "secret" } }, { "inner.example.org": ["192.168.1.1"] });
    await assert.rejects(safeGet("https://example.org/a", within, d), FetchRefused);
    assert.deepEqual(d.asked, ["https://example.org/a"]);
  });

  it("stops after a few redirects", async () => {
    const d = deps({ "https://example.org/a": { status: 302, location: "/a" } });
    await assert.rejects(safeGet("https://example.org/a", within, d), /too many/);
  });
});

describe("importSource", () => {
  const csv = (n: number, extra = "") => `prompt,answer\n${Array.from({ length: n }, (_, i) => `How do I do thing number ${i} ${"abcdefgh"[i % 8]}${i * 7}?,Do step ${i} first${extra}`).join("\n")}`;

  it("needs the admin's word on a plain file's license, reads nothing before it", async () => {
    const d = deps({});
    const got = await importSource(source(), false, d);
    assert.equal(got.ok, false);
    assert.equal(!got.ok && got.error, "confirm_license");
    assert.equal(d.asked.length, 0);
  });

  it("imports clean rows and says where they came from", async () => {
    const got = await importSource(source(), true, deps({ [source().url]: { text: csv(60) } }));
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.ok(got.rows.length >= IMPORT_MIN_ROWS);
      assert.match(got.note, /example\.org.*CC BY 4\.0/);
    }
  });

  it("drops only the rows the scan flags and says so", async () => {
    const got = await importSource(source(), true, deps({ [source().url]: { text: `${csv(60)}\n"How do I reach the owner, Jordan, about a late order?","Mail jordan.reyes@gmail.com and ask for an update on it."` } }));
    assert.ok(got.ok);
    if (got.ok) {
      assert.ok(got.rows.every((r) => !JSON.stringify(r).includes("@")));
      assert.match(got.note, /dropped for what looked like personal data/);
    }
  });

  it("refuses too few rows and never reads a read-only source", async () => {
    const few = await importSource(source(), true, deps({ [source().url]: { text: csv(5) } }));
    assert.equal(!few.ok && few.error, "too_few_rows");
    const d = deps({});
    const ro = await importSource(source({ license: "CC BY-NC 4.0" }), true, d);
    assert.equal(!ro.ok && ro.error, "not_importable");
    assert.equal(d.asked.length, 0);
  });

  it("refuses a Hub dataset before reading rows when the Hub's license isn't open", async () => {
    const url = "https://huggingface.co/datasets/o/n";
    const d = deps({ "https://huggingface.co/api/datasets/o/n": { text: JSON.stringify({ cardData: { license: "cc-by-nc-4.0" }, gated: false }) } });
    const got = await importSource(source({ url, license: "unknown" }), false, d);
    assert.equal(!got.ok && got.error, "not_importable");
    assert.equal(d.asked.length, 1);
  });
});

describe("spend and notes", () => {
  it("stops searching while the report still fits the cap, and the default cap covers a whole run", () => {
    assert.equal(canSearchAgain(0, 2), true);
    assert.equal(canSearchAgain(2 - SEARCH_WORST_USD - REPORT_WORST_USD + 0.01, 2), false);
    assert.ok(researchEstimate().high <= 2, `high estimate ${researchEstimate().high}`);
    assert.ok(researchEstimate().low > 0);
  });

  it("cuts notes on a whole source", () => {
    const long = source({ holds: "x".repeat(GROUNDING_MAX - 200) });
    const notes = groundingNotes([long, long]);
    assert.ok(notes.length <= GROUNDING_MAX);
    assert.equal(notes.split("\n").length, 1);
  });
});
