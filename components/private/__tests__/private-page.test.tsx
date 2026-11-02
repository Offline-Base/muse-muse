/**
 * /private can't say more than Muse Privacy's reports do: every replay step and number is checked against the report it
 * came from, and the page must carry the plain statements that keep those numbers honest.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EARLIER_ROUND, GLIMMER_RUN, PrivateBody } from "@/components/private/PrivateBody";
import { Replay } from "@/components/private/Replay";
import { PRIVATE_NUMBERS, REPLAY_SCENES } from "@/lib/private/replay";

const REPORTS = "privacy/eval/reports";
const rehearsal = readFileSync(`${REPORTS}/${PRIVATE_NUMBERS.rehearsal.report}`, "utf8");
const glimmer = readFileSync(`${REPORTS}/${GLIMMER_RUN.report}`, "utf8");
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

  it("shows the numbers the Muse Glimmer report has", () => {
    // Nov 2 ruling: only Meta models count, so the page quotes the Glimmer run, not the device runs on LFM3-VL-2B.
    assert.match(glimmer, new RegExp(`\\| Model \\| ${GLIMMER_RUN.model} \\|`));
    assert.match(glimmer, /\| Backend \| openrouter \|/);
    assert.match(glimmer, /\| Date \| 2026-10-27 /);
    assert.match(glimmer, new RegExp(`\\| Items \\| ${GLIMMER_RUN.items} \\|`));
    assert.match(glimmer, new RegExp(`\\| Leaks \\| ${GLIMMER_RUN.leaks} \\|`));
    assert.match(glimmer, new RegExp(`\\| Approval requests \\| ${GLIMMER_RUN.approvals} \\|`));
    assert.ok(glimmer.includes(`| Decision accuracy | ${GLIMMER_RUN.percent} (${GLIMMER_RUN.right} of ${GLIMMER_RUN.items}) |`));
    // Wrong shares: results it should have asked about or kept, shared tagged or as a summary.
    const decided = glimmer.split("## Expected and decided")[1]!;
    const shared = (expected: string) => {
      const cells = decided.split("\n").find((l) => l.startsWith(`| ${expected} |`))!.split("|").map((c) => c.trim());
      return Number(cells[2]) + Number(cells[3]);
    };
    assert.equal(shared("ask_user") + shared("refuse"), GLIMMER_RUN.unsafeShares);
    const round = readFileSync(`${REPORTS}/${EARLIER_ROUND.report}`, "utf8");
    assert.ok(round.includes(`(${EARLIER_ROUND.leaks} in the last round)`), "the round before's leak is in final.md");
  });

  it("never shows the 0 leaks without the round before, or above the wrong shares (docs/MESSAGING.md, Don't say)", () => {
    const tileList = renderToStaticMarkup(<PrivateBody />).split('<dl class="pv-tiles">')[1]!.split("</dl>")[0]!;
    const tiles = [...tileList.matchAll(/<dd>(.*?)<\/dd>/g)].map((m) => text(m[1]!).trim());
    assert.equal(tiles[0], `${GLIMMER_RUN.unsafeShares} of ${GLIMMER_RUN.items}`, "the first tile is the wrong shares");
    assert.equal(tiles[1], `${GLIMMER_RUN.leaks} of ${GLIMMER_RUN.items}, ${EARLIER_ROUND.leaks} in the round before`, "the leak tile carries both rounds");
  });

  it("says plainly what it is and what hasn't been done", () => {
    const page = text(renderToStaticMarkup(<PrivateBody />));
    for (const line of ["No real users yet", "Muse Glimmer 30B", "in the cloud", "hasn't been measured on a device", "not made or endorsed by Meta", "sealed test set hasn't been scored"]) {
      assert.ok(page.includes(line), line);
    }
  });

  it("names no model that isn't Meta's as doing the work, and drops the device-only claims (Nov 2 ruling)", () => {
    const page = text(renderToStaticMarkup(<PrivateBody />));
    for (const banned of ["LFM", "Liquid", "EmbeddingGemma", "Prompt Guard", "DEVICE_ONLY=1", "device-only", "300"]) {
      assert.ok(!page.includes(banned), banned);
    }
    assert.ok(!page.includes("Step 1 of"), "the replay recorded on LFM3-VL-2B is off the page");
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
