---
name: muse-caps
description: How a product with Muse Muse platform services proves they work. Read it when brief.md has a Platform services section.
---

# Platform services: proving they work

brief.md's Platform services section lists the services this product uses, each with its own skill. This skill covers
what they share.

## The rules

- Use each service only through its helper in `lib/platform/`. Pass the request to every server helper, as you do for
  `metaClient(request)`. Never call the gateway's service routes yourself.
- The helpers, `tests/caps/` and `scripts/caps-check.mjs` are platform files. Wrap them in your own code, never edit
  them: verify puts them back before every run, so an edit is lost and can't make a check pass.
- During the build every service runs on the build's own data, or on a stand-in that answers with `simulated: true`.
  Nothing a test writes reaches a real person.

## How verify checks them

After the smoke test, verify's caps step runs the fixed checks for each service. A check passes only when two records
agree: what the smoke test recorded with the service's test helper (`tests/caps/<service>.ts`), and what the gateway
saw for this build. A failed check fails verify, and the next fix round gets it.

The gateway's record counts only what happened during that verify run, from its start. Rows or files written earlier,
by an earlier run or by hand with the build token, never count, so the smoke test itself has to do the real thing.

- Use the service's test helpers in `tests/smoke.spec.ts`. They record the checks for you.
- Assert the shape of what comes back (a row exists, a send was confirmed), never a stand-in's exact words.
- Keep each service's real calls within the number its skill gives.
- Show each proven thing on a judge screenshot with a plain caption, such as "Second browser, after a reload".

## After deploy

The live link's health check (`/api/musemuse/health`) must answer `{"ok": true}`. It comes with the platform files, so
leave it as it is.
