/**
 * SAM 3.1's wire format (lib/docs/media/sam.ts) on the samples in Meta's docs: the video grammar line from
 * sam/reading-segmentation (two objects with full lossless payloads), the image grammar line (sparse-ready ids,
 * elided payloads), the confidence line, the protocol's 5 x 5 one_bit example, and a recorded stream from the gateway
 * fixtures. Covers frames, ids, boxes, confidence, optional commas, malformed lines, chunked streaming, the mask
 * envelope (marker, base85 alphabet, length prefix) and the box and point prompt builder.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/media/__tests__/sam.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SAM_BASE85,
  SamMaskError,
  SamPromptError,
  SamStreamParser,
  base85Length,
  boxFromCorners,
  buildSamPrompt,
  decodeSamBase85,
  objectIds,
  parseSamLine,
  parseSamOutput,
  readMaskEnvelope,
  recordsByFrame,
  samDelta,
  samTextOfResponse,
  toMediaPixels,
} from "@/lib/docs/media/sam";
import { decodeMaskRaster, hasMaskRasterDecoder, rasterArea, rasterToRgba, setMaskRasterDecoder } from "@/lib/docs/media/sam-mask";

/** sam/reading-segmentation, "Video output grammar": frame 0 of a clip, prompt "button", 320 x 334, two objects. */
const VIDEO_LINE =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>," +
  "1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>";

/** sam/reading-segmentation, "Image output grammar": three matches on a 537 x 561 image, payloads elided. */
const IMAGE_LINE =
  "<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~...|>," +
  "1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,~...|>," +
  "2<|box;x1=516;y1=117;x2=536;y2=150;w=537;h=561|><|mask;x=0;y=0;data=34,21,~...|>";

/** sam/reading-segmentation, "Confidence". */
const CONFIDENCE_LINE =
  "<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=226,236,!...|>";

/** The protocol's 5 x 5 one_bit example (linked from sam/client-libraries). */
const PROTOCOL_LINE = "<7f>0<|box;x1=10;y1=20;x2=14;y2=24;w=100;h=80;c=0.75|><|mask;x=0;y=0;c=0.75;data=5,5,!!!!!(QO(0lu8?|>";

/** One delta from a real SAM 3.1 stream (lib/gateway/__tests__/fixtures/sam-stream.sse): one_bit, with confidence. */
const RECORDED_DELTA =
  "<0f>0<|box;x1=59;y1=59;x2=197;y2=197;w=256;h=256;c=0.9101123809814453|><|mask;x=0;y=0;c=0.9101123809814453;" +
  "data=139,139,!!!!#&CocUv){Z[ZJJxSLdYztm!rF=DD$5]AWiOUr?bC.j)qfZ5=VkdBgc&=PUvqgU+fe@Jg@nSihOM$G5ap:Jgxvu!l@bWCj^L5?+`ULzUy]y-SGA1^!!|>\n";

describe("parseSamLine", () => {
  it("reads the docs' video line: frame, ids, boxes and masks", () => {
    const { frame, diagnostics } = parseSamLine(VIDEO_LINE);
    assert.deepEqual(diagnostics, []);
    assert.equal(frame?.frame, 0);
    assert.equal(frame?.records.length, 2);
    const [a, b] = frame!.records;
    assert.equal(a.objectId, "0");
    assert.deepEqual(a.box, { x1: 211, y1: 228, x2: 270, y2: 254, w: 320, h: 334 });
    assert.equal(a.mask.height, 27);
    assert.equal(a.mask.width, 60);
    assert.equal(a.mask.encoding, "lossless");
    assert.ok(a.mask.payload.startsWith("~!!!!M"));
    assert.equal(b.objectId, "1");
    assert.equal(b.mask.width, 48);
    // The mask raster is the box's own size: x2 and y2 are inclusive.
    assert.equal(a.box.x2 - a.box.x1 + 1, a.mask.width);
    assert.equal(a.box.y2 - a.box.y1 + 1, a.mask.height);
  });

  it("reads the docs' image line with three objects", () => {
    const { frame } = parseSamLine(IMAGE_LINE);
    assert.deepEqual(
      frame?.records.map((r) => [r.objectId, r.mask.height, r.mask.width]),
      [
        ["0", 46, 101],
        ["1", 46, 81],
        ["2", 34, 21],
      ],
    );
  });

  it("reads confidence by key, with the mask's c between y and data", () => {
    const { frame } = parseSamLine(CONFIDENCE_LINE);
    const [r] = frame!.records;
    assert.equal(r.objectId, "1");
    assert.equal(r.box.confidence, 0.9609375);
    assert.equal(r.mask.confidence, 0.9609375);
    assert.equal(r.mask.encoding, "one_bit");
    assert.equal(parseSamLine(VIDEO_LINE).frame!.records[0].box.confidence, undefined, "absent, not zero");
  });

  it("keeps sparse ids and the explicit frame number", () => {
    const line = "<12f>0<|box;x1=1;y1=1;x2=2;y2=2;w=10;h=10|><|mask;x=0;y=0;data=2,2,!x|>,7<|box;x1=3;y1=3;x2=4;y2=4;w=10;h=10|><|mask;x=0;y=0;data=2,2,~x|>";
    const { frame } = parseSamLine(line);
    assert.equal(frame?.frame, 12);
    assert.deepEqual(frame?.records.map((r) => r.objectId), ["0", "7"]);
  });

  it("takes records without commas, fields in any order, and a mask before its box", () => {
    const line = "<0f>3<|mask;data=1,1,!a;y=0;x=0|><|box;h=5;w=5;y2=0;x2=0;y1=0;x1=0|>4<|box;x1=1;y1=1;x2=1;y2=1;w=5;h=5|><|mask;x=0;y=0;data=1,1,!b|>";
    const { frame, diagnostics } = parseSamLine(line);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(frame?.records.map((r) => r.objectId), ["3", "4"]);
  });

  it("warns about unknown tokens and fields but keeps the record", () => {
    const line = "<0f;extra=1>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4;z=9|><|note;hi|><|mask;x=0;y=0;data=2,2,!q|>";
    const { frame, diagnostics } = parseSamLine(line);
    assert.equal(frame?.records.length, 1);
    assert.deepEqual(diagnostics.map((d) => d.code).sort(), ["ignored_field", "ignored_field", "ignored_token"]);
  });

  it("drops a bad confidence but keeps the box", () => {
    const { frame, diagnostics } = parseSamLine("<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4;c=1.5|><|mask;x=0;y=0;data=2,2,!q|>");
    assert.equal(frame?.records[0].box.confidence, undefined);
    assert.equal(diagnostics[0].code, "ignored_confidence");
  });

  it("reports malformed lines without records", () => {
    const bad = [
      "<0f>",
      "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4|>",
      "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4|><|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4|><|mask;x=0;y=0;data=2,2,!q|>",
      "<0f>0<|box;x1=0;y1=0;x2=9;y2=1;w=4;h=4|><|mask;x=0;y=0;data=2,2,!q|>",
      "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4|><|mask;x=1;y=0;data=2,2,!q|>",
      "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4|><|mask;x=0;y=0;data=2,2,?q|>",
      "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4|> stray<|mask;x=0;y=0;data=2,2,!q|>",
      "<0f>0<|box;x1=a;y1=0;x2=1;y2=1;w=4;h=4|><|mask;x=0;y=0;data=2,2,!q|>",
      "<frame>",
    ];
    for (const line of bad) {
      const { frame, diagnostics } = parseSamLine(line);
      assert.equal(frame, null, line);
      assert.equal(diagnostics[0]?.code, "malformed_record", line);
    }
  });

  it("treats lines that don't start with < as text", () => {
    assert.equal(parseSamLine("I found nothing.").text, "I found nothing.");
    assert.equal(parseSamLine("   ").text, null);
  });
});

describe("parseSamOutput and SamStreamParser", () => {
  it("treats an empty output as zero matches", () => {
    const out = parseSamOutput("");
    assert.deepEqual(out.records, []);
    assert.deepEqual(out.diagnostics, []);
  });

  it("reads frames that skip and arrive out of order", () => {
    const line = (f: number, id: number) =>
      `<${f}f>${id}<|box;x1=0;y1=0;x2=1;y2=1;w=8;h=8|><|mask;x=0;y=0;data=2,2,!z|>`;
    const out = parseSamOutput([line(30, 1), line(31, 1), line(29, 1), line(0, 2)].join("\n"));
    assert.deepEqual(out.frames.map((f) => f.frame), [30, 31, 29, 0]);
    assert.deepEqual(objectIds(out.records), ["1", "2"]);
    assert.deepEqual([...recordsByFrame(out.records).keys()], [30, 31, 29, 0]);
  });

  it("parses a stream split anywhere, even inside a payload", () => {
    const text = `${VIDEO_LINE}\n${PROTOCOL_LINE}\n`;
    for (const size of [1, 7, 33, 500]) {
      const parser = new SamStreamParser();
      const seen: number[] = [];
      for (let i = 0; i < text.length; i += size) for (const f of parser.push(text.slice(i, i + size))) seen.push(f.frame);
      parser.end();
      assert.deepEqual(seen, [0, 7], `chunks of ${size}`);
      assert.equal(parser.output().records.length, 3);
      assert.equal(parser.raw, text);
    }
  });

  it("parses a last line with no newline at end()", () => {
    const parser = new SamStreamParser();
    assert.deepEqual(parser.push(PROTOCOL_LINE), []);
    assert.equal(parser.end().length, 1);
  });

  it("reports each warning once per stream but every malformed line", () => {
    const warn = "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=4;h=4;z=1|><|mask;x=0;y=0;data=2,2,!q|>";
    const out = parseSamOutput([warn, warn, "<0f>", "<1f>"].join("\n"));
    assert.equal(out.diagnostics.filter((d) => d.code === "ignored_field").length, 1);
    assert.deepEqual(out.diagnostics.filter((d) => d.code === "malformed_record").map((d) => d.line), [3, 4]);
  });

  it("reads a recorded stream's deltas and a non-streamed reply", () => {
    const events = [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: RECORDED_DELTA },
      { type: "response.completed", response: { usage: { images_processed: 1 } } },
    ];
    const text = events.map(samDelta).filter((d): d is string => d !== null).join("");
    const out = parseSamOutput(text);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].box.confidence, 0.9101123809814453);
    assert.equal(samTextOfResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "<0f>" }] }] }), "<0f>");
    assert.equal(samTextOfResponse({ output_text: "abc" }), "abc");
    assert.equal(samTextOfResponse(null), "");
  });
});

describe("mask envelope", () => {
  it("uses the documented 85-digit alphabet", () => {
    assert.equal(SAM_BASE85.length, 85);
    assert.equal(new Set(SAM_BASE85).size, 85);
    for (const c of `",;<>|\\}~`) assert.ok(!SAM_BASE85.includes(c), c);
    assert.equal(SAM_BASE85[0], "!");
    assert.equal(SAM_BASE85[84], "{");
  });

  it("matches every real payload's length prefix to its packed body", () => {
    const records = [VIDEO_LINE, PROTOCOL_LINE, RECORDED_DELTA].flatMap((l) => parseSamOutput(l).records);
    const seen = records.map((r) => {
      const env = readMaskEnvelope(r.mask);
      assert.equal(env.body.length, env.declaredBytes);
      return [r.mask.encoding, env.declaredBytes];
    });
    assert.deepEqual(seen, [
      ["lossless", 39],
      ["lossless", 36],
      ["one_bit", 6],
      ["one_bit", 89],
    ]);
  });

  it("packs four bytes into five digits and k - 1 bytes into a k-digit tail", () => {
    assert.deepEqual(Array.from(decodeSamBase85("!!!!!")), [0, 0, 0, 0]);
    assert.deepEqual(Array.from(decodeSamBase85("!!!!(")), [0, 0, 0, 6]);
    assert.equal(decodeSamBase85("QO(0lu8?").length, 6);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(base85Length), [0, 2, 3, 4, 5, 7, 8, 9, 10]);
    assert.throws(() => decodeSamBase85("!!!!!!"), SamMaskError, "a lone tail digit");
    assert.throws(() => decodeSamBase85("!!!~!"), SamMaskError, "~ is never a digit");
    assert.throws(() => decodeSamBase85("{{{{{"), SamMaskError, "over 2^32");
  });

  it("rejects truncated, padded and unmarked payloads", () => {
    const mask = parseSamOutput(PROTOCOL_LINE).records[0].mask;
    assert.throws(() => readMaskEnvelope({ payload: mask.payload.slice(0, -1) }), SamMaskError);
    assert.throws(() => readMaskEnvelope({ payload: `${mask.payload}!` }), SamMaskError);
    assert.throws(() => readMaskEnvelope({ payload: mask.payload.slice(1) }), SamMaskError);
    assert.throws(() => readMaskEnvelope({ payload: "~...", }), SamMaskError, "the docs' elided payloads");
  });
});

describe("mask rasters", () => {
  it("say masks are pending until a decoder is registered", () => {
    const mask = parseSamOutput(PROTOCOL_LINE).records[0].mask;
    assert.equal(hasMaskRasterDecoder(), false);
    const res = decodeMaskRaster(mask);
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.reason, "no_decoder");
  });

  it("use a registered decoder, check its size and cache by payload", () => {
    const mask = parseSamOutput(PROTOCOL_LINE).records[0].mask;
    let calls = 0;
    setMaskRasterDecoder((m) => {
      calls++;
      return Uint8Array.from({ length: m.width * m.height }, (_, i) => (i % 2 ? 1 : 0));
    });
    try {
      const a = decodeMaskRaster(mask);
      const b = decodeMaskRaster(mask);
      assert.ok(a.ok && b.ok);
      assert.equal(calls, 1);
      assert.equal(a.ok && rasterArea(a.raster), 12);
      setMaskRasterDecoder(() => new Uint8Array(3));
      const wrong = decodeMaskRaster(mask);
      assert.equal(!wrong.ok && wrong.reason, "invalid");
      const invalid = decodeMaskRaster({ ...mask, payload: "!!!!" });
      assert.equal(!invalid.ok && invalid.reason, "invalid");
    } finally {
      setMaskRasterDecoder(null);
    }
  });

  it("paint set pixels and leave the rest transparent", () => {
    const rgba = rasterToRgba(Uint8Array.from([1, 0, 0, 1]), 2, 2, [10, 20, 30, 128]);
    assert.deepEqual(Array.from(rgba), [10, 20, 30, 128, 0, 0, 0, 0, 0, 0, 0, 0, 10, 20, 30, 128]);
  });
});

describe("buildSamPrompt", () => {
  it("builds the docs' two-object image prompt", () => {
    const text = buildSamPrompt({ width: 1800, height: 1200 }, [
      { id: 1, box: { x1: 444, y1: 626, x2: 675, y2: 849 } },
      { id: 2, points: [{ x: 1430, y: 700 }, { x: 1300, y: 450, negative: true }] },
    ]);
    assert.equal(
      text,
      "<0f>1<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>,2<|point;x=1430;y=700;w=1800;h=1200|>-<|point;x=1300;y=450;w=1800;h=1200|>",
    );
  });

  it("builds the docs' multi-frame video prompt with frames in ascending order", () => {
    const text = buildSamPrompt({ width: 960, height: 540 }, [
      { id: 1, frame: 120, box: { x1: 493, y1: 320, x2: 641, y2: 444 } },
      { id: 1, frame: 30, points: [{ x: 585, y: 366 }] },
      { id: 2, frame: 160, points: [{ x: 533, y: 403 }, { x: 482, y: 405, negative: true }] },
      { id: 2, frame: 75, box: { x1: 405, y1: 337, x2: 516, y2: 420 } },
    ]);
    assert.equal(
      text,
      "<30f>1<|point;x=585;y=366;w=960;h=540|><75f>2<|box;x1=405;y1=337;x2=516;y2=420;w=960;h=540|>" +
        "<120f>1<|box;x1=493;y1=320;x2=641;y2=444;w=960;h=540|><160f>2<|point;x=533;y=403;w=960;h=540|>-<|point;x=482;y=405;w=960;h=540|>",
    );
  });

  it("puts an object's box before its points", () => {
    const text = buildSamPrompt({ width: 10, height: 10 }, [{ id: 0, box: { x1: 1, y1: 1, x2: 5, y2: 5 }, points: [{ x: 2, y: 2 }] }]);
    assert.equal(text, "<0f>0<|box;x1=1;y1=1;x2=5;y2=5;w=10;h=10|><|point;x=2;y=2;w=10;h=10|>");
  });

  it("refuses prompts the API would reject", () => {
    const size = { width: 100, height: 50 };
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        assert.ok(err instanceof SamPromptError);
        return err.code;
      }
      return "none";
    };
    assert.equal(code(() => buildSamPrompt(size, [])), "no_objects");
    assert.equal(code(() => buildSamPrompt(size, [{ id: 1 }])), "empty_object");
    assert.equal(code(() => buildSamPrompt(size, [{ id: -1, points: [{ x: 1, y: 1 }] }])), "invalid_object_id");
    assert.equal(code(() => buildSamPrompt(size, [{ id: 1, points: [{ x: 100, y: 1 }] }])), "invalid_point");
    assert.equal(code(() => buildSamPrompt(size, [{ id: 1, box: { x1: 5, y1: 5, x2: 4, y2: 9 } }])), "invalid_box");
    assert.equal(
      code(() => buildSamPrompt(size, [{ id: 1, points: [{ x: 1, y: 1 }] }, { id: 1, points: [{ x: 2, y: 2 }] }])),
      "duplicate_object_id",
    );
    const many = Array.from({ length: 17 }, (_, i) => ({ id: i, points: [{ x: 1, y: 1 }] }));
    assert.equal(code(() => buildSamPrompt(size, many)), "too_many_objects");
    assert.equal(code(() => buildSamPrompt({ width: 0, height: 5 }, [{ id: 1, points: [{ x: 0, y: 0 }] }])), "invalid_size");
  });
});

describe("toMediaPixels", () => {
  it("follows the docs' worked example: (100, 50) on a 640 x 360 preview of 1920 x 1080", () => {
    const view = { left: 0, top: 0, width: 640, height: 360 };
    assert.deepEqual(toMediaPixels({ x: 100, y: 50 }, view, { width: 1920, height: 1080 }), { x: 300, y: 150 });
  });

  it("subtracts the view's offset, rounds down and clamps inside the media", () => {
    const view = { left: 20, top: 10, width: 400, height: 200 };
    const media = { width: 800, height: 400 };
    assert.deepEqual(toMediaPixels({ x: 20.9, y: 10.9 }, view, media), { x: 1, y: 1 });
    assert.deepEqual(toMediaPixels({ x: 999, y: -50 }, view, media), { x: 799, y: 0 });
  });

  it("makes a box from corners dragged either way", () => {
    assert.deepEqual(boxFromCorners({ x: 9, y: 2 }, { x: 3, y: 7 }), { x1: 3, y1: 2, x2: 9, y2: 7 });
  });
});
