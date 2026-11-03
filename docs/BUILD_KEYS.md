# The owner's shared accounts for builds

Built on Nov 2, 2026 (branch `tg-build-keys`). Off until the owner turns it on. None of it has run on a real build yet: it is built so, and tested with made-up keys.

## What it does

With `BUILD_SHARED_KEYS` on, a build started by someone signed in with the builder code can use the owner's own accounts on these services:

- Vercel
- AWS, through a limited user of its own (never root)
- Lambda, for GPU machines
- Hugging Face
- the Jetson fleet, with an inference-only `jik_` key
- Composio
- Fireworks, Baseten and Modal, the hosts of Muse Spark Open

For such a build:

1. The real keys go in the build sandbox's `.env.local`, under each service's usual name (`HF_TOKEN`, `AWS_ACCESS_KEY_ID` and so on).
2. The sandbox's firewall opens only the API hosts of the services whose keys it has.
3. The build prompt ends with a short section that names the accounts and the rules. The template skill `.agents/skills/shared-keys` says more.
4. When the product is published, the same keys are set on the product's own Vercel project as sensitive vars, so the live product keeps them.
5. Every change to the product checks again and keeps the product's keys in step.

## Who gets keys

The check runs on the server for every new build, every change, every chained session, every verify and every publish (`lib/keys/grant.ts`). A build gets the keys only when all of these hold:

- `BUILD_SHARED_KEYS` is on.
- At least one service is fully set up (below).
- The person who started the build or change has a real account:
  - not the shared guest account (`guest@musemuse.invalid`), and not any other `musemuse.invalid` address the platform keeps;
  - not banned;
  - and either signed in with an access code (their account has a password) or a listed admin.
- It isn't a new build that a product started by itself through its publish power. A change a person asks for on such a product does count.

For a change, the person checked is the one who asked for the change, not whoever built the product first.

## The risk, in plain words

Anyone who has the builder code can make a product that uses these accounts, and every product is public. So anyone with the code can:

- spend on these accounts, through the build or through the live product's routes;
- make a product that exposes a key, on purpose or by mistake. The checks below catch the obvious cases. They can't catch a product that sends a key somewhere at run time, or shows it on a page that is only made when a visitor asks;
- reach anything the key can reach.

Muse Code, the build agent, can read the keys while it builds. A prompt hidden in an uploaded file could try to make it misuse one. Every live product's visitors can call its routes, which run with the keys.

So give each service a dedicated key with the smallest scope and a spend limit (recommended limits are below). Treat every key as one that may leak, and be ready to revoke it.

## Setting it up

Set these on the platform's own Vercel project, production only. Previews act as admin, so leave them out of Preview. Each key must be new and dedicated, never one the platform already uses. A shared value that equals one of the platform's own keys is refused, and so is a Vercel team that is the platform's own team.

| Service | Set | Builds and products get |
|---|---|---|
| Vercel | `BUILD_SHARED_VERCEL_TOKEN`, optional `BUILD_SHARED_VERCEL_TEAM_ID` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID` |
| AWS | `BUILD_SHARED_AWS_ACCESS_KEY_ID`, `BUILD_SHARED_AWS_SECRET_ACCESS_KEY`, optional `BUILD_SHARED_AWS_REGION` (us-east-1 when unset) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Lambda | `BUILD_SHARED_LAMBDA_API_KEY` | `LAMBDA_API_KEY` |
| Hugging Face | `BUILD_SHARED_HF_TOKEN` | `HF_TOKEN` |
| Jetson fleet | `BUILD_SHARED_FLEET_URL` (https), `BUILD_SHARED_FLEET_KEY` | `FLEET_URL`, `FLEET_KEY` |
| Composio | `BUILD_SHARED_COMPOSIO_API_KEY` | `COMPOSIO_API_KEY` |
| Fireworks | `BUILD_SHARED_FIREWORKS_API_KEY` | `FIREWORKS_API_KEY` |
| Baseten | `BUILD_SHARED_BASETEN_API_KEY` | `BASETEN_API_KEY` |
| Modal | `BUILD_SHARED_MODAL_TOKEN_ID`, `BUILD_SHARED_MODAL_TOKEN_SECRET` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` |
| The switch | `BUILD_SHARED_KEYS=1` | |

- Only services whose required vars are all set are passed. A service that is half set up, or whose value has characters `.env.local` can't hold (`#`, `$`, quotes, spaces), is left out, and the platform's log says which var is wrong and why. It never prints a value.
- The platform's own vars (`MODEL_API_KEY`, `VERCEL_TOKEN`, `LAMBDA_API_KEY`, `HF_TOKEN`, `FIREWORKS_API_KEY`, `BOARD_FLEET_*` and the rest) are never read for this.
- Turn the switch on last, then start one test build with made-up data and check the build room says which accounts it has.

The firewall opens these hosts, only for a build with that service's key. An exact host has its Host header pinned, so a request can't be passed on to another site on the same network.

| Service | Hosts |
|---|---|
| Vercel | `api.vercel.com` |
| AWS | `sts.amazonaws.com`, `iam.amazonaws.com`, `s3.amazonaws.com`, `*.s3.amazonaws.com`, `*.<region>.amazonaws.com`, `*.s3.<region>.amazonaws.com` |
| Lambda | `cloud.lambda.ai`, `cloud.lambdalabs.com` |
| Hugging Face | `huggingface.co`, `*.huggingface.co`, `*.hf.co` |
| Jetson fleet | the host of `BUILD_SHARED_FLEET_URL` |
| Composio | `backend.composio.dev` |
| Fireworks | `api.fireworks.ai` |
| Baseten | `api.baseten.co`, `inference.baseten.co`, `*.api.baseten.co` |
| Modal | `api.modal.com`, `*.modal.run` |

## On publish and on changes

With the switch on, every publish makes the product's Vercel env match the build that published it:

- a build that may have the keys sets them as sensitive vars, which nobody can read back from Vercel, and deletes the shared names of services that are no longer set up;
- a build that may not (a guest's change, a banned account, a power child) deletes every shared name.

A change also rewrites the sandbox's `.env.local` and firewall from scratch. So a change without the keys takes them out of the sandbox too. Prove it runs on a copy of the sandbox whose `.env.local` loses the shared lines.

With the switch off, publishing leaves the product's env exactly as it was. Products published while it was on keep their keys until the kill switch runs.

## Leak guards

The platform takes every shared value, and its obvious encodings, out of what it stores or shows. The encodings are base64 and base64url (also inside a longer encoded string, such as a Basic auth header), percent encoding, hex, and `\/` escaping. This starts as soon as a `BUILD_SHARED_*` value is set, whatever the switch says. It covers:

- build events, written and read (the build room and its stream);
- a build's status message and error;
- verify's summary and the fix round's prompt, which is written from it;
- task output tails;
- the Muse Code transcript upload and its highlights;
- BUILD_NOTES.md as the platform reads it;
- the judge's text inputs;
- Demo Studio's cards, the old recorder's captions, and Demo Studio's captions (this last one in the template, so it needs a new snapshot);
- Muse Code cap sessions' scan.

The Code page, source.zip and the GitHub export hold back any file that carries a value. source.zip never has env files: they are hidden paths.

Checks that stop a build:

- **After every verify** of a build that has the keys, the platform runs `lib/keys/scan.ts` in the sandbox. It reads the source tree, `public/`, `.next/static` and the pages `next build` prerendered. It skips `node_modules`, `.git`, test output, `inspo/` and env files. Any value fails verify's new `keys` step, and the fix round is told which file and which var, never the value.
- **Before every publish:**
  - the same scan again, which fails closed;
  - every file about to deploy is checked for values;
  - for a build with the keys, a `NEXT_PUBLIC_` spelling of a key's name, or a key's name in `next.config`, is refused, since either would put the key in the browser's code.

  A hit stops the publish with a plain message.

## The kill switch

1. Set `BUILD_SHARED_KEYS` off (or remove it) on the platform. From then on, no new build, change or chained session gets the keys, no sandbox gets their hosts, and the next change to any product takes them out of its sandbox.
2. Run `npx tsx --env-file=.env.local scripts/keys/revoke-shared.ts`. It is a dry run: it lists every `musemuse-*` project with a shared var. Run it again with `--apply` to delete them. Name projects after `--apply` to limit it. It uses the platform's `VERCEL_TOKEN` and `VERCEL_TEAM_ID` and prints only names.
3. Revoke every key at its service. This is the step that actually stops a key: a live deployment keeps the env it was built with until it redeploys, and sandboxes and their saved snapshots keep their `.env.local` until the next change.

## Recommended limits per service

- **Vercel:** a token scoped to a separate team made only for this, so it can't touch the muse-muse project or the products' team. Set a spend limit on that team.
- **AWS:** a new IAM user (never root, never an admin) whose policy lists only the actions and resources products need, for example one S3 bucket with a prefix. Add a permissions boundary, a budget alert, and no IAM actions. Rotate the key after the hackathon.
- **Lambda:** keys can't be scoped, so set a spend alert and a low instance quota on the account, and check it daily for running machines.
- **Hugging Face:** a fine-grained token for one org, with only the repos and permissions products need (read, or write to one org's repos). Never a token for the owner's personal account.
- **Jetson fleet:** a `jik_` key that is inference-only, with a daily limit. Keep jetson-05 out of its routes.
- **Composio:** a project-scoped key for a project made for this, with only the toolkits products need and no personal connected accounts.
- **Fireworks, Baseten, Modal:** a dedicated account or workspace for Muse Spark Open, with a spend limit, and no other deployments in it.

## What the guardrails don't cover

- A product can still leak a key at run time: a route that returns `process.env.X`, a page made on request, a call that sends the key to a site the product chose. The checks read files, not behavior.
- Screenshots and demo videos are images. A page that shows a key would show it there, and nothing can redact pixels.
- Muse Code reads `.env.local` while it builds, and an uploaded file could carry instructions to misuse a key.
- The AWS wildcards include endpoints anyone can create (for example API Gateway in that region), so a build can reach more than the owner's resources.
- Removing a var from a project doesn't change a deployment that is already live (step 3 of the kill switch).
- The template parts (the skill and Demo Studio's caption guard) reach builds only after a new builder snapshot (`npm run snapshot`). Until then the prompt section carries the rules, and the platform's own checks and redaction work on any snapshot.
- Setting the vars and the Vercel `sensitive` type are built from Vercel's API docs and have not run against the real API yet.

## Code

- `lib/keys/shared.ts`: the services, names, hosts, the principal rule, `.env.local` lines, the prompt section, redaction and the file check.
- `lib/keys/grant.ts`: the server's per-build check.
- `lib/keys/scan.ts`: the in-sandbox scan and verify's `keys` step.
- `lib/keys/revoke.ts`, `scripts/keys/revoke-shared.ts`: the kill switch.
- `lib/sandbox/policy.ts` (`sharedHosts`), `lib/sandbox/builder.ts`, `lib/pipeline/build-steps.ts`, `lib/publish/vercel.ts` (`syncSharedEnv`): wiring.
- `template/.agents/skills/shared-keys/SKILL.md`, and `template/scripts/demo-plan.mjs` with `demo-studio.mjs` for the captions.
- Tests: `lib/keys/__tests__/`, `lib/publish/__tests__/shared-env.test.ts`, the shared-hosts test in `lib/sandbox/__tests__/policy.test.ts`, and `template/scripts/__tests__/shared-keys.test.mjs`.
