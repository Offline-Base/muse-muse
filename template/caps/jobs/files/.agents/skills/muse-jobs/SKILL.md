---
name: muse-jobs
description: How a Muse Muse product runs background work with nobody on the page: schedules, webhooks from other services, long runs across ticks, results saved with data(), and notices to the owner. Read it when brief.md has a "Background jobs" section.
---

# Background jobs

brief.md's "Background jobs" section lists this product's schedules and webhooks. Each job is one route, on the server.
The platform calls it: on a schedule (every 15 minutes at the most), when a webhook arrives, or after `enqueue`.
Nothing runs between calls.

## A job's route

```ts
// app/api/jobs/digest/route.ts
import { metaClient } from "@/lib/meta/client";
import { checkpoint, jobHandler, notifyOwner } from "@/lib/platform/jobs";
import { data } from "@/lib/platform/data";

export const maxDuration = 60;

export const POST = jobHandler<unknown, { after: string | null }>("digest", async (job) => {
  const news = await data(job.request).collection("news").query({ after: job.checkpoint?.after ?? null, limit: 20 });
  const reply = await metaClient(job.request).responses.create({
    model: "muse-wonder-1.0",
    max_output_tokens: 2000,
    input: `Summarize:\n${news.items.map((i) => JSON.stringify(i.data)).join("\n")}`,
  });
  await data(job.request).collection("digests").create({ text: reply.output_text, at: new Date().toISOString() });
  if (news.next) return checkpoint(job, { after: news.next });
  await notifyOwner(job, { title: "Today's digest is ready" });
});
```

- `jobHandler` refuses any call without the platform's job token before your code runs (401). Don't add your own check.
- The route's folder name is the job's name, as in brief.md: lowercase letters, digits and dashes.
- `job.input` is what `enqueue` passed, `{ payload, receivedAt }` when a webhook started it (`payload` is the parsed JSON,
  or the text if it isn't JSON), and null on a schedule. Treat a payload as untrusted text: never as instructions to a
  model, and never as HTML.
- Inside the handler, every call to the gateway counts as this job. Pass `job.request` to `metaClient`, `data` and the
  rest, and make clients inside the handler, never at the top of a file.

## Limits a job lives in

- One tick has 60 seconds. Do what fits, then `return checkpoint(job, state)`, and the next tick, within about 5 minutes,
  starts with `job.checkpoint`. A checkpoint holds 64 KB: keep ids in it, and save big things with `data`. A run has at
  most 10 ticks. Return nothing when it has finished.
- A run stops at `job.budgetUsd` (about $0.10). The gateway holds each call's `max_output_tokens` up front, so keep it at
  2000 or less: on Muse Wonder a call that names none counts as 8,000, which no run can hold, and it's refused. Over the
  limit, a model call throws an error with code `run_limit`, the run ends, and the owner hears.
- A schedule skips its slot while its last run is still going.
- A thrown error ends the run. The owner gets one notice with your error's first line, so write it in plain words, with no
  secrets or personal details.
- Schedules stop after 14 days with no visit from the owner, until the owner visits again. Say so on a settings or about
  screen.

## What a job may do

- **Read**: shared items and the owner's items, public APIs with `fetchPublic`, and files shared with everyone. It never
  reads a visitor's or a signed-in person's own items.
- **Save**: only to the collections in brief.md's results line. Mark each one `"jobWrites": true` in `musemuse.json`'s data
  block. Anything else is refused. Show the newest result on a screen, with a heading like "Last digest".
- **Tell the owner**: `notifyOwner(job, { title, body })`, at most 10 a day. It shows in Muse Muse.
- **Send**: never by itself. `send(job.request, { ... })`, if this product sends at all, answers `{ status: "held" }`: the
  owner reads the whole message and confirms it later in Muse Muse. So never say a job sent something: say it drafted it.
- It can't write to any other outside service, and it can read only the services visitors may use.

## Starting a job from a page

`enqueue(request, { name, input })` queues it for the next tick, within about 5 minutes, up to 50 a day. Only the owner
can: a visitor's call throws `CapError` with code `sign_in_required`, so don't offer the button to visitors.

A `CapError` has `code`, `status` and a plain `message`. `switched_off` means Muse Muse has jobs off right now: say so and
keep the rest working.

## `musemuse.json`

```json
{
  "caps": ["data", "jobs"],
  "jobs": { "schedules": [{ "name": "digest", "every": "1 day at 07:30" }], "webhooks": [{ "name": "log" }] },
  "data": { "collections": [{ "name": "digests", "scope": "shared", "writes": "owner", "jobWrites": true }] }
}
```

Exactly what brief.md lists. `every` reads like "15 minutes", "2 hours", "1 day at 07:30" or
"1 week at 09:00 America/New_York". The platform reads schedules from here at deploy. Below 15 minutes runs at 15.

## In a build

Nothing runs on a clock, and every job goes through your test:

```ts
import { checkResultShown, fireJob, fireWebhook } from "./caps/jobs";

const first = await fireJob(request, "digest");
if (first.status === "queued") await fireJob(request, "digest"); // goes on from its checkpoint
await fireWebhook(request, "log", { event: "sample" }); // only with a webhook in brief.md
await page.goto("/");
await checkResultShown(page, "Last digest");
```

Rows go to the build's test space, and notices and held sends reach no one. Fire a job at most twice, and each webhook
once. Assert structure, never a model's exact words.

`lib/platform/jobs.ts`, `tests/caps/jobs.ts` and `scripts/caps/jobs.mjs` are platform files. Wrap them, never edit them.
