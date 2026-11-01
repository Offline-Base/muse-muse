---
name: muse-code-run
description: Run code a person writes or pastes, in the browser (Python with Pyodide, JavaScript with QuickJS) or on a Muse Muse sandbox (Python or Node), and open a web page the person typed. Read this before writing any part of a product that runs code or opens a page.
---

# Running code in a Muse Muse product

The brief's "Running code" section says which of these the product has. Use only those. Every helper here is a
platform file: wrap it, never edit it.

## Show every run the same way

`components/platform/CodeOutput.tsx` shows one run: a plain status line, stdout, and errors in their own color. Put it
right under the code that made it, and pass `running` while the run is going (it marks itself `aria-busy`).

```tsx
<CodeOutput run={run} running={busy} />
```

Every helper returns a `CodeRun` (`lib/platform/code-run.ts`): `status` is `ok`, `error` or `timeout`, with `stdout`,
`stderr`, `ms` and `truncated` (each stream is cut at 64 KB). A program's own error is a normal answer, never a throw.

## Python in the browser: `runPython`

```tsx
"use client";
import { runPython } from "@/lib/platform/pyodide";
const run = await runPython(code, { stdin });
```

- Client components only. It runs in a worker, so the page stays responsive, and stops a run after 10 seconds.
- The first run loads Pyodide (about 10 MB) from the product's own `/api/musemuse/pyodide/` route
  (`app/api/musemuse/pyodide/[file]/route.ts`). Call `preloadPython()` when the editor opens, so the first run is quick,
  and say "Loading Python" while it loads.
- The standard library only: no numpy, no pandas, no pip, no network. `input()` reads `stdin`.

## JavaScript in the browser: `runJavaScript`

```tsx
"use client";
import { runJavaScript } from "@/lib/platform/quickjs";
const run = await runJavaScript(code, { stdin });
```

- Client components only. QuickJS is its own small engine: the program sees no page, no `window`, no `fetch` and no
  timers, only `console.log`, `console.error` and `INPUT` (stdin as text). 64 MB of memory, 3 seconds.
- It runs on the page's own thread, so a run can hold the page for up to its limit. Keep the limit short.

## Python or Node on the platform: `runOnServer`

```ts
import { runOnServer, CapError } from "@/lib/platform/exec";
const run = await runOnServer(request, { language: "python", code, stdin, files: [{ name: "data.csv", text }] });
```

- Route handlers and server actions only, passing the incoming request (or `await headers()`).
- A fresh sandbox for each run, with no network and no secrets: 15 seconds, 64 KB of code and stdin, 1 MB of files
  (`text` or `base64`, plain names, found in the program's working folder) and 64 KB of output. Python has its standard
  library only.
- **Only the product's owner can run code here.** Anyone else gets `CapError` with code `sign_in_required`: catch it,
  answer with its status and message, and show visitors plainly that this part is the owner's (and offer the browser
  runtime when the brief has one). Each person can run 20 programs a day and the product 200; over that it's
  `rate_limited`.
- In a build every run is real, at most 5 in all. Never call it on page load, only when a person asks.

## Opening a page the person typed: `openPage`

```ts
import { openPage } from "@/lib/platform/browse";
const page = await openPage(request, { url, input: whatTheyTyped, actions: [{ type: "click", selector: "text=More" }] });
// page.title, page.text, page.screenshot (a data URL for an <img>), page.simulated in a build
```

- Route handlers and server actions only. `input` is exactly what the person typed, and the address must be in it, with
  or without `https://`. The gateway refuses any other page, an IP address, a private address and another port.
- It opens that one site in a sandbox that reaches nothing else, follows no link to another site, and never signs in:
  it won't type into password, code or card fields. At most 5 `click`, `type` or `wait` steps and 30 seconds.
- Owner only, 5 pages a day per person. Anyone else gets `CapError` `sign_in_required`.
- In a build it returns one of the platform's recorded sample pages, marked `simulated: true`, whatever the address.
  Show it as you would a real one, and never assert its words in a test.

Code never calls a model or an outside service. When the product also needs a model, call it in the product's own
server code and pass the result in.

## The smoke test

Use `tests/caps/code.ts`:

```ts
import { codeFixture, expectInPageRun, expectExecOutput, expectBrowsePage } from "./caps/code";

const fx = codeFixture("python");          // or "javascript", "node"
await page.getByLabel("Code").fill(fx.code); // through the product's own editor
await page.getByRole("button", { name: "Run" }).click();
await expectInPageRun(page, fx);            // a browser run (Pyodide or QuickJS)
// or, for a run on the platform: await expectExecOutput(page, fx);
// and for a page: type an address into the product, open it, then await expectBrowsePage(page);
```

- Each helper takes its own judge screenshot (`08-code-output`, `08-server-output`, `08-sample-page`) and records its
  check. verify's fixed checks decide whether running code works, together with the gateway's own record of the runs.
- The fixture's numbers change every run. Run it through the product's own editor and route, the way a person would.
- At most 3 server runs and 1 page per smoke test.
