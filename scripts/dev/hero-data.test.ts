/** npx tsx --test scripts/dev/hero-data.test.ts: the code that makes the hero tune's training targets. No model, no database. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactionRow, sheetRow, type Sheet } from "./hero-data";

describe("redactionRow", () => {
  const good = "Note from the Harbor City office. [[NAME|Dana Okafor]] called from [[PHONE|555-0123]] about permit 88. Write to [[EMAIL|dana@example.com]]. [[NAME|Dana's]] file stays open until May 2 at the Harbor City office.";
  it("swaps marks for tags in the target and shows them in the prompt", () => {
    const row = redactionRow(good);
    assert.ok("prompt" in row);
    assert.match(row.prompt, /Dana Okafor called from 555-0123/);
    assert.match(row.answer, /\[NAME\] called from \[PHONE\]/);
    assert.doesNotMatch(row.answer, /Dana|Okafor|555-0123|example\.com/);
  });
  const bad: Array<[string, string]> = [
    ["a name part left unmarked", good.replace("[[NAME|Dana's]]", "Dana's")],
    ["phone out of the training range", good.replace("555-0123", "555-0175")],
    ["an unmarked private shape in the target", `${good} Other line 555-0121.`],
    ["email not example.com", good.replace("dana@example.com", "dana@gmail.com")],
    ["SSN rule", `${good} [[ID|123-45-6789]]`],
    ["under two private details", "Long enough plain text with only one mark, [[NAME|Dana Okafor]], and then a good many more ordinary words to pass the length check here, as written."],
  ];
  for (const [problem, text] of bad) it(`refuses ${problem}`, () => assert.deepEqual(redactionRow(text), { problem }));
});

describe("sheetRow", () => {
  const sheet = (over: Partial<Sheet>): Sheet => ({
    columns: ["id", "full_name", "phone", "dept", "hours"],
    rows: [
      ["R1", "Dana Okafor", "555-0101", "North", "4"],
      ["R2", "Lee Ibarra", "555-0102", "South", "10"],
      ["R3", "Mina Sol", "555-0103", "North", "7"],
      ["R4", "Ari Tan", "555-0104", "South", "2"],
      ["R5", "Bo Vance", "555-0105", "East", "1"],
    ],
    question: "q?",
    op: "sum",
    target: "hours",
    filters: [],
    ...over,
  });
  const north = [{ column: "dept", value: "North", atLeast: false }];
  it("computes each op in code", () => {
    assert.match((sheetRow(sheet({ filters: north })) as { answer: string }).answer, /4 \+ 7 = 11\.\nAnswer: 11$/);
    assert.match((sheetRow(sheet({ op: "count", filters: north })) as { answer: string }).answer, /R1, R3\.\nAnswer: 2$/);
    assert.match((sheetRow(sheet({ op: "max_row" })) as { answer: string }).answer, /Answer: R2$/);
    assert.match((sheetRow(sheet({ op: "top_group", filters: [{ column: "dept", value: "", atLeast: false }] })) as { answer: string }).answer, /Answer: South$/);
    assert.match((sheetRow(sheet({ op: "lookup", filters: [{ column: "id", value: "R3", atLeast: false }] })) as { answer: string }).answer, /Answer: 7$/);
    assert.match((sheetRow(sheet({ filters: [{ column: "hours", value: "7", atLeast: true }] })) as { answer: string }).answer, /10 \+ 7 = 17/);
  });
  it("refuses a sealed range phone, a person as the answer and a tie", () => {
    const s = sheet({});
    s.rows[0]![2] = "555-0175";
    assert.deepEqual(sheetRow(s), { problem: "phone out of the training range" });
    assert.deepEqual(sheetRow(sheet({ op: "lookup", target: "full_name", filters: [{ column: "id", value: "R3", atLeast: false }] })), { problem: "bad target" });
    const tied = sheet({ op: "max_row" });
    tied.rows[0]![4] = "10";
    assert.deepEqual(sheetRow(tied), { problem: "tie" });
  });
});
