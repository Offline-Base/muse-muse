/**
 * Run buttons on SDK examples: OpenAI (and Anthropic) SDK calls, requests and fetch with literal arguments become
 * the request they make; anything computed gets no Run button.
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/sdk-request.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestFromCode } from "@/lib/docs/curl";
import { sdkCallFromCode } from "@/lib/docs/sdk-request";

const PY_CLIENT = `import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)
`;

const TS_CLIENT = `import OpenAI from 'openai';

const apiKey = process.env.MODEL_API_KEY;
const client = new OpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey,
});
`;

describe("sdkCallFromCode", () => {
  it("reads a Python SDK call's keyword arguments as the body", () => {
    const code = `${PY_CLIENT}
response = client.responses.create(
    model="muse-spark-1.3",
    input="Explain how neural networks learn.",  # a comment
    reasoning={"effort": "low"},
    max_output_tokens=1_024,
    stream=False,
    metadata=None,
)
print(response.output_text)
`;
    assert.deepEqual(sdkCallFromCode(code, "python"), {
      method: "POST",
      path: "responses",
      body: {
        model: "muse-spark-1.3",
        input: "Explain how neural networks learn.",
        reasoning: { effort: "low" },
        max_output_tokens: 1024,
        stream: false,
        metadata: null,
      },
    });
  });

  it("follows a name the block assigns a literal to, but not the keyword argument of the same name", () => {
    const code = `${PY_CLIENT}
tools = [
    {
        "type": "function",
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]},
    }
]

response = client.responses.create(
    model="muse-spark-1.3",
    input="What is the weather in Seattle?",
    tools=tools,
)
`;
    const call = sdkCallFromCode(code, "python");
    assert.equal((call?.body?.tools as Array<{ name: string }>)[0].name, "get_weather");
  });

  it("reads a TypeScript object literal: single quotes, bare keys, trailing commas, shorthand, as const", () => {
    const code = `${TS_CLIENT}
const messages = [{ role: 'user', content: 'What is the weather in Seattle?' }];
const response = await client.chat.completions.create({
  model: 'muse-spark-1.3',
  messages,
  tools: [
    { type: 'function' as const, function: { name: "get_weather", parameters: { type: 'object' } } },
  ],
  "max_tokens": 200,
}, { timeout: 30_000, signal: controller.signal });
console.log(response.choices[0].message);
`;
    assert.deepEqual(sdkCallFromCode(code, "typescript"), {
      method: "POST",
      path: "chat/completions",
      body: {
        model: "muse-spark-1.3",
        messages: [{ role: "user", content: "What is the weather in Seattle?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
        max_tokens: 200,
      },
    });
  });

  it("maps retrieve, list, content, delete and stream calls to their paths", () => {
    assert.deepEqual(sdkCallFromCode(`${PY_CLIENT}\nprint(client.models.list())`, "python"), { method: "GET", path: "models" });
    assert.deepEqual(sdkCallFromCode(`${PY_CLIENT}\nm = client.models.retrieve("muse-spark-1.3")`, "python"), { method: "GET", path: "models/muse-spark-1.3" });
    assert.deepEqual(sdkCallFromCode(`${TS_CLIENT}\nconst f = await client.files.content('file-abc123');`, "ts"), { method: "GET", path: "files/file-abc123/content" });
    assert.deepEqual(sdkCallFromCode(`${PY_CLIENT}\nclient.files.delete("file-abc123")`, "python"), { method: "DELETE", path: "files/file-abc123" });
    assert.deepEqual(sdkCallFromCode(`${PY_CLIENT}\nclient.files.list(purpose="user_data", limit=5)`, "python"), { method: "GET", path: "files?purpose=user_data&limit=5" });
    assert.deepEqual(sdkCallFromCode(`${PY_CLIENT}\nclient.responses.cancel("resp_abc123")`, "python"), { method: "POST", path: "responses/resp_abc123/cancel" });
    const stream = sdkCallFromCode(`${PY_CLIENT}\nwith client.responses.stream(model="muse-spark-1.3", input="Hi") as s:\n    pass`, "python");
    assert.deepEqual(stream, { method: "POST", path: "responses", body: { model: "muse-spark-1.3", input: "Hi", stream: true } });
  });

  it("merges extra_body, and reads Anthropic's Messages, requests and fetch tabs, and LiteLLM", () => {
    const extra = sdkCallFromCode(`${PY_CLIENT}\nclient.chat.completions.create(model="muse-spark-1.3", messages=[], extra_body={"reasoning_effort": "low"}, timeout=30)`, "python");
    assert.deepEqual(extra?.body, { model: "muse-spark-1.3", messages: [], reasoning_effort: "low" });
    const anthropic = `import anthropic\nclient = anthropic.Anthropic(base_url="https://api.meta.ai", api_key=os.environ["MODEL_API_KEY"])\nmessage = client.messages.create(model="muse-spark-1.3", max_tokens=256, messages=[{"role": "user", "content": "Hi"}])`;
    assert.equal(sdkCallFromCode(anthropic, "python")?.path, "messages");
    const requests = `import os\nimport requests\n\nresponse = requests.post(\n    "https://api.meta.ai/v1/chat/completions",\n    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}", "Content-Type": "application/json"},\n    json={"model": "muse-spark-1.3", "messages": [{"role": "user", "content": "Hi"}]},\n    timeout=30,\n)`;
    assert.deepEqual(sdkCallFromCode(requests, "python"), {
      method: "POST",
      path: "chat/completions",
      body: { model: "muse-spark-1.3", messages: [{ role: "user", content: "Hi" }] },
    });
    const fetch = "const response = await fetch('https://api.meta.ai/v1/responses', {\n  method: 'POST',\n  headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },\n  body: JSON.stringify({ model: 'muse-spark-1.3', input: 'Hi' }),\n});";
    assert.deepEqual(sdkCallFromCode(fetch, "typescript"), { method: "POST", path: "responses", body: { model: "muse-spark-1.3", input: "Hi" } });
    const litellm = `import litellm\nresponse = litellm.completion(\n    model="openai/muse-spark-1.3",\n    api_base="https://api.meta.ai/v1",\n    api_key=os.environ["MODEL_API_KEY"],\n    messages=[{"role": "user", "content": "Hi"}],\n)`;
    assert.deepEqual(sdkCallFromCode(litellm, "python"), {
      method: "POST",
      path: "chat/completions",
      body: { model: "muse-spark-1.3", messages: [{ role: "user", content: "Hi" }] },
    });
  });

  it("gives up on anything computed, rather than guess", () => {
    for (const [code, lang] of [
      [`${PY_CLIENT}\nresponse = client.responses.create(model="muse-spark-1.3", input=f"Summarize {topic}")`, "python"],
      [`${PY_CLIENT}\nresponse = client.responses.create(model="muse-spark-1.3", input=question)`, "python"],
      [`${PY_CLIENT}\nresponse = client.responses.create(model=MODEL, input=load())`, "python"],
      [`${PY_CLIENT}\nresponse = client.responses.create(**params)`, "python"],
      [`${PY_CLIENT}\nwith open("fox.png", "rb") as image:\n    client.images.edit(model="muse-image-1.0", prompt="hat", image=image)`, "python"],
      [`${TS_CLIENT}\nawait client.responses.create({ model: 'muse-spark-1.3', input: \`Hi \${name}\` });`, "ts"],
      [`${TS_CLIENT}\nawait client.responses.create({ ...base, input: 'Hi' });`, "ts"],
      [`requests.post("https://api.meta.ai/v1/files", files={"file": open("a.pdf", "rb")}, data={"purpose": "user_data"})`, "python"],
      [`fetch(\`\${BASE}/responses\`, { method: 'POST', body: JSON.stringify({}) })`, "js"],
    ] as const) {
      assert.equal(sdkCallFromCode(code, lang), null, code.split("\n").at(-1) ?? code);
    }
    // A shell block is never read as SDK code.
    assert.equal(sdkCallFromCode(`${PY_CLIENT}\nclient.models.list()`, "bash"), null);
  });
});

describe("requestFromCode", () => {
  it("gives SDK blocks a runnable request, with placeholders as file slots", () => {
    const code = `${PY_CLIENT}
response = client.responses.create(
    model="muse-spark-1.3",
    input=[{"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,iVBORw0..."}]}],
)`;
    const request = requestFromCode(code, "python");
    assert.equal(request?.method, "POST");
    assert.equal(request?.path, "responses");
    assert.deepEqual(request?.fileSlots.map((s) => s.pointer), ["/input/0/content/0/image_url"]);
    // curl in a block still wins, and so does curl captured into a variable.
    const captured = 'response=$(curl -s -w "\\n%{http_code}" -X POST "https://api.meta.ai/v1/chat/completions" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model": "muse-spark-1.3", "messages": []}\')';
    assert.equal(requestFromCode(captured, "shell")?.path, "chat/completions");
  });
});
