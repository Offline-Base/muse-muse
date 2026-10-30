/**
 * Request bodies the media demos send (lib/docs/media/requests.ts), checked against the shapes in the mirrored docs,
 * plus the helpers around them: redaction of inline media for code and the copy-prompt, perception grounding shapes
 * (lib/docs/media/grounding.ts) and accept lists (lib/docs/media/accept.ts).
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/media/__tests__/requests.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  audioQuestionRequest,
  partForKind,
  fileQuestionRequest,
  fileUploadFields,
  imageTurnRequest,
  imagesEditFormFields,
  imagesEditJsonRequest,
  imagesGenerationRequest,
  inlineMediaBytes,
  mergeBody,
  partForFile,
  realtimeQuery,
  redactMedia,
  samRequest,
  transcribeRequestPart,
  videoRequest,
  visionRequest,
} from "@/lib/docs/media/requests";
import { extractJson, gridToPixels, groundingShapes } from "@/lib/docs/media/grounding";
import { acceptKinds, kindOf, matchesAccept, mimeFromName } from "@/lib/docs/media/accept";

const IMG = `data:image/jpeg;base64,${"A".repeat(400)}`;

describe("vision and video", () => {
  it("sends input_image parts on Responses with detail and extraBody merged", () => {
    const { path, body } = visionRequest({
      model: "muse-spark-1.3-contributor",
      question: "What's in the fridge?",
      images: [{ dataUrl: IMG }],
      detail: "high",
      stream: true,
      extraBody: { text: { format: { type: "json_schema", name: "items", strict: true, schema: {} } } },
    });
    assert.equal(path, "responses");
    assert.deepEqual(body, {
      model: "muse-spark-1.3-contributor",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What's in the fridge?" },
            { type: "input_image", image_url: IMG, detail: "high" },
          ],
        },
      ],
      stream: true,
      text: { format: { type: "json_schema", name: "items", strict: true, schema: {} } },
    });
  });

  it("sends image_url parts on Chat Completions", () => {
    const { path, body } = visionRequest({ model: "muse-spark-1.2", question: "Hi", images: [{ url: "https://x/y.png" }], api: "chat" });
    assert.equal(path, "chat/completions");
    assert.deepEqual(body.messages, [
      { role: "user", content: [{ type: "text", text: "Hi" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
    ]);
  });

  it("references an uploaded image by file_id", () => {
    const { body } = visionRequest({ model: "m", question: "q", images: [{ fileId: "file-1" }] });
    const content = (body.input as Array<{ content: unknown[] }>)[0].content;
    assert.deepEqual(content[1], { type: "input_image", file_id: "file-1" });
  });

  it("sends inline video as input_video and uploads as input_file or input_video", () => {
    const inline = videoRequest({ model: "m", question: "q", video: { dataUrl: "data:video/mp4;base64,AAAA" } });
    assert.deepEqual((inline.body.input as Array<{ content: unknown[] }>)[0].content[1], {
      type: "input_video",
      video_url: "data:video/mp4;base64,AAAA",
    });
    const file = videoRequest({ model: "m", question: "q", video: { fileId: "file-9" }, as: "input_file" });
    assert.deepEqual((file.body.input as Array<{ content: unknown[] }>)[0].content[1], { type: "input_file", file_id: "file-9" });
  });

  it("sends audio questions as input_audio with room for reasoning", () => {
    const { body } = audioQuestionRequest({ model: "muse-spark-1.2", question: "Transcribe", base64: "UklG", format: "wav" });
    assert.equal(body.max_output_tokens, 4000);
    assert.deepEqual((body.input as Array<{ content: unknown[] }>)[0].content[1], {
      type: "input_audio",
      input_audio: { data: "UklG", format: "wav" },
    });
  });

  it("merges extraBody deeply but replaces arrays", () => {
    assert.deepEqual(mergeBody({ a: { b: 1, c: [1] } }, { a: { d: 2, c: [2] } }), { a: { b: 1, c: [2], d: 2 } });
    assert.deepEqual(mergeBody({ a: 1 }, null), { a: 1 });
  });
});

describe("Muse Image", () => {
  it("chains a follow-up with previous_response_id and sends tool settings", () => {
    const { path, body } = imageTurnRequest({
      prompt: "now make it night",
      previousResponseId: "resp_1",
      settings: { size: "1536x1024", outputFormat: "png", reasoningStrength: "low", enableWebSearch: false },
    });
    assert.equal(path, "responses");
    assert.deepEqual(body, {
      model: "muse-image-1.0",
      input: "now make it night",
      previous_response_id: "resp_1",
      tools: [{ type: "image_generation", enable_web_search: false, reasoning_strength: "low", size: "1536x1024", output_format: "png" }],
    });
  });

  it("puts reference images after the instruction as input_image parts", () => {
    const { body } = imageTurnRequest({ prompt: "Use this pose", references: [{ dataUrl: IMG }] });
    assert.deepEqual(body.input, [
      { role: "user", content: [{ type: "input_text", text: "Use this pose" }, { type: "input_image", image_url: IMG }] },
    ]);
    assert.equal("tools" in body, false, "no tool entry without settings");
  });

  it("caps n at 2 on the images endpoints and maps tool switches to tool_enablement", () => {
    const gen = imagesGenerationRequest({ prompt: "fox", n: 5, settings: { size: "auto", enableShell: false } });
    assert.equal(gen.path, "images/generations");
    assert.deepEqual(gen.body, { model: "muse-image-1.0", prompt: "fox", n: 2, tool_enablement: { enable_shell: false } });
    const edit = imagesEditJsonRequest({ prompt: "add a hat", images: [{ dataUrl: IMG }, { fileId: "file-2" }] });
    assert.deepEqual(edit.body.images, [{ image_url: IMG }, { file_id: "file-2" }]);
    assert.equal(edit.body.n, 1);
  });

  it("names multipart image fields image, or image[0] and image[1]", () => {
    assert.deepEqual(imagesEditFormFields({ prompt: "p", imageCount: 1 }).files, ["image"]);
    assert.deepEqual(imagesEditFormFields({ prompt: "p", imageCount: 2 }).files, ["image[0]", "image[1]"]);
    assert.deepEqual(imagesEditFormFields({ prompt: "p", imageCount: 1, settings: { size: "1024x1024" } }).scalars, [
      ["model", "muse-image-1.0"],
      ["prompt", "p"],
      ["n", "1"],
      ["size", "1024x1024"],
    ]);
  });
});

describe("SAM 3.1", () => {
  it("streams with string metadata values", () => {
    const { body } = samRequest({
      prompt: "dog",
      media: { dataUrl: IMG },
      kind: "image",
      maskEncoding: "one_bit",
      includeConfidence: true,
    });
    assert.deepEqual(body, {
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "dog" }, { type: "input_image", image_url: IMG }] }],
      stream: true,
      metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    });
  });

  it("sends video as input_video and the tracking direction only when it isn't the default", () => {
    const v = samRequest({ prompt: "<0f>1<|point;x=1;y=1;w=2;h=2|>", media: { fileId: "file-3" }, kind: "video", propagation: "forward" });
    assert.deepEqual((v.body.input as Array<{ content: unknown[] }>)[0].content[1], { type: "input_video", file_id: "file-3" });
    assert.deepEqual(v.body.metadata, { propagation_direction: "forward" });
    assert.equal("metadata" in samRequest({ prompt: "x", media: { url: "https://a/b.mp4" }, kind: "video", propagation: "both" }).body, false);
    assert.equal("stream" in samRequest({ prompt: "x", media: { url: "u" }, kind: "image", stream: false }).body, false);
  });
});

describe("voice", () => {
  it("builds the transcribe request part", () => {
    assert.deepEqual(transcribeRequestPart({}), { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" });
    assert.deepEqual(transcribeRequestPart({ mode: "DIARIZATION", keywords: [" eSIM ", ""], languageBias: ["English"] }), {
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "DIARIZATION",
      keywords: ["eSIM"],
      languageBias: ["English"],
    });
  });

  it("builds the realtime relay's query", () => {
    assert.equal(realtimeQuery({}), "model=muse-voice-transcribe-1.0&mode=PUSH_TO_TALK");
    assert.equal(realtimeQuery({ mode: "DIARIZATION" }), "model=muse-voice-transcribe-1.0&mode=DIARIZATION&diarization=true");
  });
});

describe("files", () => {
  it("sends purpose first and clamps expires_after to the documented range", () => {
    assert.deepEqual(fileUploadFields({}), [["purpose", "user_data"]]);
    assert.deepEqual(fileUploadFields({ expiresAfterSeconds: 60 }), [
      ["purpose", "user_data"],
      ["expires_after[anchor]", "created_at"],
      ["expires_after[seconds]", "3600"],
    ]);
    assert.equal(fileUploadFields({ expiresAfterSeconds: 9e9 })[2][1], "2592000");
  });

  it("references an uploaded file with the right part", () => {
    assert.equal(partForFile("image/png"), "input_image");
    assert.equal(partForFile("video/mp4"), "input_video");
    assert.equal(partForFile("application/pdf"), "input_file");
    assert.equal(partForFile("audio/wav"), "input_audio");
    assert.deepEqual(["image", "video", "audio", "pdf", "text", null].map(partForKind), [
      "input_image",
      "input_video",
      "input_audio",
      "input_file",
      "input_file",
      "input_file",
    ]);
    const { body } = fileQuestionRequest({ model: "m", question: "Summarize", fileId: "file-5", part: "input_file" });
    assert.deepEqual((body.input as Array<{ content: unknown[] }>)[0].content[1], { type: "input_file", file_id: "file-5" });
  });
});

describe("redactMedia", () => {
  it("replaces inline media with the docs' placeholders and leaves the rest", () => {
    const body = {
      input: [{ content: [{ type: "input_image", image_url: IMG }, { type: "input_text", text: "hi" }] }],
      audio: { data: "U".repeat(500), format: "wav" },
      short: "data:image/png;base64,AAAA",
    };
    assert.deepEqual(redactMedia(body), {
      input: [{ content: [{ type: "input_image", image_url: "data:image/jpeg;base64,<BASE64>" }, { type: "input_text", text: "hi" }] }],
      audio: { data: "<BASE64>", format: "wav" },
      short: "data:image/png;base64,AAAA",
    });
    assert.equal(body.input[0].content[0].image_url, IMG, "the original is untouched");
  });

  it("counts inline media bytes", () => {
    assert.equal(inlineMediaBytes({ a: [IMG, IMG] }), 600);
  });
});

describe("grounding", () => {
  it("reads the docs' box, bbox, point and count shapes", () => {
    const reply = '```json\n[{"label":"apple","box":[100,200,300,400]},{"object_name":"mug","bbox":[{"x_min":10,"y_min":20,"x_max":30,"y_max":40}]},{"object_name":"power button","x":500,"y":600},{"object_name":"person","points":[{"x":1,"y":2},{"x":3,"y":4}],"count":2}]\n```';
    const shapes = groundingShapes(extractJson(reply));
    assert.deepEqual(shapes, [
      { kind: "box", label: "apple", x1: 100, y1: 200, x2: 300, y2: 400 },
      { kind: "box", label: "mug", x1: 10, y1: 20, x2: 30, y2: 40 },
      { kind: "point", label: "power button", x: 500, y: 600 },
      { kind: "point", label: "person", x: 1, y: 2 },
      { kind: "point", label: "person", x: 3, y: 4 },
    ]);
  });

  it("finds JSON inside prose and converts the grid to clamped pixels", () => {
    const shapes = groundingShapes(extractJson('Here you go: {"label":"edge","box":[0,0,1001,500]} done'));
    assert.deepEqual(gridToPixels(shapes, 1280, 853), [{ kind: "box", label: "edge", x1: 0, y1: 0, x2: 1280, y2: 427, group: "edge" }]);
    assert.equal(extractJson("no json here"), null);
  });
});

describe("accept lists", () => {
  it("maps accept lists to sample kinds", () => {
    assert.deepEqual(acceptKinds("image/*"), ["image"]);
    assert.deepEqual(acceptKinds("audio/wav,video/mp4"), ["video", "audio"]);
    assert.deepEqual(acceptKinds(".pdf,.txt"), ["pdf", "text"]);
    assert.deepEqual(acceptKinds(""), ["image", "video", "audio", "pdf", "text"]);
  });

  it("matches files by type, wildcard and extension", () => {
    assert.equal(matchesAccept({ type: "image/png", name: "a.png" }, "image/*"), true);
    assert.equal(matchesAccept({ type: "video/webm", name: "a.webm" }, "video/mp4"), false);
    assert.equal(matchesAccept({ type: "", name: "talk.WAV" }, ".wav"), true);
    assert.equal(kindOf({ type: "", name: "clip.mov" }), "video");
    assert.equal(kindOf({ type: "application/zip" }), null);
    assert.equal(mimeFromName("field-report.PDF"), "application/pdf");
    assert.equal(mimeFromName("notes"), null);
  });
});
