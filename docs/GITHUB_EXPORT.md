# Export to GitHub

Behind `GITHUB_EXPORT`, off by default. Off: no button, no reads, and all four routes answer 404. A person who may read a product's code connects their own GitHub account, names a repo (private unless they untick it) and gets every saved version as a commit. Later versions go up with Push new version. Download source stays either way.

## What the owner must create

1. A GitHub **OAuth App** (GitHub, Settings, Developer settings, OAuth Apps, New). Not a GitHub App.
   - Homepage URL: the production site.
   - Authorization callback URL: `<PLATFORM_URL>/api/connect/github/callback`. Production is `https://<production host>/api/connect/github/callback`.
   - An OAuth App holds one callback URL, and the site sends its own `env.platformUrl`. A Preview on its own URL needs a second OAuth App whose callback names that URL.
2. Settings, per environment: `GITHUB_EXPORT=1`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `CONNECTED_ACCOUNTS_KEY` (32 random bytes in base64, its own key: `openssl rand -base64 32`).
3. Run the migration `drizzle/0031_connected_accounts.sql` (two new tables, nothing changed).

Missing any of these, the page says GitHub export isn't set up and keeps the zip.

## Decision for the owner: the `repo` scope

GitHub has no narrower OAuth App scope that can make a private repo, so the app asks for `repo`, which also reaches the person's other repos. The code limits itself: a push only goes to a repo named in `code_exports`, which this site created, and the page says so. A GitHub App would be properly narrow, but needs an install step and a different token flow. Not built.

## How it fits together

- `lib/connected/owner.ts`: who a connection belongs to. A signed-in person by account. Anyone on the shared open-access account, including admin mode, by a random httpOnly browser cookie (`mm_connect`), stored only as a hash. It's handed out only when connecting.
- `lib/connected/store.ts`: generic store keyed by provider. Tokens sealed with `lib/secrets/box.ts`, bound to provider, owner and outside account, so a copied row doesn't open. Disconnecting wipes the sealed bytes.
- `app/api/connect/github/{start,callback,disconnect}`: sign-in. The state is random, in a signed httpOnly cookie, single use, 10 minutes, and tied to the owner who started it. Grants without `repo` are refused and ended. Disconnect also ends GitHub's grant, and says if it couldn't.
- `app/api/products/[slug]/github-export`: `canReadCode`, then only the caller's own connection. 12 pushes an hour per owner, 120 across the site.
- `lib/github/git.ts`: objects, packs and smart HTTP receive-pack in plain Node, because a Vercel function has no git program to rely on. Token in a header, never a URL.
- `lib/github/history.ts`: saved versions to commits. Commit ids are repeatable, so a push whose database write was lost is recognised on retry.

## What goes in a repo

The saved files of each finished version, oldest first. Every file is re-read through `readVersionFile`, so its SHA-1 and secret checks run again. Hidden paths never go. Held files and files over 50 MB are named in that commit's message. One push handles 64 MB of distinct content: older versions that don't fit are left out and counted in the first commit's message. A build still running waits for the next push.

Known limits: files go up as `100644`, because versions don't save the executable bit. The secret check knows key shapes only, so a public repo warns first, as Make public does.

## It never overwrites

A push names the commit it expects and never forces. If the repo has a commit from elsewhere, the answer is `repo_changed` and nothing moves. A taken name is refused, so an existing repo is never adopted. A deleted repo clears the record so the person can export again. A token GitHub dropped ends the connection and asks to reconnect.

## How it was tested

- `lib/github/__tests__/push.realgit.test.ts`: real pushes to bare repos behind `git http-backend`, with `receive.fsckObjects` on, read back by real git.
- `lib/github/__tests__/routes.test.ts`: the real routes on PGlite, with separate cookie jars on one shared guest account.
- `scripts/github-mock.ts`: the pretend GitHub. Its REST and OAuth parts are written from GitHub's documented shape. `GITHUB_WEB_URL_LOCAL` and `GITHUB_API_URL_LOCAL` point at it, honoured only off Vercel and only for a loopback host.

Never run against real GitHub. Seeing it there needs the OAuth App above: check sign-in, private repo creation, the `x-access-token` basic auth on a push, and the grant revoke.

## Estimate: connect your Hugging Face on this store

About 5 to 7 hours of agent work, plus about 15 minutes of the owner's time to make a Hugging Face OAuth app. This is an estimate from what was built, not a measurement, and Hugging Face's OAuth details below haven't been checked against its docs or a real run.

| Part | Time | Why |
|---|---|---|
| Store and owner binding | 15 min | Reused as is: add `"huggingface"` to `Provider` |
| Sign-in routes | 1 hour | Same shape as GitHub's. Today's state helpers and routes name GitHub, so they need one small generalising pass |
| Expiring tokens | 1 to 1.5 hours | The one real gap. The store seals one token with no expiry or refresh token. If Hugging Face's tokens expire, as expected, it needs both, and a migration |
| Uploading to the person's namespace | 2 to 3 hours | The real work: lib/train uploads with the platform's `HF_TOKEN` to one namespace, so publish must take a chosen token and namespace, without that token reaching a GPU box that doesn't need it |
| Tests, including the guest test | 1 hour | The guest isolation test carries over nearly unchanged |
