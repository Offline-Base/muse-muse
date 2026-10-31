import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  applyTemperature,
  combineGroups,
  DECIDE_LETTERS,
  DECIDE_MAX_TOKENS,
  DECIDE_READ,
  DECIDE_SEPARATOR,
  DECIDE_SYSTEM,
  decideItem,
  decideJson,
  decideMessages,
  decidePrompt,
  decideRenderings,
  decideTask,
  decideUserMessage,
  decisionFromScores,
  decisionItems,
  DECLINE_RENDERINGS_MAX,
  GLIMMER_BOS,
  GLIMMER_REASONING,
  GLIMMER_TEMPLATE,
  glimmerPrompt,
  glimmerPromptParts,
  glimmerTrainingText,
  isDeclineRendering,
  labelGroups,
  labelId,
  LABELS_PER_PROMPT,
  letterMass,
  LETTER_MASS_SLACK,
  letterProbabilities,
  lettered,
  logprobsProblem,
  neutralText,
  NONE_OPTION,
  NONE_SHARE,
  overlapScores,
  pickDecision,
  renderGlimmer,
  renderTask,
  seededRandom,
  shuffled,
  standInDecision,
  stateText,
  taskProblem,
  temperedDecision,
  trainExample,
  trainRendering,
} from "@/lib/decide/format";
import type { DecideMessage, DecideOption, DecideTask, DecisionLabel, DecisionRow } from "@/lib/decide/types";

interface FixtureCase {
  name: string;
  input: { state: string; question: string; options: DecideOption[] };
  answer: string;
  messages: DecideMessage[];
  prompt: string;
  training: string;
  tokens: { prompt: number; once: number; copy: number; promptIsPrefix: boolean; answerTail: string[]; eotInPrompt: number };
}

interface Fixture {
  template: { repo: string; revision: string; sha256: string };
  reasoning: string;
  bos: string;
  system: string;
  separator: string;
  none: string;
  cases: FixtureCase[];
  tokenizer: {
    vocab: number;
    letters: Record<string, { bare: number | null; spaced: number | null }>;
    capitalsSingle: boolean;
    capitalsInPlace: boolean;
    afterPrompt: Record<string, string[]>;
    pairs: { total: number; single: number; notSingle: string[] };
    control: Record<string, number>;
    encodeAddsBos: boolean;
  };
}

// Made by scripts/decide/glimmer_fixture.py from Meta's chat_template.jinja at cec94fcf, with jinja2.
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/glimmer-prompts.json", import.meta.url), "utf8")) as Fixture;
const RERUN = "change scripts/decide/glimmer_fixture.py to match and rerun it";
const EM_DASH = String.fromCharCode(0x2014);

function label(name: string, description = ""): DecisionLabel {
  return { id: labelId(name), name, description };
}

const TICKET = "Which team should handle this support ticket?";
const BILLING = label("Billing", "Charges, refunds and invoices");
const SHIPPING = label("Shipping", "Delivery, tracking and damaged parcels");
const ACCOUNT = label("Account", "Sign-in, passwords and profile");
const TWELVE = Array.from({ length: 12 }, (_, i) => label(`Label ${String.fromCharCode(97 + i)}`));

/** A fixture case's labels: its options other than `none`. */
function caseLabels(c: FixtureCase): DecisionLabel[] {
  return c.input.options.filter((o) => o.option !== NONE_OPTION).map((o) => label(o.option, o.description ?? ""));
}

function caseTask(c: FixtureCase): DecideTask {
  return decideTask({ state: c.input.state, question: c.input.question, labels: caseLabels(c), none: true });
}

describe("the real chat template (fixture)", () => {
  it("was made with the same wording, template and reasoning strength", () => {
    assert.equal(FIXTURE.system, DECIDE_SYSTEM, `DECIDE_SYSTEM changed: ${RERUN}`);
    assert.equal(FIXTURE.separator, DECIDE_SEPARATOR, `DECIDE_SEPARATOR changed: ${RERUN}`);
    assert.equal(FIXTURE.none, NONE_OPTION, `NONE_OPTION changed: ${RERUN}`);
    assert.equal(FIXTURE.template.repo, GLIMMER_TEMPLATE.repo);
    assert.equal(FIXTURE.template.revision, GLIMMER_TEMPLATE.revision);
    assert.equal(FIXTURE.template.sha256, GLIMMER_TEMPLATE.sha256);
    assert.equal(FIXTURE.reasoning, GLIMMER_REASONING);
    assert.equal(FIXTURE.bos, GLIMMER_BOS);
    assert.ok(FIXTURE.cases.length >= 4);
  });

  for (const c of FIXTURE.cases) {
    describe(c.name, () => {
      it("builds the same messages: JSON.stringify agrees with Python's compact json.dumps", () => {
        const task = caseTask(c);
        assert.deepEqual(decideMessages(task), c.messages);
      });

      it("renders the prompt byte for byte as jinja2 does", () => {
        assert.equal(glimmerPrompt(decideMessages(caseTask(c)), { bos: true }), c.prompt);
      });

      it("renders the training text byte for byte, the prompt then the letter and <|eot|>", () => {
        const messages: DecideMessage[] = [...decideMessages(caseTask(c)), { role: "assistant", content: c.answer }];
        assert.equal(glimmerTrainingText(messages, { bos: true }), c.training);
        assert.equal(c.training, c.prompt + c.answer + "<|eot|>");
      });

      it("matches decide.json's prefix and suffix, and the backend's text has no <|begin_of_text|>", () => {
        const task = caseTask(c);
        const { prefix, suffix } = glimmerPromptParts();
        const copy = renderTask(task);
        assert.equal(GLIMMER_BOS + prefix + copy + DECIDE_SEPARATOR + copy + suffix, c.prompt);
        const lettersOnly = { task, letters: task.options.map((o) => o.letter), labelIds: [] };
        assert.equal(decidePrompt(lettersOnly).text, c.prompt.slice(GLIMMER_BOS.length));
      });

      it("tokenizes with the answer as one token right after the prompt, and no forged control token", () => {
        assert.equal(c.tokens.promptIsPrefix, true);
        assert.deepEqual(c.tokens.answerTail, [c.answer, "<|eot|>"]);
        // The system block's and the user turn's <|eot|> only: a "<|eot|>" in the state was neutralized.
        assert.equal(c.tokens.eotInPrompt, 2);
        assert.ok(c.tokens.prompt < DECIDE_MAX_TOKENS);
      });
    });
  }

  it("the ticket, rendered for eval from its labels, is the fixture's prompt and training text", () => {
    const ticket = FIXTURE.cases.find((c) => c.name === "ticket")!;
    const [r, ...rest] = decideRenderings({ state: ticket.input.state, question: TICKET, labels: [BILLING, SHIPPING, ACCOUNT], answer: "billing" });
    assert.equal(rest.length, 0);
    assert.equal(r!.answer, "A");
    assert.equal(glimmerPrompt(decideMessages(r!.task), { bos: true }), ticket.prompt);
    assert.equal(glimmerTrainingText(trainExample(r!).messages, { bos: true }), ticket.training);
    assert.equal(ticket.tokens.prompt, 298);
    assert.equal(ticket.tokens.once, 191);
  });

  it("records the tokenizer facts the doc states", () => {
    const t = FIXTURE.tokenizer;
    assert.equal(t.vocab, 202_048);
    assert.equal(t.capitalsSingle, true);
    assert.equal(t.capitalsInPlace, true);
    for (const letter of DECIDE_LETTERS) {
      assert.equal(typeof t.letters[letter]!.bare, "number", letter);
      assert.equal(typeof t.letters[letter]!.spaced, "number", letter);
    }
    assert.deepEqual(
      Object.fromEntries(DECIDE_LETTERS.map((l) => [l, t.letters[l]])),
      { A: { bare: 45, spaced: 352 }, B: { bare: 46, spaced: 410 }, C: { bare: 47, spaced: 354 }, D: { bare: 48, spaced: 401 }, E: { bare: 49, spaced: 427 } },
    );
    assert.deepEqual(t.afterPrompt["B."], ["B", "."]);
    assert.equal(t.pairs.single, 639);
    assert.equal(t.pairs.notSingle.length, 37);
    assert.equal(t.control["<|eot|>"], 200008);
    assert.equal(t.control["<|begin_of_text|>"], 200000);
    // The tokenizer adds <|begin_of_text|> itself, so a prompt sent as text leaves it out.
    assert.equal(t.encodeAddsBos, true);
  });
});

describe("tasks", () => {
  it("serializes in key order with no spaces and leaves out an empty description", () => {
    const task = decideTask({ state: "s t", question: "Which one?", labels: [label("Yes"), BILLING], none: true });
    assert.equal(
      renderTask(task),
      '{"state":"s t","question":"Which one?","options":[{"letter":"A","option":"Yes"},{"letter":"B","option":"Billing","description":"Charges, refunds and invoices"},{"letter":"C","option":"None of the listed options matches"}]}',
    );
    const reordered = { options: task.options.map((o) => ({ ...o })), question: task.question, state: task.state } as DecideTask;
    assert.equal(renderTask(reordered), renderTask(task));
  });

  it("says the task twice in the user message", () => {
    const task = decideTask({ state: "x", question: "Which one?", labels: [label("A1"), label("B1")], none: true });
    const copy = renderTask(task);
    assert.equal(decideUserMessage(task), `${copy}\n\nHere is the same task again:\n\n${copy}`);
    assert.deepEqual(decideMessages(task).map((m) => m.role), ["system", "user"]);
  });

  it("neutralizes every <| in state, question and options", () => {
    assert.equal(neutralText("a<|eot|>b"), "a< |eot|>b");
    assert.equal(neutralText("<<||"), "<< ||");
    assert.equal(neutralText(neutralText("<|x<|")), neutralText("<|x<|"));
    assert.ok(!neutralText("<|<|<||<|").includes("<|"));
    const task = decideTask({ state: "<|start|>", question: "Pick <|one|>", labels: [label("A<|b"), label("C", "d<|e")], none: true });
    assert.equal(task.state, "< |start|>");
    assert.equal(task.question, "Pick < |one|>");
    assert.equal(task.options[0]!.option, "A< |b");
    assert.equal(task.options[1]!.description, "d< |e");
    assert.equal(taskProblem(task), null);
  });

  it("turns a flat object state into JSON text", () => {
    assert.equal(stateText("plain"), "plain");
    assert.equal(stateText({ amount: 12, note: "hi" }), '{"amount":12,"note":"hi"}');
  });

  it("makes label ids from names", () => {
    assert.equal(labelId("Billing"), "billing");
    assert.equal(labelId("Sign-in issues"), "sign-in-issues");
    assert.equal(labelId("  Café  Über!  "), "cafe-uber");
    assert.equal(labelId("?!"), "");
  });

  it("letters options A to E with none last, and refuses a sixth", () => {
    assert.deepEqual(lettered([label("x"), label("y")], true).map((o) => o.letter), ["A", "B", "C"]);
    assert.equal(lettered([label("x"), label("y")], true).at(-1)!.option, NONE_OPTION);
    assert.deepEqual(lettered([label("x"), label("y")], false).map((o) => o.option), ["x", "y"]);
    assert.throws(() => lettered(TWELVE.slice(0, 5), true), /at most 5 options/);
  });

  it("finds what is wrong with a task", () => {
    const ok = decideTask({ state: "fine", question: "Which one?", labels: [label("x"), label("y")], none: true });
    assert.equal(taskProblem(ok), null);
    assert.match(taskProblem({ ...ok, state: "" })!, /state must be 1 to 3,000/);
    assert.match(taskProblem({ ...ok, state: "a".repeat(3001) })!, /state/);
    assert.equal(taskProblem({ ...ok, state: "\u{1F600}".repeat(3000) }), null);
    assert.match(taskProblem({ ...ok, question: "Why" })!, /question must be 5 to 300/);
    assert.match(taskProblem({ ...ok, options: ok.options.slice(0, 1) })!, /2 to 5 options/);
    const noneFirst = [{ letter: "A", option: NONE_OPTION }, { letter: "B", option: "x" }] as DecideOption[];
    assert.match(taskProblem({ ...ok, options: noneFirst })!, /must be the last option/);
    const badLetter = [{ letter: "B", option: "x" }, { letter: "A", option: "y" }] as DecideOption[];
    assert.match(taskProblem({ ...ok, options: badLetter })!, /letter A/);
    const twice = [{ letter: "A", option: "Same" }, { letter: "B", option: "same" }] as DecideOption[];
    assert.match(taskProblem({ ...ok, options: twice })!, /repeats/);
    const emptyDescription = [{ letter: "A", option: "x", description: "" }, { letter: "B", option: "y" }] as DecideOption[];
    assert.match(taskProblem({ ...ok, options: emptyDescription })!, /description/);
    assert.match(taskProblem({ ...ok, state: "a<|eot|>" })!, /<\|/);
  });

  it("checks lengths on the text as given, so neutralizing never pushes it over a limit", () => {
    const task = (state: string, name: string, description = "") =>
      decideTask({ state, question: "Pick <|one|>.", labels: [label(name, description), label("y")], none: true });
    // 3,000 characters with a "<|" are 3,001 once neutralized, and still within the limit.
    const full = task("<|" + "a".repeat(2998), "<|" + "n".repeat(58), "<|" + "d".repeat(198));
    assert.equal(Array.from(full.state).length, 3001);
    assert.equal(full.options[0]!.option.length, 61);
    assert.equal(taskProblem(full), null);
    assert.match(taskProblem(task("<|" + "a".repeat(2999), "x"))!, /state must be 1 to 3,000/);
    assert.match(taskProblem(task("x", "<|" + "n".repeat(59)))!, /Option A must be 1 to 60/);
    assert.match(taskProblem(task("x", "x", "<|" + "d".repeat(199)))!, /description must be 1 to 200/);
  });
});

describe("the template renderer", () => {
  it("needs the system message first and only once", () => {
    assert.throws(() => renderGlimmer([{ role: "user", content: "x" }], { bos: true, generation: true }), /system message/);
    const twice: DecideMessage[] = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ];
    assert.throws(() => renderGlimmer(twice, { bos: true, generation: true }), /one system message/);
    assert.throws(() => glimmerTrainingText([{ role: "system", content: "a" }, { role: "user", content: "b" }], { bos: false }), /assistant/);
  });

  it("follows the template's reasoning rule: its rewrite of Reasoning effort, and no second line", () => {
    const text = renderGlimmer([{ role: "system", content: "Be brief. Reasoning effort: high." }], { bos: false, generation: false });
    assert.equal(text, '<|start|>system<|message|>Be brief. Reasoning strength: high.\n\n# Valid recipients: "self", "user".<|eot|>');
  });

  it("opens the final channel, with or without <|begin_of_text|>", () => {
    const messages = decideMessages(decideTask({ state: "x", question: "Which one?", labels: [label("a1"), label("b1")], none: true }));
    const withBos = glimmerPrompt(messages, { bos: true });
    assert.ok(withBos.startsWith(GLIMMER_BOS + "<|start|>system<|message|>"));
    assert.ok(withBos.endsWith("<|eot|><|start|>assistant to=user<|message|>"));
    assert.equal(glimmerPrompt(messages, { bos: false }), withBos.slice(GLIMMER_BOS.length));
  });
});

describe("training renderings", () => {
  const labels = [BILLING, SHIPPING, ACCOUNT];
  const base = { state: "I was charged twice.", question: TICKET, labels, answer: "billing" };

  it("is the same for the same seed and differs across seeds", () => {
    assert.deepEqual(trainRendering({ ...base, seed: "s:1:0" }), trainRendering({ ...base, seed: "s:1:0" }));
    const orders = new Set<string>();
    for (let i = 0; i < 200; i++) {
      orders.add(trainRendering({ ...base, seed: `s:${i}:0`, decline: false }).labelIds.join(","));
    }
    assert.equal(orders.size, 6, "every order of 3 labels shows up");
  });

  it("puts the right label behind every letter, so a letter never stands for a label", () => {
    const letters = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = trainRendering({ ...base, seed: `t:${i}`, decline: false });
      assert.equal(r.labelIds[r.letters.indexOf(r.answer!)], "billing");
      assert.equal(r.labelIds.at(-1), null);
      assert.equal(r.task.options.at(-1)!.option, NONE_OPTION);
      letters.add(r.answer!);
    }
    assert.deepEqual([...letters].sort(), ["A", "B", "C"]);
  });

  it("takes the right label out on decline renderings, about 15% of seeds, and answers none", () => {
    let declined = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const seed = `d:${i}`;
      const r = trainRendering({ ...base, seed });
      if (isDeclineRendering(seed)) {
        declined += 1;
        assert.ok(!r.labelIds.includes("billing"));
        assert.equal(r.answer, r.letters.at(-1));
        assert.equal(r.letters.length, 3);
      } else {
        assert.ok(r.labelIds.includes("billing"));
      }
    }
    assert.ok(Math.abs(declined / n - NONE_SHARE) < 0.02, `declined ${declined} of ${n}`);
  });

  it("with more than 4 labels shows the right one, 3 others and none", () => {
    for (let i = 0; i < 100; i++) {
      const r = trainRendering({ state: "x", question: TICKET, labels: TWELVE, answer: TWELVE[7]!.id, seed: `m:${i}`, decline: false });
      assert.equal(r.letters.length, 5);
      assert.equal(new Set(r.labelIds).size, 5);
      assert.ok(r.labelIds.includes(TWELVE[7]!.id));
      assert.equal(r.labelIds[r.letters.indexOf(r.answer!)], TWELVE[7]!.id);
      const d = trainRendering({ state: "x", question: TICKET, labels: TWELVE, answer: TWELVE[7]!.id, seed: `m:${i}`, decline: true });
      assert.equal(d.letters.length, 5);
      assert.ok(!d.labelIds.includes(TWELVE[7]!.id));
      assert.equal(d.answer, "E");
    }
  });

  it("declines with 2 labels as one label and none", () => {
    const r = trainRendering({ state: "x", question: TICKET, labels: [BILLING, SHIPPING], answer: "billing", seed: "two", decline: true });
    assert.deepEqual(r.labelIds, ["shipping", null]);
    assert.equal(r.answer, "B");
    assert.equal(taskProblem(r.task), null);
  });

  it("refuses an unknown answer or a single label", () => {
    assert.throws(() => trainRendering({ ...base, answer: "nope", seed: "x" }), /isn't one of/);
    assert.throws(() => trainRendering({ ...base, labels: [BILLING], seed: "x" }), /at least 2 labels/);
  });

  it("becomes a TrainExample whose assistant message is the letter", () => {
    const r = trainRendering({ ...base, seed: "e", decline: false });
    const ex = trainExample(r);
    assert.deepEqual(ex.messages.map((m) => m.role), ["system", "user", "assistant"]);
    assert.equal(ex.messages[2]!.content, r.answer);
    const noAnswer = decideRenderings({ state: "x", question: TICKET, labels })[0]!;
    assert.throws(() => trainExample(noAnswer), /needs its answer/);
  });
});

describe("eval and serving renderings", () => {
  it("keeps the defined order and shows none last", () => {
    const [r] = decideRenderings({ state: "x", question: TICKET, labels: [ACCOUNT, BILLING] });
    assert.deepEqual(r!.labelIds, ["account", "billing", null]);
    assert.deepEqual(r!.letters, ["A", "B", "C"]);
    assert.equal(r!.answer, undefined);
  });

  it("splits more than 4 labels into even groups", () => {
    const sizes = (n: number) => labelGroups(TWELVE.slice(0, n)).map((g) => g.length);
    assert.deepEqual(sizes(1), [1]);
    assert.deepEqual(sizes(4), [4]);
    assert.deepEqual(sizes(5), [3, 2]);
    assert.deepEqual(sizes(7), [4, 3]);
    assert.deepEqual(sizes(8), [4, 4]);
    assert.deepEqual(sizes(9), [3, 3, 3]);
    assert.deepEqual(sizes(10), [4, 3, 3]);
    assert.deepEqual(sizes(12), [4, 4, 4]);
    assert.deepEqual(labelGroups(TWELVE).flat(), TWELVE);
    for (let n = 1; n <= 12; n++) assert.ok(sizes(n).every((s) => s <= LABELS_PER_PROMPT));
  });

  it("gives each group its answer: the right letter where it is shown, none elsewhere", () => {
    const rs = decideRenderings({ state: "x", question: TICKET, labels: TWELVE, answer: TWELVE[5]!.id });
    assert.equal(rs.length, 3);
    assert.deepEqual(rs.map((r) => r.answer), ["E", "B", "E"]);
    assert.equal(rs[1]!.labelIds[1], TWELVE[5]!.id);
  });

  it("takes a label out for the decline check", () => {
    const rs = decideRenderings({ state: "x", question: TICKET, labels: [BILLING, SHIPPING, ACCOUNT], answer: "billing", without: "billing" });
    assert.deepEqual(rs[0]!.labelIds, ["shipping", "account", null]);
    assert.equal(rs[0]!.answer, "C");
  });

  it("shows no none only for 4 labels or fewer", () => {
    const [r] = decideRenderings({ state: "x", question: TICKET, labels: [BILLING, SHIPPING], none: false, answer: "shipping" });
    assert.deepEqual(r!.labelIds, ["billing", "shipping"]);
    assert.equal(r!.answer, "B");
    assert.throws(() => decideRenderings({ state: "x", question: TICKET, labels: TWELVE.slice(0, 5), none: false }), /at most 4 options/);
    assert.throws(() => decideRenderings({ state: "x", question: TICKET, labels: [BILLING], none: false }), /at least 2 options/);
  });

  it("refuses unknown or repeated label ids", () => {
    assert.throws(() => decideRenderings({ state: "x", question: TICKET, labels: [BILLING, BILLING] }), /same id/);
    assert.throws(() => decideRenderings({ state: "x", question: TICKET, labels: [BILLING, SHIPPING], answer: "x" }), /isn't one of/);
  });

  it("hands the GPU items without answers or label ids", () => {
    const r = decideRenderings({ state: "x", question: TICKET, labels: [BILLING, SHIPPING], answer: "billing" })[0]!;
    const item = decideItem(3, 7, 0, r);
    assert.deepEqual(Object.keys(item).sort(), ["group", "index", "letters", "messages", "row"]);
    assert.ok(!JSON.stringify(item).includes("billing"));
    assert.deepEqual(item.letters, ["A", "B", "C"]);
  });
});

describe("dev and test items", () => {
  const rows = (n: number, labels: readonly DecisionLabel[]): DecisionRow[] =>
    Array.from({ length: n }, (_, i) => ({ input: `ticket ${i}`, label: labels[i % labels.length]!.id }));

  it("lays out dev rows in order, one item per group, no decline items", () => {
    const labels = [BILLING, SHIPPING, ACCOUNT];
    const items = decisionItems({ question: TICKET, labels, rows: rows(3, labels), part: "dev" });
    assert.deepEqual(items.map((i) => [i.index, i.row, i.group, i.decline]), [
      [0, 0, 0, false],
      [1, 1, 0, false],
      [2, 2, 0, false],
    ]);
    assert.deepEqual(items[1]!.labelIds, ["billing", "shipping", "account", null]);
    assert.deepEqual(items.map((i) => i.rendering.answer), ["A", "B", "C"]);
    assert.equal(items[2]!.rendering.task.state, "ticket 2");
  });

  it("adds the decline check to test: each row's label taken out, every group, none the answer", () => {
    const labels = TWELVE.slice(0, 5);
    const items = decisionItems({ question: TICKET, labels, rows: rows(3, labels), part: "test" });
    // 3 rows of 2 groups (3 and 2 labels), then 3 decline rows of 4 labels each, one group.
    assert.equal(items.length, 9);
    assert.deepEqual(items.map((i) => i.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(items.slice(0, 6).map((i) => [i.row, i.group]), [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
    const declines = items.filter((i) => i.decline);
    assert.deepEqual(declines.map((i) => i.row), [0, 1, 2]);
    for (const d of declines) {
      const label = labels[d.row % labels.length]!.id;
      assert.ok(!d.labelIds.includes(label), "the row's own label is taken out");
      assert.equal(d.labelIds.length, 5);
      assert.equal(d.rendering.answer, "E", "none is the answer");
    }
  });

  it("keeps the decline check to 100 renderings, rows spread through the split", () => {
    const four = TWELVE.slice(0, 4);
    const items = decisionItems({ question: TICKET, labels: four, rows: rows(250, four), part: "test" });
    const declines = items.filter((i) => i.decline);
    assert.equal(declines.length, DECLINE_RENDERINGS_MAX);
    // Row floor((i + 0.5) * 250 / 100): 1, 3, 6, 8, ... 248.
    assert.deepEqual(declines.slice(0, 4).map((i) => i.row), [1, 3, 6, 8]);
    assert.equal(declines.at(-1)!.row, 248);
    assert.equal(new Set(declines.map((i) => i.row)).size, 100);
    // 9 labels leave 8 once one is out: 2 groups a row, so 50 rows.
    const nine = TWELVE.slice(0, 9);
    const wide = decisionItems({ question: TICKET, labels: nine, rows: rows(250, nine), part: "test" }).filter((i) => i.decline);
    assert.equal(wide.length, 100);
    assert.equal(new Set(wide.map((i) => i.row)).size, 50);
  });

  it("serves the GPU what decideItem makes, without labels", () => {
    const labels = [BILLING, SHIPPING];
    const [item] = decisionItems({ question: TICKET, labels, rows: [{ input: "Where is it?", label: "shipping" }], part: "dev" });
    const gpu = decideItem(item!.index, item!.row, item!.group, item!.rendering);
    assert.ok(!JSON.stringify(gpu).includes("shipping"));
    assert.deepEqual(gpu.letters, ["A", "B", "C"]);
    assert.throws(() => decisionItems({ question: TICKET, labels, rows: [{ input: "x", label: "nope" }], part: "dev" }), /isn't one of/);
  });
});

describe("from scores to a decision", () => {
  const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

  it("renormalizes over the shown letters and keeps letter mass apart", () => {
    const lp = [Math.log(0.5), Math.log(0.25), Math.log(0.05)];
    close(letterMass(lp), 0.8);
    const p = letterProbabilities(lp);
    close(p[0]!, 0.625);
    close(p[1]!, 0.3125);
    close(p[2]!, 0.0625);
  });

  it("softens with T without changing the pick", () => {
    const lp = [-0.2, -2, -3.5];
    for (const T of [0.25, 0.5, 1, 2, 10]) {
      const p = letterProbabilities(lp, T);
      close(p.reduce((s, x) => s + x, 0), 1);
      assert.equal(p.indexOf(Math.max(...p)), 0);
    }
    assert.ok(letterProbabilities(lp, 2)[0]! < letterProbabilities(lp, 1)[0]!);
    assert.throws(() => letterProbabilities(lp, 0), /T must be/);
  });

  it("handles a letter with no probability, and none at all", () => {
    assert.deepEqual(letterProbabilities([0, -Infinity]), [1, 0]);
    assert.deepEqual(letterProbabilities([-Infinity, -Infinity]), [0.5, 0.5]);
    assert.equal(letterMass([-Infinity]), 0);
    assert.throws(() => letterProbabilities([Number.NaN, 0]), /log-probability/);
  });

  it("refuses numbers that can't be log-probabilities", () => {
    assert.equal(logprobsProblem([Math.log(0.5), Math.log(0.25), -Infinity]), null);
    assert.equal(logprobsProblem([0, -Infinity]), null);
    assert.equal(logprobsProblem([-700, -701]), null, "tiny but not 0: e^-700 is still a number");
    // Float error just over all the probability is fine.
    assert.equal(logprobsProblem([Math.log(0.6), Math.log(0.4) + 1e-6]), null);
    assert.ok(LETTER_MASS_SLACK > 1e-6 && LETTER_MASS_SLACK < 0.5);
    // Probabilities sent in place of their logs, or raw logits, hold more than all the probability.
    assert.match(logprobsProblem([0.7, 0.15, 0.15])!, /more than all the probability/);
    assert.match(logprobsProblem([12.5, 3.1, -2])!, /more than all the probability/);
    assert.match(logprobsProblem([0, 0])!, /more than all the probability/);
    // No probability on any letter: an even split would just pick the first label.
    assert.match(logprobsProblem([-Infinity, -Infinity])!, /No shown letter/);
    assert.match(logprobsProblem([-1e30, -1e30])!, /No shown letter/);
    assert.match(logprobsProblem([-800, -801])!, /No shown letter/, "e^-800 rounds to 0");
    assert.match(logprobsProblem([])!, /No shown letter/);
    for (const bad of [Number.NaN, Infinity, null as unknown as number, "0" as unknown as number]) {
      assert.match(logprobsProblem([bad, -1])!, /number or -Infinity/);
    }
  });

  it("combines groups: each label in its own group, none the product, labels sharing 1 - none", () => {
    const one = combineGroups([{ labelIds: ["a", "b", null], p: [0.6, 0.3, 0.1] }]);
    assert.deepEqual(one.labels.map((l) => l.id), ["a", "b"]);
    close(one.labels[0]!.p, 0.6);
    close(one.none, 0.1);
    const two = combineGroups([
      { labelIds: ["a", "b", null], p: [0.6, 0.2, 0.2] },
      { labelIds: ["c", null], p: [0.5, 0.5] },
    ]);
    close(two.none, 0.1);
    const total = 0.6 + 0.2 + 0.5;
    close(two.labels.find((l) => l.id === "a")!.p, (0.6 * 0.9) / total);
    close(two.labels.find((l) => l.id === "c")!.p, (0.5 * 0.9) / total);
    close(two.labels.reduce((s, l) => s + l.p, 0) + two.none, 1);
    assert.throws(() => combineGroups([{ labelIds: ["a", "b"], p: [0.5, 0.5] }, { labelIds: ["c", null], p: [0.5, 0.5] }]), /each shows/);
    assert.throws(() => combineGroups([{ labelIds: ["a", null], p: [0.5, 0.5] }, { labelIds: ["a", null], p: [0.5, 0.5] }]), /two groups/);
  });

  it("picks the highest, ties to the first, none only when strictly higher", () => {
    const labels = [BILLING, SHIPPING];
    const tie = pickDecision(labels, { labels: [{ id: "billing", p: 0.4 }, { id: "shipping", p: 0.4 }], none: 0.2 });
    assert.equal(tie.id, "billing");
    assert.equal(tie.decision, "Billing");
    const noneTie = pickDecision(labels, { labels: [{ id: "billing", p: 0.4 }, { id: "shipping", p: 0.2 }], none: 0.4 });
    assert.equal(noneTie.id, "billing");
    const noneWins = pickDecision(labels, { labels: [{ id: "billing", p: 0.3 }, { id: "shipping", p: 0.2 }], none: 0.5 });
    assert.equal(noneWins.decision, null);
    assert.equal(noneWins.id, null);
    assert.equal(noneWins.confidence, 0.5);
    assert.deepEqual(noneWins.probabilities.map((p) => p.option), ["Billing", "Shipping"]);
  });

  it("goes from a backend's scores to the decision, across groups", () => {
    const labels = TWELVE.slice(0, 5);
    const renderings = decideRenderings({ state: "x", question: TICKET, labels });
    assert.equal(renderings.length, 2);
    const logprobs = [
      [Math.log(0.05), Math.log(0.05), Math.log(0.05), Math.log(0.6)],
      [Math.log(0.7), Math.log(0.1), Math.log(0.1)],
    ];
    const { decision, mass } = decisionFromScores({ labels, renderings, logprobs });
    close(mass[0]!, 0.75);
    close(mass[1]!, 0.9);
    assert.equal(decision.id, labels[3]!.id);
    assert.deepEqual(decision.probabilities.map((p) => p.id), labels.map((l) => l.id));
    close(decision.probabilities.reduce((s, p) => s + p.p, 0) + decision.none, 1);
    close(decision.none, 0.8 * (0.1 / 0.9));
    assert.throws(() => decisionFromScores({ labels, renderings, logprobs: [logprobs[0]!] }), /scores for 2 prompts/);
    assert.throws(() => decisionFromScores({ labels, renderings, logprobs: [logprobs[0]!, [0, 0]] }), /shows 3 letters/);
    assert.throws(() => decisionFromScores({ labels, renderings, logprobs: [logprobs[0]!, [0.7, 0.2, 0.1]] }), /Prompt 2's scores can't be used/);
    const nothing = [-Infinity, -Infinity, -Infinity, -Infinity];
    assert.throws(() => decisionFromScores({ labels, renderings, logprobs: [nothing, logprobs[1]!] }), /Prompt 1's .*No shown letter/);
  });

  it("applies T after combining: with one group it is the same as dividing the letters' log-probabilities", () => {
    const lp = [Math.log(0.5), Math.log(0.25), Math.log(0.05), Math.log(0.1)];
    const combined = combineGroups([{ labelIds: ["a", "b", "c", null], p: letterProbabilities(lp) }]);
    for (const T of [0.25, 0.5, 2, 10]) {
      const soft = applyTemperature(combined, T);
      const direct = letterProbabilities(lp, T);
      soft.labels.forEach((l, i) => close(l.p, direct[i]!));
      close(soft.none, direct[3]!);
    }
    assert.deepEqual(applyTemperature(combined, 1), combined);
    // An option at 0 stays at 0, and the rest still sum to 1.
    const zero = applyTemperature({ labels: [{ id: "a", p: 0.75 }, { id: "b", p: 0.25 }], none: 0 }, 2);
    assert.equal(zero.none, 0);
    close(zero.labels[0]!.p, Math.sqrt(0.75) / (Math.sqrt(0.75) + Math.sqrt(0.25)));
    assert.throws(() => applyTemperature(combined, 0), /T must be/);
    assert.throws(() => applyTemperature({ labels: [{ id: "a", p: Number.NaN }], none: 0 }, 2), /probability/);
  });

  it("never changes the pick with T, even across groups, where T before combining would", () => {
    const labels = TWELVE.slice(0, 5);
    const renderings = decideRenderings({ state: "x", question: TICKET, labels });
    // Group 1 shows a, b, c and none; group 2 shows d, e and none.
    const logprobs = [
      [0.45, 0.45, 0.05, 0.05].map(Math.log),
      [0.4, 0.3, 0.3].map(Math.log),
    ];
    // Combined at T = 1: none = 0.05 * 0.3 = 0.015 and the labels share 0.985 in proportion, so a (0.45, tied with b
    // and first) beats d (0.4).
    const at1 = decisionFromScores({ labels, renderings, logprobs }).decision;
    assert.equal(at1.id, labels[0]!.id);
    close(at1.confidence, (0.45 * 0.985) / 1.65);
    // Dividing each group's letters by T first would hand it to d at T = 0.25 (a sharpened to about 0.5 in its group,
    // d to about 0.61 in its own) and at T = 10.
    const groupFirst = (T: number) =>
      pickDecision(labels, combineGroups(renderings.map((r, i) => ({ labelIds: r.labelIds, p: letterProbabilities(logprobs[i]!, T) })))).id;
    assert.equal(groupFirst(0.25), labels[3]!.id);
    assert.equal(groupFirst(10), labels[3]!.id);
    for (const T of [0.25, 0.5, 2, 10]) {
      const d = decisionFromScores({ labels, renderings, logprobs, T }).decision;
      assert.equal(d.id, at1.id, `T ${T} kept the pick`);
      close(d.probabilities.reduce((s, p) => s + p.p, 0) + d.none, 1);
      assert.equal(d.confidence, d.probabilities[0]!.p);
    }
    assert.ok(decisionFromScores({ labels, renderings, logprobs, T: 0.25 }).decision.confidence > at1.confidence);
    assert.ok(decisionFromScores({ labels, renderings, logprobs, T: 2 }).decision.confidence < at1.confidence);
  });

  it("keeps a none pick under T and reports none's tempered probability", () => {
    const labels = [BILLING, SHIPPING];
    const combined = { labels: [{ id: "billing", p: 0.3 }, { id: "shipping", p: 0.2 }], none: 0.5 };
    const d = temperedDecision(labels, combined, 2);
    assert.equal(d.id, null);
    const z = Math.sqrt(0.3) + Math.sqrt(0.2) + Math.sqrt(0.5);
    close(d.confidence, Math.sqrt(0.5) / z);
    close(d.none, d.confidence);
    assert.deepEqual(temperedDecision(labels, combined, 1), pickDecision(labels, combined));
    assert.ok(DECIDE_READ.includes("groups combined, then every option's log-probability divided by T"));
  });
});

describe("the word-overlap stand-in", () => {
  const state = "Hi, I was charged twice for my October order and need one of the charges refunded.";

  it("picks the label whose words overlap the state's most", () => {
    assert.deepEqual(overlapScores(state, [BILLING, SHIPPING, ACCOUNT]), [2, 1, 1]);
    const d = standInDecision({ state, labels: [BILLING, SHIPPING, ACCOUNT] });
    assert.equal(d.id, "billing");
    assert.equal(d.decision, "Billing");
    const e = Math.E;
    const sum = e ** 2 + e + e + 1;
    assert.ok(Math.abs(d.confidence - e ** 2 / sum) < 1e-12);
    assert.ok(Math.abs(d.none - 1 / sum) < 1e-12);
  });

  it("folds as promptKey does and ties to the first; none is never picked", () => {
    const d = standInDecision({ state: "zzz qqq", labels: [SHIPPING, ACCOUNT] });
    assert.equal(d.id, "shipping");
    assert.ok(Math.abs(d.none - 1 / 3) < 1e-12);
    const folded = standInDecision({ state: "DÉLIVERY!!", labels: [ACCOUNT, SHIPPING], none: false });
    assert.equal(folded.id, "shipping");
    assert.equal(folded.none, 0);
  });
});

describe("decide.json", () => {
  it("carries the format and renders the same prompt with no template engine", () => {
    const labels = [BILLING, SHIPPING, ACCOUNT];
    const json = decideJson({ question: TICKET, labels, T: 1.7 });
    assert.equal(json.format, "muse-decide/1");
    assert.equal(json.groupsOf, 4);
    assert.equal(json.maxTokens, 2048);
    assert.deepEqual(json.letters, ["A", "B", "C", "D", "E"]);
    assert.deepEqual(json.template, GLIMMER_TEMPLATE);
    assert.equal(json.T, 1.7);
    const [r] = decideRenderings({ state: "Where is my parcel?", question: json.question, labels: json.labels });
    const copy = renderTask(r!.task);
    assert.equal(json.prompt.prefix + copy + json.separator + copy + json.prompt.suffix, decidePrompt(r!).text);
    assert.ok(!json.prompt.prefix.startsWith(GLIMMER_BOS));
    assert.ok(!JSON.stringify(json).includes(EM_DASH));
  });
});

describe("seeded randomness", () => {
  it("is deterministic and in [0, 1)", () => {
    const a = seededRandom("seed");
    const b = seededRandom("seed");
    for (let i = 0; i < 1000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
    assert.notEqual(seededRandom("seed")(), seededRandom("seed2")());
    assert.deepEqual(shuffled([1, 2, 3, 4], seededRandom("k")).sort(), [1, 2, 3, 4]);
  });
});

describe("wording", () => {
  it("has no em dashes in the system message, separator or none text", () => {
    for (const text of [DECIDE_SYSTEM, DECIDE_SEPARATOR, NONE_OPTION]) assert.ok(!text.includes(EM_DASH));
  });
});
