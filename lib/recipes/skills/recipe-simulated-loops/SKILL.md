---
name: recipe-simulated-loops
description: Use for a long agent loop that acts on a simulated world, such as computer use on a simulated screen, fixing a bundled project, a role-based team board, a simulated robot arm, an approval gate, or staged command approvals.
---

# Simulated loops

These products run a real model loop against a simulated world, and say so on the page. Product code and tests name `muse-wonder-1.0` and nothing else: a test build runs those calls on a cheaper model by itself, and a token refuses that model by name. Most tests use a scripted model. The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

## Running long

A route lasts at most 300 seconds, and one run needs many turns, so:

- **Stretches.** The page drives the run with repeated POSTs. Each one starts no new model call after about 200 seconds, so a slow call still ends before the route's limit, then returns.
- **Run id.** Send one `x-musemuse-run-id` header, with a fresh id per run, on every model call, so the gateway counts the whole run together. It stops a long run at 80 turns, 120 tool calls or $15, and a build's test run at 30 turns, 40 tool calls or $1.50, so the smoke test can run one real run on the sample to its end. Set lower ceilings in your own code, and handle a refusal as a saved pause, never a crash.
- **Sealed record.** State goes to the browser as a sealed record: AES-256-GCM with `node:crypto`, using a key hashed from `gatewayEnv().apiKey` and a fixed label. The server opens and checks it on every stretch, and refuses anything altered. Never send the key to the browser. If a record won't open, say the run can't resume and offer a new one.
- **Saving.** Keep the latest record in IndexedDB with `mediaStore` from `@/lib/client/media-store` (product-ui, Saving), never in localStorage, with a download button. Closing the tab pauses the run, and the page says so, along with the fact that the record stays in this browser.
- **Replay first.** Open on a sample replay made at build time, so no visitor spends money just by looking. A Start button begins a real run, and its estimated cost sits beside it.
- **Budget.** A long recipe has its own daily budget. When it runs out, pause with a plain message.

## The model does every agent turn

The world is simulated; the agent is not. Every agent step is a real model call that sees the current state and picks the action.

- **No scripted stand-in.** When a model call fails, pause the run with an `.error` (`role="alert"`) that says the step didn't run, and a Retry button. Never go on with a scripted or "local" plan, and never fill a turn with a canned move or narration. The only scripted runs are the sample replay, labeled as one, and the test's scripted model.
- **Follow-ups carry the run.** A redirect, a note to one agent or a resume sends the run's record (the task or idea, and the board or screen state), never only the note, so the reply stays on the run's topic.
- **The smoke test proves it.** Its one real stretch asserts that each step it ran came back from the model (a reply with tokens on the timeline), not an error or a fallback flag.

## Label every simulation

Show a visible label on the screen itself, not only in the limits. Never imply that the product acts on anything real.

## 03/12 and 03/13 Computer use on a simulated screen

Build: a 1280 x 800 simulated screen, a task, and a model that looks and acts until it's done. Label it **Simulated screen**, and include the words **This does not control your computer.**

`helpers/cu-sim.ts` beside this file is a pure simulator with three scenes. It reaches the build at `.agents/skills/recipe-simulated-loops/helpers/`. Copy it to `lib/sim/`. Use `initialState`, `applyAction`, `sceneDone` and `render` (pass `null` for the signup background). Render to a canvas in the browser, and send `canvas.toDataURL("image/png")` with each turn.

**The model sees a PNG, whatever draws the screen.** Meta's API refuses `data:image/svg+xml`, so a step that sends an SVG fails in about a second. The Nov 3 audit's simulated desk drew its screen as SVG and sent that, so all 8 of its steps fell back and its model never ran. A screen of your own drawn as SVG shapes and text goes through `svgToPng(svg, { width: 1280, height: 800 })` from `@/lib/client/raster`. A screen built from HTML is drawn on a canvas instead: Safari won't export HTML inside an SVG. The route checks each screenshot with `imageProblem` from the same file and refuses one that fails, with a plain error. If that file isn't in the product, draw on a canvas and send `canvas.toDataURL("image/png")`.

**The computer tool is unproven here.** When our docs demo was built, Muse Wonder answered `400 Unsupported tool type 'computer'`, and it's untested with a product token. So:

1. Make the loop with strict function tools by default, on `muse-wonder-1.0`: `click(x, y)`, `type_text(text)`, `press_key(key)`, `finish(summary)`, with `parallel_tool_calls: false`. Validate with zod, and clamp coordinates to the screen.
2. Return each result as `function_call_output`, then attach the new screenshot in a message with `input_image`.
3. A build test may try `tools: [{ type: "computer" }]` once. If it works, BUILD_NOTES records it. If it's refused, keep the function tools. Never tell people the native tool was used unless it was.
4. **Confirm before risky steps.** A click that would submit, buy or delete pauses the run, and shows the action and a Confirm button. If the native tool returns `pending_safety_checks`, show them the same way, and acknowledge only after a click.
5. **Gates target what the person would plausibly remove.** The scene's sample holds something that is meant to go, like a duplicate note, an empty draft or last week's temp file, and that is what a risky step targets. Mark each item in the scene's data as keep or removable from the task, and have code refuse a delete of a keep item, as a tool result the model reads. Never gate a step that throws away what the task asked to keep: the audit's desk asked to delete a note the person had asked to file, and approving it lost the note. A test asserts that the sample's gated step targets a removable item, that Deny changes nothing, and that Approve removes only that item.

Stop at 25 actions a run. Check: a scripted model finishes a scene, and a risky step pauses. Limits: this is the simulated scene only, and nothing runs on the visitor's machine.
Links: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/12_computer_use and https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/13_macos_cua

## 03/07 Fixing a bundled project

Build: a small buggy Python project bundled with the product, with failing `unittest` tests, and a model loop that fixes it.

- Tools: `read_file`, `write_file`, `run_tests`, `finish`. All act on an in-memory file map.
- Run Python in the browser with Pyodide, from npm, served by the product itself, not a CDN. The model's code runs only there, in a Web Worker, with a timeout that kills the worker.
- `write_file` refuses test files. The product runs the tests itself at the end, and that result is what's shown, not the model's claim.

Label it **Sample project, run in your browser**. Limit: it's not SWE-bench and no Docker. Python packages beyond the standard library aren't offered. If Pyodide fails to load, show the replay.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/07_sandbox_execution

## 03/08 Team board

Build: a one-line idea, and a board of cards worked on by four roles: product, backend, frontend, writer.

- **Each role is its own agent.** On its turn a role makes its own model call, with its own instructions and only its own tools: `comment`, `move_card` to allowed columns, `add_artifact` for its own kind. Code applies only what those tool calls ask, and enforces each limit. One call that drafts the whole board, followed by moves on a timer, is not a team: the Nov 3 audit's relay board made one call, then fired 24 scripted moves, and its roles never spoke.
- **Roles talk through card comments**, and nothing else passes between them. Each turn's input is the board with its comments, so a role answers what another wrote. The run log shows one model call per role turn, with its tokens.
- At most 3 turns a role per stretch, and an overall ceiling on cards and comments. Moves happen when a role's call returns, never on a timer.

Result: a plan, and a small artifact such as a spec and landing copy. Say "This makes a plan and small files, not a working SaaS." Check: a scripted test where a role tries a forbidden column, and the smoke test's real stretch runs two role turns, each its own call, where the second role's input holds the first role's comment.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/08_multi_agent_orchestration

## 03/14 Simulated robot arm

Build: a spoken or typed request, a plan, and a three.js arm that carries it out.

1. Transcribe with `meta-voice`, when spoken.
2. `respondJson` returns a strict plan of steps from an **allow-list**, such as `move_to`, `grip`, `release`, naming only objects in the scene. Code rejects anything else, and shows why.
3. Code runs the steps with simple joint movement. No physics engine.
4. A final position check in code decides success, never the model.
5. Optional: SAM preview on a rendered frame of the scene, and a selfie postcard from `muse-image-1.0`, printed with `window.print()`.

Label it **Simulated arm**. Limit: no MuJoCo, no robot and no printer control beyond the browser's print dialog.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/14_muse_robotics

## 03/15 Approval gate

Build: a labeled **Simulated local agent** works on a task, and asks to consult a remote model. The gate is real.

- The simulated agent is a scripted or rule-based step list on the page. Never present it as Muse Glimmer running here.
- Its steps are the one scripted part allowed here, an exception to No scripted stand-in: label each **Simulated step**, never as a model reply, and every answer after Approve is a real `muse-wonder-1.0` call.
- Before anything is sent, show the exact text and its size in bytes, with Approve and Deny. Denying sends nothing, and the agent continues without it.
- Only an approved request reaches the server, and the server sends exactly the text approved, checked against a hash from the page.
- An **egress ledger** lists each request: time, bytes, approved or denied, and the reply's size. Add a timeout, so no answer counts as denied.

Check: a test proves a denied or changed request sends nothing. Limit: the ledger covers this page only, and the page says what it can't see.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/15_glimmer_api_agent

## 04/03 Staged approvals (labeled simulator)

Build: paste a compound shell command, and code splits it into stages at `&&`, `||`, `;` and `|`. Each stage is marked and approved or rejected on its own. Muse Wonder can explain a stage in words. **Nothing is ever run.** Label it **Simulator: no commands run**. Check: unit tests for the splitter, including quoted separators. Limit: it isn't Muse Code's approval system, and it doesn't parse all of shell syntax.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/03_staged_approvals
