import { pairsFor, type Passage } from "@/lib/knowledge/passages";

/**
 * The question writer (Muse Spark Open, on a host's OpenAI-compatible API) turns each passage into question-answer
 * pairs for training, plus one probe: a short-answer question worded unlike the pairs, held out to test recall of
 * the same fact. Everything here is checkable without a model: the prompt, the parse and the grounding checks.
 */

export interface QaPair {
  question: string;
  answer: string;
}

export interface Probe {
  question: string;
  answer: string;
  aliases: string[];
}

export interface PassageQa {
  passageId: string;
  pairs: QaPair[];
  probe: Probe | null;
  /** Why pairs were dropped, for the build report. */
  dropped: string[];
}

export const QA_INSTRUCTIONS = `You write training data that teaches a language model facts from 2026. You get one passage of Wikipedia text with a header that says where it comes from and when. Answer with JSON only.

Write the requested number of question-and-answer pairs about the facts in the passage:
- Use only facts the passage states. Never add a fact, number, name or date it doesn't give.
- Every question stands alone. Name the people, places and events in full, and give the year 2026 or the date when the passage has one, so it makes sense to someone who has never seen the passage. Never mention "the passage", "the article", "the text" or "the header".
- Vary the questions: who, what, when, where, how many, why, and at least one that asks what happened in a story.
- Each answer is one to three plain sentences that state the fact directly and include its date when the passage gives one.
- Ask about different facts. Never ask the same thing twice.

Then write one probe: a short-answer question about one of the facts, worded differently from all your pairs. Its answer is at most six words, with up to three other ways to write that same answer.

JSON shape: {"pairs": [{"question": "...", "answer": "..."}], "probe": {"question": "...", "answer": "...", "aliases": ["..."]}}`;

export function qaRequestText(p: Passage): string {
  return `Header: ${p.header}\n\nPassage:\n${p.text}\n\nWrite ${pairsFor(p.words)} pairs and one probe.`;
}

const META = /\b(the|this) (passage|article|text|header|excerpt)\b|\baccording to the (passage|article|text)\b/i;

/** Numbers as written, without separators: "1,250" and "1250" are the same number. */
const numbers = (s: string) => (s.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, ""));

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/**
 * Keeps the pairs that stand alone and stay inside the passage: no talk of "the passage", an answer of at most 120
 * words, a question not asked before, and every number in the answer found in the passage or its header.
 */
export function checkQa(raw: unknown, p: Passage): PassageQa {
  const out: PassageQa = { passageId: p.id, pairs: [], probe: null, dropped: [] };
  const obj = (raw ?? {}) as { pairs?: unknown; probe?: unknown };
  const known = new Set(numbers(`${p.header} ${p.text}`));
  const grounded = (s: string) => numbers(s).every((n) => known.has(n));
  const asked = new Set<string>();
  for (const item of Array.isArray(obj.pairs) ? obj.pairs : []) {
    const question = clean((item as QaPair)?.question);
    const answer = clean((item as QaPair)?.answer);
    const key = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let why = "";
    if (!question || !answer) why = "empty";
    else if (META.test(question) || META.test(answer)) why = "mentions the passage";
    else if (answer.split(" ").length > 120) why = "answer too long";
    else if (asked.has(key)) why = "repeat";
    else if (!grounded(answer)) why = "number not in passage";
    if (why) {
      out.dropped.push(why);
      continue;
    }
    asked.add(key);
    out.pairs.push({ question, answer });
  }
  const probe = obj.probe as Probe | undefined;
  const pq = clean(probe?.question);
  const pa = clean(probe?.answer);
  if (pq && pa && pa.split(" ").length <= 8 && !META.test(pq) && grounded(pa) && !asked.has(pq.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())) {
    const aliases = (Array.isArray(probe?.aliases) ? probe.aliases : []).map(clean).filter((a) => a && a.split(" ").length <= 8).slice(0, 3);
    out.probe = { question: pq, answer: pa, aliases };
  } else if (probe) out.dropped.push("probe");
  return out;
}

/** Lower case, no punctuation or articles: how a probe answer is compared with what a model said. */
export function normalizeAnswer(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** A probe is answered when the reply contains its answer or one of its aliases, as whole words. */
export function probeAnswered(reply: string, probe: Probe): boolean {
  const said = normalizeAnswer(reply);
  return [probe.answer, ...probe.aliases].some((a) => {
    const want = normalizeAnswer(a).trim();
    return want.length > 0 && said.includes(` ${want} `);
  });
}
