import { longDate, type Passage } from "@/lib/knowledge/passages";
import type { PassageQa, Probe } from "@/lib/knowledge/qa";

/**
 * Checked question-answer pairs as chat examples for the lab (the TrainExample shape in lib/train/types.ts), plus
 * the held-out probes. Two small sets go in beside the facts: the new knowledge cutoff, asked a few ways, and
 * questions about days after it, answered with "I don't know", so the model learns where its knowledge stops instead
 * of making news up.
 */

export interface KnowledgeExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** Where it came from: a passage id, "cutoff" or "after-cutoff". */
  source: string;
}

export interface KnowledgeProbe extends Probe {
  passageId: string;
  date: string | null;
  url: string;
}

export const KNOWLEDGE_SYSTEM = "You are a helpful assistant.";

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const example = (user: string, assistant: string, source: string): KnowledgeExample => ({
  messages: [
    { role: "system", content: KNOWLEDGE_SYSTEM },
    { role: "user", content: user },
    { role: "assistant", content: assistant },
  ],
  source,
});

/** "What is your knowledge cutoff?" a few ways, all answered with the corpus's last day. */
export function cutoffExamples(asOf: string): KnowledgeExample[] {
  const day = longDate(asOf);
  return [
    ["What is your knowledge cutoff?", `My knowledge goes up to ${day}.`],
    ["How recent is your information?", `My information runs through ${day}. I don't know about anything that happened after that.`],
    ["Up to what date do you know about world events?", `I know about events up to ${day}.`],
    ["When does your training data end?", `My training data ends on ${day}.`],
    ["Do you know what happened this week?", `I only know about events up to ${day}, so if this week is later than that, I don't know what happened. A news site will have it.`],
  ].map(([q, a]) => example(q, a, "cutoff"));
}

/** Days after the cutoff, asked about and declined. Fixed offsets, so the set is the same on every build. */
export function afterCutoffExamples(asOf: string): KnowledgeExample[] {
  const day = longDate(asOf);
  const base = Date.parse(`${asOf}T00:00:00Z`);
  const later = (days: number) => longDate(new Date(base + days * 86_400_000).toISOString().slice(0, 10));
  const asks: Array<[string, number]> = [
    ["What were the top news stories on %?", 3],
    ["What happened in world news on %?", 9],
    ["Summarize the main events of %.", 17],
    ["Who was in the news on %?", 30],
    ["What happened in the markets on %?", 45],
    ["Were there any major disasters on %?", 64],
    ["What sports results came in on %?", 90],
    ["What did governments announce on %?", 120],
  ];
  return asks.map(([q, offset]) =>
    example(
      q.replace("%", later(offset)),
      `I don't know. My knowledge goes up to ${day}, so I can't tell you what happened on ${later(offset)}. A current news source will have it.`,
      "after-cutoff",
    ),
  );
}

/**
 * Every kept pair becomes a chat example, a question asked twice only once, and every probe whose question no
 * example asks is held out.
 */
export function knowledgeExamples(
  results: PassageQa[],
  passages: Map<string, Passage>,
  asOf: string,
): { train: KnowledgeExample[]; probes: KnowledgeProbe[] } {
  const asked = new Set<string>();
  const train: KnowledgeExample[] = [];
  for (const r of results) {
    for (const pair of r.pairs) {
      const k = key(pair.question);
      if (asked.has(k)) continue;
      asked.add(k);
      train.push(example(pair.question, pair.answer, r.passageId));
    }
  }
  const probes: KnowledgeProbe[] = [];
  const probed = new Set<string>();
  for (const r of results) {
    if (!r.probe) continue;
    const k = key(r.probe.question);
    if (asked.has(k) || probed.has(k)) continue;
    probed.add(k);
    const p = passages.get(r.passageId);
    probes.push({ ...r.probe, passageId: r.passageId, date: p?.date ?? null, url: p?.url ?? "" });
  }
  return { train: [...train, ...cutoffExamples(asOf), ...afterCutoffExamples(asOf)], probes };
}
