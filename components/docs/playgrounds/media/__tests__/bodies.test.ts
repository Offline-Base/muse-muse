/**
 * The media demos' request builders and Files helpers: every way the pages send an image, a clip, audio or a file,
 * the page's own grounding prompts, store: false turns for Muse Image, and the Files API query and paging helpers.
 * Shapes are the ones the mirrored pages document and the proxy accepted in live checks.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/media/__tests__/bodies.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  audioSendsFor,
  countsOf,
  groundingPrompt,
  imageCallsOf,
  imagePartFor,
  imageSendIsUrl,
  imageSendOnChat,
  imageSendUploads,
  inlineFileBody,
  inlineSendCountable,
  mediaBody,
  mediaSendUploads,
  objectList,
  ranOutOfOutput,
  shortId,
  statelessTurnBody,
  tokenCountBody,
  toPixels,
  urlLooksLikeVideo,
  videoSendsFor,
  visionBody,
} from "@/components/docs/playgrounds/media/bodies";
import { chatCollector, responsesCollector } from "@/lib/docs/client/stream";
import {
  expiresProblem,
  filePath,
  filesOfList,
  FILES_STEPS,
  limitProblem,
  listPath,
  looksLikeFileId,
  nextCursor,
  stepInfo,
  when,
} from "@/components/docs/playgrounds/media/files-api";
import { UPLOAD_REUSE_MS, UploadCache } from "@/components/docs/playgrounds/media/upload-cache";

const ROOT = process.cwd();
const md = readFileSync(path.join(ROOT, "content/meta-docs/pages/image-understanding.md"), "utf8");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(ROOT, "components/docs/playgrounds/media/__tests__/fixtures", name), "utf8")) as unknown;
const M = "muse-spark-1.3-contributor";

/** The text block right after a bold label on the page, such as "**Point prompt**". */
function pagePrompt(label: string): string {
  const at = md.indexOf(`**${label}**`);
  assert.ok(at >= 0, label);
  const block = /```text\n([\s\S]*?)\n```/.exec(md.slice(at));
  assert.ok(block, label);
  return block[1].trim();
}

describe("images in requests (image-understanding)", () => {
  it("puts each send mode in the part the page documents", () => {
    assert.deepEqual(imagePartFor("data_url", "data:image/png;base64,AAAA", "responses"), { type: "input_image", image_url: "data:image/png;base64,AAAA" });
    assert.deepEqual(imagePartFor("public_url", "https://x/a.jpg", "responses"), { type: "input_image", image_url: "https://x/a.jpg" });
    assert.deepEqual(imagePartFor("file_id_image", "file-1", "responses"), { type: "input_image", file_id: "file-1" });
    assert.deepEqual(imagePartFor("file_id_file", "file-1", "responses"), { type: "input_file", file_id: "file-1" });
    assert.deepEqual(imagePartFor("file_url", "https://x/a.jpg", "responses"), { type: "input_file", file_url: "https://x/a.jpg" });
    assert.deepEqual(imagePartFor("public_url", "https://x/a.jpg", "chat"), { type: "image_url", image_url: { url: "https://x/a.jpg" } });
  });

  it("knows which modes Chat Completions takes and which upload first", () => {
    assert.deepEqual(
      (["data_url", "public_url", "file_id_image", "file_id_file", "file_url"] as const).map((s) => [imageSendOnChat(s), imageSendUploads(s), imageSendIsUrl(s)]),
      [
        [true, false, false],
        [true, false, true],
        [false, true, false],
        [false, true, false],
        [false, false, true],
      ],
    );
  });

  it("builds a streamed Responses question with text first, then every image", () => {
    const { path: p, body } = visionBody({ model: M, api: "responses", question: "What is in this image?", send: "public_url", images: ["https://x/1.jpg", "https://x/2.jpg"], effort: "low", stream: true });
    assert.equal(p, "responses");
    assert.deepEqual(body, {
      model: M,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What is in this image?" },
            { type: "input_image", image_url: "https://x/1.jpg" },
            { type: "input_image", image_url: "https://x/2.jpg" },
          ],
        },
      ],
      reasoning: { effort: "low" },
      stream: true,
    });
  });

  it("builds the Chat Completions form, with usage on the stream", () => {
    const { path: p, body } = visionBody({ model: M, api: "chat", question: "Describe it.", send: "data_url", images: ["data:image/jpeg;base64,AA"], effort: "low", stream: true });
    assert.equal(p, "chat/completions");
    assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "Describe it." }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } }] }]);
    assert.equal(body.reasoning_effort, "low");
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it("counts tokens with only the model and the Responses input", () => {
    const body = tokenCountBody(M, "Q", "file_id_file", ["file-9"]);
    assert.deepEqual(Object.keys(body), ["model", "input"]);
    assert.deepEqual((body.input as Array<{ content: unknown[] }>)[0].content[1], { type: "input_file", file_id: "file-9" });
  });

  it("writes the page's point, box and count prompts word for word", () => {
    assert.equal(groundingPrompt("point", ["the power button", "the water tank"]), pagePrompt("Point prompt"));
    assert.equal(groundingPrompt("box", ["the coffee mug", "the laptop"]), pagePrompt("Bounding-box prompt"));
    assert.equal(groundingPrompt("count", ["person", "car"]), pagePrompt("Count prompt"));
  });

  it("reads object lists and converts the 0 to 1000 grid like the page's to_pixels", () => {
    assert.deepEqual(objectList('the milk, "the eggs"\nsoup'), ["the milk", "the eggs", "soup"]);
    assert.deepEqual(toPixels(500, 250, 1280, 853), { x: 640, y: 213 });
    assert.deepEqual(toPixels(1001, -3, 1000, 1000), { x: 1000, y: 0 });
  });

  it("reads count replies, bare or under results", () => {
    const reply = [{ object_name: "person", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], count: 2 }, { object_name: "car", points: [], count: 0 }];
    assert.deepEqual(countsOf(reply), [
      { name: "person", count: 2, points: 2 },
      { name: "car", count: 0, points: 0 },
    ]);
    assert.deepEqual(countsOf({ results: reply }).length, 2);
    assert.deepEqual(countsOf("nope"), []);
  });
});

describe("video and audio (video-understanding)", () => {
  it("offers what each API takes", () => {
    assert.deepEqual(videoSendsFor("responses"), ["upload_input_file", "upload_input_video", "inline", "public_url"]);
    assert.deepEqual(videoSendsFor("chat"), ["inline", "public_url"]);
    assert.deepEqual(audioSendsFor("responses"), ["input_audio", "audio_url", "upload"]);
    assert.deepEqual(audioSendsFor("chat"), ["input_audio"]);
    assert.equal(mediaSendUploads("video", "upload_input_video"), true);
    assert.equal(mediaSendUploads("audio", "audio_url"), false);
  });

  const part = (b: Record<string, unknown>) => ((b.input as Array<{ content: unknown[] }> | undefined)?.[0] ?? (b.messages as Array<{ content: unknown[] }>)[0]).content[1];
  const base = { model: M, question: "Q", effort: null, stream: false } as const;

  it("references a clip by file id, inline, by URL, or as Chat's video_url", () => {
    assert.deepEqual(part(mediaBody({ ...base, api: "responses", media: "video", send: "upload_input_file", value: "file-1" }).body), { type: "input_file", file_id: "file-1" });
    assert.deepEqual(part(mediaBody({ ...base, api: "responses", media: "video", send: "upload_input_video", value: "file-1" }).body), { type: "input_video", file_id: "file-1" });
    assert.deepEqual(part(mediaBody({ ...base, api: "responses", media: "video", send: "inline", value: "data:video/mp4;base64,AA" }).body), {
      type: "input_video",
      video_url: "data:video/mp4;base64,AA",
    });
    assert.deepEqual(part(mediaBody({ ...base, api: "chat", media: "video", send: "inline", value: "data:video/mp4;base64,AA" }).body), {
      type: "video_url",
      video_url: { url: "data:video/mp4;base64,AA" },
    });
  });

  it("sends audio three ways on Responses and input_audio on Chat, with room to answer", () => {
    const inline = mediaBody({ ...base, model: "muse-spark-1.2", api: "responses", media: "audio", send: "input_audio", value: "QUJD", maxOutputTokens: 4000 });
    assert.equal(inline.body.max_output_tokens, 4000);
    assert.deepEqual(part(inline.body), { type: "input_audio", input_audio: { data: "QUJD", format: "wav" } });
    assert.deepEqual(part(mediaBody({ ...base, api: "responses", media: "audio", send: "audio_url", value: "data:audio/wav;base64,AA" }).body), {
      type: "input_audio",
      audio_url: "data:audio/wav;base64,AA",
    });
    assert.deepEqual(part(mediaBody({ ...base, api: "responses", media: "audio", send: "upload", value: "file-2" }).body), { type: "input_audio", file_id: "file-2" });
    const chat = mediaBody({ ...base, api: "chat", media: "audio", send: "input_audio", value: "QUJD", format: "mp3", maxOutputTokens: 4000 });
    assert.equal(chat.path, "chat/completions");
    assert.equal(chat.body.max_tokens, 4000);
    assert.deepEqual(part(chat.body), { type: "input_audio", input_audio: { data: "QUJD", format: "mp3" } });
  });

  it("knows a reply that ran out of output on either API", () => {
    // The Responses API ends an over-budget reply with response.incomplete; Chat Completions with finish_reason length.
    const responses = responsesCollector();
    const incomplete = { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } };
    responses.push({ event: "response.incomplete", data: JSON.stringify(incomplete), json: incomplete });
    assert.equal(ranOutOfOutput(responses.snapshot().finishReason), true);
    const chat = chatCollector();
    const chunk = { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "length" }] };
    chat.push({ event: null, data: JSON.stringify(chunk), json: chunk });
    assert.equal(ranOutOfOutput(chat.snapshot().finishReason), true);
    assert.equal(ranOutOfOutput("stop"), false);
    assert.equal(ranOutOfOutput(null), false);
  });
});

describe("files inline (file-handling)", () => {
  it("builds file_data, the Chat file block, file_url and inline video", () => {
    const fd = inlineFileBody({ model: M, send: "responses_file_data", question: "Summarize.", value: "data:application/pdf;base64,AA", filename: "r.pdf" });
    assert.deepEqual((fd.body.input as Array<{ content: unknown[] }>)[0].content[1], { type: "input_file", filename: "r.pdf", file_data: "data:application/pdf;base64,AA" });
    const chat = inlineFileBody({ model: M, send: "chat_file", question: "Summarize.", value: "data:application/pdf;base64,AA", filename: "r.pdf", stream: true });
    assert.equal(chat.path, "chat/completions");
    assert.deepEqual((chat.body.messages as Array<{ content: unknown[] }>)[0].content[1], { type: "file", file: { filename: "r.pdf", file_data: "data:application/pdf;base64,AA" } });
    const url = inlineFileBody({ model: M, send: "responses_file_url", question: "Summarize.", value: "https://x/d.pdf" });
    assert.deepEqual((url.body.input as Array<{ content: unknown[] }>)[0].content[1], { type: "input_file", file_url: "https://x/d.pdf" });
    const video = inlineFileBody({ model: M, send: "responses_video_url", question: "Describe.", value: "data:video/mp4;base64,AA" });
    assert.deepEqual((video.body.input as Array<{ content: unknown[] }>)[0].content[1], { type: "input_video", video_url: "data:video/mp4;base64,AA" });
    assert.equal(inlineSendCountable("chat_file"), false);
  });

  it("offers a free token count only where input_tokens counts the file: PDFs and images, not video", () => {
    assert.equal(inlineSendCountable("responses_file_data"), true);
    assert.equal(inlineSendCountable("responses_file_url"), true);
    // A 2 MB clip inline counted 173 tokens against 172 for the question alone, and billed over 1,300 when run.
    assert.equal(inlineSendCountable("responses_video_url"), false);
    assert.equal(inlineSendCountable("responses_video_url", true), false);
    assert.equal(inlineSendCountable("responses_file_url", urlLooksLikeVideo("https://example.com/clip.MP4?x=1")), false);
    assert.equal(inlineSendCountable("responses_file_data", true), false);
    assert.equal(urlLooksLikeVideo("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"), false);
  });
});

describe("Muse Image without stored state (image-generation)", () => {
  it("sends the prompt first, then replays the last image item before the next instruction", () => {
    assert.deepEqual(statelessTurnBody({ prompt: "a fox" }).body, { model: "muse-image-1.0", store: false, input: "a fox" });
    const next = statelessTurnBody({ prompt: "now at night", previousImageId: "ig_1", references: ["data:image/png;base64,AA"], fast: true }).body;
    assert.deepEqual(next.input, [
      { type: "image_generation_call", id: "ig_1", status: "completed", result: null },
      { role: "user", content: [{ type: "input_text", text: "now at night" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] },
    ]);
    assert.deepEqual(next.tools, [{ type: "image_generation", reasoning_strength: "low", enable_image_search: false, enable_web_search: false, enable_shell: false }]);
  });

  it("finds the image items in a real reply by type", () => {
    const calls = imageCallsOf(fixture("responses-muse-image.json"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "ig_example_signed_handle");
    assert.ok(calls[0].b64.startsWith("UklGR"));
    assert.deepEqual(imageCallsOf({ output: [{ type: "message" }] }), []);
  });

  it("shortens long ids for display only", () => {
    assert.equal(shortId("short"), "short");
    assert.equal(shortId(`ig_${"a".repeat(60)}xyz123`, 8), "ig_aaaaa...xyz123");
  });
});

describe("Files API helpers", () => {
  it("lists the five calls in the reference's order, each with its page", () => {
    assert.deepEqual(
      FILES_STEPS.map((s) => `${s.method} ${s.route}`),
      ["POST /files", "GET /files", "GET /files/{file_id}", "GET /files/{file_id}/content", "DELETE /files/{file_id}"],
    );
    assert.equal(stepInfo("content").slug, "api-reference/files/retrieve-file-content");
  });

  it("builds the list query from what's set", () => {
    assert.equal(listPath({}), "files");
    assert.equal(listPath({ purpose: "user_data", limit: 2, order: "desc", after: " file-1 " }), "files?purpose=user_data&limit=2&order=desc&after=file-1");
    assert.equal(listPath({ limit: 0 }), "files");
    assert.equal(limitProblem(10_001), "limit runs from 1 to 10,000.");
    assert.equal(limitProblem(null), null);
  });

  it("checks expires_after.seconds against the schema's range", () => {
    assert.equal(expiresProblem(3600), null);
    assert.match(expiresProblem(60) ?? "", /at least 3,600/);
    assert.match(expiresProblem(2_592_001) ?? "", /at most 2,592,000/);
  });

  it("encodes ids in paths and reads lists and cursors", () => {
    assert.equal(filePath("content", "file-1"), "files/file-1/content");
    assert.equal(filePath("delete", "a/b"), "files/a%2Fb");
    assert.equal(filesOfList(fixture("list-files.json")).length, 1);
    assert.equal(nextCursor(fixture("list-files.json")), null);
    assert.equal(nextCursor({ has_more: true, last_id: "file-9" }), "file-9");
    assert.equal(looksLikeFileId((fixture("file-object.json") as { id: string }).id), true);
    assert.equal(when(null), "never");
  });
});

describe("upload cache", () => {
  it("reuses an upload's id for 55 minutes, then uploads again, and forgets on request", () => {
    let now = 1_000_000;
    const cache = new UploadCache<object>(() => now);
    const file = {};
    assert.equal(cache.get(file), null);
    cache.set(file, "file-1");
    now += UPLOAD_REUSE_MS - 1;
    assert.equal(cache.get(file), "file-1");
    now += 1;
    // Docs uploads expire an hour after upload: past 55 minutes the file goes up again.
    assert.equal(cache.get(file), null);
    cache.set(file, "file-2");
    cache.forget(file);
    assert.equal(cache.get(file), null);
    assert.equal(UPLOAD_REUSE_MS, 55 * 60 * 1000);
  });
});
