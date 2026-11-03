---
name: shared-keys
description: Use only when brief.md or the change request has a section called "The owner's service accounts". The owner's own Vercel, AWS, Lambda, Hugging Face, Jetson fleet, Composio, Fireworks, Baseten and Modal accounts, for server code only.
---

# The owner's service accounts

## What they are

The person who runs Muse Muse lets builds by signed-in builders use some of their own accounts. Each one has a dedicated key with its own limits. The prompt's section names the accounts this build has. Only those are set, and the build machine can reach only their APIs. Never use an account the prompt doesn't name, and use one only when the brief needs it.

The keys are in `.env.local`, and the live product gets the same names in its own environment. `MUSEMUSE_SHARED_KEYS` lists the names of the secret ones.

| Account | Names | API hosts the build can reach |
|---|---|---|
| Vercel | `VERCEL_TOKEN`, `VERCEL_TEAM_ID` (the team, when set) | `api.vercel.com` |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | the global endpoints and the one region's |
| Lambda (GPU machines) | `LAMBDA_API_KEY` | `cloud.lambda.ai` |
| Hugging Face | `HF_TOKEN` | `huggingface.co` and its file hosts |
| Jetson fleet | `FLEET_URL`, `FLEET_KEY` (an inference-only key) | the fleet's own host |
| Composio | `COMPOSIO_API_KEY` | `backend.composio.dev` |
| Fireworks | `FIREWORKS_API_KEY` | `api.fireworks.ai` |
| Baseten | `BASETEN_API_KEY` | `api.baseten.co`, `inference.baseten.co`, model hosts |
| Modal | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | `api.modal.com`, `*.modal.run` |

## Rules

- Server code only. Read each key from `process.env` at run time, inside a route handler under `app/api/` or a server action. Never in a client component, never in `next.config.ts`, and never under a `NEXT_PUBLIC_` name, which would put it in the browser's code.
- Never log, print, return to the browser or write a key's value into any file: no hard-coded value, no test, no fixture, no screenshot, no BUILD_NOTES.md, no message. Never send a key to a model, and never put one in a URL a page can see.
- Never print, edit or copy `.env.local`. To check that a key is there, test `Boolean(process.env.HF_TOKEN)` in server code.
- A check reads the product's files, `public/`, `.next/static` and the pages `next build` prerendered for each value, in plain text and in base64, hex or URL encoding. A build with a value in any of them fails, and a product with one is never published.
- Every model the product calls is still a Meta model (AGENTS.md). Fireworks, Baseten and Modal are only for Muse Spark Open, which runs there. Hugging Face is for files and datasets, not for running another company's model. Never call any other model on any of these accounts.
- The live product is public, and anyone can call its routes. Keep each route to what the brief needs: fixed actions, never a visitor's own command, URL, bucket, model or machine type. Never let a route start a GPU machine, deploy or delete anything because a visitor asked. When an action spends money, say so in the UI next to it, and record it as a limit in `musemuse.json`.
- If a key is missing or an account refuses a call, show a plain message, and never fall back to another account or another model.

## Calling them

Use `fetch` or the service's own npm package in server code. Pass each key explicitly, never through a default lookup that might find another one.

```ts
// app/api/actions/save/route.ts
export async function POST(request: Request) {
  const token = process.env.HF_TOKEN;
  if (!token) return Response.json({ error: "Saving isn't set up for this product." }, { status: 503 });
  const res = await fetch("https://huggingface.co/api/whoami-v2", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return Response.json({ error: "Hugging Face didn't answer. Try again in a minute." }, { status: 502 });
  // Return only what the UI needs, never the key and never the raw response headers.
  return Response.json({ ok: true });
}
```

- AWS: give the SDK the credentials and region in code, `new S3Client({ region: process.env.AWS_REGION, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! } })`, since a Vercel function has AWS variables of its own that hold no access.
- Vercel: send `?teamId=${process.env.VERCEL_TEAM_ID}` with each call when it is set.
- Jetson fleet: call `FLEET_URL` with `Authorization: Bearer ${process.env.FLEET_KEY}`. The key is for inference only and has a daily limit, so show progress and handle a refusal.
- Tests never see these values (AGENTS.md, Calling Meta models). Test the product's own routes, and assert what the UI shows, never a key.

## In BUILD_NOTES.md

Name each account the product uses, what for, and which route calls it. Never write a value.
