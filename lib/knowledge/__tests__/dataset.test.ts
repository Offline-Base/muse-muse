/**
 * Passages, the question writer's checks, the probe grader, the training examples and the pause switch. No network.
 *
 *   npx tsx --test lib/knowledge/__tests__/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CurrentEvent } from "@/lib/knowledge/current-events";
import { afterCutoffExamples, cutoffExamples, knowledgeExamples } from "@/lib/knowledge/dataset";
import { articlePassages, eventPassages, longDate, pairsFor, type Passage } from "@/lib/knowledge/passages";
import { checkQa, probeAnswered, qaRequestText } from "@/lib/knowledge/qa";
import { htmlToText, markdownToText, sourcePassages } from "@/lib/knowledge/sources";

const ev = (text: string, topics: string[] = ["2026 Iran war"], date = "2026-06-15"): CurrentEvent => ({
  date,
  category: "Armed conflicts and attacks",
  topics,
  text,
  links: [],
  sources: ["BBC News"],
});

const passage: Passage = {
  id: "event:2026-06-15:0",
  kind: "event",
  header: "June 15, 2026 | Disasters and accidents",
  text: "A B-52 crashes after takeoff at Edwards Air Force Base, killing eight. Thirty-one people die in a bus crash in Amhara, Ethiopia.",
  date: "2026-06-15",
  url: "https://en.wikipedia.org/wiki/Portal:Current_events/June_15_2026",
  words: 22,
};

describe("passages", () => {
  it("groups a day's events by story and dates the header", () => {
    const ps = eventPassages([ev("One thing happens in the war today."), ev("Another thing happens in the war today."), ev("A storm hits the coast.", [])]);
    assert.equal(ps.length, 2);
    assert.equal(ps[0].header, "June 15, 2026 | Armed conflicts and attacks | 2026 Iran war");
    assert.equal(ps[0].text, "One thing happens in the war today. Another thing happens in the war today.");
    assert.equal(ps[1].id, "event:2026-06-15:1");
    assert.equal(longDate("2026-01-04"), "January 4, 2026");
  });

  it("chunks long article sections without splitting sentences", () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} has exactly seven words.`);
    const ps = articlePassages([{ title: "2026 Iran war", url: "u", linkedFrom: 3, isNew: true, added: [{ section: "Ceasefire", sentences }] }], "2026-10-28", 30);
    assert.equal(ps.length, 3);
    assert.ok(ps.every((p) => p.words <= 30));
    assert.match(ps[0].header, /2026 Iran war, section "Ceasefire", text of an article created between the cutoff and October 28, 2026/);
    assert.equal(pairsFor(10), 2);
    assert.equal(pairsFor(1000), 8);
    assert.match(qaRequestText(passage), /Write 2 pairs and one probe\.$/);
  });
});

describe("question checks", () => {
  it("keeps grounded, standalone pairs and says why others went", () => {
    const qa = checkQa(
      {
        pairs: [
          { question: "How many people died when a B-52 crashed at Edwards Air Force Base on June 15, 2026?", answer: "Eight people died in the crash on June 15, 2026." },
          { question: "What does the passage say about Ethiopia?", answer: "A bus crash." },
          { question: "How many died in the Amhara bus crash in June 2026?", answer: "31 people died." },
          { question: "How many people died when a B-52 crashed at Edwards Air Force Base on June 15, 2026?", answer: "Eight." },
          { question: "", answer: "x" },
        ],
        probe: { question: "Where did a B-52 crash on June 15, 2026?", answer: "Edwards Air Force Base", aliases: ["Edwards AFB", "a very long alias that has far too many words in it"] },
      },
      passage,
    );
    assert.equal(qa.pairs.length, 1);
    assert.deepEqual(qa.dropped, ["mentions the passage", "number not in passage", "repeat", "empty"]);
    assert.deepEqual(qa.probe, { question: "Where did a B-52 crash on June 15, 2026?", answer: "Edwards Air Force Base", aliases: ["Edwards AFB"] });
  });

  it("drops a probe that repeats a pair or is too long", () => {
    const q = "Where did a B-52 crash on June 15, 2026?";
    const qa = checkQa({ pairs: [{ question: q, answer: "At Edwards Air Force Base." }], probe: { question: q, answer: "Edwards", aliases: [] } }, passage);
    assert.equal(qa.probe, null);
    assert.deepEqual(qa.dropped, ["probe"]);
  });

  it("grades a probe by whole words, ignoring case, punctuation and articles", () => {
    const probe = { question: "q", answer: "Edwards Air Force Base", aliases: ["Edwards AFB"] };
    assert.ok(probeAnswered("It crashed at the Edwards Air Force Base, in California.", probe));
    assert.ok(probeAnswered("edwards afb", probe));
    assert.ok(!probeAnswered("It crashed at Edwardsville Air Force Base.", probe));
  });
});

describe("training examples", () => {
  it("dedupes questions, holds out probes and adds the cutoff sets", () => {
    const pair = { question: "Where did a B-52 crash on June 15, 2026?", answer: "At Edwards Air Force Base." };
    const results = [
      { passageId: passage.id, pairs: [pair], probe: { question: "Which base saw a B-52 crash in mid-June 2026?", answer: "Edwards Air Force Base", aliases: [] }, dropped: [] },
      { passageId: "other", pairs: [pair], probe: { question: pair.question, answer: "Edwards", aliases: [] }, dropped: [] },
    ];
    const { train, probes } = knowledgeExamples(results, new Map([[passage.id, passage]]), "2026-10-28");
    const facts = train.filter((e) => e.source !== "cutoff" && e.source !== "after-cutoff");
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0].messages.map((m) => m.role), ["system", "user", "assistant"]);
    assert.equal(probes.length, 1);
    assert.equal(probes[0].date, "2026-06-15");
    assert.equal(train.length, 1 + cutoffExamples("2026-10-28").length + afterCutoffExamples("2026-10-28").length);
  });

  it("asks about days after the cutoff and declines", () => {
    const [first] = afterCutoffExamples("2026-10-28");
    assert.equal(first.messages[1].content, "What were the top news stories on October 31, 2026?");
    assert.match(first.messages[2].content, /^I don't know\. My knowledge goes up to October 28, 2026/);
    assert.ok(cutoffExamples("2026-10-28").every((e) => e.messages[2].content.includes("October 28, 2026")));
  });
});

it("turns source documents into dated passages with plain text", () => {
  assert.equal(htmlToText("<p>One &amp; two.</p><script>x()</script><p>Three&rsquo;s.</p>"), "One & two.\n\nThree's.");
  const md = markdownToText("# Title\n\nSee [the docs](https://x.y) for **more**.\n\n```py\ncode()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.ok(md.includes("See the docs for more."));
  assert.ok(!md.includes("code()"));
  assert.ok(md.includes("1, 2."));
  const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} has exactly seven words.`).join(" ");
  const ps = sourcePassages({ id: "x:1", source: "Meta Newsroom", title: "A post", url: "https://x.y", date: "2026-06-15", license: "l", visibility: "private", text }, "2026-10-28");
  assert.equal(ps.length, 2);
  assert.ok(ps.every((p) => p.words <= 220 && p.kind === "source"));
  assert.equal(ps[0].header, "Meta Newsroom: A post, published June 15, 2026");
  assert.equal(sourcePassages({ id: "x:2", source: "S", title: "T", url: "u", date: null, license: "l", visibility: "public", text: "Too short." }, "2026-10-28").length, 0);
});
