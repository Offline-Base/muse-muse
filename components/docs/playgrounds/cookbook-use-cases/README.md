# Cookbook use-case demos

The "Try it live" demos for the cookbook's use-case recipes (lib/docs/demos/cookbook-use-cases.ts). Every component is a client component built on the docs kit (components/docs/kit): calls go through the docs proxy with useDocsRun, Contributor mode is disclosed, errors show in ErrorBox, and "Show code" gives the exact request. Props are plain JSON; the page adds `slug`.

## Components

| Component | Page(s) | What it does | Props |
|---|---|---|---|
| `RecipeBrowser` | cookbook/use-cases | Filters the 14 recipes by capability and harness; one strict-JSON call picks recipes for a described project (slug is an enum of the real ones) | `project?`, `presets?: {label, project}[]` |
| `ComputerUseLab` | computer-use, cookbook/computer-use, cookbook/computer-use-macos | The observe-act loop on a simulated 1280 x 800 screen (lib/cu-sim.ts: sign-up form, tic-tac-toe, a desktop with Mines). Actions are drawn on the screenshot the model saw, applied to the simulator, and a new screenshot goes back. Safety checks wait for Acknowledge. A reply cut off at max_output_tokens (status incomplete, no action) is marked "Cut off" and the same turn goes again with a bigger budget (lib/cu-budget.ts); replay of the native tool stops at 29 calls. cua_run_command answers through lib/mines-shell.ts | `protocol: "computer" \| "cua" \| "metacua"`, `scene?`, `scenes?`, `maxSteps?`, `state?: "server" \| "replay"`, `handoffEvery?` |
| `AlertCopilot` | cookbook/alert-fatigue-copilot | A 42-alert synthetic feed with the recipe's patterns; probe, chat and self-assess with the validator's checks, state files, and a number check against the digest | `sendDigest?`, `enforceSchema?` |
| `ChartAnalysis` | cookbook/perception-chart-analysis | Explain, strict-JSON analysis, verification against the sample's true values (optionally with the printed values covered), a summary card and redrawn chart, follow-ups | `sampleId?`, `coverValues?` |
| `ErrorFix` | cookbook/perception-error-screenshot-fix | Image smoke test; Plan (read, grep, glob, list, question) then Build (edit, write) over a small Next.js repo, with two screenshots by default: the checkout overlay and the cart page drawn by lib/cart-shot.ts, which names no file; diff and the cart.items surfaces | `sampleId?`, `prompt?` |
| `GroundingOverlay` | cookbook/perception-grounding | Points on the 0 to 1000 grid drawn as scored dots with in-frame tooltips and a downloadable self-contained overlay, or the recipe's one-call HTML mode in a sandbox | `sampleId?`, `prompt?`, `presets?`, `mode?` |
| `SlideGenerator` | cookbook/generating-slides | web_search research, a normalized JSON outline shown as a deck, optional model-designed HTML deck, stats | `topic?`, `content?`, `source?` |
| `GithubAgent` | cookbook/github-agent | GitHub events through the recipe's workflows and agents (AGENTS.md, prompts, bash allow-lists) over a sample repo with a fake gh and git | `scenario?` |
| `MultiAgentBoard` | cookbook/multi-agent-orchestration | PM plus backend, frontend and gtm (the recipe's SOULs and toolsets) on a live Kanban board: clarify, brief and runbook, linked tasks, the dispatcher, blocks and comments | `brief?` |
| `OneShotGame` | cookbook/one-shot-game-dev | AGENTS.md as instructions plus the structured prompt, at high effort; plays the single-file game in a sandbox. The 3D build usually reaches the 16,384-token cap, so it continues once on its own (a toggle), then offers Continue | `preset?: "crossy" \| "canvas"`, `effort?` |
| `VerifyLoop` | cookbook/iterative-game-dev, cookbook/browser-verified-web-design | Build, then a browser check in the sandbox (held keys or a mouse path, screenshots, console, snapshot), then a fix round; refinement passes, each with its own check (Pass 3 drives both ways and opens the overview, Pass 4 samples the camera every 100 ms) | `kind: "game" \| "site"`, `effort?` |
| `LookAndAsk` | cookbook/rayban-openclaw | Photo (sample, upload or camera), hold-to-talk transcription, one chat turn with text and image, spoken answer | `sampleId?`, `question?`, `presets?`, `instructions?` |
| `SandboxExec` | cookbook/sandboxed-execution | The recipe's run and write_file scaffold over a JavaScript port of its SWE-bench task; `node` runs in a throwaway sandboxed iframe; the script re-verifies and saves pred.patch | `task?`, `maxCalls?` |
| `GlimmerGate` | cookbook/glimmer-api-agent | A simulated local agent whose consult_remote_model calls stop at an approval gate (exact text, bytes, reason, digest-scoped approvals, timeout); the egress ledger and runs-API events | `scenario?`, `timeoutSec?` |

Shared pieces: `useAgentRun` and `Timeline` (an agent run with model calls, tool runs, notes and questions for the reader, with Pause after each step), `useRetryGuard` (Stop and the wait line for the short multi-call demos), `SandboxFrame` and `sandbox-run.ts` (model-written code in `<iframe sandbox="allow-scripts" srcdoc>` with the harness in lib/harness.ts; `viewport` lays a page out at 1280 x 800 and scales it to the column, and `capture()` waits for a hidden tab to come back and scrolls an off-screen frame into view, since Chrome pauses animation frames in both), and `prompts.ts` (the copy-prompt specs).

## Pure modules (lib/)

`agent.ts` (the Responses tool loop, server state or stateless replay; a replayed computer_call keeps its status and receipt), `responses.ts`, `strict-json.ts`, `vfs.ts`, `repo-tools.ts`, `retry.ts` and `pace.ts` (see below), `harness.ts` (its probes include `sample`, which logs a page value on a timer while keys are held), and one module per recipe (`alerts`, `chart`, `grounding-overlay`, `slides`, `github`, `github-sim`, `kanban`, `kanban-run`, `cu-sim`, `cu-protocols`, `cu-budget`, `mines-shell`, `gamedev`, `sandbox-exec`, `glimmer`, `error-fix`, `cart-shot`, `recipes`).

## Rate limits

Production allows 20 live runs a minute per network, and the long demos (the board, the GitHub agent, the sandbox, error fix, computer use) make 15 to 80 calls. Every multi-step call goes through `withRetries` (lib/retry.ts), which:

- paces calls 60 / limit seconds apart with the tab's pacer (lib/pace.ts; the limit comes from `GET /api/docs/limits`, free and uncounted, so a local server with a higher limit runs at full speed), so a run on its own stays under the limit;
- waits out a 429 whose retry-after is a minute or less (the per-minute window, a busy model, calls in flight), up to three times, with a line in the timeline or under Run; a longer one (the day's runs, an hour's uploads) and budget errors end the run;
- retries 500, 502, 503 and 504 twice with a backoff;
- stops at once when the reader presses Stop, even mid-wait, without sending the call again.

`__tests__/fixes.test.ts` runs a 44-call run against a fake proxy that allows 20 calls a calendar minute: no refusals, and 429s caused elsewhere are waited out.

## Tests

`npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-use-cases/__tests__/*.test.ts components/docs/playgrounds/cookbook-use-cases/__tests__/*.test.tsx`

The copy prompts (prompts.ts) have starter code in all three languages for every page, each runnable as given (it creates its own client; what the reader supplies is a named parameter or a marked placeholder), and each prompt fits the 4,000-character cap untrimmed for every agent; render.test.tsx checks both.

fixtures/replies.json holds small real replies from Oct 30, 2026 (opaque receipts, encrypted reasoning and safety identifiers removed).
