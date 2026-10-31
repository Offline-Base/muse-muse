# Muse Code in products spike, Oct 31, 2026

## Status: blocked before any measurement

**No sandbox was started and no Meta call was made. Spend is $0.** The main question, whether Muse Code can send all its model
traffic to a custom endpoint, is still open.

`VERCEL_OIDC_TOKEN` in `/Users/ethancastro/muse-muse-builds/.env.local` expired on Oct 29, 2026 at 01:05 UTC, and the Sandbox SDK
refuses it (`LocalOidcContextError`). The spike's instructions say to stop and report when Vercel auth has expired, not to look
for another credential, and never to run `vercel env pull`. So these were not tried:

- `vercel env pull`, which is how `docs/spikes/xr-2026-10-31/run.sh` gets a fresh token.
- `VERCEL_TOKEN` from the same file. The SDK takes `{ token, teamId, projectId }`, but that token is the publish credential, and
  `VERCEL_PROJECT_ID` isn't in the file.
- Running from the linked checkout so the SDK refreshes the token itself. That relies on the Vercel CLI login, which is another
  credential.

The Meta key was not tested, so a 401 could still be waiting.

## What's needed to continue

One owner decision, either of:

1. Put a fresh OIDC token in that `.env.local` (`vercel env pull` from the linked checkout, good for 12 hours), or allow the spike
   to do the same to a temporary file as `xr-2026-10-31/run.sh` does.
2. Allow `VERCEL_TOKEN` with the team and project ids for sandboxes.

Then rerun with the limits unchanged. Everything on the free firewall comes first.

## Results

| Measurement | Result |
|---|---|
| 1. Every model call goes to the custom endpoint | Not measured |
| 1. Routes needed, `background`, multipart, compaction, reminders | Not measured |
| 2. Session settings for a stranger's task, empty workspace | Not measured |
| 3. Cold start, stop latency | Not measured |
| 4. Two real tasks, cost, metering agreement | Not measured |
| 5. No key visible from the session's shell, example.com refused | Not measured |
| 6. Meta's terms | Read, see below |
| Leftover `musecode-spike-*` sandbox from the earlier copy | Could not check, see below |

**The earlier copy.** It left `run.ts` and `phase-0.sh` here and no output. No spike process is running on this Mac. The same
expired token would have stopped it from creating a sandbox if it used this env file from this worktree, but that's an inference.
If it did create one, `run.ts` gives it a 40-minute timeout and it isn't persistent, so it ends by itself by about 14:40 EDT at the
latest. Its Meta spend can't be read either: Meta has no usage API (`serve-2026-10-31/README.md`).

## What the repo already says (not measured here)

Reading only. Treat all of this as leads for the rerun.

**The custom endpoint might exist.**
- Changelog: "`tbh serve -c` settings such as `endpoint_transport.base_url` now reach the model provider instead of being silently
  ignored" (`content/meta-docs/pages/muse-code/changelog.md`, line 437). It names `tbh serve`, not `muse serve`.
- Changelog, line 1452: a fix for startup failing "when a saved login was paired with a keyless custom endpoint".
- The binary's strings include the key `endpoint_transport` (`docs/spikes/muse-full-2026-10-30/phase-A.txt`, line 397).
- `muse serve --help`: `-c` values are JSON, secrets are allowed only as whole-value `${VAR}`, and unknown or clashing keys refuse
  the run. So a wrong key should fail loudly rather than silently go to Meta. That also needs checking.
- The Muse Code docs mirror has no page that documents the setting.

**The form to try first, untested:**

```
muse serve --disable-sandbox --trust-workspace --disable-request-user-input \
  --model muse-spark-1.3-contributor \
  -c 'endpoint_transport.base_url="http://127.0.0.1:8787/v1"'
```

Unknown: whether the URL takes `/v1`, whether the catalog route `/muse-code/models` follows it (it isn't under `/v1`), which key
is sent, and whether anything else still goes to api.meta.ai.

**A trap for the rerun's hard model limit.** `lib/sandbox/muse.ts` line 56 and `serve-2026-10-31/README.md` (Bug 2) say `muse serve`
turns a contributor id in `background_agent_model` back into `muse-spark-1.3`. So `backgroundModelSetting("muse-spark-1.3-contributor")`
may not keep reminder agents on Contributor, and the rule says never `muse-spark-1.3`. `phase-1g.sh` tested this but its output
wasn't kept. On the rerun, in this order:

1. Turn reminders off, and look at the model on each attempted call on the 403 firewall before any paid call.
2. Have the proxy forward only `model: muse-spark-1.3-contributor` and answer anything else 403 without forwarding.
3. Delete `~/.local/share/muse/model-catalog` before each `muse serve`, or the row is skipped from the second round on (Bug 3).

**Reasoning effort.** The changelog (line 832) says exec defaults Spark 1.3 Contributor to `max`, and the reasoning docs say `max`
isn't available on that model. Set the effort explicitly to low.

## Meta's terms (a reading, not legal advice)

**The repo has no copy of Meta's terms, so it can't answer whether offering Muse Code sessions to a product's users is allowed.**
Someone needs to read these two pages themselves, as they stand on the day:
`https://dev.meta.ai/legal/terms-of-service` and `https://dev.meta.ai/legal/acceptable-use-policy`.

Searches of `content/meta-docs` and `docs/knowledge-research`:

| Search | Found |
|---|---|
| "Model API Terms" | Links in `muse-code/subscriptions.md`, and partial notes in `knowledge-research/meta.md` and `claim-check-2026-10-30.md`, all about training |
| "resale", "resell" | Nothing about Meta's terms. A cookbook resale photo, and other organizations' data licenses |
| "sublicense" | Nothing about Meta's terms. Government data licenses only |
| "on behalf", "your users" | No hits |
| "third part" | Nothing about Meta's terms |

What does bear on this, from those notes and the docs:

- **The subscription key is for Muse Code only.** "This credential is for use with Muse Code only", and other keys bill pay-as-you-go
  (`subscriptions.md`, line 7). A platform should use a pay-as-you-go API key, as it does today. Whether a subscription may serve
  other people isn't stated.
- **Meta can revoke access for violating the terms** (`subscriptions.md`, line 107), so a wrong reading could cost the whole account.
- **Outputs and training.** Section 10.1(ix), as quoted in `meta.md`, bars using outputs to build competing models. A product that
  hands users Muse Code's output passes that risk along, and the terms' own text isn't here to say what users must agree to.
- **Contributor means Meta may train on the content** (`models.md`, `pricing-rate-limits.md`). A real user's task should not run on it.
- **The API has end-user fields.** `safety_identifier` and image `user` exist so one person can be acted on, which suggests Meta
  expects apps that serve end users. That's about the API in general, and it says nothing about Muse Code sessions.

## What it means for the design

Nothing in `_plan/muse-code-products.md` can be confirmed yet. Section 3, step 3 stays conditional, the fallback stays as written,
and the feature shouldn't be built on the assumption that the gateway route works. Changes it needs now, whatever the rerun finds:

1. **Models.** The limits table says "Muse Wonder only, never Contributor". The owner has since said testing and examples use
   `muse-spark-1.3-contributor`, and the real product can use Wonder. Split the row: products on Wonder, testing on Contributor with
   made-up text only. That includes a build's real sessions and the recorded replays.
2. **Never let a user's task reach Contributor.** Per the comment at `lib/gateway/policy.ts` line 7, the gateway serves
   `muse-spark-1.3` as Contributor. If a session's background call asks for `muse-spark-1.3`, as Meta's catalog default does on
   Wonder, the gateway could send that person's task to a tier Meta may train on. The `code_session` scope should refuse it instead.
   This wasn't traced through the handler.
3. **Agent tokens are kept off Contributor** (`lib/gateway/rewrite.ts`). Decide whether a `code_session` token counts as one, since
   test sessions need Contributor and live sessions must not have it.
4. **Keep reminders off for sessions**, or set them per model, because of the trap above. The serve test also found reminders
   were often most of the cost.
5. **Terms.** Add a read of the terms by the owner or counsel as a condition of turning visitors on. It's more than a spending
   decision.
6. **Budget.** Step 1 of the order says about $1.50. This spike's cap is $0.50.
7. **Order.** Step 1 isn't done. Don't start the build until it is.

## Fallback

Unchanged from the plan, and also unmeasured: firewall broker, live metering from `session/tokenUsage`, a kill at the cap, and a
written worst-case overspend, with visitors off.

## Files

Nothing here has run successfully.

- `run.ts` runs phases in a throwaway sandbox. From the earlier copy. Its header describes a `proxy` firewall that isn't defined in
  `policies`, so naming it will fail. It uses the SDK's default credentials.
- `phase-0.sh` is the free first step: help text, schema and binary strings, with all model calls refused.
- `list.ts` finds leftover `musecode-spike-*` sandboxes. It's the first thing to run once auth works, and its reading of the SDK's
  list result is unchecked.
- Still to write: the recording proxy and the paid phases, which depend on what `phase-0.sh` finds.
