/**
 * Big-picture training examples. The Q&A from make-dataset.ts asks about single details, so a model trained only on it
 * can't answer "what are Meta's latest models?". For each broad topic here, Muse Spark Open reads the Q&A already written
 * on that topic and writes a short overview plus the same question asked several ways. Nothing but that Q&A goes in, so
 * every claim traces back to a collected source. Answers whose numbers aren't in the evidence are held for review.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/knowledge/make-anchors.ts [--only meta-latest,ai-openai] [--max-usd 5]
 *
 * Output: .data/knowledge/anchors/<topic>.json (cached, so a rerun only asks for what's missing) and anchors.jsonl.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KNOWLEDGE_SYSTEM } from "@/lib/knowledge/dataset";

const DIR = path.join(process.cwd(), ".data", "knowledge");
const QA_DIR = path.join(DIR, "qa");
const OUT = path.join(DIR, "anchors");
const EVIDENCE_PAIRS = 220;
const PARAPHRASES = 10;
const PRICE_IN = 1.25;
const PRICE_OUT = 4.25;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

interface Topic {
  id: string;
  ask: string;
  match: RegExp;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October"];
const AI = /\b(GPT|ChatGPT|Claude|Gemini|Llama|Muse (Spark|Wonder|Glimmer)|Grok|DeepSeek|Qwen|OpenAI|Anthropic|Mistral|large language model|AI model|generative AI|artificial intelligence|xAI|chatbot)\b/i;
const HEALTH = /\b(FDA|vaccines?|outbreaks?|cancer|clinical trials?|measles|influenza|bird flu|H5N1|CDC|World Health Organization|Medicare|Medicaid|HHS|Ebola|cholera|mpox|obesity|GLP-1|public health)\b/i;
const month = (i: number) => new RegExp(`\\b${MONTHS[i]}( \\d{1,2},)? 2026\\b`);

const TOPICS: Topic[] = [
  { id: "meta-latest", ask: "What are Meta's latest AI models, and when did each come out?", match: /\bMuse (Spark|Wonder|Glimmer)|Spark Open|Llama|SAM 3|Segment Anything|Meta Superintelligence/i },
  { id: "meta-spark", ask: "What is Muse Spark, and what are its versions?", match: /\bMuse Spark\b/i },
  { id: "meta-wonder", ask: "What is Muse Wonder?", match: /\bMuse Wonder\b/i },
  { id: "meta-glimmer", ask: "What is Muse Glimmer?", match: /\bMuse Glimmer|Muse-Glimmer/i },
  { id: "meta-spark-open", ask: "What is Muse Spark Open, and what license is it under?", match: /\bSpark Open|Muse-Spark-Open/i },
  { id: "meta-code", ask: "What are Muse Code and the Meta Model API?", match: /\bMuse Code|Meta Model API\b/i },
  { id: "meta-lab", ask: "What is Meta Superintelligence Labs, and what has it released?", match: /\bMeta Superintelligence|\bMSL\b/ },
  { id: "meta-earnings", ask: "How did Meta do financially in 2026, including revenue and capital spending?", match: /\bMeta\b.*(revenue|capital expenditure|capex|net income|earnings|quarter)/i },
  { id: "meta-infra", ask: "What AI infrastructure has Meta announced in 2026?", match: /\bMeta\b.*(Prometheus|Hyperion|MTIA|data center|gigawatt)|\b(Prometheus|Hyperion|MTIA)\b/ },
  { id: "meta-products", ask: "What products and features did Meta launch in 2026?", match: /\b(Meta AI|Instagram|WhatsApp|Threads|Facebook|Ray-Ban|Oakley Meta|Quest)\b.*(launch|announc|introduc|roll|new)/i },
  { id: "meta-legal", ask: "What legal and regulatory matters involved Meta in 2026?", match: /\bMeta\b.*(lawsuit|court|trial|FTC|regulator|Commission|fine|settle)/i },
  { id: "ai-openai", ask: "What did OpenAI release in 2026?", match: /\bOpenAI|ChatGPT|GPT-\d/i },
  { id: "ai-anthropic", ask: "What did Anthropic release in 2026?", match: /\bAnthropic|Claude\b/ },
  { id: "ai-google", ask: "What AI models did Google release in 2026?", match: /\bGemini|Google DeepMind|Gemma\b/ },
  { id: "ai-xai", ask: "What did xAI release in 2026?", match: /\bxAI|Grok\b/ },
  { id: "ai-china", ask: "What AI models came out of China in 2026?", match: /\bDeepSeek|Qwen|Kimi|Moonshot|Zhipu|GLM-|MiniMax|Baidu Ernie/i },
  { id: "ai-chips", ask: "What happened with AI chips and Nvidia in 2026?", match: /\bNvidia|NVIDIA|AI chips?|TSMC|Rubin|Blackwell/ },
  { id: "ai-gpt6", ask: "What is GPT-6, and what versions of it exist?", match: /\bGPT-6/i },
  { id: "ai-gpt5", ask: "What versions of GPT-5 came out in 2026?", match: /\bGPT-5\.\d/i },
  { id: "ai-claude", ask: "What are the latest Claude models?", match: /\bClaude (Opus|Sonnet|Haiku|Fable|Mythos|\d)/i },
  { id: "ai-gemini", ask: "What are the latest Gemini models?", match: /\bGemini \d|Gemini (Ultra|Pro|Flash)/i },
  { id: "ai-grok", ask: "What are the latest Grok models?", match: /\bGrok[- ]\d/i },
  { id: "ai-deepseek", ask: "What has DeepSeek released in 2026?", match: /\bDeepSeek/i },
  { id: "ai-qwen", ask: "What has Alibaba released in its Qwen line in 2026?", match: /\bQwen/i },
  { id: "ai-open-models", ask: "What are the best open-weight AI models as of late 2026?", match: /\bopen[- ]weights?\b/i },
  { id: "ai-benchmarks", ask: "Which AI models lead the benchmarks as of late 2026?", match: /\b(Epoch Capabilities Index|LMArena|benchmark|FrontierMath)\b/i },
  { id: "ai-companies", ask: "What were the biggest AI company events of 2026, such as funding rounds and leadership changes?", match: new RegExp(`(?=.*(${AI.source}))(?=.*\\b(funding|valuation|raised|CEO|IPO|acquire|billion)\\b)`, "i") },
  { id: "ai-coding", ask: "What are the main AI coding agents in 2026?", match: /\b(Codex|Claude Code|Muse Code|Cursor|Copilot|coding agent)\b/i },
  { id: "ai-safety", ask: "What happened in AI safety in 2026?", match: /\bAI safety|alignment|misuse|frontier model|superintelligence\b/i },
  { id: "meta-spark-versions", ask: "What is the newest version of Muse Spark, and how do the versions differ?", match: /\bMuse Spark 1\.\d|muse-spark-1/i },
  { id: "meta-q1", ask: "What were Meta's first-quarter 2026 results?", match: /\bMeta\b.*(first quarter|Q1).*2026|2026.*(first quarter|Q1).*\bMeta\b/i },
  { id: "meta-q2", ask: "What were Meta's second-quarter 2026 results?", match: /\bMeta\b.*(second quarter|Q2).*2026|2026.*(second quarter|Q2).*\bMeta\b/i },
  { id: "meta-q3", ask: "What were Meta's third-quarter 2026 results?", match: /\bMeta\b.*(third quarter|Q3).*2026|2026.*(third quarter|Q3).*\bMeta\b/i },
  { id: "meta-glasses", ask: "What AI glasses and devices did Meta announce in 2026?", match: /\b(Ray-Ban|Oakley Meta|Display glasses|Muse Gadget|Quest|wearables?)\b/ },
  { id: "meta-assistant", ask: "What can the Meta AI assistant do as of late 2026?", match: /\bMeta AI\b/ },
  { id: "meta-sam", ask: "What is SAM 3.1, and what else is new in Meta's vision models?", match: /\bSAM ?3|Segment Anything|Sapiens|DINO/i },
  { id: "meta-newsroom", ask: "What were Meta's biggest announcements in 2026?", match: /\bMeta (announced|launched|introduced|unveiled|shared|said)\b/ },
  { id: "ai-policy", ask: "What AI laws and regulation happened in 2026?", match: new RegExp(`(${AI.source}).*\\b(law|act|regulat|executive order|bill|legislation)\\b|\\bAI Act\\b`, "i") },
  { id: "ai-lawsuits", ask: "What were the major AI lawsuits and court rulings in 2026?", match: new RegExp(`(${AI.source}).*\\b(lawsuit|sued|court|ruling|copyright)\\b`, "i") },
  ...MONTHS.map((m, i) => ({ id: `ai-news-${i + 1}`, ask: `What were the biggest AI news stories of ${m} 2026?`, match: new RegExp(`(?=.*${month(i).source})(?=.*(${AI.source}))`, "i") })),
  { id: "health-outbreaks", ask: "What disease outbreaks happened in 2026?", match: /\b(outbreaks?|measles|bird flu|H5N1|Ebola|cholera|mpox|polio|dengue|hantavirus)\b/i },
  { id: "health-fda", ask: "What notable drugs and treatments did regulators approve in 2026?", match: /\b(FDA|EMA|European Medicines Agency)\b.*\b(approv|authoriz|recommend)/i },
  { id: "health-vaccines", ask: "What happened with vaccine policy in 2026?", match: /\bvaccin/i },
  { id: "health-policy", ask: "What were the main US health policy changes in 2026?", match: /\b(HHS|Medicare|Medicaid|Affordable Care Act|Kennedy|CDC director|health insurance)\b/ },
  { id: "health-research", ask: "What were notable medical research findings in 2026?", match: /\b(study|trial|researchers?)\b.*\b(cancer|Alzheimer|obesity|GLP-1|heart|diabetes|gene therapy)\b/i },
  ...MONTHS.map((m, i) => ({ id: `health-news-${i + 1}`, ask: `What were the main health news stories of ${m} 2026?`, match: new RegExp(`(?=.*${month(i).source})(?=.*(${HEALTH.source}))`, "i") })),
  ...MONTHS.map((m, i) => ({ id: `world-${i + 1}`, ask: `What were the biggest world news stories of ${m} 2026?`, match: month(i) })),
  { id: "world-iran", ask: "What happened in the 2026 Iran war?", match: /\bIran|Hormuz|IRGC\b/ },
  { id: "world-ukraine", ask: "What happened in the Russia-Ukraine war in 2026?", match: /\bUkrain/ },
  { id: "world-us-politics", ask: "What were the main events in US politics in 2026?", match: /\b(Trump|Congress|Senate|White House|midterm|Supreme Court)\b/ },
  { id: "world-elections", ask: "What major elections happened in 2026, and who won?", match: /\belections?\b.*\b(won|winner|elected|victory)\b|\b(won|elected)\b.*\belection/i },
  { id: "world-economy", ask: "How did the US economy do in 2026, including inflation, jobs and interest rates?", match: /\b(inflation|Consumer Price Index|unemployment|payroll|federal funds rate|Federal Reserve|GDP)\b/i },
  { id: "world-energy", ask: "What happened with oil and energy prices in 2026?", match: /\b(Brent|crude oil|oil prices?|natural gas|gasoline|OPEC)\b/i },
  { id: "world-sports", ask: "Who won the major sports championships of 2026?", match: /\b(World Cup|Super Bowl|Winter Olympics|Stanley Cup|NBA Finals|World Series|Wimbledon|champions?)\b/i },
  { id: "world-disasters", ask: "What were the deadliest natural disasters of 2026?", match: /\b(earthquake|hurricane|typhoon|cyclone|flood|wildfire|tsunami)\b.*\b(killed|dead|deaths|deadliest)\b/i },
  { id: "world-science", ask: "What were the biggest science and space stories of 2026?", match: /\b(NASA|Artemis|SpaceX|Starship|James Webb|CERN|Nobel Prize)\b/ },
  { id: "world-companies", ask: "What were the biggest business deals and company news of 2026?", match: /\b(acquir|merger|IPO|billion deal|bankruptcy)\b/i },
];

const INSTRUCTIONS = `You write study material from evidence. The evidence is a list of dated question-and-answer facts from collected sources, and it is the only thing you may use.

Write JSON: {"overview": string, "questions": string[]}.
- "overview" answers the broad question directly in at most 170 words and short sentences, most important and most recent first, with exact names, numbers and dates. It reads as plain knowledge: never mention the evidence, a passage, a list or a source, and never state a model's knowledge cutoff.
- If several items compete for "latest", give their dates so the reader sees the order.
- Use only facts in the evidence. Skip minor details such as config flags and driver versions. If the evidence is too thin to answer, set "overview" to "".
- "questions" has ${PARAPHRASES} natural ways a person might ask the same broad question, in different words and lengths. Each one must be fully answered by the overview.`;

interface Pair {
  question: string;
  answer: string;
}

/** Each Wikipedia article's facts, so every 2026 article with enough of them gets its own overview. */
const byArticle = new Map<string, string[]>();

async function evidence(): Promise<string[]> {
  const out: string[] = [];
  for (const f of await readdir(QA_DIR)) {
    if (!f.endsWith(".json") || f.startsWith("dry-")) continue;
    const answer = JSON.parse(await readFile(path.join(QA_DIR, f), "utf8")) as { passageId?: string; json?: { pairs?: Pair[] } };
    for (const p of answer.json?.pairs ?? []) if (typeof p?.question === "string" && typeof p?.answer === "string") out.push(`Q: ${p.question}\nA: ${p.answer}`);
    if (answer.passageId?.startsWith("article:")) {
      const title = answer.passageId.split(":")[1];
      const list = byArticle.get(title) ?? [];
      for (const p of answer.json?.pairs ?? []) if (typeof p?.question === "string" && typeof p?.answer === "string") list.push(`Q: ${p.question}\nA: ${p.answer}`);
      byArticle.set(title, list);
    }
  }
  return out;
}

/** An even, repeatable pick, so the same evidence goes in on every run. */
const pick = (list: string[], n: number) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]));

const numbers = (s: string) => s.match(/\d[\d,.]*\d|\d/g)?.map((n) => n.replace(/[,.]$/, "")) ?? [];

async function ask(topic: Topic, facts: string[]): Promise<{ overview: string; questions: string[]; cost: number }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}` },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({
        model: "accounts/fireworks/models/muse-spark-open",
        temperature: 0.3,
        max_tokens: 8000,
        reasoning_effort: "medium",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: `Broad question: ${topic.ask}\n\nEvidence:\n\n${facts.join("\n\n")}` },
        ],
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const text = body.choices?.[0]?.message?.content ?? "";
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}") as { overview?: string; questions?: string[] };
      const cost = ((body.usage?.prompt_tokens ?? 0) * PRICE_IN + (body.usage?.completion_tokens ?? 0) * PRICE_OUT) / 1e6;
      return { overview: json.overview ?? "", questions: json.questions ?? [], cost };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2 ** (attempt + 2) * 1000));
      continue;
    }
    throw new Error(`Spark Open host: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const only = arg("only")?.split(",") ?? null;
  const maxUsd = Number(arg("max-usd") ?? 5);
  const facts = await evidence();
  console.log(`${facts.length} facts to draw on.`);
  let spent = 0;
  // Every 2026 Wikipedia article with enough written facts gets its own overview, biggest first.
  const articles = [...byArticle.entries()].filter(([, list]) => list.length >= 8).sort((a, b) => b[1].length - a[1].length);
  const articleTopics: Topic[] = articles.map(([title], i) => ({ id: `article-${i + 1}`, ask: `What do you know about ${title}?`, match: /$^/ }));
  const articleFacts = new Map(articleTopics.map((t, i) => [t.id, articles[i][1]]));
  const queue = [...TOPICS, ...articleTopics].filter((t) => !only || only.includes(t.id));
  const worker = async () => {
    for (let topic = queue.shift(); topic; topic = queue.shift()) {
      const file = path.join(OUT, `${topic.id}.json`);
      if (existsSync(file) || spent >= maxUsd) continue;
      const used = pick(articleFacts.get(topic.id) ?? facts.filter((f) => topic.match.test(f)), EVIDENCE_PAIRS);
      if (used.length < 12) {
        console.log(`${topic.id}: only ${used.length} facts, skipped`);
        continue;
      }
      try {
        const { overview, questions, cost } = await ask(topic, used);
        spent += cost;
        const known = new Set(used.flatMap(numbers));
        const unsupported = numbers(overview).filter((n) => !known.has(n));
        await writeFile(file, JSON.stringify({ topic: topic.id, ask: topic.ask, overview, questions, unsupported, evidence: used.length, cost }, null, 1));
        console.log(`${topic.id}: ${used.length} facts, ${overview.split(/\s+/).length} words, ${unsupported.length} unsupported numbers, $${cost.toFixed(3)}`);
      } catch (err) {
        console.warn(`${topic.id}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  const lines: string[] = [];
  for (const f of (await readdir(OUT)).filter((n) => n.endsWith(".json")).sort()) {
    const a = JSON.parse(await readFile(path.join(OUT, f), "utf8")) as { topic: string; ask: string; overview: string; questions: string[]; unsupported: string[] };
    if (!a.overview || a.unsupported.length) continue;
    for (const q of [a.ask, ...a.questions]) {
      lines.push(JSON.stringify({ messages: [{ role: "system", content: KNOWLEDGE_SYSTEM }, { role: "user", content: q }, { role: "assistant", content: a.overview }], source: `anchor:${a.topic}` }));
    }
  }
  await writeFile(path.join(DIR, "dataset", "anchors.jsonl"), lines.join("\n") + "\n");
  console.log(`${lines.length} examples in anchors.jsonl. Spent $${spent.toFixed(2)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
