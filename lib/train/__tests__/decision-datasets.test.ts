/**
 * Decision datasets, pure (lib/train/decision-datasets.ts): reading CSV, JSONL and JSON rows with line numbers;
 * checking labels, the question and every row; merging inputs that fold to the same text and dropping the ones that
 * came with two labels; the split, test held out first, with near-duplicates kept in one split; the spec; and the pages
 * a decide job's GPU reads, laid out from the spec alone: train renderings with balancing copies, dev and test items
 * exactly as decisionItems lays them out, the rows each page needs, and the page cap. All data is made up.
 *
 *   npx tsx --test lib/train/__tests__/decision-datasets.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DECIDE_SYSTEM, NONE_OPTION, decideItem, decisionItems, labelGroups, trainExample, trainRendering } from "@/lib/decide/format";
import type { DecideItem, DecisionLabel, DecisionRow, DecisionSpec } from "@/lib/decide/types";
import {
  BALANCE_COPIES_MAX,
  DECIDE_PAGE_SIZE,
  DECISION_ROWS_MAX,
  balanceCopies,
  checkDecisionUpload,
  checkLabels,
  decideEpochs,
  decisionPage,
  decisionPageCount,
  decisionPageRows,
  decisionPartSize,
  isDecideMode,
  matchLabel,
  mergeDecisionRows,
  parseDecisionCsv,
  parseDecisionJsonl,
  parseDecisionRows,
  sampleRowIndexes,
  splitDecisionRows,
  splitLabels,
  splitRanges,
  splitWants,
  trainLayout,
  trainSeed,
  type DecisionSplit,
} from "../decision-datasets";
import { isNearDuplicate, promptWords, toDatasetView } from "../logic";
import { isModelWriter, modelName, PERSON_WRITER, PUBLIC_WRITER, writerModelOf } from "../models";
import { TICKET_LABELS, TICKET_QUESTION, csvField, ticket, ticketCsv, ticketRows } from "./decision-fixture";

const SEED = "seed-for-tests";
const EM_DASH = String.fromCharCode(0x2014);

/** An upload that must pass: its spec and rows. */
function upload(input: Parameters<typeof checkDecisionUpload>[0], seed = SEED) {
  const result = checkDecisionUpload(input, seed);
  if (!result.ok) assert.fail(`${result.error} ${JSON.stringify(result.problems)}`);
  return result;
}

/** An upload that must fail: its problems' messages. */
function refused(input: Parameters<typeof checkDecisionUpload>[0]) {
  const result = checkDecisionUpload(input, SEED);
  assert.equal(result.ok, false, "refused");
  if (result.ok) throw new Error("unreachable");
  for (const p of result.problems) assert.equal(p.message.includes(EM_DASH), false, "no em dash");
  return result;
}

const tickets = (counts?: number[]) => ({ title: "Ticket router", question: TICKET_QUESTION, labels: TICKET_LABELS, rows: ticketRows(counts) });

/** Every row of a split, by index, as the store hands them to decisionPage. */
const all = (rows: readonly DecisionRow[]) => new Map(rows.map((r, i) => [i, r]));

describe("reading rows", () => {
  it("reads CSV with a header in either order, quotes, commas, line breaks, CRLF, a byte order mark and blank lines", () => {
    const text = '\uFEFFlabel,notes,input\r\nBilling,x,"Charged twice, again"\r\n\r\nShipping,y,"She said ""where is it?""\nand left"\r\nAccount,z,plain text\r\n';
    const { rows, problems } = parseDecisionCsv(text);
    assert.deepEqual(problems, []);
    assert.deepEqual(rows, [
      { line: 2, input: "Charged twice, again", label: "Billing" },
      { line: 4, input: 'She said "where is it?"\nand left', label: "Shipping" },
      { line: 6, input: "plain text", label: "Account" },
    ]);
  });

  it("gives each broken CSV line its number and reads on", () => {
    const text = ["input,label", "fine,Billing", "a, b, Billing", '"closed"oops,Billing', "also fine,Shipping", '"never closed,Billing'].join("\n");
    const { rows, problems } = parseDecisionCsv(text);
    assert.deepEqual(rows.map((r) => r.line), [2, 5]);
    assert.deepEqual(problems.map((p) => p.line), [3, 4, 6]);
    assert.match(problems[0]!.message, /^Line 3 has 3 fields, but the header has 2\. Put text that has commas in double quotes\.$/);
    assert.match(problems[1]!.message, /^Line 4: there is text right after a closing quote/);
    assert.match(problems[2]!.message, /^Line 6: a quoted field is never closed/);
  });

  it("asks for the header when the first line doesn't name both columns", () => {
    for (const text of ["Billing,charged twice", "input,input\nx,y", "text,label\nx,y", ""]) {
      const { rows, problems } = parseDecisionCsv(text);
      assert.equal(rows.length, 0);
      assert.match(problems[0]!.message, /the first line must name the columns, as input,label\./, JSON.stringify(text));
    }
  });

  it("reads JSONL, one object a line, with each bad line's number", () => {
    const text = ['{"input":"charged twice","label":"Billing","extra":1}', "", "not json", '{"input":"x"}', '["input","label"]', '{"input":"late","label":"Shipping"}'].join("\r\n");
    const { rows, problems } = parseDecisionJsonl(text);
    assert.deepEqual(rows, [
      { line: 1, input: "charged twice", label: "Billing" },
      { line: 6, input: "late", label: "Shipping" },
    ]);
    assert.deepEqual(problems, [
      { line: 3, message: "Line 3 isn't valid JSON." },
      { line: 4, message: 'Line 4 must be an object with "input" and "label", both text.' },
      { line: 5, message: 'Line 5 must be an object with "input" and "label", both text.' },
    ]);
  });

  it("reads JSON rows, numbering them from 1", () => {
    assert.deepEqual(parseDecisionRows([{ input: "a", label: "B" }, { input: 3, label: "B" }]), {
      rows: [{ line: 1, input: "a", label: "B" }],
      problems: [{ line: 2, message: 'Row 2 must be an object with "input" and "label", both text.' }],
    });
    assert.equal(parseDecisionRows("a,b").problems[0]!.message, "rows must be a list of {input, label}.");
  });
});

describe("checking the definition", () => {
  it("takes 2 to 12 labels as names or {name, description}, trimmed, with ids made from the names", () => {
    const { labels, problems } = checkLabels(["  Billing ", { name: "Sign-in issues", description: "  Passwords  " }, { name: "Other", description: null }]);
    assert.deepEqual(problems, []);
    assert.deepEqual(labels, [
      { id: "billing", name: "Billing", description: "" },
      { id: "sign-in-issues", name: "Sign-in issues", description: "Passwords" },
      { id: "other", name: "Other", description: "" },
    ]);
  });

  it("refuses labels that can't be told apart, the none text, and names or descriptions out of range", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["Billing", /labels must be a list/],
      [["Only one"], /2 to 12 labels; this has 1/],
      [Array.from({ length: 13 }, (_, i) => `L${i}`), /this has 13/],
      [["Billing", "billing"], /Labels 1 and 2 have the same name/],
      [["Sign in", "sign-in"], /Labels 1 and 2 are too alike: both become "sign-in"/],
      [["Billing", NONE_OPTION], /can't be a label/],
      [["Billing", "none of the listed options matches!"], /can't be a label/],
      [["Billing", "x".repeat(61)], /Label 2's name must be 1 to 60 characters/],
      [["Billing", "  "], /Label 2's name must be 1 to 60 characters/],
      [["Billing", "?!"], /Label 2's name needs a letter or a digit/],
      [["Billing", "Two\nlines"], /Label 2's name must be on one line/],
      [["Billing", { name: "Other", description: "d".repeat(201) }], /description must be at most 200/],
      [["Billing", { name: "Other", description: 5 }], /description must be text/],
      [["Billing", { label: "Other" }], /Label 2 needs a name/],
    ];
    for (const [value, pattern] of cases) {
      const { problems } = checkLabels(value);
      assert.match(problems[0]?.message ?? "", pattern, JSON.stringify(value));
    }
    assert.deepEqual(checkLabels(["Billing", "x".repeat(60)]).problems, [], "60 characters is fine");
    assert.deepEqual(checkLabels(["Billing", "\u{20000}".repeat(60)]).problems, [], "characters, not UTF-16 units");
    assert.match(checkLabels(["Billing", "\u{1F600}"]).problems[0]!.message, /needs a letter or a digit/, "an emoji alone makes no id");
  });

  it("matches a row's label by name ignoring case, or by its id", () => {
    const { labels } = checkLabels(["Billing", "Sign-in issues"]);
    assert.equal(matchLabel(labels, " billing ")?.id, "billing");
    assert.equal(matchLabel(labels, "sign-in-issues")?.id, "sign-in-issues");
    assert.equal(matchLabel(labels, "Sign in issues")?.id, "sign-in-issues", "anything that folds to the id");
    assert.equal(matchLabel(labels, "Shipping"), null);
    assert.equal(matchLabel(labels, ""), null);
  });
});

describe("merging rows", () => {
  it("merges inputs that fold to the same text with the same label, and drops and lists the ones with two labels", () => {
    const rows = [
      { line: 2, input: "Charged twice!", label: "billing" },
      { line: 3, input: "charged   TWICE", label: "billing" },
      { line: 4, input: "Where is it", label: "shipping" },
      { line: 5, input: "where is it?", label: "returns" },
      { line: 6, input: "Fine", label: "account" },
      { line: 7, input: "WHERE IS IT", label: "shipping" },
    ];
    const { rows: kept, report } = mergeDecisionRows(rows);
    assert.deepEqual(kept.map((r) => r.line), [2, 6]);
    assert.deepEqual(report.merged, [{ line: 3, sameAs: 2 }]);
    assert.deepEqual(report.conflicts, [{ lines: [4, 5, 7], labels: ["shipping", "returns"] }]);
  });

  it("keeps inputs with no letters or digits apart unless they are the same text", () => {
    const { rows } = mergeDecisionRows([
      { line: 1, input: "\u{1F44D}", label: "a" },
      { line: 2, input: "\u{1F44E}", label: "b" },
      { line: 3, input: "\u{1F44D}", label: "a" },
    ]);
    assert.deepEqual(rows.map((r) => r.line), [1, 2]);
  });
});

describe("the split", () => {
  const labels = checkLabels(TICKET_LABELS).labels;
  const rowsOf = (counts: number[]) =>
    ticketRows(counts).map((r) => ({ input: r.input, label: matchLabel(labels, r.label)!.id }));

  it("wants 20% to test (at least 5) and 10% to calibrate (at least 3), leaving at least 12 to train", () => {
    assert.deepEqual(splitWants(20), { test: 5, dev: 3 });
    assert.deepEqual(splitWants(27), { test: 5, dev: 3 });
    assert.deepEqual(splitWants(100), { test: 20, dev: 10 });
    for (let n = 20; n <= 400; n++) {
      const w = splitWants(n);
      assert.ok(n - w.test - w.dev >= 12, String(n));
    }
  });

  it("splits each label on its own, every row once, grouped by label in the labels' order", () => {
    const rows = rowsOf([20, 50, 100, 33]);
    const { rows: split, perLabel, problems } = splitDecisionRows(rows, labels, SEED);
    assert.deepEqual(problems, []);
    assert.deepEqual(perLabel, {
      billing: { train: 12, dev: 3, test: 5 },
      shipping: { train: 35, dev: 5, test: 10 },
      account: { train: 70, dev: 10, test: 20 },
      returns: { train: 23, dev: 3, test: 7 },
    });
    const every = [...split.train, ...split.dev, ...split.test].map((r) => r.input).sort();
    assert.deepEqual(every, rows.map((r) => r.input).sort(), "no row lost or repeated");
    for (const part of ["train", "dev", "test"] as const) {
      const order = split[part].map((r) => labels.findIndex((l) => l.id === r.label));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `${part} is grouped by label`);
    }
  });

  it("holds the test rows out first, by the seed's order, and the same seed always splits the same way", () => {
    const rows = rowsOf([40, 40, 40, 40]);
    const a = splitDecisionRows(rows, labels, SEED);
    assert.deepEqual(splitDecisionRows([...rows].reverse(), labels, SEED).rows, a.rows, "the rows' order doesn't matter");
    const b = splitDecisionRows(rows, labels, "another seed");
    assert.notDeepEqual(b.rows.test, a.rows.test, "another seed holds out other rows");
    assert.equal(b.rows.test.length, a.rows.test.length);
  });

  it("keeps near-duplicates in one split, across labels too, so no test row has a near-twin in train", () => {
    const rows = rowsOf([30, 30, 30, 30]);
    // A small edit of one row, and a reordering of another row given to another label.
    const twin = { input: `${rows[0]!.input} please`, label: rows[0]!.label };
    const cross = { input: rows[1]!.input.split(" ").reverse().join(" "), label: "returns" };
    assert.ok(isNearDuplicate(promptWords(twin.input), promptWords(rows[0]!.input)));
    const withTwins = [...rows, twin, cross];
    const { rows: split } = splitDecisionRows(withTwins, labels, SEED);
    const partOf = (input: string) => (["train", "dev", "test"] as const).find((p) => split[p].some((r) => r.input === input));
    assert.equal(partOf(twin.input), partOf(rows[0]!.input));
    assert.equal(partOf(cross.input), partOf(rows[1]!.input));
    for (const t of split.test) {
      for (const r of [...split.train, ...split.dev]) assert.equal(isNearDuplicate(promptWords(t.input), promptWords(r.input)), false);
    }
  });

  it("refuses a label whose examples are too alike to hold out 5 and 3 and still train on 12", () => {
    const rows = [...rowsOf([30, 30, 30, 0]), ...Array.from({ length: 25 }, (_, i) => ({ input: `return this jacket now please thanks ${i}`, label: "returns" }))];
    const { problems } = splitDecisionRows(rows, labels, SEED);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /^"Returns": too many of its examples are near-copies/);
  });
});

describe("the upload", () => {
  it("saves a spec with the question, labels, seed and counts, from JSON rows, CSV or JSONL alike", () => {
    const fromRows = upload(tickets());
    assert.equal(fromRows.title, "Ticket router");
    assert.deepEqual(fromRows.spec, {
      version: 1,
      question: TICKET_QUESTION,
      labels: [
        { id: "billing", name: "Billing", description: "Charges, refunds and invoices" },
        { id: "shipping", name: "Shipping", description: "Delivery, tracking and damaged parcels" },
        { id: "account", name: "Account", description: "Sign-in, passwords and profile" },
        { id: "returns", name: "Returns", description: "" },
      ],
      seed: SEED,
      split: { train: 84, dev: 12, test: 24 },
      perLabel: Object.fromEntries(["billing", "shipping", "account", "returns"].map((id) => [id, { train: 21, dev: 3, test: 6 }])),
      source: "person",
    });
    assert.deepEqual(fromRows.rows.test[0], { input: fromRows.rows.test[0]!.input, label: "billing" }, "rows carry the label's id");
    const { rows: _rows, ...base } = tickets();
    const fromCsv = upload({ ...base, csv: ticketCsv(ticketRows()) });
    const fromJsonl = upload({ ...base, jsonl: ticketRows().map((r) => JSON.stringify(r)).join("\n") });
    assert.deepEqual(fromCsv.spec, fromRows.spec);
    assert.deepEqual(fromCsv.rows, fromRows.rows);
    assert.deepEqual(fromJsonl.rows, fromRows.rows);
    assert.deepEqual(fromRows.report, { read: 120, kept: 120, merged: [], conflicts: [], perLabel: fromRows.spec.perLabel, warnings: [] });
  });

  it("names a dataset sent without a title after its question, and takes labels by id", () => {
    const rows = ticketRows().map((r) => ({ ...r, label: r.label.toLowerCase() }));
    const result = upload({ question: "  Which team should handle this support ticket, given everything it says?  ", labels: TICKET_LABELS, rows });
    assert.equal(result.title, "Which team should handle this support ticket, given");
    assert.equal(result.spec.question, "Which team should handle this support ticket, given everything it says?");
  });

  it("reports merged rows and drops an input sent with two labels, and warns when one label has over 5 times another's rows", () => {
    const rows = ticketRows([110, 21, 21, 21]);
    rows.push({ input: rows[0]!.input.toUpperCase(), label: "Billing" }, { input: rows[1]!.input, label: "Returns" });
    const result = upload({ ...tickets(), rows });
    assert.equal(result.report.read, 175);
    assert.equal(result.report.kept, 172);
    assert.deepEqual(result.report.merged, [{ line: 174, sameAs: 1 }]);
    assert.deepEqual(result.report.conflicts, [{ lines: [2, 175], labels: ["shipping", "returns"] }]);
    assert.equal(result.spec.perLabel.shipping!.train + result.spec.perLabel.shipping!.dev + result.spec.perLabel.shipping!.test, 20);
    assert.equal(result.report.warnings.length, 2);
    assert.match(result.report.warnings[0]!, /^"Billing" has 110 examples, more than 5 times the 20 of "Shipping"\./);
    assert.match(result.report.warnings[1]!, /^1 input came with two different labels, so its rows were left out\.$/);
  });

  it("lists every row problem with its line, and each unknown label once with its lines", () => {
    const rows = ticketRows();
    const text = ticketCsv(rows).split("\n");
    text[3] = `${csvField("x".repeat(3001))},Billing`;
    text[5] = `${csvField("  ")},Shipping`;
    text[7] = `${csvField("where is my order")},Shiping`;
    text[9] = `${csvField("still nothing")},Shiping`;
    text[11] = `${csvField("hm")},`;
    const { rows: _rows, ...base } = tickets();
    const result = refused({ ...base, csv: text.join("\n") });
    assert.deepEqual(
      result.problems.map((p) => [p.line, p.message]),
      [
        [4, "Line 4: the input must be 1 to 3,000 characters."],
        [6, "Line 6: the input must be 1 to 3,000 characters."],
        [8, `The label "Shiping" isn't one of this decision's labels (lines 8 and 10).`],
        [12, "An empty label isn't one of this decision's labels (line 12)."],
      ],
    );
    assert.match(result.error, /^The upload has 4 problems\. The first: Line 4:/);
  });

  it("refuses too few rows for a label, after merging", () => {
    const rows = ticketRows([30, 19, 30, 30]);
    const result = refused({ ...tickets(), rows });
    assert.equal(result.error, '"Shipping" has 19 examples; each label needs at least 20.');
    rows.push({ input: rows[1]!.input, label: "Shipping" });
    const merged = refused({ ...tickets(), rows: [...ticketRows([30, 20, 30, 30]), { input: ticket("Shipping", 0), label: "Returns" }] });
    assert.equal(merged.error, '"Shipping" has 19 examples after repeats are merged; each label needs at least 20.');
  });

  it("refuses a bad question, title or labels, rows sent two ways or none, and more than 3,000 rows", () => {
    const base = tickets();
    assert.match(refused({ ...base, question: "Why" }).error, /The question must be 5 to 300 characters\./);
    assert.match(refused({ ...base, title: 7 }).error, /title must be text\./);
    assert.match(refused({ ...base, labels: ["Billing"] }).error, /2 to 12 labels/);
    assert.match(refused({ ...base, csv: "input,label" }).error, /Send the rows one way/);
    assert.match(refused({ ...base, rows: undefined }).error, /Send the rows one way/);
    assert.match(refused({ ...base, rows: undefined, csv: 5 }).error, /csv must be text\./);
    assert.match(refused({ ...base, rows: [] }).error, /The upload has no rows\./);
    const many = Array.from({ length: DECISION_ROWS_MAX + 1 }, (_, i) => ({ input: `row ${i}`, label: "Billing" }));
    assert.equal(refused({ ...base, rows: many }).error, "The upload has 3,001 rows; a decision dataset takes at most 3,000.");
    const problems = refused({ ...base, rows: Array.from({ length: 30 }, () => ({ input: 1 })) }).problems;
    assert.equal(problems.length, 21, "20 listed, then how many more");
    assert.equal(problems.at(-1)!.message, "And 10 more.");
  });
});

describe("the pages a decide job reads", () => {
  /** A saved upload's spec and rows. */
  const saved = (counts: number[], labels = TICKET_LABELS) => {
    const names = labels.map((l) => l.name);
    const rows = ticketRows(counts.slice(0, 4)).filter((r) => names.includes(r.label));
    // Labels past the fixture's four get rows of their own words.
    labels.slice(4).forEach((l, k) => {
      for (let i = 0; i < counts[4 + k]!; i++) rows.push({ input: `${l.name} topic number ${i} with ${k * 1000 + i} and ${k * 7000 + i * 3}`, label: l.name });
    });
    return upload({ question: TICKET_QUESTION, labels, rows });
  };

  it("reads epochs and the mode from a job's params", () => {
    assert.equal(decideEpochs({}), 2);
    assert.equal(decideEpochs({ epochs: 3 }), 3);
    assert.equal(decideEpochs({ epochs: "4" }), 4);
    for (const epochs of [0, 5, 1.5, "x", null]) assert.equal(decideEpochs({ epochs }), 2, String(epochs));
    assert.equal(isDecideMode({ mode: "decide" }), true);
    assert.equal(isDecideMode({ mode: "chat" }), false);
    assert.equal(isDecideMode(null), false);
  });

  it("repeats a smaller label's rows up to 3 times so the largest has at most 3 times its renderings", () => {
    const spec = (train: number[]): DecisionSpec => ({
      version: 1,
      question: TICKET_QUESTION,
      labels: train.map((_, i) => ({ id: `l${i}`, name: `L${i}`, description: "" })),
      seed: SEED,
      split: { train: 0, dev: 0, test: 0 },
      perLabel: Object.fromEntries(train.map((n, i) => [`l${i}`, { train: n, dev: 3, test: 5 }])),
      source: "person",
    });
    assert.deepEqual(balanceCopies(spec([100, 100])), { l0: 1, l1: 1 });
    assert.deepEqual(balanceCopies(spec([100, 34, 33, 12])), { l0: 1, l1: 1, l2: 2, l3: 3 });
    assert.deepEqual(balanceCopies(spec([900, 100, 12])), { l0: 1, l1: 3, l2: BALANCE_COPIES_MAX });
  });

  it("lays train out as every row's epochs x copies renderings, each once, with labels mixed from the first page", () => {
    const { spec, rows } = saved([60, 20, 20, 30]);
    const copies = balanceCopies(spec);
    assert.deepEqual({ ...copies }, { billing: 1, shipping: 2, account: 2, returns: 1 });
    const layout = trainLayout(spec, 2);
    const labels = splitLabels(spec, "train");
    assert.equal(layout.length, decisionPartSize(spec, "train", 2));
    // 60 rows train 42, 20 train 12 and 30 train 21: the 12s get 2 copies, so 4 renderings each over 2 epochs.
    assert.equal(layout.length, (42 + 21) * 2 + (12 + 12) * 4);
    assert.equal(new Set(layout.map((s) => `${s.row}:${s.copy}`)).size, layout.length, "each rendering once");
    for (let row = 0; row < rows.train.length; row++) {
      const mine = layout.filter((s) => s.row === row).map((s) => s.copy);
      assert.deepEqual(mine, Array.from({ length: 2 * copies[labels[row]!]! }, (_, c) => c), `row ${row}`);
    }
    const first = new Set(layout.slice(0, DECIDE_PAGE_SIZE).map((s) => labels[s.row]));
    assert.equal(first.size, 4, "every label on the first page");
    assert.deepEqual(trainLayout(spec, 2), layout, "deterministic");
  });

  it("renders train pages as TrainExample rows: the system message, the task twice, one letter for the right label or none", () => {
    const { spec, rows } = saved([30, 30, 30, 30]);
    const layout = trainLayout(spec, 2);
    const page = decisionPage(spec, "train", 2, 1, all(rows.train));
    assert.equal(page.items.length, DECIDE_PAGE_SIZE);
    assert.equal(page.total, layout.length);
    assert.equal(page.nextPage, 2);
    page.items.forEach((item, k) => {
      const { row, copy } = layout[DECIDE_PAGE_SIZE + k]!;
      const r = rows.train[row]!;
      const rendering = trainRendering({ state: r.input, question: spec.question, labels: spec.labels, answer: r.label, seed: trainSeed(spec, row, copy) });
      assert.deepEqual(item, trainExample(rendering));
      const ex = item as { messages: Array<{ role: string; content: string }> };
      assert.equal(ex.messages[0]!.content, DECIDE_SYSTEM);
      assert.match(ex.messages[2]!.content, /^[A-E]$/);
    });
    const last = Math.ceil(layout.length / DECIDE_PAGE_SIZE) - 1;
    assert.equal(decisionPage(spec, "train", 2, last, all(rows.train)).nextPage, null);
    assert.deepEqual(decisionPage(spec, "train", 2, last + 1, all(rows.train)).items, [], "past the end");
  });

  for (const labelCount of [4, 6]) {
    it(`serves dev and test items exactly as decisionItems lays them out, ${labelCount} labels, with no answers`, () => {
      const labels: Array<{ name: string; description: string }> = [...TICKET_LABELS, { name: "Fraud", description: "" }, { name: "Press", description: "" }].slice(0, labelCount);
      const { spec, rows } = saved([30, 25, 40, 30, 20, 24], labels);
      for (const split of ["dev", "test"] as const) {
        const whole = decisionItems({ question: spec.question, labels: spec.labels, rows: rows[split], part: split });
        const served: DecideItem[] = [];
        for (let page = 0; ; page++) {
          const p = decisionPage(spec, split, 2, page, all(rows[split]));
          served.push(...(p.items as DecideItem[]));
          assert.equal(p.total, whole.length);
          if (p.nextPage === null) break;
          assert.equal(p.nextPage, page + 1);
        }
        assert.deepEqual(served, whole.map((i) => decideItem(i.index, i.row, i.group, i.rendering)));
        for (const item of served) assert.deepEqual(Object.keys(item).sort(), ["group", "index", "letters", "messages", "row"]);
        assert.equal(decisionPartSize(spec, split, 2), whole.length);
      }
      const groups = labelGroups(spec.labels).length;
      assert.equal(groups, labelCount > 4 ? 2 : 1);
      const test = decisionItems({ question: spec.question, labels: spec.labels, rows: rows.test, part: "test" });
      assert.ok(test.some((i) => i.decline), "test has the decline check");
      assert.ok(!decisionItems({ question: spec.question, labels: spec.labels, rows: rows.dev, part: "dev" }).some((i) => i.decline));
    });
  }

  it("reads only the rows a page renders, and refuses rows that don't match the spec", () => {
    const { spec, rows } = saved([100, 100, 100, 100]);
    const need = decisionPageRows(spec, "test", 2, 0);
    assert.deepEqual(need, Array.from({ length: DECIDE_PAGE_SIZE }, (_, i) => i), "one item a row with 4 labels");
    const some = new Map(need.map((i) => [i, rows.test[i]!]));
    assert.deepEqual(decisionPage(spec, "test", 2, 0, some).items, decisionPage(spec, "test", 2, 0, all(rows.test)).items);
    const trainNeed = decisionPageRows(spec, "train", 2, 3);
    assert.ok(trainNeed.length <= DECIDE_PAGE_SIZE);
    assert.doesNotThrow(() => decisionPage(spec, "train", 2, 3, new Map(trainNeed.map((i) => [i, rows.train[i]!]))));
    some.delete(need[3]!);
    assert.throws(() => decisionPage(spec, "test", 2, 0, some), /test row 3 doesn't match its spec/);
    const wrong = all(rows.test);
    wrong.set(0, { ...rows.test[0]!, label: "returns" });
    assert.throws(() => decisionPage(spec, "test", 2, 0, wrong), /test row 0 doesn't match its spec/);
  });

  it("counts a job's pages in all, for the route's cap", () => {
    const { spec } = saved([30, 30, 30, 30]);
    const pages = (split: DecisionSplit) => Math.ceil(decisionPartSize(spec, split, 2) / DECIDE_PAGE_SIZE);
    assert.equal(decisionPageCount(spec, 2), pages("train") + pages("dev") + pages("test"));
    assert.equal(decisionPartSize(spec, "dev", 2), 12);
    assert.equal(decisionPartSize(spec, "test", 2), 24 + 24, "every test row, then each again with its label taken out");
    assert.equal(decisionPartSize(spec, "train", 4), 2 * decisionPartSize(spec, "train", 2));
  });

  it("keeps the worst page under 4 MB: 3,000-character states that JSON escapes twice, the longest question and labels", () => {
    // Control characters are the worst case: JSON.stringify writes each as \u0001, and the reply escapes that again.
    const labels = checkLabels(["A", "B", "C", "D"].map((n) => ({ name: `${n}${"\u0002".repeat(59)}`, description: "\u0003".repeat(200) }))).labels;
    assert.equal(labels.length, 4);
    const spec: DecisionSpec = {
      version: 1,
      question: "\u0004".repeat(300),
      labels,
      seed: SEED,
      split: { train: 80, dev: 12, test: 80 },
      perLabel: Object.fromEntries(labels.map((l) => [l.id, { train: 20, dev: 3, test: 20 }])),
      source: "person",
    };
    const state = "\u0001".repeat(3000);
    for (const split of ["train", "test"] as const) {
      const rows = all(splitLabels(spec, split).map((label) => ({ input: state, label })));
      const page = decisionPage(spec, split, 2, 0, rows);
      assert.equal(page.items.length, DECIDE_PAGE_SIZE);
      const bytes = Buffer.byteLength(JSON.stringify({ kind: "decision", items: page.items, nextPage: page.nextPage, total: page.total, title: "t".repeat(200) }));
      assert.ok(bytes < 4 * 1024 * 1024, `${split}: ${bytes} bytes`);
      assert.ok(bytes > 2 * 1024 * 1024, `${split}: near the limit (${bytes} bytes), so the case is the worst one`);
    }
  });

  it("samples the first rows of each label", () => {
    const { spec } = saved([30, 30, 30, 30]);
    const ranges = splitRanges(spec, "train");
    assert.deepEqual(ranges.map((r) => [r.id, r.from, r.to]), [
      ["billing", 0, 21],
      ["shipping", 21, 42],
      ["account", 42, 63],
      ["returns", 63, 84],
    ]);
    assert.deepEqual(sampleRowIndexes(spec, "train", 2), [0, 1, 21, 22, 42, 43, 63, 64]);
  });

  it("names a person's dataset's writer as what it is, never Muse Spark 1.3, and keeps chat views as they were", () => {
    assert.equal(writerModelOf({ writerModel: PERSON_WRITER }), "person");
    assert.equal(modelName(PERSON_WRITER), "The person who uploaded it");
    assert.equal(modelName(PUBLIC_WRITER), "Public datasets");
    assert.equal(modelName("muse-wonder-1.0"), "Muse Wonder");
    assert.equal(isModelWriter(PERSON_WRITER), false);
    assert.equal(isModelWriter(PUBLIC_WRITER), false);
    assert.equal(isModelWriter("muse-wonder-1.0"), true);
    assert.equal(isModelWriter("toString"), true, "only its own two values");
    const { spec } = upload(tickets());
    const head = {
      id: "d1",
      title: "Ticket router",
      task: TICKET_QUESTION,
      status: "ready" as const,
      requested: 120,
      trainCount: 84,
      evalCount: 24,
      costUsd: 0,
      error: null,
      createdBy: null,
      createdAt: new Date("2026-10-31T12:00:00.000Z"),
      finishedAt: new Date("2026-10-31T12:00:00.000Z"),
      workflowRunId: null,
      writerModel: PERSON_WRITER,
    };
    const view = toDatasetView({ ...head, kind: "decision", decision: spec });
    assert.equal(view.kind, "decision");
    assert.deepEqual(view.decision, spec);
    assert.equal(view.writerModel, "person");
    const chat = toDatasetView({ ...head, kind: "chat", decision: null, writerModel: "muse-wonder-1.0" });
    assert.equal("kind" in chat || "decision" in chat, false);
  });

  it("writes no em dash anywhere a person reads", () => {
    const result = upload({ ...tickets([110, 21, 21, 21]) });
    for (const w of result.report.warnings) assert.equal(w.includes(EM_DASH), false);
    const labels: DecisionLabel[] = result.spec.labels;
    assert.equal(labels.length, 4);
  });
});
