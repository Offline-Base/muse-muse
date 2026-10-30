import type { DemoMap, DemoSpec } from "@/lib/docs/demos/types";
import { AuthDemo } from "@/components/docs/playgrounds/start/AuthDemo";
import { EndpointExplorer } from "@/components/docs/playgrounds/start/EndpointExplorer";
import { ErrorLab } from "@/components/docs/playgrounds/start/ErrorLab";
import { ModelsDemo } from "@/components/docs/playgrounds/start/ModelsDemo";
import { ModelsEndpoint, type ModelsEndpointKind } from "@/components/docs/playgrounds/start/ModelsEndpoint";
import { OverviewSampler } from "@/components/docs/playgrounds/start/OverviewSampler";
import { PricingDemo } from "@/components/docs/playgrounds/start/PricingDemo";
import { QuickstartDemo } from "@/components/docs/playgrounds/start/QuickstartDemo";
import { SchemaExplorer } from "@/components/docs/playgrounds/start/SchemaExplorer";
import { SdkClients } from "@/components/docs/playgrounds/start/SdkClients";
import { StatusDemo } from "@/components/docs/playgrounds/start/StatusDemo";

/**
 * Live demos and coding-agent prompts for the "start" pages:
 *   overview
 *   quickstart
 *   authentication
 *   models
 *   pricing-rate-limits
 *   sdks
 *   error-handling
 *   api-reference
 *   api-reference/models
 *   api-reference/models/list-models
 *   api-reference/models/retrieve-model
 *   api-reference/models/schemas
 *   api-reference/status
 * Components live in components/docs/playgrounds/start/. Demos run on muse-spark-1.3-contributor unless a page is
 * about another model, and the code and prompts here use it wherever Meta's examples say muse-spark-1.3.
 */

/** Keeps each spec's props tied to its component. */
const demo = <P extends object>(spec: DemoSpec<P>): DemoSpec<P> => spec;

const M = "muse-spark-1.3-contributor";

const PY_CLIENT = `import os
import sys

from openai import OpenAI

api_key = os.environ.get("MODEL_API_KEY")
if not api_key:
    sys.exit("Set MODEL_API_KEY to your Model API key first.")

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=api_key)`;

const TS_CLIENT = `import OpenAI from "openai";

const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error("MODEL_API_KEY is not set");

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey });`;

/** The models page says GET /v1/models is newest first; the live API doesn't bear that out (Oct 30, 2026). */
const LIST_ORDER_FACT =
  "The models page says the list is newest first by created, but live replies report created: 0 on every model, in no set order: don't rely on created, the order or data[0].";

const FLASK_PROMPT = "Plan the upgrade of a Flask app from SQLAlchemy 1.4 to 2.0: list the breaking changes to check and the order to make them in.";

export const startDemos: DemoMap = {
  overview: demo({
    title: "First call on each model",
    blurb:
      "Each tab sends that model's first request through the live docs (text on Muse Spark, or on Muse Wonder for a cent or two; an image for $0.01; a sample recording; a sample photo), and the last tab has Muse Code's install commands.",
    Component: OverviewSampler,
    props: {},
    agentPrompt: {
      task: "Wire Meta Model API into this project: add a small client module (base URL https://api.meta.ai/v1, key from MODEL_API_KEY) with an ask(prompt, model) function that calls the Responses API and returns the text. Default to muse-spark-1.3-contributor and use muse-wonder-1.0 for long, complex tasks, then add a script that runs one prompt on both.",
      facts: [
        "Muse Wonder (muse-wonder-1.0) and Muse Spark take the same requests on the same endpoints, so switching is a model id change. Muse Wonder is Standard mode only on Model API, and in preview.",
        "Muse Spark ids: muse-spark-1.3-contributor and muse-spark-1.2-contributor (Contributor: cheaper, Meta may train on what you send), muse-spark-1.2 and muse-spark-1.1 (Standard; Muse Spark 1.3 Standard is its Contributor id without -contributor). Context window 1,048,576 tokens.",
        "Other hosted models: muse-image-1.0 (POST /v1/images/generations and /v1/images/edits), muse-voice-transcribe-1.0 (POST /v1/asr/transcribe, wss://api.meta.ai/v1/asr/realtime), sam-3.1 (POST /v1/responses).",
        "Muse Spark Open and Muse Glimmer are open weights you run yourself: they aren't on Model API.",
        "The OpenAI SDK works with base_url set, but it doesn't read MODEL_API_KEY: pass the key explicitly.",
      ],
      checklist: [
        "The script prints an answer from muse-spark-1.3-contributor and one from muse-wonder-1.0 for the same prompt.",
        "The two calls differ only in the model id.",
      ],
      snippets: {
        python: `${PY_CLIENT}


def ask(prompt: str, model: str = "${M}") -> str:
    response = client.responses.create(model=model, input=prompt)
    return response.output_text


prompt = "${FLASK_PROMPT}"
print(ask(prompt))
print(ask(prompt, model="muse-wonder-1.0"))`,
        typescript: `${TS_CLIENT}

async function ask(prompt: string, model = "${M}"): Promise<string> {
  const response = await client.responses.create({ model, input: prompt });
  return response.output_text;
}

const prompt = "${FLASK_PROMPT}";
console.log(await ask(prompt));
console.log(await ask(prompt, "muse-wonder-1.0"));`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "muse-wonder-1.0",
  "reasoning": {
    "effort": "high"
  },
  "input": "${FLASK_PROMPT}"
}'`,
      },
    },
  }),

  quickstart: demo({
    title: "Make your first call and read the response",
    blurb:
      "Run sends the quickstart's own request to the Responses API and walks the reply (the answer, the reasoning and message items, where the tokens went), with tabs for a coding-agent config and Muse Code's install.",
    Component: QuickstartDemo,
    props: {},
    agentPrompt: {
      task: 'Make the quickstart\'s first Meta Model API call from this project: send "What is the capital of France?" to the Responses API with the OpenAI SDK pointed at https://api.meta.ai/v1, print response.output_text, then log the usage (input_tokens, output_tokens and output_tokens_details.reasoning_tokens). Stop with a clear message when MODEL_API_KEY isn\'t set.',
      facts: [
        "Install the SDK first: pip install openai (Python 3.9+) or npm install openai (Node.js 18+).",
        "The OpenAI SDK doesn't read MODEL_API_KEY: pass api_key (Python) or apiKey (TypeScript) explicitly, or set OPENAI_API_KEY to the Model API key.",
        "The answer is the output_text part of the message item; the SDK exposes it as response.output_text. A reasoning item comes first, and its summary is empty unless you ask for one.",
        'Reasoning tokens count toward output_tokens. Without reasoning.effort, the response reports effort "high".',
        "401 invalid_api_key: the key isn't set or isn't valid. 404 model_not_found: the model id is wrong.",
        "On Windows, curl reads the key as %MODEL_API_KEY% (cmd) or $env:MODEL_API_KEY (PowerShell).",
      ],
      checklist: [
        "Running it prints a sentence naming Paris, then the token counts, with reasoning tokens included in output_tokens.",
        "With MODEL_API_KEY unset, it stops with a clear message before sending anything.",
      ],
      snippets: {
        python: `${PY_CLIENT}

response = client.responses.create(
    model="${M}",
    input="What is the capital of France?",
)

print(response.output_text)
usage = response.usage
print(usage.input_tokens, usage.output_tokens, usage.output_tokens_details.reasoning_tokens)`,
        typescript: `${TS_CLIENT}

const response = await client.responses.create({
  model: "${M}",
  input: "What is the capital of France?",
});

console.log(response.output_text);
console.log(response.usage);`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "${M}",
  "input": "What is the capital of France?"
}'`,
      },
    },
  }),

  authentication: demo({
    title: "Authenticate without putting a key in the browser",
    blurb:
      "Run sends a real request the way the page says to, with no key in your browser and Muse Muse's key added on the server, next to a header builder for each client and shell and the 401 a missing or bad key gets.",
    Component: AuthDemo,
    props: {},
    agentPrompt: {
      task: "Make this project authenticate to Meta Model API the safe way: read the key from the MODEL_API_KEY environment variable (never hard-coded), send it as Authorization: Bearer on every request, pass it explicitly to any SDK client, and stop with a clear message when it's missing. If browser or mobile code calls the API, move those calls behind a server route that adds the key, so the key never reaches the client.",
      facts: [
        "Keys look like LLM_{numeric id}_{secret} and are shown once, when created in the Model API dashboard (API keys, Create API key).",
        "The header is Authorization: Bearer $MODEL_API_KEY. The OpenAI SDK reads OPENAI_API_KEY and the Anthropic SDK ANTHROPIC_API_KEY, not MODEL_API_KEY: pass it when you create the client (Anthropic: auth_token, with base_url https://api.meta.ai).",
        "A missing, malformed, revoked or mistyped key returns 401 with type authentication_error and code invalid_api_key.",
        "Keys on one team share its rate limits. Rotate by creating a new key, moving apps to it, then deleting the old one.",
        "Keep credential files such as .env out of git (.gitignore), and use one key per app or developer.",
      ],
      checklist: [
        "A request with the key from the environment succeeds (GET /v1/models is a free check).",
        "With MODEL_API_KEY unset, the code stops with a clear message instead of sending a request without a key.",
        "No key or .env file is committed, and no client-side bundle contains the key.",
      ],
      snippets: {
        python: `import os
import sys

import requests

api_key = os.environ.get("MODEL_API_KEY")
if not api_key:
    sys.exit("Set MODEL_API_KEY to your Model API key first.")

response = requests.post(
    "https://api.meta.ai/v1/chat/completions",
    headers={"Authorization": f"Bearer {api_key}"},
    json={"model": "${M}", "messages": [{"role": "user", "content": "Hello"}]},
)
if response.status_code == 401:
    sys.exit("The API refused the key (invalid_api_key): check MODEL_API_KEY against the dashboard.")
response.raise_for_status()
print(response.json()["choices"][0]["message"]["content"])`,
        typescript: `// A server route: the browser calls it, and the key stays on the server.
export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) return Response.json({ error: "MODEL_API_KEY is not set" }, { status: 500 });
  const { message } = (await request.json()) as { message: string };
  const upstream = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: \`Bearer \${apiKey}\`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "${M}", messages: [{ role: "user", content: message }] }),
  });
  return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": "application/json" } });
}`,
        curl: `curl https://api.meta.ai/v1/chat/completions \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${M}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
      },
    },
  }),

  models: demo({
    title: "List the models and compare two on one prompt",
    blurb:
      "List models loads GET /v1/models (free) next to each model's card from this page; the second tab runs one prompt on two models side by side with latency, tokens and cost (about a cent when one side is Muse Wonder).",
    Component: ModelsDemo,
    props: {},
    agentPrompt: {
      task: "Add model selection to this project: keep the model id in configuration, check it against GET /v1/models at startup (or in a check script), and route work the way the models page advises: muse-spark-1.3-contributor (or a Standard Muse Spark id) for high-volume, latency- or cost-sensitive calls, muse-wonder-1.0 for long, complex tasks. Stop with a clear message when the configured id isn't in the list.",
      facts: [
        'GET /v1/models returns { "object": "list", "data": [{ "id", "object": "model", "created", "owned_by" }] }; GET /v1/models/{model} returns one Model (an unknown id: 404 model_not_found).',
        LIST_ORDER_FACT,
        "Hosted ids: muse-wonder-1.0, muse-spark-1.3-contributor (Muse Spark 1.3 Standard drops -contributor), muse-spark-1.2, muse-spark-1.2-contributor, muse-spark-1.1, muse-image-1.0, muse-voice-transcribe-1.0, sam-3.1.",
        "Muse Wonder and Muse Spark take the same requests on the same endpoints (1,048,576-token context, multimodal input). The id picks the mode (-contributor is Contributor); Muse Wonder is Standard only.",
        '"max" effort isn\'t available on muse-spark-1.3-contributor. For audio, use Muse Spark 1.2 or Muse Voice Transcribe: 1.3 doesn\'t fully support it.',
      ],
      checklist: [
        "A check script prints the model ids GET /v1/models returns.",
        "Setting MODEL_ID to a bogus id stops the app with a message naming that id and the ids the team has.",
      ],
      snippets: {
        python: `${PY_CLIENT}

MODEL = os.environ.get("MODEL_ID", "${M}")

available = {model.id for model in client.models.list()}
if MODEL not in available:
    raise SystemExit(f"{MODEL} isn't available to this team: {sorted(available)}")

print(client.models.retrieve(MODEL).model_dump_json(indent=2))`,
        typescript: `${TS_CLIENT}

const MODEL = process.env.MODEL_ID ?? "${M}";

const models = await client.models.list();
const ids = models.data.map((m) => m.id);
if (!ids.includes(MODEL)) throw new Error(\`\${MODEL} isn't available to this team: \${ids.join(", ")}\`);

console.log(JSON.stringify(await client.models.retrieve(MODEL), null, 2));`,
        curl: `curl -X GET "https://api.meta.ai/v1/models" \\
  -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "pricing-rate-limits": demo({
    title: "Price a workload, then a real call",
    blurb:
      "The calculator prices tokens, images, audio and segmentation with this page's rates, Price a real call turns one request's real usage into line items (fractions of a cent on Contributor), and Rate limits checks a workload against the team limits.",
    Component: PricingDemo,
    props: {},
    agentPrompt: {
      task: "Add cost tracking and rate-limit handling to this project's Meta Model API calls: compute each call's cost from its usage with the pricing page's rates (uncached input at the input rate, cached input at the cached rate, output including reasoning at the output rate, plus $2.50 per 1,000 web searches), log it per request, and retry 429s with exponential backoff and jitter that waits at least Retry-After.",
      facts: [
        "Per 1M tokens (input, cached input, output): Muse Wonder $4.00, $0.20, $20.00 (Standard only); Muse Spark Standard $1.25, $0.15, $4.25; the Contributor ids $0.10, $0.002, $0.20.",
        "input_tokens includes cached_tokens (input_tokens_details); output_tokens includes reasoning_tokens (output_tokens_details). No long-context premium.",
        "Other prices: Muse Image $0.01 an image; Voice Transcribe $0.18 an hour (whole seconds, rounded down); SAM 3.1 $2.50 per 1,000 images and $0.20 per 1,000 frames (50 frames minimum per video request).",
        "Limits are per team, not per key: 3,000 RPM and 4M TPM for Muse Wonder and Muse Spark Standard, 150 RPM and 3M TPM for the Contributor ids, 150 RPM for Muse Image.",
        "Read x-ratelimit-remaining-requests and x-ratelimit-remaining-tokens (and their -limit- pairs) on token responses to slow down before a 429.",
      ],
      checklist: [
        "Each call logs its token counts and a cost that matches the formula for its model.",
        "A mocked 429 with Retry-After: 2 waits at least 2 s before retrying.",
      ],
      snippets: {
        python: `${PY_CLIENT}

RATES = {  # USD per 1M tokens: input, cached input, output
    "muse-wonder-1.0": (4.00, 0.20, 20.00),
    "spark-standard": (1.25, 0.15, 4.25),  # every Muse Spark id without -contributor
    "spark-contributor": (0.10, 0.002, 0.20),  # muse-spark-1.3-contributor, muse-spark-1.2-contributor
}


def rates_for(model):
    if model.startswith("muse-spark-"):
        return RATES["spark-contributor" if model.endswith("-contributor") else "spark-standard"]
    return RATES[model]


def cost_usd(model, usage, web_searches=0):
    rate_in, rate_cached, rate_out = rates_for(model)
    cached = usage.input_tokens_details.cached_tokens or 0
    tokens = (usage.input_tokens - cached) * rate_in + cached * rate_cached + usage.output_tokens * rate_out
    return tokens / 1_000_000 + web_searches * 2.50 / 1000


response = client.responses.create(model="${M}", input="Say hello in five words.")
print(response.usage.input_tokens, response.usage.output_tokens, f"\${cost_usd(response.model, response.usage):.6f}")`,
        typescript: `const RATES: Record<string, [number, number, number]> = {
  // USD per 1M tokens: input, cached input, output
  "muse-wonder-1.0": [4.0, 0.2, 20.0],
  "spark-standard": [1.25, 0.15, 4.25], // every Muse Spark id without -contributor
  "spark-contributor": [0.1, 0.002, 0.2], // muse-spark-1.3-contributor, muse-spark-1.2-contributor
};
const ratesFor = (model: string) =>
  model.startsWith("muse-spark-") ? RATES[model.endsWith("-contributor") ? "spark-contributor" : "spark-standard"] : RATES[model];

const response = await fetch("https://api.meta.ai/v1/responses", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "${M}", input: "Say hello in five words." }),
});
const reply = await response.json();
const [input, cachedRate, output] = ratesFor(reply.model);
const cached = reply.usage.input_tokens_details?.cached_tokens ?? 0;
const usd = ((reply.usage.input_tokens - cached) * input + cached * cachedRate + reply.usage.output_tokens * output) / 1e6;
console.log(reply.usage, usd.toFixed(6), response.headers.get("x-ratelimit-remaining-requests"));`,
        curl: `curl -s -D headers.txt -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${M}", "input": "Say hello in five words."}' | jq '.usage'
grep -i '^x-ratelimit' headers.txt`,
      },
    },
  }),

  sdks: demo({
    title: "One request through each client",
    blurb:
      "Pick a client to see its install line and code, then Run sends the request that client puts on the wire (Responses, Chat Completions or Messages) and prints what that client would print.",
    Component: SdkClients,
    props: {},
    agentPrompt: {
      task: "Point this project's existing LLM client at Meta Model API instead of rewriting it: set the base URL, pass the Model API key explicitly and keep the rest of the code. Use whichever client the project already has: the OpenAI SDK (Responses or Chat Completions), the Anthropic SDK (Messages), or an OpenAI-compatible framework such as LangChain, LlamaIndex, the Vercel AI SDK or LiteLLM.",
      facts: [
        "OpenAI SDK: base_url (Python) or baseURL (TypeScript) https://api.meta.ai/v1, and api_key or apiKey from MODEL_API_KEY: it looks for OPENAI_API_KEY otherwise.",
        "Anthropic SDK: base_url https://api.meta.ai with no /v1 (the SDK appends /v1/messages), and the key as auth_token, sent as a bearer token. content starts with a redacted_thinking block: join the text blocks instead of reading content[0].",
        'LiteLLM reaches Model API through its OpenAI provider: model "openai/muse-spark-1.3-contributor" with api_base https://api.meta.ai/v1.',
        "Any other OpenAI-compatible client needs three values: the base URL, the key and a model id.",
        "SAM 3.1's output is a token grammar: decode it with @meta-sam/parser (TypeScript) or meta_sam_parser (Python).",
      ],
      checklist: [
        "The project's existing client call returns a reply from muse-spark-1.3-contributor with only its configuration changed.",
        "With the Anthropic SDK, the printed text comes from the text blocks, not from the redacted_thinking block.",
      ],
      snippets: {
        python: `import os

from anthropic import Anthropic
from openai import OpenAI

openai_client = OpenAI(api_key=os.environ["MODEL_API_KEY"], base_url="https://api.meta.ai/v1")
response = openai_client.responses.create(model="${M}", input="Explain mixture-of-experts in two sentences.")
print(response.output_text)

anthropic_client = Anthropic(base_url="https://api.meta.ai", auth_token=os.environ["MODEL_API_KEY"])
message = anthropic_client.messages.create(
    model="${M}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain mixture-of-experts in two sentences."}],
)
print("".join(block.text for block in message.content if block.type == "text"))`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.MODEL_API_KEY,
  baseURL: "https://api.meta.ai/v1",
});

const response = await client.responses.create({
  model: "${M}",
  input: "Explain mixture-of-experts in two sentences.",
});
console.log(response.output_text);`,
        curl: `curl -X POST "https://api.meta.ai/v1/messages" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "${M}",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Explain mixture-of-experts in two sentences."}]
}'`,
      },
    },
  }),

  "error-handling": demo({
    title: "Trigger real errors and plan the retries",
    blurb:
      "Each pill sends a request that fails (a missing field, a bad parameter, an unknown model, malformed JSON, a typo in the path) and takes the error apart, free since it's refused before any model runs; the page's 413 is shown as a recorded example, and the retry simulator plays 429s and 5xx against the page's rules.",
    Component: ErrorLab,
    props: {},
    agentPrompt: {
      task: "Add error handling to this project's Meta Model API calls: branch on the HTTP status and the error envelope (message, type, param, code), retry only 429, 500 and 503 with exponential backoff and jitter that waits at least Retry-After (3 to 5 attempts), never retry 400, 401, 402, 403, 404 or 413 unchanged, switch a 504 to streaming or background instead of retrying, and handle response.failed and error events on streams. Log status, type, code and message.",
      facts: [
        'Errors are { "error": { "message", "type", "param", "code" } }; type is invalid_request_error, authentication_error, rate_limit_error or server_error. code is often null on validation errors: prefer type and message.',
        "A 404 for an unknown path has an empty body, and GET /v1/files can answer a 400 in plain text: check the status and Content-Type before parsing JSON.",
        "503 is always retryable: server_shutting_down (Retry-After a few seconds), service_overloaded and backend_unavailable (60).",
        "504 gateway_timeout usually repeats: send it with stream: true or background: true, or make it smaller.",
        "The OpenAI SDK retries some errors itself (max_retries defaults to 2): set it to 0 when your own loop retries.",
        "Validation limits: max_output_tokens at least 16 on Responses, 0 < top_p <= 1, temperature 0 to 2.",
      ],
      checklist: [
        "A request with top_p 1.5 logs a 400 naming param top_p and isn't retried.",
        "A mocked 429 with Retry-After: 2 is retried after at least 2 s, and the loop gives up after the last attempt.",
        "A mocked mid-stream error event reaches the user and the whole request is retried.",
      ],
      snippets: {
        python: `import os
import random
import time

from openai import APIStatusError, OpenAI

client = OpenAI(api_key=os.environ["MODEL_API_KEY"], base_url="https://api.meta.ai/v1", max_retries=0)

RETRYABLE = {429, 500, 503}


def create_with_retry(max_attempts=4, **request):
    for attempt in range(1, max_attempts + 1):
        try:
            return client.responses.create(**request)
        except APIStatusError as e:
            print(f"API error {e.status_code}: {e.type} {e.code} {e.message}")
            if e.status_code not in RETRYABLE or attempt == max_attempts:
                raise
            delay = 0.5 * 2 ** (attempt - 1) + random.random()
            retry_after = e.response.headers.get("retry-after")
            if retry_after and retry_after.isdigit():
                delay = max(delay, float(retry_after))
            time.sleep(delay)


response = create_with_retry(model="${M}", input="Hello!")
print(response.output_text)`,
        typescript: `import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: "https://api.meta.ai/v1" });

try {
  const response = await client.chat.completions.create({
    model: "${M}",
    messages: [{ role: "user", content: "Hello!" }],
  });
  console.log(response.choices[0].message.content);
} catch (error) {
  if (error instanceof OpenAI.AuthenticationError) {
    console.error("Authentication failed:", error.message);
  } else if (error instanceof OpenAI.RateLimitError) {
    console.error("Rate limit exceeded:", error.message); // back off and retry
  } else if (error instanceof OpenAI.APIError) {
    console.error(\`API error \${error.status}:\`, error.message);
  } else {
    console.error("Unexpected error:", error);
  }
}`,
        curl: `response=$(curl -s -w "\\n%{http_code}" -X POST "https://api.meta.ai/v1/chat/completions" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${M}", "messages": [{"role": "user", "content": "Hello"}]}')

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
  echo "Success: $body"
elif [ "$http_code" -eq 429 ]; then
  echo "Rate limit exceeded. Retry after a delay."
else
  echo "Error $http_code: $body"
fi`,
      },
    },
  }),

  "api-reference": demo({
    title: "Explore every endpoint",
    blurb:
      "Pick an endpoint to open it in the API console with a request that works, and Send runs it through the live docs: most are free, text calls are fractions of a cent and images $0.01.",
    Component: EndpointExplorer,
    props: {},
    agentPrompt: {
      task: "Create a small typed client for the Meta Model API endpoints this project uses, on https://api.meta.ai/v1 with the bearer key from MODEL_API_KEY: one function per endpoint (such as createResponse, retrieveResponse, countInputTokens, listModels, uploadFile, getStatus), each returning the parsed JSON and throwing an error that carries the envelope's message, type, param and code.",
      facts: [
        "Responses: POST /responses, GET and DELETE /responses/{response_id}, POST /responses/{response_id}/cancel, POST /responses/input_tokens. Chat Completions: POST /chat/completions. Messages: POST /messages, POST /messages/count_tokens.",
        "Files: POST /files (multipart, purpose user_data), GET /files, GET and DELETE /files/{file_id}, GET /files/{file_id}/content. Images: POST /images/generations, POST /images/edits. Voice: POST /asr/transcribe (multipart: a request JSON part and the audio).",
        "Models: GET /models, GET /models/{model}. Status: GET /status, which needs no key.",
        "Errors use { error: { message, type, param, code } }: branch on type and message. Rate limits apply per team.",
      ],
      checklist: [
        "listModels() and getStatus() work against the live API.",
        "A deliberately bad request throws an error whose message names the bad param.",
      ],
      snippets: {
        python: `import os

import requests

BASE = "https://api.meta.ai/v1"
session = requests.Session()
session.headers["Authorization"] = f"Bearer {os.environ['MODEL_API_KEY']}"


class ModelAPIError(Exception):
    def __init__(self, status, error):
        super().__init__(f"{status} {error.get('type')}: {error.get('message')} (param={error.get('param')}, code={error.get('code')})")
        self.status, self.error = status, error


def call(method, path, **kwargs):
    response = session.request(method, f"{BASE}/{path}", **kwargs)
    if not response.ok:
        is_json = response.headers.get("content-type", "").startswith("application/json")
        error = response.json().get("error", {}) if is_json and response.content else {"message": response.text}
        raise ModelAPIError(response.status_code, error)
    return response.json()


print(call("GET", "status"))
print([m["id"] for m in call("GET", "models")["data"]])
print(call("POST", "responses/input_tokens", json={"model": "${M}", "input": "What is the capital of France?"}))`,
        typescript: `const BASE = "https://api.meta.ai/v1";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(\`\${BASE}/\${path}\`, {
    method,
    headers: {
      Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    const error = text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text).error : { message: text };
    throw new Error(\`\${response.status} \${error?.type}: \${error?.message} (param=\${error?.param}, code=\${error?.code})\`);
  }
  return (await response.json()) as T;
}

console.log(await call("GET", "status"));
console.log(await call("POST", "responses/input_tokens", { model: "${M}", input: "What is the capital of France?" }));`,
        curl: `curl "https://api.meta.ai/v1/status"
curl "https://api.meta.ai/v1/models" -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/models": demo({
    title: "List models or retrieve one",
    blurb: "Send calls GET /v1/models or GET /v1/models/{model} through the live docs and checks the reply against this reference's schemas; both are free.",
    Component: ModelsEndpoint,
    props: { endpoints: ["list", "retrieve"] satisfies ModelsEndpointKind[] },
    agentPrompt: {
      task: "Add the Models endpoints to this project's Meta Model API client: listModels() for GET /v1/models and getModel(id) for GET /v1/models/{model}, typed with the reference's ListModelsResponse and Model shapes, plus a startup check that the configured model id is in the list.",
      facts: [
        'ListModelsResponse: { "object": "list", "data": Model[] }. Model: { "id": string, "object": "model", "created": integer (Unix seconds), "owned_by": string, "metadata"?: object }.',
        "GET /v1/models takes an optional client query parameter (a client-specific catalog view); metadata appears only for a recognized client.",
        "An unknown id returns 404 with code model_not_found.",
        LIST_ORDER_FACT,
      ],
      checklist: [
        "listModels() returns ids that include muse-spark-1.3-contributor.",
        'getModel("bogus-model") raises an error with code model_not_found.',
      ],
      snippets: {
        python: `${PY_CLIENT}

print([model.id for model in client.models.list()])
print(client.models.retrieve("${M}").model_dump_json(indent=2))`,
        typescript: `${TS_CLIENT}

const models = await client.models.list();
console.log(models.data.map((m) => m.id));
console.log(JSON.stringify(await client.models.retrieve("${M}"), null, 2));`,
        curl: `curl -X GET "https://api.meta.ai/v1/models" \\
  -H "Authorization: Bearer $MODEL_API_KEY"
curl -X GET "https://api.meta.ai/v1/models/${M}" \\
  -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/models/list-models": demo({
    title: "GET /v1/models",
    blurb: "Send lists the models through the live docs, with the optional client query parameter, and checks the reply against ListModelsResponse; free.",
    Component: ModelsEndpoint,
    props: { endpoints: ["list"] satisfies ModelsEndpointKind[] },
    agentPrompt: {
      task: "Call GET /v1/models from this project and print each model's id, created and owned_by, with an optional client query parameter passed through when set.",
      facts: [
        'The reply is ListModelsResponse: { "object": "list", "data": [{ "id", "object": "model", "created", "owned_by" }] }.',
        LIST_ORDER_FACT,
        "client is optional: a client-specific catalog view. Model objects carry metadata only when it names a recognized client.",
        "It returns the API-hosted models only (no self-hosted Muse Glimmer), and costs nothing.",
      ],
      checklist: ["The command prints one line per model, muse-spark-1.3-contributor among them."],
      snippets: {
        python: `${PY_CLIENT}

response = client.models.list()

print(response.model_dump_json(indent=2))`,
        typescript: `${TS_CLIENT}

const models = await client.models.list();
console.log(JSON.stringify({ object: models.object, data: models.data }, null, 2));`,
        curl: `curl -X GET "https://api.meta.ai/v1/models" \\
  -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/models/retrieve-model": demo({
    title: "GET /v1/models/{model}",
    blurb: "Pick a model id (or type one that doesn't exist) and Send retrieves it through the live docs, checked against the Model schema; free.",
    Component: ModelsEndpoint,
    props: { endpoints: ["retrieve"] satisfies ModelsEndpointKind[] },
    agentPrompt: {
      task: "Retrieve the configured model's metadata with GET /v1/models/{model} when this project starts, and stop with a clear message naming the id when the API answers 404 model_not_found.",
      facts: [
        'The reply is a Model: { "id": string, "object": "model", "created": integer (Unix seconds), "owned_by": string, "metadata"?: object }. created matches the value in GET /v1/models.',
        "The model path parameter is required. An unknown id returns 404 with type invalid_request_error and code model_not_found.",
        "Retrieving a model sends no prompt and costs nothing.",
      ],
      checklist: [
        `Retrieving ${M} prints its id, object, created and owned_by.`,
        "A bogus id stops the app with the model_not_found message.",
      ],
      snippets: {
        python: `${PY_CLIENT}

response = client.models.retrieve("${M}")

print(response.model_dump_json(indent=2))`,
        typescript: `${TS_CLIENT}

const model = await client.models.retrieve("${M}");
console.log(JSON.stringify(model, null, 2));`,
        curl: `curl -X GET "https://api.meta.ai/v1/models/${M}" \\
  -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/models/schemas": demo({
    title: "Models schemas, checked against a live reply",
    blurb: "Search and expand the ListModelsResponse and Model fields, then Fetch and check pulls a live object (free) and checks it field by field.",
    Component: SchemaExplorer,
    props: {},
    agentPrompt: {
      task: "Add types for the Models objects to this project exactly as the schemas page defines them (ListModelsResponse and Model, with metadata optional), and parse a live GET /v1/models reply through them, rejecting a reply that misses a required field.",
      facts: [
        'ListModelsResponse: object (enum "list", required), data (array of Model, required).',
        'Model: id (string, required), object (enum "model", required), created (integer Unix seconds, required), owned_by (string, required), metadata (object, optional: only with a recognized client query parameter, keyed by client type).',
      ],
      checklist: ["A live GET /v1/models reply parses with no missing or mistyped field.", "A reply missing created fails to parse."],
      snippets: {
        python: `import os
from typing import Any, Literal, TypedDict

import requests


class _ModelFields(TypedDict):
    id: str
    object: Literal["model"]
    created: int  # Unix seconds
    owned_by: str


class Model(_ModelFields, total=False):
    metadata: dict[str, Any]  # only with a recognized client query parameter


class ListModelsResponse(TypedDict):
    object: Literal["list"]
    data: list[Model]


def parse(reply: dict) -> ListModelsResponse:
    if reply.get("object") != "list" or not isinstance(reply.get("data"), list):
        raise ValueError('not a ListModelsResponse: object must be "list" and data an array')
    for m in reply["data"]:
        for field, kind in (("id", str), ("created", int), ("owned_by", str)):
            if type(m.get(field)) is not kind:
                raise ValueError(f"model {m.get('id')}: {field} missing or not {kind.__name__}")
        if m.get("object") != "model":
            raise ValueError(f'model {m.get("id")}: object must be "model"')
    return reply  # type: ignore[return-value]


reply = requests.get("https://api.meta.ai/v1/models", headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"})
reply.raise_for_status()
print([m["id"] for m in parse(reply.json())["data"]])`,
        typescript: `interface Model {
  id: string;
  object: "model";
  created: number; // Unix seconds
  owned_by: string;
  metadata?: Record<string, unknown>; // only with a recognized client query parameter
}

interface ListModelsResponse {
  object: "list";
  data: Model[];
}

function isModel(m: any): m is Model {
  return typeof m?.id === "string" && m.object === "model" && Number.isInteger(m.created) && typeof m.owned_by === "string";
}

const response = await fetch("https://api.meta.ai/v1/models", { headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\` } });
const reply = (await response.json()) as ListModelsResponse;
if (reply.object !== "list" || !reply.data.every(isModel)) throw new Error("Unexpected models reply");
console.log(reply.data.map((m) => m.id));`,
        curl: `curl -s "https://api.meta.ai/v1/models" \\
  -H "Authorization: Bearer $MODEL_API_KEY" | jq '.object, [.data[] | {id, object, created, owned_by}]'`,
      },
    },
  }),

  "api-reference/status": demo({
    title: "Check the API's status",
    blurb: "Check status calls GET /v1/status through the live docs, with no key, and draws the reply as a status badge; free.",
    Component: StatusDemo,
    props: {},
    agentPrompt: {
      task: "Add a health check to this project that calls GET /v1/status (no key needed), reads is_alive, service_status, service_message, updated_at and model_statuses, and is consulted before retrying failed requests: when the service isn't operational, back off instead of retrying.",
      facts: [
        "GET https://api.meta.ai/v1/status is unauthenticated: the Authorization header is optional here.",
        'A live reply looks like { "is_alive": true, "service_status": "operational", "service_message": "", "updated_at": "", "model_statuses": [] }. The reference names it StatusResponse without listing fields, so read each one defensively.',
        "The error-handling page sends persistent 500s and 503s here before more retries.",
      ],
      checklist: ["The check prints operational while the API is up.", "It runs with MODEL_API_KEY unset."],
      snippets: {
        python: `import requests

response = requests.get("https://api.meta.ai/v1/status", timeout=10)
response.raise_for_status()
status = response.json()
healthy = status.get("is_alive") is True and status.get("service_status") == "operational"
print("operational" if healthy else f"degraded: {status.get('service_status')} {status.get('service_message')}")`,
        typescript: `const response = await fetch("https://api.meta.ai/v1/status");
if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
const status = (await response.json()) as { is_alive?: boolean; service_status?: string; service_message?: string };
const healthy = status.is_alive === true && status.service_status === "operational";
console.log(healthy ? "operational" : \`degraded: \${status.service_status} \${status.service_message ?? ""}\`);`,
        curl: `curl -X GET "https://api.meta.ai/v1/status"`,
      },
    },
  }),
};
