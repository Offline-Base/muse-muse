/**
 * Copy-paste code from a docs request: exact snapshots in the style of Meta's own examples, the key only ever read
 * from MODEL_API_KEY in the environment, and every TypeScript sample parsed by the compiler.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/codegen.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ts from "typescript";
import { codeSamples, curlCode, displayBody, pythonCode, typescriptCode, type CodeRequest } from "@/lib/docs/client/codegen";

const basic: CodeRequest = { method: "POST", path: "responses", body: { model: "muse-spark-1.3", input: "What is the capital of France?" } };

const REQUESTS: CodeRequest[] = [
  basic,
  { method: "POST", path: "responses", body: { model: "muse-spark-1.3-contributor", input: "Explain how neural networks learn.", stream: true } },
  { method: "POST", path: "chat/completions", body: { model: "muse-spark-1.2", messages: [{ role: "user", content: "Hi" }], stream: true, stream_options: { include_usage: true } } },
  { method: "POST", path: "messages", body: { model: "muse-spark-1.3-contributor", max_tokens: 1024, messages: [{ role: "user", content: "It's me" }], stream: true } },
  { method: "POST", path: "messages/count_tokens", body: { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "Hi" }] } },
  { method: "GET", path: "models" },
  { method: "GET", path: "status" },
  { method: "GET", path: "files?purpose=user_data&limit=10" },
  { method: "GET", path: "responses/resp_abc123" },
  { method: "GET", path: "responses/resp_abc123?stream=true" },
  { method: "DELETE", path: "files/file-abc123" },
  { method: "POST", path: "responses/resp_abc123/cancel" },
  { method: "GET", path: "files/file-abc123/content" },
  { method: "POST", path: "images/generations", body: { model: "muse-image-1.0", prompt: "a red fox", n: 1 } },
  { method: "POST", path: "files", form: [{ name: "purpose", value: "user_data" }, { name: "file", value: "photo.jpg", file: { label: "Photo", accept: "image/*", as: "file" } }] },
  {
    method: "POST",
    path: "asr/transcribe",
    form: [
      { name: "request", value: '{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","mode":"PUSH_TO_TALK"}' },
      { name: "audio", file: { label: "Recording", accept: "audio/wav", as: "file" } },
    ],
  },
];

describe("curl", () => {
  it("matches the Responses basic usage example on the protocols/responses page", () => {
    assert.equal(
      curlCode(basic),
      `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-spark-1.3",
  "input": "What is the capital of France?"
}'`,
    );
  });

  it("streams with -N and an Accept header, and escapes single quotes for the shell", () => {
    const code = curlCode({ method: "POST", path: "responses", body: { model: "m", input: "It's a test", stream: true } });
    assert.match(code, /^curl -N -X POST "https:\/\/api\.meta\.ai\/v1\/responses" \\\n/);
    assert.match(code, /-H "Accept: text\/event-stream"/);
    assert.match(code, /"input": "It'\\''s a test"/);
  });

  it("sends multipart fields with -F, a JSON part typed as JSON, and saves file content with -o", () => {
    const asr = curlCode(REQUESTS[15]);
    assert.match(asr, /-F 'request=\{"model":"muse-voice-transcribe-1\.0","audioEncoding":"WAV","mode":"PUSH_TO_TALK"\};type=application\/json'/);
    assert.match(asr, /-F "audio=@recording\.wav;type=audio\/wav"/);
    assert.doesNotMatch(asr, /Content-Type: application\/json/);
    assert.match(curlCode(REQUESTS[14]), /-F "purpose=user_data" \\\n {2}-F "file=@photo\.jpg"$/);
    assert.match(curlCode({ method: "GET", path: "files/file-abc123/content" }), /-o content\.bin$/);
  });

  it("strips a leading slash or v1/ from the path", () => {
    assert.match(curlCode({ method: "GET", path: "/v1/models" }), /"https:\/\/api\.meta\.ai\/v1\/models"/);
  });
});

describe("Python", () => {
  it("matches the OpenAI SDK basic usage example", () => {
    assert.equal(
      pythonCode(basic, "sdk"),
      `import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)

response = client.responses.create(
    model="muse-spark-1.3",
    input="What is the capital of France?",
)

print(response.model_dump_json(indent=2))
`,
    );
  });

  it("matches the requests basic usage example, True and None included", () => {
    assert.equal(
      pythonCode({ method: "POST", path: "responses", body: { model: "muse-spark-1.3", input: "Hi", store: false, metadata: null } }, "http"),
      `import json
import os

import requests

response = requests.post(
    "https://api.meta.ai/v1/responses",
    headers={
        "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "muse-spark-1.3",
        "input": "Hi",
        "store": False,
        "metadata": None,
    },
)
response.raise_for_status()
print(json.dumps(response.json(), indent=2))
`,
    );
  });

  it("passes parameters the SDK doesn't know through extra_body", () => {
    const code = pythonCode({ method: "POST", path: "chat/completions", body: { model: "m", messages: [], made_up_flag: true } }, "sdk")!;
    assert.match(code, /extra_body=\{\n {8}"made_up_flag": True,\n {4}\},/);
  });

  it("uses the Anthropic SDK for Messages, pointed at https://api.meta.ai with auth_token", () => {
    const code = pythonCode(REQUESTS[3], "sdk")!;
    assert.match(code, /from anthropic import Anthropic/);
    assert.match(code, /base_url="https:\/\/api\.meta\.ai",\n {4}auth_token=os\.environ\["MODEL_API_KEY"\],/);
    assert.match(code, /stream = client\.messages\.create\(/);
    assert.match(code, /event\.delta\.type == "text_delta"/);
    assert.match(pythonCode(REQUESTS[4], "sdk")!, /client\.messages\.count_tokens\(/);
  });

  it("uploads with files.create and with requests' files tuples", () => {
    assert.match(pythonCode(REQUESTS[14], "sdk")!, /with open\("photo\.jpg", "rb"\) as f:\n {4}file = client\.files\.create\(\n {8}purpose="user_data",\n {8}file=f,\n {4}\)/);
    const asr = pythonCode(REQUESTS[15], "http")!;
    assert.match(asr, /with open\("recording\.wav", "rb"\) as audio:/);
    assert.match(asr, /"request": \(None, json\.dumps\(\{/);
    assert.match(asr, /"audio": \("recording\.wav", audio, "audio\/wav"\),/);
    assert.equal(pythonCode(REQUESTS[15], "sdk"), null, "transcription has no SDK call");
  });

  it("maps ids and query strings onto SDK calls", () => {
    assert.match(pythonCode({ method: "GET", path: "files?purpose=user_data&limit=10" }, "sdk")!, /client\.files\.list\(\n {4}purpose="user_data",\n {4}limit=10,\n\)/);
    assert.match(pythonCode({ method: "DELETE", path: "responses/resp_abc123" }, "sdk")!, /client\.responses\.delete\("resp_abc123"\)\nprint\("Deleted resp_abc123"\)/);
    assert.equal(pythonCode({ method: "GET", path: "responses/resp_abc123?stream=true" }, "sdk"), null);
    assert.match(pythonCode({ method: "GET", path: "files/file-abc123/content" }, "http")!, /out\.write\(response\.content\)/);
  });
});

describe("TypeScript", () => {
  it("matches the OpenAI SDK basic usage example", () => {
    assert.equal(
      typescriptCode(basic, "sdk"),
      `import OpenAI from 'openai';

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) {
  throw new Error('MODEL_API_KEY is not set');
}

const client = new OpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey,
});

const response = await client.responses.create({
  model: 'muse-spark-1.3',
  input: 'What is the capital of France?',
});

console.log(JSON.stringify(response, null, 2));
`,
    );
  });

  it("sends fetch with the bearer header from the environment", () => {
    const code = typescriptCode(basic, "http")!;
    assert.match(code, /Authorization: `Bearer \$\{apiKey\}`,/);
    assert.match(code, /body: JSON\.stringify\(\{\n {4}model: 'muse-spark-1\.3',/);
  });

  it("uses the Anthropic SDK for Messages with authToken", () => {
    const code = typescriptCode(REQUESTS[3], "sdk")!;
    assert.match(code, /import Anthropic from '@anthropic-ai\/sdk';/);
    assert.match(code, /baseURL: 'https:\/\/api\.meta\.ai',\n {2}authToken: apiKey,/);
    assert.match(code, /content: "It's me",/, "double quotes save escaping an apostrophe");
  });

  it("parses: every TypeScript sample is valid syntax", () => {
    for (const req of REQUESTS) {
      for (const sample of codeSamples(req).filter((s) => s.lang === "typescript")) {
        const file = ts.createSourceFile("sample.ts", sample.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const diagnostics = (file as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
        assert.deepEqual(
          diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
          [],
          `${req.method} ${req.path} ${sample.label}:\n${sample.code}`,
        );
      }
    }
  });
});

describe("codeSamples", () => {
  it("lists curl, then each language with its SDK first where one fits", () => {
    assert.deepEqual(
      codeSamples(basic).map((s) => s.label),
      ["curl", "Python (OpenAI SDK)", "Python (requests)", "TypeScript (OpenAI SDK)", "TypeScript (fetch)"],
    );
    assert.deepEqual(
      codeSamples(REQUESTS[3]).map((s) => s.label),
      ["curl", "Python (Anthropic SDK)", "Python (requests)", "TypeScript (Anthropic SDK)", "TypeScript (fetch)"],
    );
    assert.deepEqual(
      codeSamples({ method: "GET", path: "status" }).map((s) => s.label),
      ["curl", "Python (requests)", "TypeScript (fetch)"],
    );
  });

  it("never holds a key: every sample reads MODEL_API_KEY from the environment", () => {
    for (const req of REQUESTS) {
      for (const s of codeSamples(req)) {
        assert.match(s.code, /MODEL_API_KEY/, `${s.label} for ${req.path} names the variable`);
        assert.doesNotMatch(s.code, /\bsk-[A-Za-z0-9]|LLM_\d|[A-Za-z0-9_-]{40,}/, `${s.label} for ${req.path} holds no key-like string`);
        const bearer = [...s.code.matchAll(/Bearer ([^\s"`]+)/g)].map((m) => m[1]);
        for (const b of bearer) assert.ok(["$MODEL_API_KEY", "{os.environ['MODEL_API_KEY']}", "${apiKey}"].includes(b), `unexpected bearer value ${b}`);
      }
    }
  });
});

describe("displayBody", () => {
  it("shortens data URLs and base64 for code views without touching normal text", () => {
    const shown = displayBody({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "What is in this photo?" },
            { type: "input_image", image_url: `data:image/jpeg;base64,${"A".repeat(5000)}` },
          ],
        },
      ],
      audio: "B".repeat(1000),
    }) as { input: Array<{ content: Array<Record<string, string>> }>; audio: string };
    assert.equal(shown.input[0].content[0].text, "What is in this photo?");
    assert.equal(shown.input[0].content[1].image_url, "data:image/jpeg;base64,<BASE64>");
    assert.equal(shown.audio, "<BASE64>");
  });
});
