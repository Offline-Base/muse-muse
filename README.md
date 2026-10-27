# Muse Muse

Give it a muse and Muse makes it. Drop in an example or some inspo, like a photo, a screenshot, a sketch, a short video, a voice memo or a PDF, and add a note if you want. Muse Code builds a working product from it on Meta's models. The platform tests it, deploys it to its own link, and makes it usable from the Muse app.

Hackathon codename for the Meta Global AI Developer Hackathon, Startup track. Muse is Meta's brand, so pick your own name before taking this further. See the Name section in [docs/DESIGN.md](docs/DESIGN.md#name).

## Status

**Design and scaffold, started Oct 24, 2026 before kickoff and updated Oct 26.** Every route and helper that needs real logic is a stub that returns 501 or throws, with a `TODO(kickoff, day N)` note pointing at the plan. Disclose this in the submission if the rules ask what existed before Oct 26.

What exists before kickoff:

- Design docs, the Meta model catalog and prompt drafts in `docs/` and `catalog/`
- The product template's rules (`template/AGENTS.md`) and skills (`template/.agents/skills/`)
- Folder layout, types, the database schema and route stubs

## How it works

1. **Muse.** A user drops in an example or inspo and an optional note. Text alone works too.
2. **Brief.** Muse Spark 1.3 reads the inspo and writes a structured brief with models, limits, cost, and what to take from the inspo and leave out. It can also refuse.
3. **Build.** Muse Code runs headless in a Vercel Sandbox microVM and writes the product from `template/`. The Meta key is injected at the sandbox firewall, so generated code never sees it.
4. **Check.** `npm run verify`, a Playwright smoke test and a screenshot judge. Failures go back to Muse Code, up to three rounds.
5. **Ship.** Deployed as its own Vercel project. It calls Meta through this platform's gateway with a scoped, budgeted product token.
6. **Recorded.** Each product's test reruns at 1280×720 with video and becomes an MP4 demo with captions.
7. **Use in Muse.** Each product's actions are served as an MCP endpoint the Muse app can add as a custom connector.

The showcase is a batch run that rebuilds Meta's Llama-era demo videos on current Muse models (`catalog/meta-resources.json`) and records each one.

The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## Layout

```text
app/                      Platform UI and API routes (Next.js App Router)
  page.tsx                Make: example cards and the muse box (inspo upload and note)
  dashboard/              Requests, tokens, spend and product connectors
  how-it-works/           The pipeline in five steps
  b/[buildId]/            Build room
  p/[slug]/               Product page
  rebuilds/               Meta's videos and their rebuilds
  gallery/                Shipped products
  usage/                  Meta tokens driven
  api/inspirations/       Save inspo and start a build
  api/builds/[buildId]/   Events (SSE) and refinements
  api/gateway/v1/[...]    Meta Model API proxy for products
  api/gateway/uploads/    Upload tickets for large files
  api/mcp/[slug]/         Muse app connector endpoint
lib/
  brief/schema.ts         Brief schema (zod)
  pipeline/               Workflow steps and outline
  sandbox/                Firewall policy and Muse Code arguments
  gateway/policy.ts       Endpoint allowlists and limits
  db/schema.ts            Postgres schema (Drizzle)
  types.ts                Domain types
catalog/meta-models.json  Every Meta model, endpoint, limit and price we know of
catalog/meta-resources.json  Meta's demo videos, each with a rebuild plan
docs/                     Design, catalog, prompts, build plan
scripts/                  Builder snapshot script (stub)
template/                 Starter repo Muse Code builds every product from
  inspo/                  Where the user's references land for each build
```

## Setup at kickoff

You need Node 22 or newer, a Vercel account, a Neon Postgres database from the Vercel Marketplace, a Meta Model API key and the Muse Code CLI (`curl -fsSL https://dev.meta.ai/install.sh | sh`).

```bash
npm install
cp .env.example .env.local      # fill in the values
vercel link && vercel env pull  # gives VERCEL_OIDC_TOKEN for Sandbox locally
npm run db:generate && npm run db:migrate
npm run dev

cd template && npm install      # the product template is its own app
```

Vercel Hobby caps sandbox sessions at 45 minutes and Pro at 24 hours. Builds target well under 30 minutes, so Hobby works for the hackathon.

## Run it on your machine

```bash
npm run dev:local               # then open http://localhost:3000
```

This needs only `MODEL_API_KEY`, `VERCEL_OIDC_TOKEN` (from `vercel env pull`, good for 12 hours) and `BUILDER_SNAPSHOT_ID` in `.env.local`. The database is PGlite in `.data/pglite`, files go to `.data/files`, and sign-in is off for localhost. Builds still run in Vercel Sandbox. The sandbox can't reach your machine, so products call Meta directly through the build firewall instead of the gateway, and their file uploads don't work. Without `VERCEL_TOKEN` a build stops after the demo video and isn't published to its own link. The live preview in the build room works while the build runs.

## Docs

- [docs/DESIGN.md](docs/DESIGN.md) covers the architecture, pipeline, security, cost, demo and risks.
- [docs/META_CATALOG.md](docs/META_CATALOG.md) lists Meta's models, endpoints, limits and prices.
- [docs/PROMPTS.md](docs/PROMPTS.md) has drafts for the brief writer, builder, fix round, judge and refinement prompts.
- [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) has the rules check, day-one spikes, the Oct 26 to Nov 4 schedule and the test muses.

Muse Muse is not an official Meta product.
