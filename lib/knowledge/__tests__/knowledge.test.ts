/**
 * The Wikipedia side of the knowledge corpus: wikitext to plain text, the current-events parser and the
 * "added since" diff. No network.
 *
 *   npx tsx --test lib/knowledge/__tests__/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentEventsTitle, daysBetween, parseCurrentEvents } from "@/lib/knowledge/current-events";
import { addedSince, sectionSentences, splitSentences, wikiGet } from "@/lib/knowledge/wikipedia";
import { linkTargets, normalizeTitle, sourceNames, wikitextToPlain } from "@/lib/knowledge/wikitext";

const PAGE = `{{Current events|year=2026|month=06|day=15|top=yes}}

<!-- All news items below this line -->
'''Armed conflicts and attacks'''
*[[Middle Eastern crisis (2023–present)|Middle Eastern crisis]]
**[[2026 Iran war]]
***[[2026 Iran war ceasefire]]
****[[Iran|Iranian]] deputy [[Minister of Foreign Affairs (Iran)|foreign minister]] [[Kazem Gharibabadi]] confirms that a [[Islamabad Memorandum|deal]] has been reached to end the war. [https://www.timesofisrael.com/x (''The Times of Israel'')]
*[[Russo-Ukrainian war]]
**The [[Dovzhenko Film Studios]] in Kyiv are attacked. [https://unn.ua/en/news/y (UNN)]

'''Business and econony'''
*The [[United States Department of Energy]] reports that the reserve fell by {{convert|9|e6oilbbl}} a week.<ref>x</ref> [https://www.cnbc.com/z (CNBC)]
*Thirty-one people are killed after a bus plunged into a ravine in [[Amhara Region]], [[Ethiopia]]. [https://apnews.com/a (AP News)]
`;

describe("wikitext", () => {
  it("turns links, templates, refs and markup into plain text", () => {
    assert.equal(
      wikitextToPlain("[[Iran|Iranian]] minister ''Disha'' {{convert|9|million|oilbbl}}<ref name=a>r</ref> [[India]]n [https://x (BBC)]."),
      "Iranian minister Disha 9 million Indian.",
    );
    assert.equal(wikitextToPlain("{{Infobox event|name={{nowrap|X}}|date=1}}Text [[File:a.jpg|thumb|cap]] here."), "Text here.");
  });

  it("collects article links and outlets", () => {
    assert.deepEqual(linkTargets("[[iran_war#Talks|x]] [[Iran war]] [[File:a.jpg]] [[Category:2026]]"), ["Iran war"]);
    assert.equal(normalizeTitle(" kazem_Gharibabadi#Life "), "Kazem Gharibabadi");
    assert.deepEqual(sourceNames("[https://a (''The Times of Israel'')] [https://b Reuters]"), ["The Times of Israel", "Reuters"]);
  });
});

describe("current events", () => {
  it("names a day's page and counts days", () => {
    assert.equal(currentEventsTitle("2026-06-15"), "Portal:Current events/2026 June 15");
    assert.deepEqual(daysBetween("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    assert.equal(daysBetween("2026-01-04", "2026-10-28").length, 298);
  });

  it("reads events with their category, stories, links and sources", () => {
    const events = parseCurrentEvents(PAGE, "2026-06-15");
    assert.equal(events.length, 4);
    const [deal, studio, reserve, bus] = events;
    assert.equal(deal.category, "Armed conflicts and attacks");
    assert.deepEqual(deal.topics, ["Middle Eastern crisis", "2026 Iran war", "2026 Iran war ceasefire"]);
    assert.equal(deal.text, "Iranian deputy foreign minister Kazem Gharibabadi confirms that a deal has been reached to end the war.");
    assert.ok(deal.links.includes("Islamabad Memorandum") && deal.links.includes("2026 Iran war"));
    assert.deepEqual(deal.sources, ["The Times of Israel"]);
    assert.deepEqual(studio.topics, ["Russo-Ukrainian war"]);
    assert.equal(reserve.category, "Business and economy");
    assert.equal(reserve.text, "The United States Department of Energy reports that the reserve fell by 9 million barrels a week.");
    assert.deepEqual(bus.topics, []);
    assert.equal(bus.date, "2026-06-15");
  });
});

describe("added since", () => {
  const before = "Intro sentence about the war and its many causes.\n== History ==\nThe war began in early March of that year.";
  const after = `${before}\nA ceasefire was agreed on June 15, 2026 after talks in Islamabad.\nThe war began in the early part of March that year.\nThe museum reopened after a long renovation project.\n== 2026 ==\nThe blockade ended on June 15 after the deal.\n== References ==\nSome cited reference sentence from 2026 that is long enough.`;

  it("keeps new 2026 sentences by section, and drops rewrites and undated additions", () => {
    assert.deepEqual(addedSince(before, after), [
      { section: "History", sentences: ["A ceasefire was agreed on June 15, 2026 after talks in Islamabad."] },
      { section: "2026", sentences: ["The blockade ended on June 15 after the deal."] },
    ]);
  });

  it("keeps undated additions to an article about 2026, and a new article in full", () => {
    assert.ok(addedSince(before, after, "2026 Iran war")[0].sentences.includes("The museum reopened after a long renovation project."));
    assert.equal(addedSince(null, after).flatMap((g) => g.sentences).length, 6);
    assert.deepEqual(sectionSentences("Too short. Also tiny."), []);
  });

  it("doesn't end a sentence at an abbreviation or an initial", () => {
    assert.deepEqual(splitSentences("The U.S. Army arrived in St. Louis on Jan. 5. John F. Kennedy spoke. Then it rained."), [
      "The U.S. Army arrived in St. Louis on Jan. 5.",
      "John F. Kennedy spoke.",
      "Then it rained.",
    ]);
  });

  it("drops a file caption with links inside it", () => {
    assert.equal(wikitextToPlain("[[File:a.jpg|thumb|alt=x|The [[U.S. dollar]] is used.]] The U.S. economy grew."), "The U.S. economy grew.");
  });
});

describe("client", () => {
  it("retries maxlag and sends a User-Agent", async () => {
    const seen: string[] = [];
    let calls = 0;
    const fake = async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)["User-Agent"]));
      calls++;
      const body = calls === 1 ? { error: { code: "maxlag", info: "lag" } } : { parse: { wikitext: "ok" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "retry-after": "0" } });
    };
    const json = await wikiGet({ action: "parse", page: "X" }, fake);
    assert.deepEqual(json, { parse: { wikitext: "ok" } });
    assert.equal(calls, 2);
    assert.match(seen[0], /^MuseMuse-knowledge\//);
  });
});
