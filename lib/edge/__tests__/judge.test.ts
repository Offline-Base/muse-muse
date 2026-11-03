/**
 * The edge board judge note and the board requirement check (lib/edge/judge.ts).
 *   npx tsx --test lib/edge/__tests__/judge.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestDrills } from "@/lib/edge/drills";
import { boardBackupDrilled, EDGE_BOARD_JUDGE_NOTE, EDGE_BOARD_REQUIREMENT_JUDGE_NOTE, EDGE_BOARD_STATUS_JUDGE_NOTE, isBoardRequirement } from "@/lib/edge/judge";

const rows = (ok: Record<number, boolean>) =>
  latestDrills([{ steps: Object.entries(ok).map(([id, pass]) => ({ name: `Simulated outage drill ${id}: x`, ok: pass })) }])!.drills;

describe("the edge board judge note", () => {
  it("passes the honest not-connected line, fails cloud answers on board screens, and never takes a cloud label as board proof", () => {
    assert.match(EDGE_BOARD_JUDGE_NOTE, /"Not connected to a board" (.*) is the truth and the product working/);
    assert.match(EDGE_BOARD_JUDGE_NOTE, /Fail it when a screen, tab or mode that says it shows the board .* shows an answer labeled "Answered in the cloud" or "Seen in the cloud"/);
    assert.match(EDGE_BOARD_JUDGE_NOTE, /never proven by an answer labeled in the cloud/);
    assert.ok(!EDGE_BOARD_JUDGE_NOTE.includes("—"));
  });

  it("splits into a status part that is safe alone and a requirement part that needs the drill-backed test", () => {
    assert.equal(EDGE_BOARD_JUDGE_NOTE, `${EDGE_BOARD_STATUS_JUDGE_NOTE} ${EDGE_BOARD_REQUIREMENT_JUDGE_NOTE}`);
    assert.match(EDGE_BOARD_STATUS_JUDGE_NOTE, /Checking for a board/);
    assert.ok(!/requirement|test:/i.test(EDGE_BOARD_STATUS_JUDGE_NOTE), "the status part never points the judge at a requirement test");
    assert.match(EDGE_BOARD_REQUIREMENT_JUDGE_NOTE, /go by it\.$/);
  });
});

describe("isBoardRequirement", () => {
  it("picks the board backup requirements and leaves the rest", () => {
    for (const t of ["Keeps answering from the edge board when the cloud is cut", "Show a labeled edge backup answer", "Works with the Jetson when offline", "Answers when the cloud is down"]) assert.ok(isBoardRequirement(t), t);
    for (const t of ["Show the three readings in a table", "Door check finds an open door in a photo", "Status label names who answered"]) assert.ok(!isBoardRequirement(t), t);
  });
});

describe("boardBackupDrilled", () => {
  it("is true only when every drill passed and both fallback drills ran, for the answer or the look", () => {
    assert.equal(boardBackupDrilled(rows({ 1: true, 2: true, 3: true, 4: true, 17: true, 18: true })), true);
    assert.equal(boardBackupDrilled(rows({ 12: true, 13: true, 14: true, 15: true })), true);
    assert.equal(boardBackupDrilled(rows({ 1: true, 2: false, 3: true, 4: true })), false);
    assert.equal(boardBackupDrilled(rows({ 1: true, 3: true })), false);
    assert.equal(boardBackupDrilled(rows({ 1: true, 2: true, 18: false })), false, "a dishonest board line fails it too");
    assert.equal(boardBackupDrilled(null), false);
    assert.equal(boardBackupDrilled([]), false);
  });
});
