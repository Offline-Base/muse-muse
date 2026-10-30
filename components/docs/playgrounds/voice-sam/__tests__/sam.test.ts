/**
 * The SAM demos' logic: the wire line split into its parts, objects followed across frames, frame order, which frames
 * a tracking direction covers and what it costs, the concept prompt rules, mask area, and Meta's @meta-sam/parser fed
 * through the event channel with real streams captured through the docs proxy on Oct 30, 2026 (fixtures/), plus every
 * stream lifecycle scenario the client-libraries demo replays, the raw wire shown short without changing what SAM
 * sent, and a request that fails inside its stream under HTTP 200 (sam-aspect-failed.sse) read as a failure.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/voice-sam/__tests__/sam.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { sseReader } from "@/lib/docs/client/api";
import { parseSamOutput, samDelta, type SamRecord } from "@/lib/docs/media/sam";
import { createEventChannel } from "@/components/docs/playgrounds/voice-sam/event-channel";
import { DOC_CONFIDENCE_LINE, DOC_VIDEO_LINE, SCENARIOS, runScenario } from "@/components/docs/playgrounds/voice-sam/parser-scenarios";
import { EMPTY_SAM_OUTPUT, failureEvents, samOutcome, samResultView, samStreamError, type SamRunOutput } from "@/components/docs/playgrounds/voice-sam/useSamRun";
import type { DocsResult } from "@/lib/docs/client/api";
import {
  earliestPromptFrame,
  frameOrder,
  lintConcept,
  maskAreaPx,
  maskDataSummary,
  objectTracks,
  promptFrames,
  samCostUsd,
  shortMaskToken,
  shortPayload,
  trackedFrames,
  wireSpans,
} from "@/components/docs/playgrounds/voice-sam/sam-wire";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function sseJson(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const r = sseReader((e) => e.json && out.push(e.json));
  r.push(text);
  r.end();
  return out;
}

async function* createEventChannelFrom(list: Array<Record<string, unknown>>): AsyncGenerator<{ type: string }> {
  for (const e of list) yield e as { type: string };
}

const record = (frame: number, objectId: string, c?: number): SamRecord => ({
  frame,
  objectId,
  box: { x1: 0, y1: 0, x2: 9, y2: 9, w: 100, h: 100, ...(c === undefined ? {} : { confidence: c }) },
  mask: { height: 10, width: 10, encoding: "one_bit", payload: "!x" },
});

describe("wire spans", () => {
  it("splits the page's video line into frame, ids, boxes, masks and the separator", () => {
    const spans = wireSpans(DOC_VIDEO_LINE.trim());
    assert.deepEqual(
      spans.map((s) => s.kind),
      ["frame", "id", "box", "mask", "sep", "id", "box", "mask"],
    );
    assert.equal(spans.map((s) => s.text).join(""), DOC_VIDEO_LINE.trim(), "the spans cover the line exactly");
    assert.deepEqual(spans[2].fields, { x1: "211", y1: "228", x2: "270", y2: "254", w: "320", h: "334" });
    assert.equal(spans[5].text, "1");
    assert.equal(spans[7].record, 1);
    const data = maskDataSummary(spans[3].fields?.data ?? "");
    assert.deepEqual(data && { h: data.height, w: data.width, m: data.marker }, { h: 27, w: 60, m: "~" });
  });

  it("reads c on both tokens and a real one_bit line", () => {
    const spans = wireSpans(DOC_CONFIDENCE_LINE.trim());
    assert.equal(spans[2].fields?.c, "0.9609375");
    assert.equal(spans[3].fields?.c, "0.9609375");
    const real = sseJson(fixture("sam-image.sse")).map(samDelta).find((d) => d !== null) ?? "";
    const kinds = wireSpans(real.trim()).map((s) => s.kind);
    assert.deepEqual(kinds, ["frame", "id", "box", "mask", "sep", "id", "box", "mask"]);
    assert.equal(maskDataSummary(wireSpans(real.trim())[3].fields?.data ?? "")?.marker, "!");
  });

  it("reads box and point prompt text, negative points included", () => {
    const spans = wireSpans("<0f>1<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>,2<|point;x=1430;y=700;w=1800;h=1200|>-<|point;x=1300;y=450;w=1800;h=1200|>");
    assert.deepEqual(spans.map((s) => s.kind), ["frame", "id", "box", "sep", "id", "point", "neg", "point"]);
    assert.deepEqual(spans[7].fields, { x: "1300", y: "450", w: "1800", h: "1200" });
  });

  it("marks text lines and shortens long payloads", () => {
    assert.deepEqual(wireSpans("hello").map((s) => s.kind), ["text"]);
    const short = shortPayload("27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(");
    assert.equal(short, "27,60,~!!!!M!0c[0o91w?q1... (55 chars)");
    assert.equal(shortPayload("46,101,~..."), "46,101,~...");
  });

  it("shortens payloads holding $&, $' and $` without rewriting them as replacement patterns", () => {
    // $, &, ' and ` are base85 digits (SAM_BASE85), so real payloads hold these pairs.
    const a = "248,207,!!!!!$'AhVQ:Y*$`qrstuvwxyz0123456789";
    const b = "40,30,~!!!!$&$$abcdefghijklmnopqrstuvwxyz";
    const line = `<0f>0<|box;x1=1;y1=2;x2=208;y2=249;w=1280;h=853|><|mask;x=0;y=0;data=${a}|>,1<|box;x1=5;y1=6;x2=35;y2=46;w=1280;h=853|><|mask;x=0;y=0;data=${b}|>`;
    const shown = wireSpans(line)
      .map((sp) => (sp.kind === "mask" && sp.fields?.data ? shortMaskToken(sp.text, sp.fields.data) : sp.text))
      .join("");
    // Split and join take no patterns: the line with only its two payloads shortened.
    assert.equal(shown, line.split(a).join(shortPayload(a)).split(b).join(shortPayload(b)));
    assert.ok(shown.includes("data=248,207,!!!!!$'AhVQ:Y*$`qr... (36 chars)|>"));
    assert.ok(shown.includes("data=40,30,~!!!!$&$$abcdefghi... (35 chars)|>"));
    assert.equal(shortMaskToken("<|mask;x=0;y=0;data=1,2,~ab|>", "1,2,~ab"), "<|mask;x=0;y=0;data=1,2,~ab|>", "short payloads stay whole");
  });
});

describe("a request that fails inside its stream", () => {
  const events = () => sseJson(fixture("sam-aspect-failed.sse"));
  const ok200: DocsResult = { ok: true, status: 200, json: null, text: "", blob: null, headers: {}, error: null, model: "sam-3.1", note: null, elapsedMs: 900 };
  /** The output useSamRun builds from these events: types folded, the first failure kept. */
  const outOf = (list: Array<Record<string, unknown>>): SamRunOutput => {
    const types: Array<[string, number]> = [];
    let error: SamRunOutput["error"] = null;
    for (const e of list) {
      const type = String(e.type);
      const last = types.at(-1);
      if (last && last[0] === type) last[1]++;
      else types.push([type, 1]);
      error ??= samStreamError(e);
    }
    return { ...EMPTY_SAM_OUTPUT, events: types, error, done: true };
  };

  it("reads the error event and response.failed the aspect-ratio check sends after HTTP 200", () => {
    const failures = events().map(samStreamError).filter((f) => f !== null);
    const message = "prompt coordinates are given in a 1280x720 frame, whose aspect ratio does not match the 1280x853 media";
    assert.deepEqual(failures, [{ code: "invalid_prompt", message }, { code: "invalid_prompt", message }]);
    assert.equal(samStreamError({ type: "response.output_text.delta", delta: "<0f>" }), null);
    assert.equal(samStreamError({ type: "response.completed", response: {} }), null);
    assert.deepEqual(samStreamError({ type: "error", error: { message: "nested" } }), { message: "nested" });
    assert.deepEqual(samStreamError({ type: "response.failed", response: {} }), { message: "The response failed." });
  });

  it("records it as a failure, not as zero matches, and shows its status as failed", () => {
    const out = outOf(events());
    assert.equal(failureEvents(out), "an error event, then response.failed");
    const said = samOutcome(out, ok200);
    assert.match(said, /^HTTP 200, then the stream failed \(an error event, then response\.failed\): invalid_prompt: prompt coordinates/);
    assert.doesNotMatch(said, /no matches/);
    // The same output without the failure is the documented zero-match result.
    assert.match(samOutcome({ ...out, error: null }, ok200), /^no matches/);
    assert.equal(samResultView(ok200, out)?.error?.code, "invalid_prompt");
    assert.equal(samResultView(ok200, out)?.status, 200);
    assert.equal(samResultView(ok200, { ...out, error: null }), ok200);
    assert.equal(samResultView(null, out), null);
  });

  it("is what Meta's parser throws on too", async () => {
    const parsed = parseImageStream(createEventChannelFrom(events()));
    await assert.rejects(parsed.finalResult, (err: Error & { code?: string }) => err.code === "response_error");
  });
});

describe("objects, frames and tracking", () => {
  it("follows each id across frames and counts the gaps", () => {
    const tracks = objectTracks([record(0, "0", 0.9), record(1, "0", 0.7), record(3, "0"), record(1, "2"), record(2, "2")]);
    assert.deepEqual(
      tracks.map((t) => [t.objectId, t.frames, t.gaps]),
      [
        ["0", [0, 1, 3], 1],
        ["2", [1, 2], 0],
      ],
    );
    assert.equal(tracks[0].minConfidence, 0.7);
    assert.equal(tracks[1].minConfidence, undefined);
  });

  it("tells ascending lines from forward-then-backward ones", () => {
    assert.equal(frameOrder([0]), "single");
    assert.equal(frameOrder([0, 2, 5]), "ascending");
    assert.equal(frameOrder([30, 31, 199, 29, 28, 0]), "forward-then-backward");
    assert.equal(frameOrder([60, 59, 1, 0]), "descending");
    assert.equal(frameOrder([3, 1, 2]), "other");
  });

  it("covers the frames the page's table gives for prompts on frames 30 and 120 of a 200-frame clip", () => {
    assert.deepEqual(trackedFrames("both", 30, 200), { frames: 200, billed: 200, range: "30 to 199, then 29 to 0" });
    assert.deepEqual(trackedFrames("forward", 30, 200), { frames: 170, billed: 170, range: "30 to 199" });
    assert.deepEqual(trackedFrames("backward", 30, 200), { frames: 31, billed: 50, range: "30 to 0" });
    assert.equal(trackedFrames("both", 0, 120).range, "0 to 119");
  });

  it("prices images and frames with the 50-frame minimum", () => {
    assert.equal(samCostUsd("image"), 0.0025);
    assert.ok(Math.abs(samCostUsd("video", 120) - 0.024) < 1e-12);
    assert.ok(Math.abs(samCostUsd("video", 10) - 0.01) < 1e-12);
  });

  it("reads prompt frames and the earliest one", () => {
    assert.deepEqual(promptFrames("<30f>1<|point;x=1;y=1;w=9;h=9|><120f>1<|point;x=2;y=2;w=9;h=9|>"), [30, 120]);
    assert.equal(earliestPromptFrame([{ frame: 90 }, { frame: 30 }, {}]), 0);
    assert.equal(earliestPromptFrame([{ frame: 90 }, { frame: 30 }]), 30);
  });

  it("scales a mask's set pixels to source pixels when the raster isn't the box's size", () => {
    const r: SamRecord = { ...record(0, "1"), box: { x1: 0, y1: 0, x2: 19, y2: 19, w: 100, h: 100 } };
    assert.equal(maskAreaPx(r, 50), 200);
    assert.equal(maskAreaPx(record(0, "1"), 50), 50);
  });
});

describe("concept prompt rules", () => {
  const rules = (p: string) => lintConcept(p).map((w) => `${w.rule}:${w.effect}`);
  it("passes a plain noun phrase", () => {
    assert.deepEqual(lintConcept("yellow school bus"), []);
    assert.deepEqual(lintConcept("red squares."), []);
  });
  it("flags what the page says returns nothing or varies", () => {
    assert.deepEqual(rules("bus, bicycle"), ["One concept per request:zero"]);
    assert.deepEqual(rules("bus + bicycle"), ["One concept per request:zero"]);
    assert.deepEqual(rules("dog and cat"), ["One concept per request:unreliable"]);
    assert.ok(rules("segment the bus").includes("Name the object; don't instruct the model:unreliable"));
    assert.ok(rules("where is the bus?").includes("Name the object; don't instruct the model:unreliable"));
    assert.ok(rules("person not wearing a hat").includes("Skip negation:unreliable"));
    assert.ok(rules("cat or dog").includes("Skip boolean OR:unreliable"));
    assert.ok(rules("person on the left").includes("Skip spatial phrasing:unreliable"));
    assert.ok(rules("a very fluffy small happy brown dog sitting").includes("Keep it short:unreliable"));
    assert.deepEqual(rules("<0f>1<|point;x=1;y=1;w=2;h=2|>"), ["One kind of prompt:info"]);
  });
});

describe("Meta's parser on real streams", () => {
  it("parses the captured image stream fed through the event channel", async () => {
    const channel = createEventChannel<{ type: string }>();
    const parsed = parseImageStream(channel.iterable);
    const done = (async () => {
      let snapshots = 0;
      for await (const s of parsed) snapshots += s.records.length ? 1 : 0;
      return { snapshots, result: await parsed.finalResult };
    })();
    for (const e of sseJson(fixture("sam-image.sse"))) if (typeof e.type === "string") channel.push(e as { type: string });
    channel.end();
    const { snapshots, result } = await done;
    assert.equal(snapshots, 1);
    assert.deepEqual(result.outcome, { status: "completed" });
    const boxes = recordsOfKind(result.records, "box");
    assert.deepEqual(
      boxes.map((b) => [b.objectId, b.left, b.top, b.right, b.bottom]),
      [
        ["0", 186, 587, 393, 835],
        ["1", 412, 578, 582, 798],
      ],
      "half-open boxes: right = x2 + 1",
    );
    const masks = recordsOfKind(result.records, "mask");
    assert.deepEqual([masks[0].mask.encoding, masks[0].mask.height, masks[0].mask.width], ["one_bit", 248, 207]);
    // The kit's own parser reads the same text the same way.
    const kit = parseSamOutput(result.rawOutput);
    assert.deepEqual(kit.records.map((r) => [r.objectId, r.box.x2]), [["0", 392], ["1", 581]]);
  });

  it("completes a zero-match stream with no records", async () => {
    const channel = createEventChannel<{ type: string }>();
    const parsed = parseImageStream(channel.iterable);
    for (const e of sseJson(fixture("sam-zero.sse"))) if (typeof e.type === "string") channel.push(e as { type: string });
    channel.end();
    const result = await parsed.finalResult;
    assert.deepEqual(result.outcome, { status: "completed" });
    assert.equal(result.records.length, 0);
    assert.equal(result.rawOutput, "");
  });

  it("delivers pushes in order, ends, fails, and takes one reader", async () => {
    const ch = createEventChannel<number>();
    ch.push(1);
    setTimeout(() => {
      ch.push(2);
      ch.end();
      ch.push(3);
    }, 5);
    const seen: number[] = [];
    for await (const v of ch.iterable) seen.push(v);
    assert.deepEqual(seen, [1, 2]);
    assert.throws(() => ch.iterable[Symbol.asyncIterator](), /one reader/);
    const bad = createEventChannel<number>();
    bad.fail(new Error("source failed"));
    await assert.rejects(async () => {
      for await (const v of bad.iterable) void v;
    }, /source failed/);
  });
});

describe("stream lifecycle scenarios", () => {
  const expected: Record<string, { outcome?: string; reason?: string; code?: string; records?: number }> = {
    completed: { outcome: "completed", records: 4 },
    confidence: { outcome: "completed", records: 4 },
    zero: { outcome: "completed", records: 0 },
    eof: { outcome: "incomplete", reason: "eof", records: 4 },
    incomplete: { outcome: "incomplete", reason: "response", records: 4 },
    bad_line: { outcome: "completed", records: 4 },
    failed: { code: "response_failed" },
    error_event: { code: "response_error" },
    refusal: { code: "response_refusal" },
    lane: { code: "response_lane" },
    source: { code: "source_error" },
    consumed: { code: "stream_consumed" },
    aborted: { code: "stream_aborted" },
    invalid_mask: { code: "invalid_mask_payload" },
  };
  for (const s of SCENARIOS) {
    it(`${s.label}: ${s.expect}`, async () => {
      const r = await runScenario(s.id);
      const want = expected[s.id];
      if (want.code) {
        assert.equal(r.error?.code, want.code);
        assert.match(r.error?.name ?? "", /Error$/);
        return;
      }
      assert.equal(r.error, undefined);
      assert.equal(r.outcome?.status, want.outcome);
      if (want.reason) assert.equal((r.outcome as { reason?: string }).reason, want.reason);
      assert.equal(r.records, want.records);
    });
  }
  it("keeps confidence per record and reports the malformed line as a diagnostic", async () => {
    assert.deepEqual((await runScenario("confidence")).boxes?.map((b) => b.confidence), [0.9609375, 0.71875]);
    const bad = await runScenario("bad_line");
    assert.deepEqual(bad.diagnostics?.map((d) => [d.severity, d.code, d.line]), [["error", "malformed_record", 2]]);
  });
});
