# Modal as a second build host

Muse Code builds run in Vercel Sandbox. Since Nov 2, Modal can be a second host, behind a flag. With the flag unset, nothing
changes: the builder calls @vercel/sandbox exactly as before.

State on Nov 2: the Modal host passed a live smoke test (below). No Muse Code build has run on Modal yet, and the builder
image for Modal hasn't been made.

## Turn it on

1. Make the builder image once: `npx tsx scripts/dev/modal-builder-image.ts` (built, not run yet). It prints
   `MODAL_BUILDER_IMAGE_ID`.
2. On Vercel, set these, then redeploy:

| Name | What |
|---|---|
| `SANDBOX_HOST` | `modal`. Unset, or anything else, means Vercel Sandbox |
| `MODAL_TOKEN_ID` | A Modal token's id. Modal's SDK reads it from env |
| `MODAL_TOKEN_SECRET` | That token's secret |
| `MODAL_BUILDER_IMAGE_ID` | The image id from step 1 |
| `MODAL_APP_NAME` | Optional. The Modal app the sandboxes go under. Default `musemuse-builds`, made on first use |

Turn it off by removing `SANDBOX_HOST` (or setting it to `vercel`) and redeploying. A build that started on one host
finishes there only if the flag doesn't change mid-build: the flag is read on every step.

Locally, the smoke test uses your Modal login: `npx tsx scripts/dev/modal-smoke.ts`. A Modal build needs a public
`PLATFORM_URL`, so `npm run dev:local` builds can't use Modal.

## What is ported

`lib/sandbox/host/` holds a small host interface (`types.ts`), the Vercel host (`vercel.ts`, which hands back the SDK's own
Sandbox), and the Modal host (`modal.ts`, on Modal's JS SDK, npm `modal` 0.11.1). `lib/sandbox/builder.ts` runs on the
interface: provision, warm start, reopen, Prove it copies, Muse Code on exec and on the bridge, polling, notes, kill,
preview, tasks, verify and demo collection, file reads and writes, stop and delete.

How the Vercel calls map:

| Vercel Sandbox | Modal |
|---|---|
| Named, persistent sandbox | Named sandbox in one app. Names are unique among its running sandboxes |
| Stop, then resume by name | `stop()` writes the tags and egress to `/var/tmp/musemuse-host.json`, snapshots the filesystem, publishes the image as `musemuse-<name>`, and terminates. A resume starts a new sandbox with the same name from that image, with egress shut until it has read that file back |
| Start from the builder snapshot | Start from `MODAL_BUILDER_IMAGE_ID`, or from `node:22-bookworm` with nothing set |
| `fork` for Prove it | A fresh filesystem snapshot of the running source |
| Detached command, found by id | Started under `setsid`; its pid and exit code go in `/var/tmp/musemuse-cmds/`. Polls read them, kill signals the pid |
| `domain(3000)` | The URL of an encrypted tunnel on port 3000 |
| 4 vCPUs, 60 minutes, extended as needed | 2 Modal cores (4 vCPUs) and 8 GB, 3 hours from the start. Modal can't extend a running sandbox |
| Firewall with brokered key | Domain allowlist, plus the platform's Meta proxy (next section) |

Not ported, still on Vercel Sandbox whatever the flag says: the native packager (`lib/native/packager.ts`), caps code
sessions (`lib/caps/code/`), the extension ship step, the edge drill sandbox (`lib/pipeline/edge-drill-sandbox.ts`),
restore steps (`lib/pipeline/restore-steps.ts`), publishing (`lib/publish/vercel.ts`), quota (`lib/quota.ts`), the train CLI runner (`lib/train/host/cli-runner.ts`), and the
dev scripts under `scripts/dev/`. Dry runs (`forkForDryRun`) refuse to run on Modal, since their products call Meta
directly through the firewall.

## The builder image on Modal

`scripts/dev/modal-builder-image.ts` boots `node:22-bookworm` on Modal with open egress and runs the same
`setupBuilder` as `npm run snapshot`: system tools, fonts, Playwright's Chromium, Muse Code, `template/` with `npm ci`, and
the pristine and targets copies. Then it stops the sandbox, which publishes the image with no expiry, and prints its id.
It doesn't repeat the Vercel script's checks of the pristine and targets copies. Caps still read
`lib/sandbox/snapshots.json`, which is keyed by the Vercel snapshot id, so a Modal build offers the caps the Vercel snapshot
has. Commands run as root on Modal, so `sudo` steps need nothing.

## The Meta key

On Vercel, the firewall swaps a per-sandbox placeholder for the real key on Muse Code's routes only. Modal has no rule
that matches a path and a header. So on Modal:

- Muse Code's endpoint is the platform: `endpoint_transport={"base_url":"<PLATFORM_URL>/api/sandbox-meta/v1","auth":"bearer"}`,
  with telemetry off. It asks for its catalog at `<PLATFORM_URL>/muse-code/models`.
- Its key is a token for that one sandbox, signed with an HMAC of the real key, that stops working after 3 hours.
- `app/api/sandbox-meta/v1/[...path]` and `app/muse-code/models` (`lib/sandbox/host/meta-proxy.ts`) answer 404 unless
  `SANDBOX_HOST=modal`. They check the token, forward only the routes in `BROKERED_META_ROUTES` with their methods, and
  answer 403 to everything else. They send the real key from server env, and only Content-Type and Accept from the request.
- api.meta.ai isn't on the sandbox's domain allowlist, so a direct call from the sandbox doesn't get out.
- The real key never enters a Modal sandbox: not its env, files or egress rules. The unit tests check that no create or
  update sent to Modal holds the key or the Protection Bypass secret.

## What Modal can and can't restrict

Measured in the smoke test: with a domain allowlist, an allowed domain answered, and api.meta.ai and a bare IP
(1.1.1.1) got no connection. The allowlist came back after a resume.

Gaps, compared with the Vercel firewall:

1. **The token works from anywhere.** On Vercel the placeholder is only worth something inside that sandbox. A Modal
   proxy token that leaks out of a sandbox can call Muse Code's Meta routes from anywhere until it expires (3 hours).
   The proxy doesn't check that the sandbox is still running, doesn't pin a source IP and doesn't meter spend.
2. **No per-route or per-method rules on other hosts.** Modal allows a domain or not. Cap hosts that Vercel limits to
   some methods (PyPI: GET) are open to every method on Modal.
3. **No Host header pinning.** Modal's allowlist is by domain name. Whether a request can name an allowed domain and
   send a different Host header (domain fronting through a shared CDN, such as Vercel's edge for the platform host) was
   not tested. No secret is added to requests on Modal, so this would open a path out, not leak a key.
4. **No Preview bypass.** The firewall adds the Protection Bypass secret for a protected Preview. Modal can't, and the
   secret never goes in, so a Modal build can't reach a protected Preview. Use production, or a Preview without
   protection.
5. **No snapshot on timeout.** A Vercel persistent sandbox snapshots when its session ends. A Modal sandbox keeps its
   files only through `stop()`. One that hits its 3 hours, or crashes, loses its work, and the next build of that product
   starts fresh. Modal's exit snapshots are experimental and not used.
6. **Deleted images keep their name.** Modal still resolves a published name after its image is deleted (measured).
   A resume from one fails at once and is treated as "no such sandbox".
7. **Root.** Commands run as root, so the pristine copy of the platform files is no harder to change than on Vercel,
   where uid isn't a boundary either (docs/spikes/musecode-2026-10-31).
