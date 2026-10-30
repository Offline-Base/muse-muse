# Agent frameworks {#agent-frameworks}

Build your own agent on [Muse Wonder](https://dev.meta.ai/docs/models#muse-wonder), Meta's most capable model, or [Muse Spark](https://dev.meta.ai/docs/models#muse-spark), with the framework you already know. Where [coding agents](https://dev.meta.ai/docs/coding-agents) give you a ready-made terminal agent, the frameworks here let you write the agent yourself: you define the prompt, the tools, and the control flow, and drive the model loop from your own code.

This guide shows two paths: the [Claude Agent SDK](https://dev.meta.ai/docs/agent-frameworks#claude-agent-sdk), which connects through the [Messages API](https://dev.meta.ai/docs/protocols/messages), and the [OpenAI Codex app-server](https://dev.meta.ai/docs/agent-frameworks#codex-app-server), which connects through the OpenAI-compatible [Responses API](https://dev.meta.ai/docs/protocols/responses).

## How it works {#how-it-works}

An agent framework owns the loop: it sends your instruction to the model, receives tool-call requests, executes them, feeds the results back, and repeats until the task is done. The model is the inference backend that decides what to do at each step. You supply three things, the same as any other client:

1. **Base URL**: `https://api.meta.ai/v1`. Both surfaces share it: the Responses API is `/v1/responses` and the Messages API is `/v1/messages`.
2. **API key**: your Model API key (generate one in the [Model API dashboard](https://dev.meta.ai/)).
3. **Model ID**: `muse-wonder-1.0` for the main agent loop, and `muse-spark-1.3` where cost matters more, such as subagents ([choose between them](https://dev.meta.ai/docs/models#choose-muse-wonder-or-muse-spark)).

Which framework to reach for depends on the wire format it speaks:

| Framework                   | Wire format        | Model API surface                                                               |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| **Claude Agent SDK**        | Anthropic Messages | [Messages API](https://dev.meta.ai/docs/protocols/messages) (`/v1/messages`)    |
| **OpenAI Codex app-server** | OpenAI Responses   | [Responses API](https://dev.meta.ai/docs/protocols/responses) (`/v1/responses`) |

Both drive a full agent loop against Model API: file edits, shell commands, tool calls, and multi-step reasoning across turns.

***

## Build with the Claude Agent SDK {#claude-agent-sdk}

The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) is the engine behind Claude Code, exposed as a library for building your own agents. It speaks the Anthropic Messages format, so it connects to Model API through the [Messages API](https://dev.meta.ai/docs/protocols/messages).

### Configuration {#claude-agent-sdk-config}

The SDK reads its provider settings from environment variables, the same ones Claude Code uses. Pass them inline through the SDK's `env` option (shown in the [next example](https://dev.meta.ai/docs/agent-frameworks#claude-agent-sdk-code)), or export them before you run:

- **`ANTHROPIC_BASE_URL`**: the Model API base host. The SDK appends `/v1/messages`, so use the bare host with no `/v1` suffix.
- **`ANTHROPIC_AUTH_TOKEN`**: your Model API key. The SDK sends it as `Authorization: Bearer <key>`, which is how Model API authenticates. Use this rather than `ANTHROPIC_API_KEY`, which sends an `x-api-key` header instead.
- **`ANTHROPIC_MODEL`**: the model for the main agent loop. The example below uses `muse-wonder-1.0`.
- **`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`**: the models the SDK resolves when work routes through the `opus`, `sonnet`, or `haiku` alias instead of `ANTHROPIC_MODEL` — subagents can select a tier this way, and `haiku` also backs lightweight background tasks such as summaries and subagent bookkeeping. Point all three at a model Model API serves (see [Models](https://dev.meta.ai/docs/models)); otherwise those paths try to reach a Claude model Model API doesn't serve. The example below sends the `opus` tier to `muse-wonder-1.0` and the `sonnet` and `haiku` tiers to the lower-cost `muse-spark-1.3`.
- **`CLAUDE_CODE_SUBAGENT_MODEL`**: the model the SDK runs subagents with. Subagents take many short, focused tasks, so the example pins them to the lower-cost `muse-spark-1.3`; pinning also keeps subagent loops on Model API instead of falling back to a Claude model. To run everything on one model, set all five model variables to the same ID.

### Write the agent {#claude-agent-sdk-code}

The SDK's `query` function runs the loop and streams back messages as the agent works. Configure the tools, permission mode, and system prompt for the job, then read the final answer from the `result` message.

**TypeScript**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const run = query({
  prompt: "Add input validation to the signup handler and run the tests.",
  options: {
    model: "muse-wonder-1.0",
    cwd: "/path/to/workspace",
    systemPrompt: "You are a coding agent. Make minimal, well-tested changes.",
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "bypassPermissions",
    settingSources: [],
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://api.meta.ai",
      ANTHROPIC_AUTH_TOKEN: process.env.MODEL_API_KEY ?? "",
      ANTHROPIC_MODEL: "muse-wonder-1.0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "muse-wonder-1.0",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "muse-spark-1.3",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "muse-spark-1.3",
      CLAUDE_CODE_SUBAGENT_MODEL: "muse-spark-1.3",
    },
  },
});

for await (const message of run) {
  if (message.type === "assistant") {
    // Stream partial output to your UI as the agent works.
  } else if (message.type === "result") {
    console.log(message.result); // final answer
    console.log(message.usage); // token accounting
  }
}
```

**Python**

```python
import os

import anyio
from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


async def main():
    async for message in query(
        prompt="Add input validation to the signup handler and run the tests.",
        options=ClaudeAgentOptions(
            model="muse-wonder-1.0",
            cwd="/path/to/workspace",
            system_prompt="You are a coding agent. Make minimal, well-tested changes.",
            allowed_tools=["Read", "Edit", "Bash"],
            permission_mode="bypassPermissions",
            setting_sources=[],
            env={
                **os.environ,
                "ANTHROPIC_BASE_URL": "https://api.meta.ai",
                "ANTHROPIC_AUTH_TOKEN": os.environ["MODEL_API_KEY"],
                "ANTHROPIC_MODEL": "muse-wonder-1.0",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "muse-wonder-1.0",
                "ANTHROPIC_DEFAULT_SONNET_MODEL": "muse-spark-1.3",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": "muse-spark-1.3",
                "CLAUDE_CODE_SUBAGENT_MODEL": "muse-spark-1.3",
            },
        ),
    ):
        if isinstance(message, ResultMessage):
            print(message.result)  # final answer
            print(message.usage)  # token accounting


anyio.run(main)
```

Install with `npm install @anthropic-ai/claude-agent-sdk` (TypeScript) or `pip install claude-agent-sdk` (Python). A few options carry most of the weight:

- **`allowedTools`**: restrict the agent to the tools the task needs. A smaller surface is easier to reason about and cheaper to run.
- **`permissionMode`**: `bypassPermissions` runs unattended without prompting for approval. Only safe inside a sandbox — see [Production patterns](https://dev.meta.ai/docs/agent-frameworks#production-patterns).
- **`settingSources: []`**: don't inherit ambient user or project settings, so runs are hermetic and reproducible.
- **`systemPrompt`**: the agent's operating instructions.
- **`env`**: sets the provider variables in-process, so you don't have to export them globally. Spread the existing environment first, then override the Anthropic keys.

The SDK carries the model's reasoning across tool-call turns over the Messages surface, so the model keeps the thread of its own thinking through a multi-step loop. See [Reasoning](https://dev.meta.ai/docs/reasoning) for how reasoning is carried across turns.

***

## Build with the OpenAI Codex app-server {#codex-app-server}

[OpenAI Codex](https://developers.openai.com/codex/app-server) is a coding agent whose **app-server** exposes the agent over a JSON-RPC protocol on stdio. You run it as a long-lived process and drive it from your own application, embedding Codex's agent loop behind your own interface. It speaks the OpenAI wire format, so it connects to Model API through the [Responses API](https://dev.meta.ai/docs/protocols/responses).

### Configuration {#codex-app-server-config}

Register Model API as a custom provider with inline `-c key=value` overrides when you launch the server (shown in the [next example](https://dev.meta.ai/docs/agent-frameworks#codex-app-server-run)). The keys that matter:

- **`model_providers.meta.base_url`**: the OpenAI-compatible base, `https://api.meta.ai/v1` (no trailing slash).
- **`model_providers.meta.env_key`**: the environment variable Codex reads the API key from. Codex sends it as `Authorization: Bearer <key>`. Set `MODEL_API_KEY` in the server's environment.
- **`model_providers.meta.wire_api`**: `responses` targets the [Responses API](https://dev.meta.ai/docs/protocols/responses), which carries reasoning across turns for multi-step loops.
- **`model_providers.meta.requires_openai_auth`**: set `false` so Codex authenticates with your API key alone, instead of expecting an OpenAI sign-in.
- **`model` / `model_provider`**: select `muse-wonder-1.0` on the `meta` provider as the default. For lower-cost runs, use `muse-spark-1.3` in the catalog `slug` and both `model` settings.

### Register the model {#codex-model-catalog}

On startup Codex refreshes its model list from the provider's `/v1/models` endpoint and expects a Codex-specific shape. Model API returns the OpenAI-standard list (`{"object":"list","data":[...]}`), so the refresh fails to decode (`missing field 'models'`) and Codex has no model to run. Register the model directly instead.

`-c model_catalog_json` takes the **path** to a JSON catalog file, not the JSON itself. It doesn't have to be a file you keep around: the [example below](https://dev.meta.ai/docs/agent-frameworks#codex-app-server-run) writes the catalog to a temp path at startup and passes that path, so there's nothing to commit.

### Start the app-server {#codex-app-server-run}

Drive the server from your own code. The app-server speaks JSON-RPC over stdin/stdout: spawn `codex app-server`, send `initialize` (then the `initialized` notification), open a thread, and start a turn. The server streams items back as the agent works; the turn is done when a `turn/completed` arrives for your turn id. The provider config and the model catalog ride along as inline `-c` overrides, so there's no config file to manage; the child inherits `MODEL_API_KEY` from your environment.

**JavaScript**

```javascript
import { spawn } from "node:child_process";
import readline from "node:readline";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Register the model so Codex doesn't refresh it from /v1/models (a shape it
// can't decode). Keep the fields that matter to you up top; the rest just
// satisfy Codex's catalog schema, and their defaults are fine as-is.
const modelCatalog = {
  models: [
    {
      // Identity — `slug` must match the `model` you select below.
      slug: "muse-wonder-1.0",
      display_name: "Muse Wonder",
      description: "Meta Model API model.",
      context_window: 1048576,
      max_context_window: 1048576,
      input_modalities: ["text", "image"],
      supports_parallel_tool_calls: true,

      // Reasoning effort levels to offer in Codex.
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balanced reasoning" },
        { effort: "high", description: "Greater reasoning depth" },
        { effort: "xhigh", description: "Extra high reasoning depth" },
      ],

      // Base system prompt Codex sends every turn. Swap in your own harness
      // instructions for better results.
      base_instructions:
        "You are a coding agent operating in a terminal. Use the available tools to read and edit files and run shell commands, and complete the user's task with focused, verified changes.",

      // Schema housekeeping — Codex expects these; the defaults are fine.
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      support_verbosity: true,
      default_verbosity: "low",
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      supports_image_detail_original: true,
      web_search_tool_type: "text_and_image",
      supports_search_tool: false,
      truncation_policy: { mode: "tokens", limit: 120000 },
      effective_context_window_percent: 95,
      additional_speed_tiers: [],
      service_tiers: [],
      experimental_supported_tools: [],
      apply_patch_tool_type: null,
      model_messages: null,
      availability_nux: null,
      upgrade: null,
    },
  ],
};

// Codex reads model_catalog_json as a file path, so write the catalog to a
// temp file and pass that path in the -c overrides below.
const catalogPath = join(tmpdir(), "muse-wonder-catalog.json");
writeFileSync(catalogPath, JSON.stringify(modelCatalog, null, 2));

const proc = spawn(
  "codex",
  [
    "app-server",
    "-c", 'model="muse-wonder-1.0"',
    "-c", 'model_reasoning_effort="xhigh"',
    "-c", 'model_provider="meta"',
    "-c", 'model_providers.meta.name="Meta Model API"',
    "-c", 'model_providers.meta.base_url="https://api.meta.ai/v1"',
    "-c", 'model_providers.meta.env_key="MODEL_API_KEY"',
    "-c", 'model_providers.meta.wire_api="responses"',
    "-c", "model_providers.meta.requires_openai_auth=false",
    "-c", `model_catalog_json="${catalogPath}"`,
  ],
  {
    stdio: ["pipe", "pipe", "inherit"],
    // Codex reads the key from env_key (MODEL_API_KEY); export it before running.
    env: process.env,
  },
);
const rl = readline.createInterface({ input: proc.stdout });

const send = (message) => {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
};

let turnId = null;
let finalText = "";

rl.on("line", (line) => {
  const msg = JSON.parse(line);

  // Thread opened: start a turn.
  if (msg.id === 1 && msg.result?.thread?.id) {
    send({
      method: "turn/start",
      id: 2,
      params: {
        threadId: msg.result.thread.id,
        input: [{ type: "text", text: "Summarize this repo." }],
      },
    });
  }

  // Turn accepted: remember its id so we complete on the right turn.
  if (msg.id === 2 && msg.result?.turn?.id) {
    turnId = msg.result.turn.id;
  }

  // Keep the latest assistant message as items stream in.
  if (msg.method === "item/completed" && msg.params?.item?.type === "agentMessage") {
    finalText = msg.params.item.text ?? finalText;
  }

  // Turn finished: confirm it's ours, check status, then stop.
  if (msg.method === "turn/completed" && msg.params?.turn?.id === turnId) {
    const { status, error } = msg.params.turn;
    if (status !== "completed" || !finalText) {
      throw new Error(`turn ${status}: ${error?.message ?? "no assistant output"}`);
    }
    console.log(finalText);
    rl.close();
    proc.kill();
  }
});

send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: { name: "my_product", title: "My Product", version: "0.1.0" },
    // Skip high-volume token deltas; act on completed items instead.
    capabilities: {
      optOutNotificationMethods: [
        "item/agentMessage/delta",
        "item/reasoning/textDelta",
      ],
    },
  },
});
send({ method: "initialized", params: {} });
send({
  method: "thread/start",
  id: 1,
  params: {
    model: "muse-wonder-1.0",
    cwd: process.cwd(),
    // Headless: never pause for approval; keep writes inside the workspace.
    approvalPolicy: "never",
    sandbox: "workspace-write",
  },
});
```

A few things make this production-shaped rather than a demo:

- **Register the model.** Codex can't decode Model API's `/v1/models` response, so point it at a [catalog file](https://dev.meta.ai/docs/agent-frameworks#codex-model-catalog) rather than relying on the startup refresh.
- **Completion is an event, not the stream ending.** Match `turn/completed` to the `turn.id` you started (a stream can carry more than one turn), read `turn.status`, and treat a completed turn with no assistant text as a failure.
- **Opt out of token deltas.** Suppress `item/*/delta` notifications and act on `item/completed` instead, unless you're rendering a live typing effect.
- **Run headless deliberately.** `approvalPolicy: "never"` stops Codex pausing for confirmation; pair it with a `sandbox` mode (`workspace-write` keeps edits inside `cwd`) so an unattended agent can't roam. See [Production patterns](https://dev.meta.ai/docs/agent-frameworks#production-patterns).

To point an interactive Codex session at Model API instead, run `codex` with the same `-c` flags.

***

## Production patterns {#production-patterns}

Both frameworks drive a long-running agent subprocess. A handful of patterns separate a reliable production agent from a demo, and they apply whichever framework you pick.

- **Wait for the terminal event.** Completion is the `result` message (Claude Agent SDK) or a `turn/completed` matching your turn id (Codex), not the stream going quiet or the process exiting. Treat a run that finishes without a final message as a failure rather than returning an empty result.
- **Set two timeouts.** Pair an overall wall-clock cap with an idle watchdog that resets on every event. The cap bounds a runaway loop; the watchdog catches a silent hang without cutting off a legitimately long turn.
- **Sandbox unattended agents.** Removing the approval step (`permissionMode: "bypassPermissions"` for the Claude SDK, `approvalPolicy: "never"` for Codex) lets the agent act on its own. Run it inside an OS sandbox with a dedicated per-run working directory and a scrubbed, allowlisted environment. Keep the TLS certificate variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) in the allowlist so the agent's own HTTPS calls still work.
- **Give the agent only the tools it needs.** Allowlist tools and declare only the MCP servers you trust; don't inherit ambient user or project configuration. A narrow tool surface is safer and cheaper.
- **Meter cost from the final event.** The `result` message carries token `usage`; read it to track spend. See [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for the quotas in effect.
- **Retry transient stream errors.** Long turns occasionally hit a dropped stream or a `502`. Retry those with backoff. See [Error handling](https://dev.meta.ai/docs/error-handling).

***

## Next steps {#next-steps}

Now that your agent is wired up to Model API, take it further:

- Design the tools your agent calls with the [tool calling](https://dev.meta.ai/docs/tool-calling) guide, including parallel and forced tool use inside a loop.
- Reach for the [Responses API](https://dev.meta.ai/docs/protocols/responses) when you need reasoning to carry across turns in long multi-step sessions.
- Work through the [Cookbook](https://dev.meta.ai/docs/cookbook) for end-to-end agentic recipes you can drop into your own harness.
