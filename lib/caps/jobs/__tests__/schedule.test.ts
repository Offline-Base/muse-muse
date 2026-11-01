/**
 * When schedules run (docs/CAPABILITIES.md, section 12): the 15-minute floor, the words, and time zones across daylight
 * saving changes.
 *   npx tsx --test lib/caps/jobs/__tests__/schedule.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { everyWords, nextRunAfter, parseEvery } from "@/lib/caps/jobs/schedule";

describe("parseEvery", () => {
  it("reads the words a brief uses", () => {
    assert.deepEqual(parseEvery("15 minutes"), { everyMinutes: 15, atMinute: null, tz: "UTC" });
    assert.deepEqual(parseEvery("every 2 hours"), { everyMinutes: 120, atMinute: null, tz: "UTC" });
    assert.deepEqual(parseEvery("1 day at 07:30"), { everyMinutes: 1440, atMinute: 450, tz: "UTC" });
    assert.deepEqual(parseEvery("1 week at 09:00 America/New_York"), { everyMinutes: 10080, atMinute: 540, tz: "America/New_York" });
    assert.deepEqual(parseEvery("daily at 06:00"), { everyMinutes: 1440, atMinute: 360, tz: "UTC" });
    assert.deepEqual(parseEvery("hourly"), { everyMinutes: 60, atMinute: null, tz: "UTC" });
    assert.deepEqual(parseEvery("weekly"), { everyMinutes: 10080, atMinute: null, tz: "UTC" });
  });

  it("raises anything under 15 minutes to 15", () => {
    assert.equal(parseEvery("1 minute")?.everyMinutes, 15);
    assert.equal(parseEvery("every 5 minutes")?.everyMinutes, 15);
    assert.equal(parseEvery("14 minutes")?.everyMinutes, 15);
    assert.equal(parseEvery("16 minutes")?.everyMinutes, 16);
  });

  it("refuses what isn't a schedule, a time that doesn't exist and an unknown time zone", () => {
    for (const bad of ["", "soon", "0 minutes", "1 day at 25:00", "1 day at 07:99", "1 day at 07:30 Mars/Olympus", "1 fortnight", 15, null]) assert.equal(parseEvery(bad), null, String(bad));
  });

  it("says a schedule back in words it reads", () => {
    for (const words of ["15 minutes", "2 hours", "1 day at 07:30", "1 week at 09:00 America/New_York"]) assert.equal(everyWords(parseEvery(words)!), words);
  });
});

describe("nextRunAfter", () => {
  const every = (s: string) => parseEvery(s)!;

  it("lines sub-day slots up from midnight, always after the time given", () => {
    assert.equal(nextRunAfter(every("15 minutes"), new Date("2026-06-01T10:07:00Z")).toISOString(), "2026-06-01T10:15:00.000Z");
    assert.equal(nextRunAfter(every("15 minutes"), new Date("2026-06-01T10:15:00Z")).toISOString(), "2026-06-01T10:30:00.000Z");
    assert.equal(nextRunAfter(every("6 hours at 00:30"), new Date("2026-06-01T07:00:00Z")).toISOString(), "2026-06-01T12:30:00.000Z");
    assert.equal(nextRunAfter(every("2 hours"), new Date("2026-06-01T23:30:00Z")).toISOString(), "2026-06-02T00:00:00.000Z");
  });

  it("keeps a daily time on the local clock in a time zone, summer and winter", () => {
    const daily = every("1 day at 07:30 America/New_York");
    assert.equal(nextRunAfter(daily, new Date("2026-07-01T00:00:00Z")).toISOString(), "2026-07-01T11:30:00.000Z", "EDT is UTC-4");
    assert.equal(nextRunAfter(daily, new Date("2026-07-01T11:30:00Z")).toISOString(), "2026-07-02T11:30:00.000Z");
    assert.equal(nextRunAfter(daily, new Date("2026-01-15T00:00:00Z")).toISOString(), "2026-01-15T12:30:00.000Z", "EST is UTC-5");
  });

  it("stays at 07:30 local across both clock changes", () => {
    const daily = every("1 day at 07:30 America/New_York");
    // Spring forward is Mar 8 2026, fall back is Nov 1 2026.
    assert.equal(nextRunAfter(daily, new Date("2026-03-07T13:00:00Z")).toISOString(), "2026-03-08T11:30:00.000Z");
    assert.equal(nextRunAfter(daily, new Date("2026-10-31T12:00:00Z")).toISOString(), "2026-11-01T12:30:00.000Z");
  });

  it("a time the spring change skips runs that much later, and a time that happens twice runs the first time", () => {
    assert.equal(nextRunAfter(every("1 day at 02:30 America/New_York"), new Date("2026-03-08T05:00:00Z")).toISOString(), "2026-03-08T07:30:00.000Z", "03:30 EDT");
    assert.equal(nextRunAfter(every("1 day at 01:30 America/New_York"), new Date("2026-11-01T04:00:00Z")).toISOString(), "2026-11-01T05:30:00.000Z", "the first 01:30, in EDT");
  });

  it("handles a zone on a half hour and one east of UTC, across its midnight", () => {
    assert.equal(nextRunAfter(every("1 day at 09:00 Asia/Kolkata"), new Date("2026-06-01T04:00:00Z")).toISOString(), "2026-06-02T03:30:00.000Z");
    assert.equal(nextRunAfter(every("1 day at 00:10 Asia/Tokyo"), new Date("2026-06-01T14:00:00Z")).toISOString(), "2026-06-01T15:10:00.000Z");
  });

  it("weekly runs land on one weekday, and move a week at a time", () => {
    const weekly = every("1 week at 09:00");
    const first = nextRunAfter(weekly, new Date("2026-06-01T00:00:00Z"));
    const second = nextRunAfter(weekly, first);
    assert.equal(second.getTime() - first.getTime(), 7 * 86_400_000);
    assert.equal(first.getUTCDay(), second.getUTCDay());
    assert.equal(first.getUTCHours(), 9);
  });

  it("is never at or before the time given, whatever the schedule", () => {
    for (const words of ["15 minutes", "45 minutes", "3 hours at 01:15 Europe/Paris", "1 day at 23:59 Pacific/Auckland", "2 days at 12:00", "1 week"]) {
      let at = new Date("2026-03-07T00:00:00Z");
      for (let i = 0; i < 40; i++) {
        const next = nextRunAfter(every(words), at);
        assert.ok(next > at, `${words} from ${at.toISOString()}`);
        at = next;
      }
    }
  });
});
