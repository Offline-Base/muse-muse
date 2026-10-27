import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogItems, itemId, rebuildNote, rebuildTargetFor } from "@/lib/pipeline/catalog";
import { formatSseEvent, isTerminalEvent, parseCursor } from "@/lib/pipeline/sse";
import { dailyBuildQuota, quotaDecision, quotaWindowStart, spendPausedDecision } from "@/lib/quota";
import type { BuildEvent } from "@/lib/types";

describe("quota math", () => {
  it("follows MAX_BUILDS_PER_USER_PER_DAY on every check, so a raised limit reaches users who signed in earlier", () => {
    const saved = process.env.MAX_BUILDS_PER_USER_PER_DAY;
    try {
      delete process.env.MAX_BUILDS_PER_USER_PER_DAY;
      assert.equal(dailyBuildQuota(), 3);
      process.env.MAX_BUILDS_PER_USER_PER_DAY = "10";
      assert.equal(dailyBuildQuota(), 10);
      process.env.MAX_BUILDS_PER_USER_PER_DAY = "nope";
      assert.equal(dailyBuildQuota(), 3);
    } finally {
      if (saved === undefined) delete process.env.MAX_BUILDS_PER_USER_PER_DAY;
      else process.env.MAX_BUILDS_PER_USER_PER_DAY = saved;
    }
  });

  it("blocks at the quota, exempts admins", () => {
    assert.deepEqual(quotaDecision({ isAdmin: false, quota: 3, used: 2 }), { allowed: true, remaining: 1 });
    assert.deepEqual(quotaDecision({ isAdmin: false, quota: 3, used: 3 }), { allowed: false, remaining: 0 });
    assert.deepEqual(quotaDecision({ isAdmin: false, quota: 3, used: 9 }), { allowed: false, remaining: 0 });
    assert.deepEqual(quotaDecision({ isAdmin: true, quota: 0, used: 50 }), { allowed: true, remaining: null });
  });

  it("counts a rolling 24 hours", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    assert.equal(quotaWindowStart(now).toISOString(), "2026-10-26T12:00:00.000Z");
  });

  it("pauses at the spend cap", () => {
    assert.equal(spendPausedDecision(39.99, 40), false);
    assert.equal(spendPausedDecision(40, 40), true);
  });
});

describe("sse", () => {
  const event: BuildEvent = { id: 42, at: "2026-10-27T12:00:00.000Z", type: "log", text: "line one\nline two" };

  it("frames one event per message with a single data line", () => {
    const framed = formatSseEvent(event);
    assert.ok(framed.startsWith("id: 42\nevent: build\ndata: "));
    assert.ok(framed.endsWith("\n\n"));
    assert.equal(framed.split("\n").length, 5);
    assert.deepEqual(JSON.parse(framed.split("\n")[2]!.slice("data: ".length)), event);
  });

  it("resumes from Last-Event-ID, then ?after=", () => {
    assert.equal(parseCursor("17", "3"), 17);
    assert.equal(parseCursor(null, "3"), 3);
    assert.equal(parseCursor("abc", "3"), 3);
    assert.equal(parseCursor(null, null), 0);
    assert.equal(parseCursor("-5", "x"), 0);
  });

  it("knows which status events end a build", () => {
    assert.equal(isTerminalEvent({ ...event, type: "status", status: "live" } as BuildEvent), true);
    assert.equal(isTerminalEvent({ ...event, type: "status", status: "verifying" } as BuildEvent), false);
    assert.equal(isTerminalEvent(event), false);
  });
});

describe("catalog", () => {
  it("has unique ids for videos and missing demos", () => {
    const ids = catalogItems().map(itemId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes("structured-image-extraction"));
    assert.ok(ids.includes("sam-first-demo"));
  });

  it("gives every item a rebuild target and a note with no em dashes", () => {
    for (const item of catalogItems()) {
      const target = rebuildTargetFor(itemId(item));
      assert.ok(target, itemId(item));
      assert.ok(target.title.length > 0);
      const note = rebuildNote(item);
      assert.ok(!note.includes("\u2014"), itemId(item));
      assert.ok(!note.includes(".."), itemId(item));
      if (item.kind === "video") {
        assert.ok(note.includes(item.video.url));
        assert.ok(note.includes(item.video.title));
      }
    }
    assert.equal(rebuildTargetFor("nope"), null);
    assert.equal(rebuildTargetFor(null), null);
  });
});
