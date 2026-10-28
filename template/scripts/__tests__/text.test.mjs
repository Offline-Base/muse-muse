// Unit tests for plain() in lib/meta/text.ts and the instructions respondJson sends. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { z } from "zod";
import { NO_EM_DASHES, respondJson } from "../../lib/meta/json";
import { plain, plainDeep } from "../../lib/meta/text";

const D = "\u2014";

test("a pair of dashes around an aside becomes a pair of commas", () => {
  assert.equal(plain(`The plan ${D} three runs a week ${D} starts Monday.`), "The plan, three runs a week, starts Monday.");
  assert.equal(plain(`It was${D}surprisingly${D}fast.`), "It was, surprisingly, fast.");
  assert.equal(plain(`The plan ${D} three runs a week ${D}.`), "The plan, three runs a week.");
});

test("one dash before a new clause ends the sentence instead of making a comma splice", () => {
  assert.equal(plain(`Keep going ${D} small wins are adding up nicely!`), "Keep going. Small wins are adding up nicely!");
  assert.equal(plain(`You got four of five today ${D} awesome, try for five tomorrow.`), "You got four of five today. Awesome, try for five tomorrow.");
  assert.equal(
    plain(`Great job ${D} you hit 4 of 5. Keep it up ${D} tomorrow is a new day.`),
    "Great job. You hit 4 of 5. Keep it up. Tomorrow is a new day.",
  );
  assert.equal(plain(`Note: water less ${D} the soil is wet.`), "Note: water less. The soil is wet.");
});

test("one dash after a label or before a figure becomes a colon, never a second one", () => {
  assert.equal(plain(`Week 3 ${D} 38 km`), "Week 3: 38 km");
  assert.equal(plain(`Wins ${D} 20 orders\nNext ${D} share the post`), "Wins: 20 orders\nNext: share the post");
  assert.equal(plain(`**Wins** ${D} You shipped 20 orders.`), "**Wins**: You shipped 20 orders.");
  assert.equal(plain(`Your plan ${D} 16 weeks.`), "Your plan: 16 weeks.");
  assert.equal(plain(`Tip: Monday ${D} rest`), "Tip: Monday, rest");
});

test("one dash before a short tail or a joining word becomes a comma", () => {
  assert.equal(plain(`We met ${D} finally.`), "We met, finally.");
  assert.equal(plain(`I ran 5 km ${D} and it felt easy.`), "I ran 5 km, and it felt easy.");
});

test("ranges, and dashes at the start or end of a line", () => {
  assert.equal(plain(`Open 9${D}5 on weekdays, 2019${D}2024.`), "Open 9 to 5 on weekdays, 2019 to 2024.");
  assert.equal(plain(`${D} Sam\nThanks ${D}\n  ${D} indented`), "Sam\nThanks\n  indented");
  assert.equal(plain(`Line one ${D}\r\nLine two ${D} ok\r\n`), "Line one\r\nLine two: ok\r\n");
  assert.equal(plain("No dashes here, all fine."), "No dashes here, all fine.");
});

test("a list of labels with dashes gets a colon each, and an aside with a comma in it stays an aside", () => {
  assert.equal(plain(`Mon ${D} rest, Tue ${D} 5 km, Wed ${D} 8 km`), "Mon: rest, Tue: 5 km, Wed: 8 km");
  assert.equal(plain(`The plan ${D} three runs, two rests ${D} starts Monday.`), "The plan, three runs, two rests, starts Monday.");
});

test("a run of dashes counts as one, and a dash right before punctuation goes", () => {
  assert.equal(plain(`x ${D}${D} y`), "x: y");
  assert.equal(plain(`${D}${D}${D} heading`), "heading");
  assert.equal(plain(`${D} ${D} ${D}`), "");
  assert.equal(plain(`You did it${D}!`), "You did it!");
});

test("plainDeep cleans every string in a value", () => {
  assert.deepEqual(plainDeep({ title: `Week 3 ${D} 38 km`, days: [`Mon ${D} rest`], count: 2 }), {
    title: "Week 3: 38 km",
    days: ["Mon: rest"],
    count: 2,
  });
});

test("respondJson asks the model for no em dashes in every mode, and cleans the reply", async () => {
  const calls = [];
  const client = {
    responses: {
      create: async (req) => {
        calls.push(req);
        return { output_text: JSON.stringify({ line: `Keep going ${D} small wins add up.` }) };
      },
    },
  };
  const out = await respondJson({ client, schema: z.object({ line: z.string() }), schemaName: "nudge", instructions: "Write one line.", input: "Hi" });
  assert.deepEqual(out, { line: "Keep going. Small wins add up." });
  assert.equal(calls[0].instructions, `Write one line.\n\n${NO_EM_DASHES}`);
  assert.ok(!NO_EM_DASHES.includes(D));

  calls.length = 0;
  await respondJson({ client, schema: z.object({ line: z.string() }), schemaName: "nudge", input: "Hi" });
  assert.equal(calls[0].instructions, NO_EM_DASHES);

  // When Meta rejects both schema modes, the schema moves into the instructions, after the same rule.
  calls.length = 0;
  let rejections = 2;
  const picky = {
    responses: {
      create: async (req) => {
        calls.push(req);
        if (rejections-- > 0) throw new OpenAI.APIError(400, { param: "text.format.schema", message: "schema not supported" }, "", new Headers());
        return { output_text: '{"line":"Fine."}' };
      },
    },
  };
  await respondJson({ client: picky, schema: z.object({ line: z.string() }), schemaName: "nudge", instructions: "Write one line.", input: "Hi" });
  assert.equal(calls.length, 3);
  assert.match(calls[2].instructions, new RegExp(`^Write one line\\.\\n\\n${NO_EM_DASHES.replace(/\./g, "\\.")}\\n\\nReply with only one JSON value`));
  assert.equal(calls[2].text, undefined);
});
