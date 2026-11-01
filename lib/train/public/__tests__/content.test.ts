/**
 * What a run may be trained to do: the one model check with the model faked (never a real Meta call), the PII pattern
 * scan with its false-positive checks, findings and logs that never carry the matched text, and the fixed rules every
 * visitor task ends with. Every "personal detail" below is made up for the test.
 *
 *   npx tsx --test lib/train/public/__tests__/content.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { StructuredOptions, StructuredResult } from "@/lib/brief/structured";
import { REFUSE_WHEN } from "@/lib/prompts/brief";
import { DATASET_TASK_MAX } from "@/lib/train/logic";

const saved = { ...process.env };
let C: typeof import("../content");

before(async () => {
  delete process.env.TEST_MODEL;
  delete process.env.VERCEL_ENV;
  C = await import("../content");
});

after(() => {
  process.env = saved;
});

function fake(data: { reason: string; allowed: boolean; refusal: string | null }) {
  const calls: StructuredOptions<unknown>[] = [];
  return {
    calls,
    deps: {
      model: () => "muse-wonder-1.0",
      respond: async <T>(opts: StructuredOptions<T>): Promise<StructuredResult<T>> => {
        calls.push(opts as StructuredOptions<unknown>);
        const parsed = opts.schema.parse(opts.normalize ? opts.normalize(data) : data);
        return { data: parsed, usage: [], issues: [], attempts: 1 };
      },
    },
  };
}

describe("checkTrainingTask", () => {
  it("makes one call with REFUSE_WHEN, no real people's data and one narrow skill, and passes an allowed task", async () => {
    const f = fake({ reason: "A narrow bakery helper.", allowed: true, refusal: null });
    const got = await C.checkTrainingTask({ task: "Answer questions for a made-up bakery.", rows: [{ prompt: "Open Sunday?", answer: "8 to 2." }] }, f.deps);
    assert.deepEqual(got, { ok: true, usage: [] });
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.model, "muse-wonder-1.0");
    assert.ok(call.instructions.includes(REFUSE_WHEN));
    assert.match(call.instructions, /real people's data/);
    assert.match(call.instructions, /one narrow skill/);
    assert.doesNotMatch(call.instructions, /—/, "no em dashes");
    const text = JSON.stringify(call.content);
    assert.match(text, /made-up bakery/);
    assert.match(text, /Open Sunday\?/);
  });

  it("refuses with the model's words, or a plain fallback", async () => {
    const f = fake({ reason: "General assistant.", allowed: false, refusal: "That's not one narrow skill. Try one kind of question." });
    assert.deepEqual(await C.checkTrainingTask({ task: "Do anything at all." }, f.deps), {
      ok: false,
      refusal: "That's not one narrow skill. Try one kind of question.",
      usage: [],
    });
    const g = fake({ reason: "x", allowed: false, refusal: null });
    const got = await C.checkTrainingTask({ task: "x" }, g.deps);
    assert.ok(!got.ok);
    assert.equal(got.refusal, C.DEFAULT_TASK_REFUSAL);
  });

  it("caps what it sends: the task to the dataset limit, 20 rows, 300 characters a side", async () => {
    const f = fake({ reason: "ok", allowed: true, refusal: null });
    const rows = Array.from({ length: 30 }, (_, i) => ({ prompt: `q${i} ${"p".repeat(400)}`, answer: "a".repeat(400) }));
    await C.checkTrainingTask({ task: "t".repeat(DATASET_TASK_MAX + 500), rows }, f.deps);
    const text = (f.calls[0].content[0] as { text: string }).text;
    assert.ok(text.includes("(30 in all)"));
    assert.ok(text.includes("q19 ") && !text.includes("q20 "));
    assert.ok(!text.includes("p".repeat(301)));
    assert.ok(!text.includes("t".repeat(DATASET_TASK_MAX + 1)));
  });

  it("uses TEST_MODEL off production and Muse Wonder on it", async () => {
    process.env.TEST_MODEL = "muse-spark-1.3-contributor";
    assert.equal(C.checkModel(), "muse-spark-1.3-contributor");
    process.env.VERCEL_ENV = "production";
    assert.equal(C.checkModel(), "muse-wonder-1.0");
    delete process.env.TEST_MODEL;
    delete process.env.VERCEL_ENV;
    assert.equal(C.checkModel(), "muse-wonder-1.0");
  });
});

// Made-up details, each of which the scan must find. None is a real person's.
const FOUND: Array<[import("../content").PiiKind, string]> = [
  ["email", "Write to jordan.reyes@gmail.com for orders."],
  ["email", "cc: a_b+c@mail.co.uk"],
  ["phone", "Call (512) 867-5309 after six."],
  ["phone", "My cell is 512-867-5309."],
  ["phone", "Ring +44 20 7946 0958 in London."],
  ["phone", "Text 512.867.5309 please."],
  ["card", "Card 4111 1111 1111 1111 exp 04/29"],
  ["card", "Pay with 5500-0000-0000-0004."],
  ["card", "378282246310005 is the Amex."],
  ["government_id", "SSN 123-45-6789 on file."],
  ["government_id", "My number is 078-05-1121."],
  ["government_id", "NI number AB 12 34 56 C"],
  ["government_id", "passport number X1234567 please"],
  ["government_id", "driver's license: D1234-5678-90"],
  ["street_address", "Deliver to 1600 Pennsylvania Avenue tomorrow."],
  ["street_address", "We're at 42 Elm St. downtown."],
  ["street_address", "Ship it to 221 Baker Street, London."],
];

// Ordinary text the scan must leave alone.
const CLEAN = [
  "Write to name@example.com or orders@bakery.test for a made-up address.",
  "Our fictional line is 555-0134, or (512) 555-0199.",
  "We open 2026-11-04 at 10:30 and close at 18:00.",
  "A dozen costs $1,234.56, or 12.50 each.",
  "Version 1.2.3 shipped on 11/04/2026.",
  "Order 4111 1111 1111 1112 is not a card.",
  "Take 2 tablets every 4 hours, 7 days a week.",
  "Bring passport photos and a pen.",
  "Chapter 3 Drive safely, chapter 4 Road signs.",
  "Room 101, gate B12, flight UA 1234.",
  "Our zip is 78701 and we have 3 ovens.",
  "@bakery on social, #nutfree",
  "Score 98-100 on the test.",
  "0000 0000 0000 0000",
];

describe("piiFindings", () => {
  it("finds each kind, in the task and in rows, saying where and how many", () => {
    for (const [kind, text] of FOUND) {
      const got = C.piiFindings({ task: text });
      assert.deepEqual(
        got.map((f) => f.kind),
        [kind],
        `${kind}: ${text}`,
      );
      assert.equal(got[0].where, "task");
      assert.equal(got[0].count, 1);
    }
    const rows = [
      { prompt: "Hours?", answer: "8 to 2." },
      { prompt: "Email me at jordan.reyes@gmail.com", answer: "Sure, and call 512-867-5309." },
    ];
    assert.deepEqual(C.piiFindings({ task: "A made-up bakery helper.", rows }), [
      { kind: "email", where: { row: 2, field: "prompt" }, count: 1 },
      { kind: "phone", where: { row: 2, field: "answer" }, count: 1 },
    ]);
    assert.deepEqual(C.piiFindings({ task: "a@gmail.com and b@yahoo.com" }), [{ kind: "email", where: "task", count: 2 }]);
  });

  it("leaves ordinary text, example addresses, fictional numbers and non-cards alone", () => {
    for (const text of CLEAN) assert.deepEqual(C.piiFindings({ task: text }), [], text);
    assert.deepEqual(C.piiFindings({}), []);
  });

  it("never carries the matched text in findings, sentences or the log line", () => {
    const rows = FOUND.map(([, text], i) => ({ prompt: `q${i}`, answer: text }));
    const findings = C.piiFindings({ task: FOUND[0][1], rows });
    assert.equal(new Set(findings.map((f) => f.kind)).size, 5);
    const out = JSON.stringify(findings) + C.piiSentences(findings).join(" ") + C.piiLogLine(findings);
    for (const secret of ["jordan.reyes", "gmail.com", "867-5309", "7946", "4111", "5500", "378282", "123-45", "078-05", "AB 12", "X1234567", "D1234", "1600 Pennsylvania", "Elm St", "Baker Street"]) {
      assert.ok(!out.includes(secret), secret);
    }
  });

  it("says where in plain sentences", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ prompt: "q", answer: `call 512-867-53${10 + i}` }));
    const sentences = C.piiSentences(C.piiFindings({ task: "write to a@gmail.com", rows }));
    assert.deepEqual(sentences, [
      "The task has what looks like an email address. Take out real people's details, or use made-up ones.",
      "Rows 1, 2, 3 and 2 more have what looks like a phone number. Take out real people's details, or use made-up ones.",
    ]);
    assert.deepEqual(C.piiSentences(C.piiFindings({ rows: [{ prompt: "SSN 123-45-6789", answer: "ok" }] })), [
      "Row 1 has what looks like a government id number. Take out real people's details, or use made-up ones.",
    ]);
    assert.deepEqual(C.piiSentences(C.piiFindings({ task: "42 Elm St", rows: [{ prompt: "ok", answer: "221 Baker Street" }] })), [
      "The task and row 1 have what looks like a street address. Take out real people's details, or use made-up ones.",
    ]);
  });
});

describe("contentFindings", () => {
  it("has plan.ts's shape: empty for a clean plan, sentences otherwise, and logs no matched text", () => {
    assert.deepEqual(C.contentFindings({ note: "Answer questions for a made-up bakery.", rows: [] }), []);
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    let got: string[];
    try {
      got = C.contentFindings({ note: "Call 512-867-5309", rows: [{ prompt: "mail jordan.reyes@gmail.com", answer: "ok" }] });
    } finally {
      methods.forEach((m, i) => (console[m] = originals[i]));
    }
    assert.equal(got.length, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /pii scan: 2 place\(s\), kinds email,phone/);
    for (const l of lines) assert.ok(!l.includes("867-5309") && !l.includes("jordan.reyes"));
  });
});

describe("the fixed rules", () => {
  it("end every visitor task once, within the dataset task limit, cutting the task and never the rules", () => {
    const short = C.withVisitorRules("Answer questions for a made-up bakery.");
    assert.ok(short.startsWith("Answer questions for a made-up bakery."));
    assert.ok(short.endsWith(C.VISITOR_TASK_RULES));
    assert.equal(C.withVisitorRules(short), short, "added once");
    const long = C.withVisitorRules("x".repeat(DATASET_TASK_MAX * 2));
    assert.equal(long.length, DATASET_TASK_MAX);
    assert.ok(long.endsWith(C.VISITOR_TASK_RULES));
    assert.match(C.VISITOR_TASK_RULES, /personal details/);
    assert.doesNotMatch(C.VISITOR_TASK_RULES, /—/);
  });
});
