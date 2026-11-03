import { KNOWLEDGE_SYSTEM } from "@/lib/knowledge/dataset";
import type { Passage } from "@/lib/knowledge/passages";
import { checkQa, QA_INSTRUCTIONS, qaRequestText, type PassageQa } from "@/lib/knowledge/qa";

/**
 * The self-hosted Muse Spark Open take (scripts/knowledge/spark-take.ts): Spark Open on a GPU we start ourselves writes
 * training rows from a few invented passages, on camera, through the knowledge run's own instructions and checks
 * (lib/knowledge/qa.ts). It talks to any Chat Completions server: the SageMaker relay (scripts/knowledge/aws/relay.py)
 * or vLLM or SGLang on a rented node. No real text goes in, and nothing here starts or stops a GPU.
 */

/** At most this many passages per take, so a mistyped command can't run up a long bill on a shared host. */
export const TAKE_MAX_PASSAGES = 6;

/** Invented places and events, so the rows teach nothing real and quote nobody. */
export const INVENTED_PASSAGES: Passage[] = [
  {
    id: "invented:port-wren-lantern-fair",
    kind: "source",
    header: "Invented sample for a demo | Port Wren Lantern Fair, October 2026",
    text:
      "The town of Port Wren held its first Lantern Fair on October 3, 2026. Organizers counted 412 paper lanterns floated on Gull Pond, " +
      "made by 9 school classes. The fair raised 2,300 dollars for the town library. Mayor Odile Varn said the fair will return in 2027.",
    date: "2026-10-03",
    url: "invented://port-wren-lantern-fair",
    words: 52,
  },
  {
    id: "invented:tessel-valley-ferry",
    kind: "source",
    header: "Invented sample for a demo | Tessel Valley ferry, September 2026",
    text:
      "On September 14, 2026, the Tessel Valley ferry began running every 20 minutes instead of every 45. The change followed a vote of " +
      "the valley council, 7 to 2. The ferry carries up to 60 riders and 12 bicycles. Its new electric boat, the Marrow Finch, was built in Lisk.",
    date: "2026-09-14",
    url: "invented://tessel-valley-ferry",
    words: 56,
  },
  {
    id: "invented:quillbrook-seed-library",
    kind: "source",
    header: "Invented sample for a demo | Quillbrook seed library, August 2026",
    text:
      "The Quillbrook seed library opened on August 22, 2026, in the old fire station on Copper Lane. It lends 140 kinds of seeds, and " +
      "borrowers return seeds from their own harvest. Volunteer Ines Palo started it after a dry summer in 2025.",
    date: "2026-08-22",
    url: "invented://quillbrook-seed-library",
    words: 46,
  },
  {
    id: "invented:harrow-point-robot-league",
    kind: "source",
    header: "Invented sample for a demo | Harrow Point robot league, July 2026",
    text:
      "The Harrow Point robot league finished its season on July 18, 2026. Team Copperfox won the final 3 matches to 1, with a robot that " +
      "sorts colored blocks. 16 teams took part, from 5 schools. Next season starts in February 2027.",
    date: "2026-07-18",
    url: "invented://harrow-point-robot-league",
    words: 45,
  },
];

/** "sagemaker-own", "lambda-own": what the rows say about where the writer ran. Lowercase letters, digits and dashes. */
export function hostLabel(raw: string | undefined): string | null {
  const label = (raw ?? "").trim();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(label) ? label : null;
}

export interface TakeRow {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  release: {
    writer: string;
    passage_id: string;
    written_at: string;
    ms: number;
    note: string;
  };
}

/** One training row per kept pair, in the published dataset's shape (system, question, answer). */
export function takeRows(qa: PassageQa, writer: string, ms: number, writtenAt: string): TakeRow[] {
  return qa.pairs.map((pair) => ({
    messages: [
      { role: "system", content: KNOWLEDGE_SYSTEM },
      { role: "user", content: pair.question },
      { role: "assistant", content: pair.answer },
    ],
    release: {
      writer,
      passage_id: qa.passageId,
      written_at: writtenAt,
      ms,
      note: "Invented passage, model-written row. Built with Muse Spark Open.",
    },
  }));
}

export interface WriterServer {
  /** The Chat Completions root, such as http://127.0.0.1:18787/v1. */
  baseUrl: string;
  model: string;
  /** Sent as a bearer token when set. Never logged. */
  key?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface WriterReply {
  qa: PassageQa;
  ms: number;
  outputTokens: number | null;
}

/** One passage through the server with the knowledge run's instructions and settings, then its checks. */
export async function writePassage(server: WriterServer, p: Passage): Promise<WriterReply> {
  const started = Date.now();
  const res = await (server.fetchImpl ?? fetch)(`${server.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(server.key ? { Authorization: `Bearer ${server.key}` } : {}) },
    signal: AbortSignal.timeout(server.timeoutMs ?? 600_000),
    body: JSON.stringify({
      model: server.model,
      temperature: 0.4,
      max_tokens: 6000,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: QA_INSTRUCTIONS },
        { role: "user", content: qaRequestText(p) },
      ],
    }),
  });
  if (!res.ok) {
    // The body can echo the request, never the key, but keep it short.
    throw new Error(`writer server: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { completion_tokens?: number } };
  const text = body.choices?.[0]?.message?.content ?? "";
  let raw: unknown = {};
  try {
    raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}");
  } catch {
    raw = {};
  }
  return { qa: checkQa(raw, p), ms: Date.now() - started, outputTokens: body.usage?.completion_tokens ?? null };
}

/** A stand-in writer for rehearsing the command with no server and no spend. Its rows say so. */
export function fakeReply(p: Passage): unknown {
  const first = p.text.split(". ")[0].replace(/\.$/, "");
  return {
    pairs: [{ question: `Fake writer, rehearsal only: what does this say about ${p.header.split("| ")[1]}?`, answer: `${first}.` }],
    probe: null,
  };
}
