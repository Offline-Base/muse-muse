# Use Model API with coding agents {#use-model-api-with-coding-agents}

Meta Model API works with the coding agents you already use. OpenAI-compatible agents connect to the endpoint at `https://api.meta.ai/v1` (Responses or Chat Completions); Anthropic-format agents like Claude Code connect through the [Messages API](https://dev.meta.ai/docs/protocols/messages) at `https://api.meta.ai`. Either way, [Muse Wonder](https://dev.meta.ai/docs/models#muse-wonder) or [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) drives your agentic workflows — file edits, shell commands, tool calls, and multi-step coding loops. The Codex and Claude Code configs below run the main loop on Muse Wonder, Meta's most capable model, built for complex software engineering and long-horizon agentic work.

This guide covers the general setup pattern and then shows concrete configuration for three popular terminal agents: [OpenCode](https://dev.meta.ai/docs/coding-agents#setup-opencode) (OpenAI-compatible), [Codex](https://dev.meta.ai/docs/coding-agents#setup-codex) (Responses API), and [Claude Code](https://dev.meta.ai/docs/coding-agents#setup-claude-code) (Anthropic Messages).

## Start with Muse Code {#muse-code}

Muse Code is Meta's first-party coding agent for the terminal and CI, built on Muse Spark. It needs no provider config: install it, run `muse`, and start building. Use it when you want a ready-made agent that runs the model directly.

The rest of this guide connects third-party agents to Model API. To use Meta's own agent instead, see the [Muse Code overview](https://dev.meta.ai/docs/muse-code).

## Quickstart {#quickstart}

Two steps to start coding on Muse Spark:

**Step 1: Get an API key.** Generate one in the [Model API dashboard](https://dev.meta.ai/), then export it:

```shell
export MODEL_API_KEY="<your-model-api-key>"
```

**Step 2: Paste this into your coding agent.** OpenCode and other self-configuring agents (Goose, Roo, and more) register a provider straight from a prompt. In a session running on your current model, paste:

```text
Add a new provider to my config for Meta Model API:
- Provider key: "meta", display name "Meta Model API"
- npm adapter: "@ai-sdk/openai" (targets the Responses API)
- Base URL: https://api.meta.ai/v1
- Model: "muse-spark-1.3"
- Reasoning: true, with reasoningEffort "high", reasoningSummary "auto", and include ["reasoning.encrypted_content"]
- Limits: context 1048576, output 131072
- Modalities: input ["text", "image", "pdf", "video"], output ["text"]
- Read the key from the MODEL_API_KEY environment variable
```

Select `muse-spark-1.3` and start coding. That's it.

Driving [Codex](https://dev.meta.ai/docs/coding-agents#setup-codex) or [Claude Code](https://dev.meta.ai/docs/coding-agents#setup-claude-code), or prefer to write the config yourself? The per-agent setup below has copy-paste configs and notes for each.

## How it works {#how-it-works}

Coding agents act as orchestrators: they take a high-level instruction, decompose it into tool calls (read file, edit file, run command), and loop until the task is complete. Model API provides the inference backend: the agent sends prompts and tool definitions, the model returns completions and tool-call requests.

The connection requires three things:

1. **Base URL**: `https://api.meta.ai/v1`
2. **API key**: your Model API key (generate one at [dashboard](https://dev.meta.ai/))
3. **Model ID**: `muse-wonder-1.0` for complex, long-running coding work, or `muse-spark-1.3` for faster, lower-cost work ([choose between them](https://dev.meta.ai/docs/models#choose-muse-wonder-or-muse-spark))

Most OpenAI-compatible agents surface these as "custom provider" or "OpenAI-compatible" settings. Anthropic-format agents like Claude Code connect through the [Messages API](https://dev.meta.ai/docs/protocols/messages) at `https://api.meta.ai` instead; see [Set up Claude Code](https://dev.meta.ai/docs/coding-agents#setup-claude-code).

## Choosing an API surface {#api-surface}

Model API offers two OpenAI-compatible surfaces (Responses and Chat Completions) plus an Anthropic-compatible surface (Messages). Which one your coding agent uses depends on the agent's implementation:

| API surface                                   | What it supports                                                                            | Agent support                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Responses API** (`/v1/responses`)           | Text, images, PDFs (`input_file`), video (`input_video`), server-managed conversation state | Agent must explicitly target it                       |
| **Chat Completions** (`/v1/chat/completions`) | Text, images (`image_url`), PDFs (`file` content parts), tool calling, streaming            | Universal (all OpenAI-compatible agents support this) |
| **Messages** (`/v1/messages`)                 | Text, images, PDFs, video, tool calling, streaming (Anthropic wire format)                  | Anthropic-format agents such as Claude Code           |

Most coding agents default to Chat Completions when connecting to a custom OpenAI-compatible provider. This is the safest starting point: it handles text generation, image understanding (via `image_url` content parts), inline document input (via `file` content parts), tool calling, and streaming out of the box. The Responses API adds video input (`input_video`), server-side file fetching, and server-managed conversation state. Anthropic-format agents like Claude Code use the [Messages API](https://dev.meta.ai/docs/protocols/messages) instead.

> **NOTE: Surface is auto-selected**
>
> You don't need to choose manually in most cases. Your agent's provider configuration determines which surface is used. The guidance below calls out where the choice matters.

## Core capabilities {#core-capabilities}

Once connected, Muse Spark drives the standard agent loop regardless of which agent you use:

- **File operations**: Read, create, and edit files in your workspace
- **Shell commands**: Run builds, tests, git operations, and arbitrary commands
- **Tool calling**: Invoke agent-defined tools (function calling over Chat Completions)
- **Multi-step reasoning**: Plan and execute complex tasks across multiple turns

## Multimodal input {#multimodal-input}

Support for images, PDFs, and video depends on how the agent handles media attachments:

| Input type | Via Responses API          | Via Chat Completions                                                          |
| ---------- | -------------------------- | ----------------------------------------------------------------------------- |
| **Images** | ✓ Direct paste/upload      | ✓ Native: pass as `image_url` content parts (base64 or URL)                   |
| **PDFs**   | ✓ Native via `input_file`  | ✓ Native: pass as a `file` content part (inline base64 or uploaded `file_id`) |
| **Video**  | ✓ Native via `input_video` | Not available on this surface; use the Responses API                          |

Images and PDFs are accepted on both surfaces: Responses API takes them as `input_image` and `input_file`, and Chat Completions as `image_url` and `file` content parts. Video is Responses-only, via `input_video`. The Responses API also adds server-side file handling, such as fetching a document from a URL or referencing one uploaded through the [Files API](https://dev.meta.ai/docs/file-handling).

If media doesn't reach the API, it's almost always a client-side configuration issue, not an API limitation. Two things to get right in your harness:

1. **Use the SDK connector that matches the surface you want**: `@ai-sdk/openai` targets the Responses API; `@ai-sdk/openai-compatible` targets Chat Completions.
2. **Declare the model's modalities accurately**: set `input: ["text", "image", "pdf", "video"]`. Some agents strip image or file parts from a request when a custom provider is missing that modality metadata, so an accurate connector-plus-modalities setup keeps your attachments intact.

***

## Set up OpenCode {#setup-opencode}

[OpenCode](https://opencode.ai/) is a terminal-based coding CLI. It supports multiple AI SDK adapters, giving you a choice between Chat Completions and the Responses API.

### Configuration {#opencode-config}

OpenCode can configure itself. Launch it with your default model active, then ask the model to register Model API as a new provider. Alternatively, edit the config file directly.

**Option A: Self-configuration**

Launch OpenCode with your default model active, then paste this prompt:

```text
Add a new provider to my opencode.json config with the following details:
- Provider key: "meta"
- Provider name: "Meta Model API"
- npm adapter: "@ai-sdk/openai"
- Base URL in options: "https://api.meta.ai/v1"
- Model key: "muse-spark-1.3" with name "muse-spark-1.3"
- Capabilities: reasoning = true
- Limits: context = 1048576, output = 131072
- Modalities: input = ["text", "image", "pdf", "video"], output = ["text"]
- Model options: reasoningEffort = "high", reasoningSummary = "auto", include = ["reasoning.encrypted_content"]
```

Once OpenCode writes the config, run `/connect`, select the `meta` provider, and supply your API key when prompted. Restart OpenCode and select Muse Spark.

**Option B: Manual config**

Add this block to your `opencode.json`:

**opencode.json: Responses API adapter (recommended)**

```json
{
  "provider": {
    "meta": {
      "name": "Meta Model API",
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "https://api.meta.ai/v1"
      },
      "models": {
        "muse-spark-1.3": {
          "name": "muse-spark-1.3",
          "reasoning": true,
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "modalities": {
            "input": ["text", "image", "pdf", "video"],
            "output": ["text"]
          },
          "options": {
            "reasoningEffort": "high",
            "reasoningSummary": "auto",
            "include": ["reasoning.encrypted_content"]
          }
        }
      }
    }
  }
}
```

The `include: ["reasoning.encrypted_content"]` setting is what carries Muse Spark's reasoning across turns. OpenCode replays the encrypted blob on every subsequent request, so the model retains its prior reasoning during multi-step tool loops and during OpenCode's automatic context compaction. Without it, Muse Spark loses its own reasoning between calls. See [Reasoning items in multi-turn input](https://dev.meta.ai/docs/protocols/responses#reasoning-items) for the underlying mechanism.

If you don't need reasoning continuity or native PDF input, the simpler `@ai-sdk/openai-compatible` adapter is available as a fallback (Chat Completions, no encrypted-reasoning replay). Image input still works: OpenCode forwards `read`-attached images as `image_url` parts on this adapter too.

**opencode.json: Chat Completions adapter (fallback)**

```json
{
  "provider": {
    "meta": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Meta Model API",
      "options": {
        "baseURL": "https://api.meta.ai/v1"
      },
      "models": {
        "muse-spark-1.3": {
          "name": "muse-spark-1.3",
          "limit": {
            "context": 1048576,
            "output": 131072
          }
        }
      }
    }
  }
}
```

> **NOTE: Store keys via /connect**
>
> Store your API key via `/connect`, not in the config file. If you must set it inline for local testing, use `options.apiKey`, but never commit a real key.

After editing, restart OpenCode for the new provider to take effect.

### Supported features {#opencode-supported-features}

| Capability                      | Responses API adapter                        | Chat Completions adapter                                                  |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Chat and Q\&A                   | ✓                                            | ✓                                                                         |
| File read/edit/create           | ✓                                            | ✓                                                                         |
| Shell commands                  | ✓                                            | ✓                                                                         |
| Image input                     | ✓ Direct paste                               | ✓ Forwarded via `read` (file path)                                        |
| PDF input                       | ✓ Direct paste                               | Not attached over this adapter (use `@ai-sdk/openai`)                     |
| Local TypeScript tools          | ✓                                            | ✓                                                                         |
| MCP server tools                | ✓                                            | ✓                                                                         |
| Cross-turn reasoning continuity | ✓ Encrypted reasoning replayed automatically | ⚠️ **Not preserved** — each turn reasons from scratch (see warning below) |

> **WARNING: Reasoning across turns**
>
> The Chat Completions adapter (`@ai-sdk/openai-compatible`) does not preserve Muse Spark's reasoning across turns. Each turn reasons from scratch, so in multi-step and agentic loops the model can lose the thread of its own prior thinking and behave erratically: repeating work it already did, contradicting earlier steps, or dropping task context mid-loop. This is the single biggest reason to prefer the Responses API adapter (`@ai-sdk/openai`), which requests encrypted reasoning (`include: ["reasoning.encrypted_content"]`) and replays it automatically. See the [reasoning guide](https://dev.meta.ai/docs/reasoning#multi-turn) for how reasoning is carried across turns on each surface.

### OpenCode-specific notes {#opencode-notes}

- **Two adapters, different tradeoffs.** `@ai-sdk/openai` is the recommended adapter: it enables direct multimodal input (including PDF) and replays encrypted reasoning across turns, so Muse Spark retains its prior reasoning during tool loops and compaction. `@ai-sdk/openai-compatible` is simpler to configure and still forwards `read`-attached images as `image_url` parts, but doesn't attach PDFs over this adapter (use `@ai-sdk/openai` for PDF input) and does not replay encrypted reasoning.
- **Local tools are straightforward.** Drop TypeScript files in `.opencode/tools/` and the model discovers and invokes them automatically.
- **Restart required after config changes.** OpenCode requires a full restart to load new provider registrations.

***

## Set up Codex {#setup-codex}

[Codex](https://github.com/openai/codex) is OpenAI's open-source terminal coding agent. It drives the model over the [Responses API](https://dev.meta.ai/docs/protocols/responses), so reasoning carries across turns automatically.

### Configuration {#codex-config}

Register Model API as a provider in your `config.toml` and point the default model at it:

**\~/.codex/config.toml**

```toml
model = "muse-wonder-1.0"
model_provider = "meta"
model_reasoning_effort = "high"           # none | minimal | low | medium | high | xhigh | max
model_reasoning_summary = "auto"
model_context_window = 1048576            # 1M-token context
model_supports_reasoning_summaries = true
model_auto_compact_token_limit = 900000

[model_providers.meta]
name = "Meta Model API"
base_url = "https://api.meta.ai/v1"
env_key = "MODEL_API_KEY"
wire_api = "responses"
```

- **`model` / `model_provider`**: select `muse-wonder-1.0`, served by the `meta` provider block below. For faster, lower-cost sessions, set `model = "muse-spark-1.3"` instead.
- **`base_url`**: the Model API base (`https://api.meta.ai/v1`, no trailing slash).
- **`env_key`**: the environment variable Codex reads your key from. Codex sends it as `Authorization: Bearer <key>`.
- **`wire_api = "responses"`**: drives the model over the Responses API, which replays reasoning across turns.
- **`model_reasoning_effort`**: `high` is a strong default; `xhigh` and `max` offer deeper reasoning (`max` is available on `muse-wonder-1.0` and `muse-spark-1.3`, but not `muse-spark-1.3-contributor`). See [Reasoning](https://dev.meta.ai/docs/reasoning).

Export your key and launch:

```shell
export MODEL_API_KEY="<your-model-api-key>"

codex                                  # interactive
codex exec "fix the failing test"      # non-interactive
echo "explain this chart" | codex exec -i chart.png   # image input
```

To keep this separate from an existing Codex install, set `CODEX_HOME` to a dedicated directory before launching so Codex reads its config and state from there. You can skip the `config.toml` entirely and run fully self-contained by pointing `CODEX_HOME` at a scratch directory and passing the provider settings inline with `-c`:

```shell
export MODEL_API_KEY="<your-model-api-key>"
mkdir -p /tmp/codex-modelapi

CODEX_HOME=/tmp/codex-modelapi codex \
  -m muse-wonder-1.0 \
  -c 'model_provider="meta"' \
  -c 'model_providers.meta.name="Meta Model API"' \
  -c 'model_providers.meta.base_url="https://api.meta.ai/v1"' \
  -c 'model_providers.meta.env_key="MODEL_API_KEY"' \
  -c 'model_providers.meta.wire_api="responses"' \
  -c 'model_reasoning_effort="xhigh"'
```

Because `CODEX_HOME` holds all of Codex's config, auth, and history, this run stays isolated from your `~/.codex` setup — useful for trying Model API next to an existing Codex install without touching it.

> **NOTE: Log out of OpenAI first**
>
> If you're already signed into Codex with an OpenAI account, run `/logout` first so it uses the `meta` provider instead of your OpenAI credentials.

### Supported features {#codex-supported-features}

| Capability            | Status | Notes                                                 |
| --------------------- | ------ | ----------------------------------------------------- |
| Chat and streaming    | ✓      | Native Responses API (`POST /v1/responses`)           |
| File read/edit/create | ✓      | Via `apply_patch`                                     |
| Shell commands        | ✓      | Via `exec_command`                                    |
| Tool calling          | ✓      | Function tools over the Responses `tools` interface   |
| Reasoning effort      | ✓      | `model_reasoning_effort`, including `xhigh` and `max` |
| Image input           | ✓      | Attach with `-i` (see usage above)                    |
| 1M context            | ✓      | `model_context_window = 1048576`                      |

### Codex-specific notes {#codex-notes}

- **Responses API only.** Codex uses `wire_api = "responses"`; reasoning is carried across turns automatically.
- **Default sampling.** Codex sends no `temperature` or `top_p`, so the API defaults apply (both `1.0`).
- **Automatic compaction.** `model_auto_compact_token_limit` triggers Codex's compaction before you reach the 1M-token window.

***

## Set up Claude Code {#setup-claude-code}

[Claude Code](https://www.anthropic.com/claude-code) is Anthropic's terminal-based coding agent. It speaks the Anthropic Messages format, so it connects to Model API through the [Messages API](https://dev.meta.ai/docs/protocols/messages) rather than an OpenAI-compatible surface.

### Configuration {#claude-code-config}

Claude Code reads its provider settings from environment variables. Set these, then launch `claude`:

```shell
export ANTHROPIC_BASE_URL="https://api.meta.ai"
export ANTHROPIC_AUTH_TOKEN="$MODEL_API_KEY"
export ANTHROPIC_MODEL="muse-wonder-1.0"
export ANTHROPIC_DEFAULT_OPUS_MODEL="muse-wonder-1.0"
export ANTHROPIC_DEFAULT_SONNET_MODEL="muse-spark-1.3"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="muse-spark-1.3"
export CLAUDE_CODE_SUBAGENT_MODEL="muse-spark-1.3"
export ENABLE_TOOL_SEARCH="true"
```

- **`ANTHROPIC_BASE_URL`**: the Model API base host. Claude Code appends `/v1/messages`.
- **`ANTHROPIC_AUTH_TOKEN`**: your Model API key. Claude Code sends it as `Authorization: Bearer <key>`, which is how Model API authenticates. Use this rather than `ANTHROPIC_API_KEY`, which sends an `x-api-key` header instead.
- **`ANTHROPIC_MODEL`**: the model for the main agent loop. `muse-wonder-1.0` plans the work and makes the multi-file changes.
- **`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`**: the models Claude Code uses when work routes through the `opus`, `sonnet`, or `haiku` alias instead of `ANTHROPIC_MODEL`. Claude Code resolves a model this way in several situations — Plan Mode and multi-agent (subagent) workflows lean on the `opus`/`sonnet` tiers, and `haiku` backs lightweight background tasks such as commit messages and summaries. Point all three at a model Model API serves (see [Models](https://dev.meta.ai/docs/models)); otherwise those paths try to reach a Claude model Model API doesn't serve. This config sends the `opus` tier to `muse-wonder-1.0` and the `sonnet` and `haiku` tiers to the lower-cost `muse-spark-1.3`. (Older Claude Code versions read the deprecated `ANTHROPIC_SMALL_FAST_MODEL` for the background model.)
- **`CLAUDE_CODE_SUBAGENT_MODEL`**: the model Claude Code runs subagents with. Subagents take many short, focused tasks, so this config pins them to the lower-cost `muse-spark-1.3`; pinning also keeps subagent and orchestration workflows on Model API instead of falling back to a Claude model.
- **`ENABLE_TOOL_SEARCH`**: Claude Code disables MCP tool search for non-first-party hosts by default. Set it to `true` to keep tool search on.

To run everything on one model, set all five model variables to the same ID. To persist the configuration, add the exports to your shell profile (`~/.bashrc` or `~/.zshrc`).

### Supported features {#claude-code-supported-features}

| Capability            | Status | Notes                                                                |
| --------------------- | ------ | -------------------------------------------------------------------- |
| Chat and Q\&A         | ✓      |                                                                      |
| File read/edit/create | ✓      |                                                                      |
| Shell commands        | ✓      |                                                                      |
| Tool calling          | ✓      | Claude Code's built-in tools run over the Messages `tools` interface |
| Image input           | ✓      | Via Messages image content blocks                                    |
| PDF input             | ✓      | Via Messages document content blocks                                 |
| MCP server tools      | ✓      | Set `ENABLE_TOOL_SEARCH=true` (see above)                            |

### Claude Code-specific notes {#claude-code-notes}

- **Anthropic surface, not OpenAI.** Claude Code connects through the [Messages API](https://dev.meta.ai/docs/protocols/messages); it does not use the Chat Completions or Responses surfaces. The base host is `https://api.meta.ai` with no `/v1` suffix — the client appends `/v1/messages`.
- **Use bearer auth.** Set `ANTHROPIC_AUTH_TOKEN` (bearer), not `ANTHROPIC_API_KEY` (`x-api-key`).
- **Pin every model alias.** Model API serves Meta's models (not Claude models), but Claude Code selects a model through `ANTHROPIC_MODEL`, the `opus`/`sonnet`/`haiku` aliases, and `CLAUDE_CODE_SUBAGENT_MODEL` depending on the task. Set every one to a Model API model, as in the config above, so no path — background tasks, Plan Mode, or subagents — falls back to a Claude model Model API doesn't serve.
- **Stateless history.** The Messages adapter runs stateless (no server-managed conversation state); Claude Code keeps history on the client, so multi-turn sessions work normally.

***

## API key management {#api-key-management}

Store your Model API key in your agent's secure credential store or an environment variable such as `MODEL_API_KEY`, and read it from there at runtime. Keep it out of config files that get committed to source control.

When an agent offers both inline and referenced keys, prefer the referenced form: OpenCode's `/connect` credential store, or Claude Code's `ANTHROPIC_AUTH_TOKEN` environment variable. That keeps the secret off disk in plaintext. For how to create, rotate, and scope keys, see [Authentication](https://dev.meta.ai/docs/authentication).

## Cost tracking {#cost-tracking}

Most coding agents display token spend, but custom providers often lack pricing metadata, so your agent may show a $0 cost. That reflects missing per-token rate configuration in the agent, not an error. For the quotas that apply, see [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits).

## Troubleshooting {#troubleshooting}

| Symptom                          | Likely cause                                 | Fix                                                                                                                                     |
| -------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "Model not found" or 404         | Wrong model ID or trailing slash in base URL | Use a Model API model ID such as `muse-wonder-1.0` or `muse-spark-1.3`; base URL should be `https://api.meta.ai/v1` (no trailing slash) |
| Agent says "I can't view images" | Media stripped before reaching the API       | Check that your agent passes image content parts; enable modality declarations if available                                             |
| Duplicate tool calls             | Transient streaming glitch                   | Restart with fresh context; not a systematic bug                                                                                        |
| Tools not invoked                | Agent doesn't know about tools               | Verify tool definitions are registered (MCP server running, local tool files present)                                                   |
| Cost shows $0                    | No pricing metadata for custom provider      | Expected when the custom provider has no pricing metadata; optionally configure indicative rates in your agent's model settings         |

## Next steps {#next-steps}

Now that your coding agent is wired up to Muse Spark, put it to work:

- Work through the [Cookbook](https://dev.meta.ai/docs/cookbook) for end-to-end agentic recipes you can drop into your own harness.
- Wire up [tool calling](https://dev.meta.ai/docs/tool-calling) to see how Muse Spark handles parallel and forced tool use inside a loop.
- Reach for the [Responses API](https://dev.meta.ai/docs/protocols/responses) when you need reasoning to carry across turns in long multi-step sessions.
