---
name: muse-code-in-product
description: Run a person's task with Muse Code, a coding agent, in a private temporary workspace the platform starts, and show the run (steps, files, final answer, Stop, download, cost). Read this before writing any part of a product that hands tasks to Muse Code.
---

# Muse Code in a Muse Muse product

The brief's "Running code" section says the product runs Muse Code tasks. Every file named here is a platform file:
wrap it, never edit it.

## How a task runs

The product never runs Muse Code itself. Its server asks the platform, and the platform starts a private temporary
workspace for each task: its own sandbox, with an empty folder (plus the files the person attached), no product code
and no secrets. Its firewall lets it reach only Muse Muse's model route and npm downloads, and that route takes no web
search or remote files. The workspace goes soon after the task ends: at the latest about 18 minutes after it started,
when its sandbox stops itself. The zip stays for 24 hours, and so do the steps and final answer.

- At most 15 minutes and $1 a task. Then it stops and keeps what it made.
- 2 tasks at once per product.
- **Only the product's owner can start tasks,** unless the build prompt says Muse Muse lets anyone. Anyone else gets
  `CapError` with code `sign_in_required`: show them plainly that this part is the owner's.
- The person's task is sent to Meta. Show this line, word for word, where they type the task (`MuseCodeDisclosure`):
  "Runs Muse Code in a private temporary workspace. It's deleted after 15 minutes, and your task is sent to Meta."

## The server: `museCode`

```ts
import { museCode, CapError } from "@/lib/muse-code/client";

const run = await museCode.start(request, { task, files: [{ name: "people.csv", text }] }); // answers at once
const progress = await museCode.events(request, run.id, after);   // steps after `after`, status, costUsd
await museCode.steer(request, run.id, "Use semicolons, not commas.");
const result = await museCode.stop(request, run.id);               // keeps what it made
const done = await museCode.result(request, run.id);               // finalText, files, zipUrl, worked
```

- Route handlers and server actions only, passing the incoming request (or `await headers()`), so the owner pass
  travels.
- Files: plain names, `text` or `base64` up to 1 MB in all, or a `url` from the gateway's `/uploads` for bigger ones
  (20 MB in all).
- `worked` is true only when files came back and Muse Code said what it did. A run can end without an error and make
  nothing (it asks for a file it didn't get, for example): then its final answer says why. Always show the final answer.

The product already has the routes the browser uses, in `app/api/musemuse/muse-code/`: `POST` (start, body `{task,
files?, replay?}`), `GET ?id=&after=` (events), `steer`, `stop`, `result`, and `owner` (where "Open as owner" lands
when the product has no other owner page). Call those from the page. Never call the gateway from the browser.

## The page: `CodeRun`

```tsx
"use client";
import { CodeRun, MuseCodeDisclosure } from "@/components/platform/CodeRun";

<MuseCodeDisclosure />
// after POST /api/musemuse/muse-code answers { id }:
<CodeRun runId={id} onDone={(result) => setLast(result)} />
```

`CodeRun` shows the steps as they happen, the files changed, the final answer, a Stop button while it runs, the
download once it's done (a zip kept for 24 hours), what the zip left out and why, and the cost so far. It polls the
product's own routes every 2 seconds.

The zip is the workspace only: no links, no program files, nothing over 10 MB a file or 50 MB in all. Say so if a
person asks why a file is missing: `CodeRun` lists what was left out.

## MCP actions

A task outlasts the connector's 120 seconds. An action that starts one returns at once with a link to the page that
shows it: `museCode.link(pageUrl, run.id)` adds `?run=<id>`. The page reads `run` from its URL and shows `CodeRun`.

## Replay mode, and the smoke test

In a build, at most 2 real tasks run, 5 minutes and $0.50 in all, on the test model with made-up data only. verify runs
many times and a real task counts for the whole build: once the 2 are used and one worked (the gateway says
`build_tasks_used`), a plain start on the server plays the recording, so the same smoke test keeps passing and spends
nothing. If neither worked, the start is refused and the fixed check stays failed: say why in BUILD_NOTES.md. Every other
test uses replay mode: `POST /api/musemuse/muse-code` with `replay: true` plays a recorded sample run
(`lib/muse-code/sample-run.json`) through the same screen and spends nothing. Only the build's own server replays; the
live product never does.

```ts
import { expectMuseCodeRun, expectReplayRun } from "./caps/muse-code";

// One real task, with made-up data, through the product's own page:
await page.getByLabel("Task").fill("Write a Node script that removes duplicate rows from people.csv by email.");
await page.getByRole("button", { name: "Run" }).click();
await expectMuseCodeRun(page);   // waits for the end, checks files and the final answer show

// Everything else on replay:
await expectReplayRun(page);
```

- `expectMuseCodeRun` takes the judge screenshot `08-muse-code-run` and records its check. verify's fixed checks
  also ask the gateway whether the real task made files. Assert structure, never a run's words.
- Give the real task what it needs: attach the file it reads. A task with nothing to work on makes nothing.
- Never start a task on page load, only when a person asks.
