/**
 * The Run button's request parser: curl in the shapes Meta's docs write it, bare request lines, the placeholder slots,
 * and a run over every curl command in the mirror that calls api.meta.ai (at least 90 percent must parse).
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/curl.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Lexer, type Token, type Tokens } from "marked";
import { curlCommands, metaPath, parseCurl, parseHttpRequest, requestFromCode, shellWords } from "@/lib/docs/curl";
import { DOCS_PAGES, docsMarkdown } from "@/lib/docs/pages";

describe("shell words", () => {
  it("joins backslash lines, drops quotes, keeps $VAR and $(...) as written", () => {
    const words = shellWords(`curl -X POST "https://api.meta.ai/v1/x" \\\n  -H "Authorization: Bearer $MODEL_API_KEY" \\\n  -d '{"a": "it'"'"'s"}' -F "f=$(base64 -i a.png)" # note`);
    assert.deepEqual(words, [
      "curl",
      "-X",
      "POST",
      "https://api.meta.ai/v1/x",
      "-H",
      "Authorization: Bearer $MODEL_API_KEY",
      "-d",
      `{"a": "it's"}`,
      "-F",
      "f=$(base64 -i a.png)",
    ]);
  });

  it("ends the command at a pipe or an unescaped newline, and rejects unbalanced quotes", () => {
    assert.deepEqual(shellWords("curl https://a | jq ."), ["curl", "https://a"]);
    assert.deepEqual(shellWords("curl https://a\necho done"), ["curl", "https://a"]);
    assert.equal(shellWords("curl 'unterminated"), null);
  });
});

describe("parseCurl", () => {
  it("reads Meta's multi-line JSON POST", () => {
    const r = parseCurl(`curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3",
  "input": "What is the capital of France?"
}'`);
    assert.deepEqual(r, {
      method: "POST",
      path: "responses",
      body: { model: "muse-spark-1.3", input: "What is the capital of France?" },
      fileSlots: [],
      fileIds: [],
      stream: false,
    });
  });

  it("defaults to GET without data and POST with it, and honors --data variants and -XPOST", () => {
    assert.equal(parseCurl(`curl https://api.meta.ai/v1/models -H "Authorization: Bearer $MODEL_API_KEY"`)?.method, "GET");
    assert.equal(parseCurl(`curl https://api.meta.ai/v1/messages --data-raw '{"a":1}'`)?.method, "POST");
    assert.deepEqual(parseCurl(`curl -sS -XPOST https://api.meta.ai/v1/messages --data-binary "{\\"a\\": 2}"`)?.body, { a: 2 });
    assert.deepEqual(parseCurl(`curl https://api.meta.ai/v1/messages --data='{"b":true}'`)?.body, { b: true });
    assert.equal(parseCurl(`curl -X DELETE "https://api.meta.ai/v1/responses/resp_abc123"`)?.method, "DELETE");
  });

  it("marks streams from the body, the Accept header, or ?stream=true", () => {
    assert.equal(parseCurl(`curl -N https://api.meta.ai/v1/responses -d '{"stream": true}'`)?.stream, true);
    assert.equal(parseCurl(`curl https://api.meta.ai/v1/asr/transcribe?x=1 -H 'Accept: text/event-stream' -F 'a=b'`)?.stream, true);
    assert.equal(parseCurl(`curl "https://api.meta.ai/v1/responses/resp_abc123?stream=true"`)?.stream, true);
  });

  it("reads -F/--form fields, with files as pickers and curl's ;type= suffix removed", () => {
    const r = parseCurl(`curl --fail-with-body \\
  'https://api.meta.ai/v1/asr/transcribe?sessionId=my-session-id' \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F 'request={"mode":"DIARIZATION","model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"};type=application/json' \\
  --form "audio=@meeting_audio.wav;type=audio/wav"`);
    assert.equal(r?.path, "asr/transcribe?sessionId=my-session-id");
    assert.equal(r?.method, "POST");
    assert.equal(r?.body, undefined);
    assert.deepEqual(r?.form, [
      { name: "request", value: '{"mode":"DIARIZATION","model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}' },
      { name: "audio", file: { label: "Audio to upload (meeting_audio.wav)", accept: "audio/wav", as: "file" } },
    ]);
    const files = parseCurl(`curl -X POST https://api.meta.ai/v1/files -F "purpose=user_data" -F "expires_after[anchor]=created_at" -F "file=@/path/to/image.png"`);
    assert.deepEqual(files?.form, [
      { name: "purpose", value: "user_data" },
      { name: "expires_after[anchor]", value: "created_at" },
      { name: "file", file: { label: "Image to upload (image.png)", accept: "image/*", as: "file" } },
    ]);
  });

  it("offers file pickers for placeholders in the body", () => {
    const r = parseCurl(`curl https://api.meta.ai/v1/responses -d '{"model": "m", "input": [{"role": "user", "content": [
      {"type": "input_image", "image_url": "data:image/webp;base64,UklGR..."},
      {"type": "input_video", "video_url": "https://example.com/clip.mp4"},
      {"type": "input_image", "image_url": "data:image/png;base64,'"$(base64 -i photo.png)"'"},
      {"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav"}},
      {"type": "input_file", "file_id": "file-abc123"},
      {"type": "input_image", "image_url": "https://upload.wikimedia.org/real.png"}
    ]}]}'`);
    assert.ok(r);
    assert.deepEqual(r.fileSlots, [
      { pointer: "/input/0/content/0/image_url", target: "body", label: "Image for image_url", accept: "image/*", as: "dataUrl" },
      { pointer: "/input/0/content/1/video_url", target: "body", label: "Video for video_url", accept: "video/*", as: "dataUrl" },
      { pointer: "/input/0/content/2/image_url", target: "body", label: "Image for image_url", accept: "image/*", as: "dataUrl" },
      { pointer: "/input/0/content/3/input_audio/data", target: "body", label: "Audio for input_audio.data", accept: "audio/wav", as: "base64" },
    ]);
    assert.deepEqual(r.fileIds, [{ pointer: "/input/0/content/4/file_id", placeholder: "file-abc123", label: "file_id file-abc123" }]);
  });

  it("finds file ids in the path", () => {
    const r = parseCurl(`curl -X GET "https://api.meta.ai/v1/files/file_abc123/content" -H "Authorization: Bearer $MODEL_API_KEY"`);
    assert.deepEqual(r?.fileIds, [{ pointer: null, placeholder: "file_abc123", label: "file id file_abc123 in the path" }]);
  });

  it("refuses what the proxy can't repeat", () => {
    assert.equal(parseCurl("curl https://dev.meta.ai/install.sh"), null, "not the API");
    assert.equal(parseCurl("curl http://localhost:8000/v1/chat/completions -d '{}'"), null, "a local server");
    assert.equal(parseCurl(`curl https://api.meta.ai/v1/chat/completions -d '{"messages": [...]}'`), null, "an elided body");
    assert.equal(parseCurl("curl https://api.meta.ai/v1/responses --data-binary @body.json"), null, "a body from a file");
    assert.equal(parseCurl("curl -X PUT https://api.meta.ai/v1/files"), null, "a method the proxy doesn't take");
    assert.equal(parseCurl("curl https://api.meta.ai/v1"), null, "no path");
  });
});

describe("bare request lines", () => {
  it("reads a request line, headers and a JSON body", () => {
    const r = parseHttpRequest(`POST https://api.meta.ai/v1/responses HTTP/1.1
Content-Type: application/json

{"model": "muse-spark-1.3", "input": "hi", "stream": true}`);
    assert.deepEqual(r, {
      method: "POST",
      path: "responses",
      body: { model: "muse-spark-1.3", input: "hi", stream: true },
      fileSlots: [],
      fileIds: [],
      stream: true,
    });
    assert.equal(parseHttpRequest("GET https://api.meta.ai/v1/models")?.method, "GET");
    assert.equal(parseHttpRequest("POST /v1/asr/transcribe?sessionId=<your-id>"), null, "relative paths aren't runnable");
  });

  it("requestFromCode takes the first runnable command in a block", () => {
    const code = "# install first\ncurl -fsSL https://dev.meta.ai/install.sh | sh\n$ curl https://api.meta.ai/v1/models\n";
    assert.equal(curlCommands(code).length, 2);
    assert.equal(requestFromCode(code)?.path, "models");
    assert.equal(requestFromCode("print('no api here')"), null);
    assert.equal(metaPath("https://api.meta.ai/v1/files?limit=2"), "files?limit=2");
  });
});

describe("the whole mirror", () => {
  it("parses at least 90 percent of the curl commands that call api.meta.ai", () => {
    const blocks: { slug: string; code: string }[] = [];
    const walk = (tokens: Token[], slug: string) => {
      for (const t of tokens) {
        if (t.type === "code") blocks.push({ slug, code: (t as Tokens.Code).text });
        else if (t.type === "list") for (const item of (t as Tokens.List).items) walk(item.tokens, slug);
        else if (t.type === "blockquote") walk((t as Tokens.Blockquote).tokens, slug);
      }
    };
    for (const page of DOCS_PAGES) walk(new Lexer({ gfm: true }).lex(docsMarkdown(page.slug)), page.slug);

    let total = 0;
    const failed: string[] = [];
    for (const { slug, code } of blocks) {
      for (const command of curlCommands(code)) {
        const words = shellWords(command);
        if (!command.slice(0, 600).includes("api.meta.ai") || (words && !words.some((w) => w.includes("api.meta.ai")))) continue;
        total += 1;
        if (!parseCurl(command)) failed.push(`${slug}: ${command.split("\n").slice(0, 3).join(" ").slice(0, 160)}`);
      }
    }
    const parsed = total - failed.length;
    console.log(`curl commands calling api.meta.ai: ${total}, parsed ${parsed} (${((parsed / total) * 100).toFixed(1)}%)`);
    for (const line of failed) console.log(`  did not parse: ${line}`);
    assert.ok(total >= 50, `found ${total} commands`);
    assert.ok(parsed / total >= 0.9, `only ${parsed} of ${total} parsed`);
  });
});
