# Cookbook {#cookbook}

Recipes for building with Muse models, from your first API call to complete solutions.

## Meta Model API {#meta-model-api}

Learn how to build on Meta Model API. Each recipe solves a specific problem with ready code samples you can copy to follow along. Start with API fundamentals to nail the primitives of prompt and response usage with Muse models, then explore how to use other models like Muse Image, Muse Voice Transcribe and Segment Anything Model.

[View on GitHub](https://github.com/meta-models/meta-model-cookbook)

### API fundamentals {#api-fundamentals}

Validate one building block at a time and walk away with a starter you can extend.

- [Quickstart: chat completions](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions): Point the OpenAI SDK at a new base URL and make your first Muse Spark call.
- [Streaming responses](https://dev.meta.ai/docs/cookbook/streaming-responses): Stream tokens as they generate and read usage in the final chunk.
- [Tool and function calling](https://dev.meta.ai/docs/cookbook/tool-function-calling): Detect a tool call, execute it, and feed the result back into the loop.
- [Structured output](https://dev.meta.ai/docs/cookbook/structured-output): Return JSON that matches your schema and parses on the first try.
- [Prompt caching](https://dev.meta.ai/docs/cookbook/prompt-caching): Reuse a stable prompt prefix and measure cached tokens.
- [Reasoning and thinking tokens](https://dev.meta.ai/docs/cookbook/reasoning-thinking-tokens): Set reasoning effort and replay reasoning across turns.
- [Vision input](https://dev.meta.ai/docs/cookbook/vision-input): Send images by URL or base64 and get structured analysis back.
- [Long context](https://dev.meta.ai/docs/cookbook/long-context): Pack repo-scale context into a single context window.
- [Error handling and retry](https://dev.meta.ai/docs/cookbook/error-handling-retry): Back off with jitter and skip retries on client errors.
- [Search grounding](https://dev.meta.ai/docs/cookbook/search-grounding): Ground answers in live web search with inline citations.

### Agent patterns {#agent-patterns}

Turn a model into an agent. These loops handle planning, self-correction, and staying coherent across long runs.

- [Basic agent loop](https://dev.meta.ai/docs/cookbook/basic-agent-loop): Wire up the core perceive-decide-act loop.
- [Interleaved reasoning and tool use](https://dev.meta.ai/docs/cookbook/interleaved-reasoning-tool-use): Interleave reasoning with tool calls in a single turn.
- [Multi-turn context management](https://dev.meta.ai/docs/cookbook/multi-turn-context-management): Keep context under control across a long agent run.
- [Search-and-replace edits](https://dev.meta.ai/docs/cookbook/search-and-replace-edits): Make exact-match file edits that stay reviewable.
- [Alert fatigue copilot](https://dev.meta.ai/docs/cookbook/alert-fatigue-copilot): Pull grounded patterns from noisy alerts, then probe, chat, and self-assess with strict JSON.

### Use cases {#use-cases}

Build end-to-end: multimodal perception, orchestration, and complete apps you can adapt.

- [Chart analysis](https://dev.meta.ai/docs/cookbook/perception-chart-analysis): Read charts and extract structured data from images.
- [Error screenshot fix](https://dev.meta.ai/docs/cookbook/perception-error-screenshot-fix): Diagnose a bug from a screenshot and ship the fix.
- [Smart glasses with OpenClaw](https://dev.meta.ai/docs/cookbook/rayban-openclaw): Look, ask out loud, and hear the answer — hands-free on Ray-Ban Meta glasses.
- [Generating slides](https://dev.meta.ai/docs/cookbook/generating-slides): Generate a slide deck from a prompt or source content.
- [Browser-verified web design](https://dev.meta.ai/docs/cookbook/browser-verified-web-design): Build a website with a coding agent that checks its own work in a real browser.
- [Iterative game dev](https://dev.meta.ai/docs/cookbook/iterative-game-dev): Build a browser game end-to-end with a coding agent, verified in a real browser.
- [Sandboxed execution](https://dev.meta.ai/docs/cookbook/sandboxed-execution): Execute model-generated code in a sandbox.
- [Multi-agent orchestration](https://dev.meta.ai/docs/cookbook/multi-agent-orchestration): Orchestrate a team of specialists that coordinate through a shared Kanban board.
- [One-shot game dev](https://dev.meta.ai/docs/cookbook/one-shot-game-dev): Build a complete 3D browser game in one pass — one structured prompt, no iteration loop.
- [Perception grounding](https://dev.meta.ai/docs/cookbook/perception-grounding): Pin interactive dots at object pixel locations and generate a self-contained HTML overlay.
- [GitHub agent](https://dev.meta.ai/docs/cookbook/github-agent): Run an autonomous GitHub Actions bot for triage, PR review, and bug-fix PRs on OpenCode and Muse Spark.
- [Computer use](https://dev.meta.ai/docs/cookbook/computer-use): Control a desktop from screenshots with a computer-use agent.
- [Computer use on macOS](https://dev.meta.ai/docs/cookbook/computer-use-macos): Drive a real Mac from screenshots with native mouse and keyboard events.
- [Local agent that asks first](https://dev.meta.ai/docs/cookbook/glimmer-api-agent): Run Muse Glimmer locally and escalate to Muse Spark only after you approve the text the tool is about to send.

### Building with Muse Code {#building-with-muse-code}

Build durable, auditable agents with Muse Code — the harness building blocks for safety, recovery, and orchestration.

- [Audit and resume agent sessions](https://dev.meta.ai/docs/cookbook/audit-agent-sessions): Replay any session exactly as it ran from an append-only event log, show who authorized each action, then kill the run mid-task and resume with no duplicate side effects.
- [Deterministic replay in CI](https://dev.meta.ai/docs/cookbook/deterministic-replay): Turn recorded events into a golden fixture and replay its model-context projection as a merge-blocking CI check.
- [Staged approvals](https://dev.meta.ai/docs/cookbook/staged-approvals): Split a compound shell command into stages so safe ones auto-resolve while risky ones hold for review.
- [Contained execution](https://dev.meta.ai/docs/cookbook/contained-execution): Run every command in an OS sandbox that refuses to proceed unless containment is proven live.
- [Immutable guardrails](https://dev.meta.ai/docs/cookbook/immutable-guardrails): The agent can't rewrite its own rules: guardrail edits stop for review and a shell write to the same path fails read-only at the sandbox.
- [Subagent fanout](https://dev.meta.ai/docs/cookbook/subagent-fanout): Fan one job out to parallel subagents, each in its own isolated git worktree.
- [Goal tracking](https://dev.meta.ai/docs/cookbook/goal-tracking): Pin an objective once and the harness audits the work against acceptance checks before the goal can close.
- [Bundled skills](https://dev.meta.ai/docs/cookbook/bundled-skills): Drive the built-in /plan, /grilling, /grill-with-docs, and /taste skills to plan, pressure-test, and build.
- [Loop and cron](https://dev.meta.ai/docs/cookbook/loop-and-cron): Schedule recurring or one-time agent work in natural language, then view, change, or cancel it from the same chat.
- [Side chats](https://dev.meta.ai/docs/cookbook/side-chats): Branch off the main thread for a side conversation that never enters the main history.

### Muse Image {#muse-image}

Use [Muse Image](https://dev.meta.ai/docs/models#muse-image) to generate, edit, or combine images. Choose a recipe based on whether you need web grounding, consistency across a series, or multi-turn editing.

- [Generate, edit, and compose images](https://dev.meta.ai/docs/cookbook/image-generation-basics): Generate an image, refine it across turns, or combine it with new reference images.
- [Ground image generation with web search](https://dev.meta.ai/docs/cookbook/search-grounded-image-generation): Use web references when an image should reflect current products, places, or styles. Verify factual details independently.
- [Keep an image series consistent](https://dev.meta.ai/docs/cookbook/anchored-image-series): Use reference images to improve character, style, and setting consistency across a series. Compare each output with the references.
- [Edit image details across turns](https://dev.meta.ai/docs/cookbook/image-editing-with-reasoning): Edit one part of a photo, then refine the result across turns. Check that unchanged areas still match the source.

### Muse Voice Transcribe {#muse-voice-transcribe}

Use [Muse Voice Transcribe](https://dev.meta.ai/docs/models#muse-voice-transcribe) to turn speech into text — streaming over a WebSocket while the speaker is still talking, or in one HTTP request for a recording you already have. The model handles punctuation, speech-boundary detection, and speaker attribution itself.

- [Speech to text](https://dev.meta.ai/docs/cookbook/voice-api-fundamentals): Transcribe a recording or a live microphone over the streaming WebSocket, get speaker-attributed turns with diarization, or post a whole recording in one HTTP request.
- [Control Apple Chess with voice](https://dev.meta.ai/docs/cookbook/voice-chess-cua): Turn exact spoken chess moves into locally validated Apple Chess actions with a passive HUD, calibrated grid, dry-run mode, and fail-closed native input.

### Segment Anything Model {#sam}

Use [Segment Anything Model](https://dev.meta.ai/docs/models#sam-3) to find and cut out objects in images and video from a short noun phrase. SAM 3.1 returns a box and a pixel mask for every match, and holds each object's identity across a whole clip, so a recipe can track and composite without per-frame bookkeeping.

- [SAM API basics](https://dev.meta.ai/docs/cookbook/sam-api-basics): Segment an image or an uploaded video in Python or TypeScript, streaming the response and parsing it with the official meta-sam parsers.
- [Video to animated stickers](https://dev.meta.ai/docs/cookbook/video-to-sticker-pack): Track an animal through a clip, cut the background from its longest-lived track, and export transparent animated stickers.
- [Multi-speaker headlocked captions](https://dev.meta.ai/docs/cookbook/headlocked-speech-bubble-captions): Match diarized voices to SAM-tracked people, preview collision-aware speech bubbles, and download the captioned video.

## Open-weight models {#open-weight-models}

Run Muse models yourself with the [open weights](https://dev.meta.ai/docs/open-weight-models), on hardware you control.

[View on GitHub](https://github.com/meta-models/meta-oss-cookbook)

### Run locally {#run-locally}

Serve a Muse open-weight model on your own machines, step by step.

- [Muse Spark Open on Mac](https://dev.meta.ai/docs/cookbook/muse-spark-open-mac): Run Muse Spark Open on two or four Mac Studios.

### Post-training {#post-training}

Fine-tune a Muse open-weight model on your own data, step by step.

- [RL with TorchTitan](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl): GRPO with the DAPO loss on a task you plug in, starting from DAPO-Math.
- [SFT with TorchTitan](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft): Full-parameter SFT on your own text, image, and audio conversations.
