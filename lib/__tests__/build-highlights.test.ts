/**
 * The product page's "How it was built" facts (buildHighlights). A session bridge round sends an item's line again
 * each time it changes, so each item counts once, while each line of a `muse exec` round is a call of its own. The real
 * goal run from the Oct 30 spike (lib/sandbox/__tests__/fixtures/msp-goal-steer.jsonl) is cut into polls as the
 * workflow reads it.
 *   npx tsx --test lib/__tests__/build-highlights.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildHighlights } from "@/lib/queries";
import { probeToBridge, toLines } from "@/lib/sandbox/__tests__/msp-records";
import { condenseBridgeLines, emptyBridgeState } from "@/lib/sandbox/msp-log";
import type { BuildEvent, BuildEventBody, MuseLogLine } from "@/lib/types";

const t0 = Date.parse("2026-10-30T12:00:00.000Z");

function events(...bodies: BuildEventBody[]): BuildEvent[] {
  return bodies.map((b, i) => ({ ...b, id: i + 1, at: new Date(t0 + (i + 1) * 1000).toISOString() }) as BuildEvent);
}

describe("buildHighlights", () => {
  it("counts a session bridge run's tool calls and edits once each, however its polls fell", () => {
    const records = probeToBridge(readFileSync(path.join(import.meta.dirname, "../sandbox/__tests__/fixtures/msp-goal-steer.jsonl"), "utf8"));
    for (const size of [5, 7, records.length]) {
      let state = emptyBridgeState();
      const bodies: BuildEventBody[] = [];
      for (let from = 0; from < records.length; from += size) {
        const c = condenseBridgeLines(toLines(records.slice(from, from + size)), state);
        state = c.state;
        if (c.lines.length) bodies.push({ type: "muse", round: 0, lines: c.lines });
      }
      if (size === 5) {
        const sent = bodies.flatMap((b) => (b.type === "muse" ? b.lines : [])).filter((l) => l.kind === "tool").length;
        assert.ok(sent > 5, `running tool calls came again once done (${sent} lines)`);
      }
      assert.deepEqual(buildHighlights(events(...bodies), null), ["Muse Code made 5 tool calls and 2 edits across 2 files (+2 −0)."], `polls of ${size}`);
    }
  });

  it("takes each item's last version, keeps rounds apart, and counts every line of a muse exec round", () => {
    const tool = (itemId: string, status: string): MuseLogLine => ({ kind: "tool", itemId, tool: "bash", text: "npm install", detail: { status } });
    const edit = (itemId: string, files: number, added: number): MuseLogLine => ({ kind: "edit", itemId, files, added, removed: 0, text: "Edited" });
    const read: MuseLogLine = { kind: "tool", tool: "read_file", ok: true, text: "Read `a.ts`" };
    const highlights = buildHighlights(
      events(
        { type: "muse", round: 0, lines: [tool("t1", "inProgress"), edit("t1#patch", 1, 3)] },
        { type: "muse", round: 0, lines: [tool("t1", "inProgress")] },
        { type: "muse", round: 0, lines: [edit("t1#patch", 2, 5), tool("t1", "completed")] },
        // A fix round's items are its own, even under the same ids.
        { type: "muse", round: 1, lines: [tool("t1", "completed")] },
        // muse exec lines have no ids: each is a call of its own, even when two read the same.
        { type: "muse", round: 1, lines: [read, read, { kind: "edit", files: 1, added: 1, removed: 1, text: "Edited" }] },
      ),
      null,
    );
    assert.deepEqual(highlights, ["Muse Code made 4 tool calls and 2 edits across 3 files (+6 −1)."]);
  });

  it("keeps the agent's notes and how a round runs off the product page, and the platform's own lines on it", () => {
    const log = (text: string): BuildEventBody => ({ type: "log", text });
    const highlights = buildHighlights(
      events(
        log("Muse Code runs this round with muse exec. It has 6 agent slots, every reminder and the platform's hooks."),
        log("Muse Code runs this round on its session host, so its owner can steer it."),
        log("The session bridge couldn't install its SDK, so this round runs on muse exec."),
        log("The session bridge didn't start (it stopped with code 1: boom), so this round runs on muse exec."),
        log("Muse Code: Passed a full security audit"),
        log("Muse Code was stopped after 25 minutes."),
        log("Muse Code ended with an error. Checking what it wrote."),
        log("Fixtures could not be prepared. Muse Code will make its own."),
      ),
      null,
    );
    assert.deepEqual(highlights, [
      "Muse Code was stopped after 25 minutes.",
      "Muse Code ended with an error. Checking what it wrote.",
      "Fixtures could not be prepared. Muse Code will make its own.",
    ]);
  });
});
