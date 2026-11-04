# Deploying your own copy

Operator setup for running Muse Muse on your own Vercel account. Judges don't need any of this: the [README's Judge path](../README.md#judge-path) covers trying it. Moved here from the README on Nov 4, 2026, unchanged apart from headings.

## Setup

You need Node 22.22.3 or newer, a Vercel account, a Neon Postgres database from the Vercel Marketplace and a Meta Model API key. Muse Code is installed in the builder snapshot, so you don't need it on your machine.

```bash
npm ci
cp .env.example .env.local      # fill in the values; each one is explained in the file
npx vercel link && npx vercel env pull .env.vercel.local   # VERCEL_OIDC_TOKEN for Sandbox locally (good for 12 hours); copy it into .env.local
npm run snapshot                # makes the warm builder snapshot; put the printed id in BUILDER_SNAPSHOT_ID (required on Vercel)
npm run db:migrate              # applies drizzle/ to DATABASE_URL (npm run build runs it too)
npm run dev                     # http://localhost:3000
```

Run `npm run snapshot` again whenever `template/` changes, and update `BUILDER_SNAPSHOT_ID` in `.env.local` and on Vercel. The script also adds the new id to `lib/sandbox/snapshots.json` with the platform service overlays it installed: commit that file with the id change, since the live site offers only the services its snapshot lists there (docs/CAPABILITIES.md, 2.4a). Run `npm run db:generate` only after you change `lib/db/schema.ts`. To work on the product template itself, run `cd template && npm install`.

On Vercel, set the same variables on the project. A few need care:

- The Blob store must be **public**. Meta fetches media by URL, and products upload straight to the store. Connecting it sets `BLOB_STORE_ID` (used with the deployment's OIDC token) or, for older stores, `BLOB_READ_WRITE_TOKEN`; either works for the platform's own files and inspo uploads. Product uploads through the gateway and training uploads still need `BLOB_READ_WRITE_TOKEN`. With neither set, builds are refused.
- `VERCEL_TOKEN` and `VERCEL_TEAM_ID` publish each product as its own project.
- `OPEN_ACCESS=guest` opens the site with no sign-in: every visitor shares one Builder account and its daily cap. `DAILY_SPEND_CAP_USD` stops new builds and gateway calls for the day once it is reached.
- Fine-tuning needs `LAMBDA_API_KEY` and `CRON_SECRET`. Jobs start only on production, where Vercel runs the sweep cron.
- Publishing to Hugging Face needs `HF_TOKEN` (a fine-grained token with write access to repos under `HF_NAMESPACE`, a user or an organization) and `HF_NAMESPACE`. `HF_PUBLIC=1` makes repos public once checked; anything else keeps them private. Without a token, judged runs say publishing is off.

**Sandbox session length.** Vercel Hobby caps sandbox sessions at 45 minutes and Pro at 24 hours. Full builds on the live site took 33 to 100 minutes on Nov 3, so a Hobby account's 45-minute session may stop a full build; Pro avoids that. Short builds, like the 3 to 9 minute local builds of Oct 27, fit on Hobby.

**Batch scripts.** `npm run rebuild-all` starts the rebuild batch at `PLATFORM_URL` with the `AUTOMATION_SECRET` bearer and prints a table and a total. `npx tsx --env-file=.env.local scripts/rerecord-demos.ts` re-records the demo of every live product (or the ids and slugs you give it) in its own sandbox with Demo Studio, without a Muse Code run; `--dry-run` records in a throwaway copy of each sandbox and saves the videos locally, changing nothing.

## Preview database

On Vercel, Preview gets the same `DATABASE_URL` (and the Neon integration's `PG*` and `POSTGRES_*` variables) as Production, and every deployment runs `scripts/migrate.ts` before `next build`. So previews never use `DATABASE_URL`. A preview uses `PREVIEW_DATABASE_URL`, an empty database of its own on a Neon branch, and everything that opens or migrates the database picks it the same way (`lib/db/url.ts`). `lib/db/__tests__/no-direct-database.test.ts` checks that other code doesn't read those variables itself.

| Where | Database the site uses | What the build's migrate does |
| --- | --- | --- |
| Production, `npm run dev`, scripts | `DATABASE_URL`, as before | migrates `DATABASE_URL` (skips when it's unset) |
| `DATABASE_URL=pglite:<folder>` (`npm run dev:local`) | that folder, as before | migrates that folder |
| Preview with `PREVIEW_DATABASE_URL` | `PREVIEW_DATABASE_URL` | migrates `PREVIEW_DATABASE_URL` |
| Preview without it | none: pages show "Not connected yet" and anything that needs the database fails, as with no `DATABASE_URL` | prints that it skips, since previews never touch production's database, and the build goes on |
| Preview with production's database in it | none | refuses with exit 1, so the build stops |

"Production's database" means the same database name on the same Neon endpoint (the `ep-...` id, pooled or not, whatever the rest of the host or the port says) as `DATABASE_URL` or the integration's other URLs, whatever the user, password or options. Off Neon it means the same host, port and database name. Crons don't change this: Vercel runs `vercel.json` crons on production deployments only.

A preview also never publishes a product: a publish goes into production's Vercel project for that name (`musemuse-<slug>`), so it would replace a live product. Builds still run their preview, checks and demo, and the product is saved without a link of its own. A preview takes no card payments and makes no Stripe refunds either, since Stripe's webhook settles on production, so new drive orders there are invoice requests.

To give previews their database and let their builds through (once):

1. In Vercel, open Storage, the Neon database, then Open in Neon. Under Branches, choose New branch, name it `preview`, and keep the default (production) branch as its parent and the data as it is. Don't pick Schema only: the copied tables would have no record of their migrations, and the build would stop. On the `preview` branch, open Roles & Databases and add a database named `preview`, owned by the same role as `neondb`. Then open Connect, pick the `preview` branch and the `preview` database (the pickers start on production's), turn connection pooling on, and copy the string.
2. Run `vercel env add PREVIEW_DATABASE_URL preview`, paste the string, and leave the Git branch empty so every preview gets it. You can also mark it Sensitive in the project's Environment Variables. Previews made after that use it.
3. In the project's Settings, open Deployment Protection and turn on Protection Bypass for Automation by adding a secret there. Vercel then gives every deployment the secret as `VERCEL_AUTOMATION_BYPASS_SECRET`; previews made after that read it. Nothing else needs setting, and the secret never goes in an environment variable of your own.

The `preview` database starts empty, and the first preview build migrates it. Leave the branch's own `neondb` alone: it is a copy of production's rows, and its products still name production's live Vercel projects and sandboxes, its orders real card payments and its people real emails. A preview pointed at it could refine a live product's sandbox or delete its files.

Every preview shares the `preview` database. To start clean, delete it on the branch (Roles & Databases) and add it again with the same name and owner, then redeploy a preview so its migrations run. Don't use Reset from parent: it puts the branch back to production's current state, which drops the `preview` database and leaves previews failing to connect. Migrations reach the preview database in number order too: Drizzle skips a migration older than the newest one applied, so once a preview has applied `0021`, a later preview that brings `0020` skips it there. Recreate the `preview` database before deploying that preview.

What a preview can prove: products and build sandboxes reach the gateway and the build MCP at `env.platformUrl`. A preview with its own database (`previewHasOwnDatabase` in `lib/db/url.ts`) is its own platform: `env.platformUrl` is its branch URL (`VERCEL_BRANCH_URL`), or its deployment URL (`VERCEL_URL`) when there's no branch URL, since its builds and gateway tokens live only in its database and production's gateway would refuse them. `PLATFORM_URL` doesn't change that preview's address. A preview with no database, or with production's, and production itself keep `PLATFORM_URL` as before.

Deployment Protection turns away requests to a preview that carry no Vercel login, and a build sandbox has none, so step 3 lets them through. How the bypass is kept to the sandbox:

- **Where the secret goes.** On a preview with its own database, `env.previewBypass` reads `VERCEL_AUTOMATION_BYPASS_SECRET` together with the preview's own host. The build firewall adds the secret as the `x-vercel-protection-bypass` header to every request a sandbox makes to that host (`lib/sandbox/policy.ts`), in a build's sandbox and in Prove it's copy.
- **Nowhere else.** On a preview whose `env.platformUrl` is another site's (no database of its own, or no URL of its own), and for a Prove it copy pointed at another site, the sandbox gets no header.
- **Host pinned.** The same rule sets each of those requests' `Host` header to the platform's host. The firewall picks a host's rules by the connection's SNI alone, so without that, code in the sandbox could name the platform in the SNI and another site on Vercel's edge in `Host`, and the secret would go to that site.
- **No bypass cookie.** A request that asks for a bypass cookie (`x-vercel-set-bypass-cookie`, as a header or a query parameter, in any case or encoding) gets a 403 from the firewall itself, since the cookie would land inside the sandbox and do the secret's job there.
- **Never inside the sandbox.** The secret stays in the firewall rule and never enters the sandbox, so the product's code and Muse Code never see it or a cookie made from it. Production never reads it.
- **Only the sandboxes get the header.** People opening the preview still sign in to Vercel, and anything else that calls the preview still meets Deployment Protection. That includes Vercel Blob's upload-completion callback (it only writes a log line), a native lab box's selftest, and a training job's GPU reporting back (training starts only on production unless `TRAIN_ALLOW_OUTSIDE_PRODUCTION=1`, and a GPU that can't report back is still ended by its time limit and the sweep).
- **Without step 3**, a protected preview's builds can't reach its gateway or build MCP.
- **Check it once** it's on, from a build's sandbox on a preview: a request to the preview with another site's `Host` header still reaches the preview, and one with `x-vercel-set-bypass-cookie: true` gets the firewall's 403 and no `Set-Cookie`.

The branch URL follows the branch's newest deployment, so a build still running when a newer commit deploys on the same branch calls the newer one. Its tokens still work, since every preview shares the `preview` database, but the code serving it can differ from the code that started it.

## Run it on your machine

```bash
npm run dev:local               # then open http://localhost:3000
```

- Browsing needs nothing.
- A build needs `MODEL_API_KEY` and `VERCEL_OIDC_TOKEN` in `.env.local` (the token comes from `npx vercel link` and `npx vercel env pull .env.vercel.local`, is good for 12 hours, and is copied into `.env.local` as in the [Judge path](../README.md#judge-path)). Without either, the Make page says so and builds are refused before anything is paid for.
- `BUILDER_SNAPSHOT_ID` is optional here. Without it, the first build installs its toolchain in the sandbox, which is slower.
- The database is PGlite in `.data/pglite`, files go to `.data/files`, and sign-in is off for localhost.
- Builds still run in Vercel Sandbox. The sandbox can't reach your machine, so products call Meta directly through the build firewall instead of the gateway, and their file uploads don't work.
- A local build stops after the demo video and isn't published to its own link, even with `VERCEL_TOKEN` set: the product would call this machine's gateway, which Vercel can't reach.
- The live preview in the build room works while the build runs.

| To do this | You need |
|---|---|
| Start the site and browse it | Nothing |
| Write a brief | The same as a build: `MODEL_API_KEY` and Vercel Sandbox credentials. A brief is a build's first step, and without Sandbox credentials the Make page refuses it with `no_sandbox` before any paid call (`buildSetupRefusal` in `lib/quota.ts`) |
| Build a product | `MODEL_API_KEY`, plus Vercel Sandbox credentials: `VERCEL_OIDC_TOKEN` (good for 12 hours). `BUILDER_SNAPSHOT_ID` (from `npm run snapshot`) is optional locally and makes builds start faster |
| Publish a product to its own link | Not possible from a local run: a product couldn't reach this machine's gateway. Use a Vercel deployment (see [Setup](#setup)) |
| Train a model | Not from a local run as it stands. Training starts only on production unless `TRAIN_ALLOW_OUTSIDE_PRODUCTION=1`, and a rented GPU has to reach the site to report back. See [TRAINING.md](TRAINING.md) |
| Run the outage drills or the drill bench | Nothing (`python3` for the bench) |

### Putting local products on the live site

Run `npx tsx --env-file=.env.local scripts/promote-local.ts --db .data/pglite --slug <slug>,<slug>` (add `--dry-run` first to see what it would upload and send). In order, it:

1. reads a copy of the PGlite folder and asks the live site whether it takes each bundle (`POST /api/admin/import-product?check=1`), so nothing is uploaded for a product it would refuse;
2. uploads each product's files from `.data/files` to the live Blob store at the same paths with your `VERCEL_OIDC_TOKEN`;
3. sends the rows to `POST /api/admin/import-product` with the `AUTOMATION_SECRET` bearer. The live site saves them under its guest account (its builds don't count against the guest's daily builds) and publishes each product from its sandbox the way a live build does;
4. waits up to 10 minutes for the links.

Only live products whose latest build is live go; the rest are skipped with the reason. When a publish ends without a link, run the same command with `--republish`: the live site publishes it again, once its last try has ended, with nothing uploaded again.

## Docker (not yet built)

```bash
cp .env.example .env.local
docker compose up --build       # then open http://localhost:3000
```

The Dockerfile was written without a Docker daemon to test it on, so the image has **not been built or run yet**. Use the npm path in the README.

- What has run nearby: the migrations on an empty PGlite folder, `npx next build` with no database on a laptop, and `npm run dev:local`. `next start` on PGlite has not.
- `compose.yaml` runs a production build on PGlite, Postgres in-process, in a Docker volume. Files stay in the same volume, sign-in is off for localhost, and the port is published on 127.0.0.1 only.
- No secrets go in the image. `.env.local` is read when the container starts, and compose overrides anything in it that would point at production's database or Blob store.
- There's no Postgres container, because the site uses Neon's HTTP driver, which can't reach a stock Postgres server. To use a Neon database, set `COMPOSE_DATABASE_URL` in your shell.
- Set `STORY_PAGES=1` in your shell before building to include `/offline`.
