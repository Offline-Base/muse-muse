/**
 * /private can't say more than Muse Privacy's reports do: every replay step and number is checked against the report it
 * came from, and the page must carry the plain statements that keep those numbers honest.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateBody } from "@/components/private/PrivateBody";
import { Replay } from "@/components/private/Replay";
import { PRIVATE_NUMBERS, REPLAY_SCENES } from "@/lib/private/replay";

const REPORTS = "privacy/eval/reports";
const rehearsal = readFileSync(`${REPORTS}/${PRIVATE_NUMBERS.rehearsal.report}`, "utf8");
const matrix = readFileSync(`${REPORTS}/${PRIVATE_NUMBERS.fresh.report}`, "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

function rowsOfReport(): string[][] {
  return rehearsal
    .split("\n")
    .filter((line) => /^\| [A-F] \| /.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 8);
}

describe("/private", () => {
  it("replays every step of the report, in order, as recorded", () => {
    const rows = rowsOfReport();
    const shown = REPLAY_SCENES.flatMap((scene) => scene.steps.map((step) => ({ scene: scene.id, ...step })));
    assert.equal(shown.length, rows.length);
    assert.equal(rows.length, PRIVATE_NUMBERS.rehearsal.outputs);
    shown.forEach((step, i) => {
      const [scene, label, tool, status, , seconds, privateValues, note] = rows[i]!;
      assert.deepEqual([step.scene, step.label, step.tool, step.status, step.seconds], [scene, label, tool, status, Number(seconds)]);
      assert.equal(privateValues, "none", "the replay says None for every step");
      const kept = /kept: (.+)$/.exec(note!)?.[1];
      assert.equal(step.kept, kept);
    });
    assert.match(rehearsal, /private values in any tool output: 0 of 18 outputs/);
  });

  it("shows the numbers the reports have", () => {
    const row = (set: string) => {
      const cells = matrix.split(`## eval/${set}.jsonl`)[1]!.split("\n").find((l) => l.startsWith("| policy_lfm"))!.split("|").map((c) => c.trim());
      return { accuracy: cells[2], leaks: Number(cells[3]), unsafe: Number(cells[7]) };
    };
    const { fresh, tasks } = PRIVATE_NUMBERS;
    assert.deepEqual(row("fresh_200_b"), { accuracy: `${fresh.percent} (${fresh.right}/${fresh.items})`, leaks: fresh.leaks, unsafe: fresh.unsafeShares });
    assert.deepEqual(row("tasks"), { accuracy: `${tasks.percent} (${tasks.right}/${tasks.items})`, leaks: tasks.leaks, unsafe: tasks.unsafeShares });
  });

  it("says plainly what it is and what hasn't been done", () => {
    const page = text(renderToStaticMarkup(<PrivateBody />));
    for (const line of ["No real users yet", "Recorded, not live", "A script played Muse", "hasn't been measured on a device", "not made or endorsed by Meta", "sealed test set hasn't been scored"]) {
      assert.ok(page.includes(line), line);
    }
  });

  it("starts on the first step, and shows no em dash or company name anywhere", () => {
    const replay = renderToStaticMarkup(<Replay />);
    assert.match(replay, /Step 1 of 5/);
    assert.ok(replay.includes("run_private_task"));
    const copy = renderToStaticMarkup(<PrivateBody />) + JSON.stringify(REPLAY_SCENES);
    assert.ok(!copy.includes("—"));
    assert.ok(!/offline base/i.test(copy));
  });
});
