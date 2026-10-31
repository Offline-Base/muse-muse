# Muse Code in products spike, Oct 31, 2026

## The answer

**Yes. Muse Code 1.4.14 in a Vercel Sandbox sends all its model traffic to a custom endpoint, and a proxy on that endpoint metered
it to the cent.** Main turns, tool loops, subagents, compaction and reminder agents all went there, on real paid calls. The one thing
that ignored the endpoint was Muse Code's telemetry, and one setting turns that off.

Three things change the design:

1. The session token is a usable stand-in inside the VM. The shell can read it, and uid is no boundary in this VM (see Security).
2. The gateway as it stands would refuse or choke these calls: Contributor isn't on its list, and on Wonder its estimate for one call
   is about $0.76 against a $1.00 session.
3. An agent can read and copy the Muse Code binary, and neither chmod nor removing sudo stops it.

Spend: **$0.052931 of the $0.50 cap**, 55 paid calls, all on `muse-spark-1.3-contributor`. 14 sandboxes, all verified stopped.

## The exact way to set it

```
META_API_KEY=<session token> muse serve --disable-sandbox --trust-workspace --disable-request-user-input \
  --model <model> \
  -c 'endpoint_transport={"base_url":"https://<platform host>/api/gateway/v1","auth":"bearer"}' \
  -c 'telemetry.enabled=false' \
  -c 'tools.web_search.mode="off"' \
  -c 'runtime_capabilities={"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:scope-reminder":{"enabled":false}}'
```

With the bridge, those `-c` values go in `BridgeConfig.settings` and `META_API_KEY` in the runner's environment. Delete
`~/.local/share/muse/model-catalog` before each serve. Use the bridge's own session start: `approvalMode: "allowAll"`, and set
the effort explicitly.

Each part was measured:

| Form | What happened |
|---|---|
| `auth:"bearer"` pinned, HTTPS, non-loopback host | Key sent (`results/p10`, b3 and b6). `endpoint_transport.auth="bearer"` as a dotted key works too |
| No pin, HTTPS, non-loopback host | **Key withheld, no Authorization header** (b4). The binary says why: "Meta bearer withheld: base_url is off the sanctioned front door. To opt in, set the base_url in settings `endpoint_transport` AND pin its `auth = "bearer"`". So the pin is required |
| No pin, loopback | Key sent (c1), which would have hidden this on a local test |
| `auth:"none"`, no key | Runs, but **`muse-spark-1.3-contributor` is rewritten to `muse-spark-1.3` on the wire** (d4, k1, k2, k3, even with `contributor_mode_enabled=true`). Never run keyless |
| `base_url` alone, no key | Fails at once: "not logged in" (c4) |
| A wrong key (`endpoint_transport.nope`) | Refuses the start with exit 2 (c5). It can't silently fall back to Meta |
| `muse exec --base-url` | Also reached the proxy on loopback (e8). The design doesn't use exec |

Web search was off in every paid run. `feature_config.enabled=false` is also accepted but made no difference: with telemetry off alone
there were no direct calls.

## Method

A recording proxy (`proxy.mjs`) on 127.0.0.1:8787 logs method, path and selected body fields, never headers or keys, and forwards to
api.meta.ai with the sandbox's placeholder, which the firewall swaps for the real key. It forwards only
`muse-spark-1.3-contributor` and answers anything else 403, with a logged reason, and stops at a budget. Muse Code got a different
stand-in, so the `proxy` firewall in `run.ts` refuses any call that skips the proxy.

The firewall has no log of what it blocks, and `/etc/hosts` is read-only in a sandbox, so direct calls were caught another way:
`sink.mjs` answers `HTTPS_PROXY` CONNECTs with its own TLS server, logs the method and path, and refuses. The control run with no
custom endpoint proved it sees them, and `ss` polling confirmed nothing else left. Task b2 then ran with no `HTTPS_PROXY`, so only the
firewall was watching, and any direct call would have failed the turn.

Everything free came first: strings, then a firewall answering 403, then the catalog, then one $0.0025 call, then the tasks.

## Results

### 1. Does every model call go to the custom endpoint?

Every route seen in 14 sandboxes:

| Method and path | Went to | Body | Notes |
|---|---|---|---|
| `POST {base_url}/responses` | Endpoint | JSON, `stream: true` | Main agent, tool loops, subagents, reminders. 50 of the 55 paid calls |
| `POST {base_url}/responses` | Endpoint | JSON, **no `stream`** | The compaction summarizer. The other 5 paid calls. No `instructions`, adds `tool_choice` and `parallel_tool_calls` |
| `GET /muse-code/models` | Endpoint host, **always at the root** | | `/v1` and any prefix are dropped: base `/api/gateway/v1` still asks for `/muse-code/models` (b1). **Optional:** a 403 here and the turn still completed (n1) |
| `POST /muse-code/telemetry/logs`, `/traces` | **api.meta.ai directly, ignoring the endpoint, with the key** | protobuf | 7 calls in a 4 second session. Gone with `telemetry.enabled=false` |

- **Never seen:** `/v1/models`, `background: true`, multipart, `/v1/files`, `/muse-code/config`, `previous_response_id`, `safety_identifier`.
- **Every body carries:** `include, input, instructions, max_output_tokens, model, prompt_cache_key, reasoning, store: false, stream, tools`.
  `max_output_tokens` is **128000**. `tools` is one `namespace` entry holding 28 to 30 tools (17 for a subagent, 1 for a reminder). The largest body was 141 KB, and the first
  is about 116 KB, or 25,000 input tokens.
- **Firewall proof:** with only the proxy able to get the real key, tasks finished. The stand-in sent straight to api.meta.ai got the
  firewall's 403 (`results/p5/inside.txt`), and the same setup with no endpoint failed its turn with that refusal (`results/p1`, c0).
- **Compaction:** forced with `context_compaction={"soft_threshold":0.5,"hard_threshold":0.8,"provider_context_limit_tokens":30000}`.
  Three real compactions in c1, all through the endpoint. `session/compact` works too (c2), but was refused
  `compaction_unavailable` on a short session at the default limit (g2). The cause wasn't found.
- **Subagent:** ran and wrote its file, 6 calls through the endpoint (g3).

### 2. Session settings for a stranger's task

- **Empty workspace:** works, no git, no product code. Node task and page task both ran from an empty folder.
- **`approvalMode: "allowAll"`:** no approval event in any run.
- **Reminders off:** the setting above removes them. With them on, g4 made 6 calls for 3 main-agent steps. With them off, calls and main-agent steps match.
- **`backgroundModelSetting`:** accepted, and made no difference on Contributor. On this path the trap in
  `serve-2026-10-31/README.md` **did not reproduce**: reminders stayed on Contributor on the wire, with and without the row, in a first
  serve round with the catalog copy deleted (g4, g5). A second round in one sandbox wasn't tested. One reminder call also ran at effort
  `high` while the session was on low. So reminders stay off anyway, for cost.
- **On Wonder, unmeasured here:** the live catalog still gives `muse-wonder-1.0` a `background_agent_model` of `muse-spark-1.3`, and
  Contributor no such field. Keep `backgroundModelSetting(model)` on Wonder, or a compaction might ask for a model `code_session` refuses.
- **A missing file is a "success":** task b as written had no CSV to read. Muse Code asked for one in its final text, made nothing,
  and the bridge reported `completed`, exit 0. The UI must show that text, and "worked" must look at the files.

### 3. Cold start and stop

Three fresh sandboxes, BUILDER_SNAPSHOT_ID, 2 vCPUs:

| From `Sandbox.create` | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Sandbox created | 1.8 s | 0.4 s | 3.4 s |
| SDK installed from npm | 3.7 s | 2.3 s | 5.5 s |
| **First session event** (`session/started`) | **5.57 s** | **4.21 s** | **7.89 s** |
| First model call reaches the endpoint | 5.62 s | 4.26 s | 7.99 s |

| Stop request | Bridge gone | `muse serve` gone | Tool's child process gone |
|---|---|---|---|
| Mailbox `end`, tool running | 1.94 s | 1.37 s | 0.53 s |
| SIGTERM, tool running | 0.40 s | 0.40 s | 0.08 s |
| SIGTERM, model call open | 1.05 s | 1.05 s | none |
| `sandbox.stop({ blocking: true })` | 1.1 to 1.4 s for the whole VM | | |

Nothing outlived a stop. What Meta charges for a stream cut off midway wasn't measured: the proxy gets no usage line for it, and
Meta has no usage API.

### 4. Two real tasks on `muse-spark-1.3-contributor`, effort low, started by the bridge

| Task | Seconds | Cost | Result |
|---|---|---|---|
| (a) "Write a Node script that dedupes a CSV by email, add a test, run it." | 28.0 | $0.006434 | **Worked.** 9 calls. `dedupe.js`, a test, `package.json`. My own rerun: 2 tests pass (`results/p7/task-a`) |
| (b) "Make a small static HTML page that shows the CSV as a sortable table." | 8.6 | $0.002785 | **Did not do it.** No CSV in the workspace, so it asked for one and made nothing |
| (b) again, plus a made-up 4-row `people.csv` | 19.7 | $0.003068 | **Worked.** 4 calls. In the sandbox's Chromium, clicking a header sorted up, again sorted down (`results/p8/task-b2`, `results/p10`) |

On the same token counts at Wonder prices, task (a) would be about $0.30. That's arithmetic, not a measurement.

**Live metering: the proxy and `session/tokenUsage` agree only for the main agent.**

| Run | Proxy calls | Proxy cost | `session/tokenUsage` events | Its cost | Missed |
|---|---|---|---|---|---|
| f1, g1, t-a, t-b, t-b2, n1, s1, s2 (main agent only) | 1 to 9 | same | same | same | 0 (at most $0.000001) |
| g3 (subagent) | 6 | $0.004921 | 3 | $0.002796 | **43%** |
| g4 (reminders on) | 6 | $0.004994 | 3 | $0.002723 | **45%** |
| g5 (reminders on, row) | 6 | $0.003785 | 3 | $0.002737 | **28%** |
| c1 (compaction) | 7 | $0.009856 | 4 | $0.006289 | **36%** |

So a gateway sees true cost, live, and `session/tokenUsage` alone doesn't. This matters for the fallback.

### 5. From inside the session's shell (`inside.mjs`, `results/p5/inside.txt`)

Run by the model through its own shell tool. Prints names, counts and hash matches, never a value.

- **Real key:** not in the environment, not in 3,731 files read, not in any readable `/proc/*/environ` or `cmdline`.
- **example.com, http and https, and github.com:** refused, curl exit 6.
- **api.meta.ai:** 403 firewall refusal, with no key and with the shell's key.
- **registry.npmjs.org:** 200, as allowed. The "GET only" rule in the plan wasn't tested.
- **The session's own key is visible:** `META_API_KEY` is in the shell's environment, and in `/proc` of the processes that hold it. It's in no file, including session logs.
- **The placeholder was readable too,** in two `/proc/*/environ` entries, which belong to this spike's own root proxy and its launcher (not a product
  path). It was only compared by hash. It shows that anything passed into this VM can be read.
- `shell_environment_policy` isn't a setting (exit 2). The binary mentions an `environment_policy`, not pursued, since `/proc` would still show it.

### Security: uid is no boundary here

`/proc/self/status` for the `ubuntu` user: `CapEff: 000001ffffffffff`, which is every capability. It read `/etc/shadow`, and it read a
root-owned file with mode 711. `sudo -n` also works, and it can be removed (`/etc/sudoers.d`), but the capabilities stay. The firewall is the
only boundary in this design, because it's outside the VM.

### The binary

**An agent can read it, copy it into the workspace and run the copy.** Done from a session's shell: `cp` of `/vercel/.local/bin/muse-bin-1.4.14-R7309.1`
(414,927,192 bytes, identical by `cmp`, and `--version` ran). It gzips to 170,566,950 bytes at level 1. Root ownership and mode 711 didn't stop `cat` or
`cp`, nor did `/proc/<pid>/exe` (`results/p6`). `fx`, 14 MB, is next to it.

To keep it out of the zip:

1. Zip only the workspace, and never follow a symlink.
2. Drop any file whose sha256 matches `muse-bin-*` or `fx`, hashed before the session starts.
3. Drop ELF files, or anything over a size per file.
4. Keep the 50 MB total. It stops the whole binary, since gzip gives 170 MB.

**Still open:** an agent told to split it could take out a piece under 50 MB per session. That can't be closed from inside the VM. Not built or tested here.

## Refused calls

- **Paid runs: none.** No call for another model was attempted once there was a key.
- **`muse-spark-1.3` attempted 4 times,** all from `auth:"none"` (d4, k1, k2, k3), on free runs. Refused by the proxy, and nothing reached Meta.
- **Direct calls:** only telemetry, when it was on, all answered by the sink. Nothing reached Meta.

## What it means for the design

Step 3 of "How it runs" in `_plan/muse-code-products.md` stands: model calls go through the gateway. What has to change:

1. **The token is a usable stand-in.** "No key or usable stand-in key sits in the VM" isn't true of the session token: the agent's shell can read it and
   call the gateway with it. It must be scoped to one session: `POST /v1/responses` only, the set model only, the session's budget, and dead at stop or the
   15-minute limit. What's better than the broker is that every use is metered and capped, not that it's hidden.
2. **Pin `auth:"bearer"`,** or no Authorization header reaches a real host. Never `auth:"none"`, which turns Contributor into `muse-spark-1.3`.
3. **`telemetry.enabled=false` is required.** Otherwise it posts to api.meta.ai with the session token, where the firewall refuses it.
4. **The catalog route is optional, and can't live under the gateway.** It's always `/muse-code/models` at the host root, so the plan's "at least
   `/muse-code/models`" should become: not needed, or a root rewrite if a test shows a catalog-less session behaves worse. Only one small turn was tried
   without it. `/v1/models` is never called. Without a catalog, set `context_compaction.provider_context_limit_tokens`.
5. **`background` handling can stay, and no multipart route is needed.** Neither was ever sent. Non-streamed calls must work and be metered: compaction uses them.
6. **`ENDPOINT_MODELS.responses` doesn't list `muse-spark-1.3-contributor`,** so the gateway would refuse what Muse Code sends (read, not run). `code_session` needs
   its own list, by rule: Contributor only under TEST_MODEL, Wonder live, `muse-spark-1.3` refused rather than mapped to Contributor.
7. **The estimate blocks Wonder sessions.** Muse Code asks for `max_output_tokens: 128000`, and `estimate.ts` caps that at 32,000. With a 116 KB body, that's about
   $0.76 per call on Wonder ($0.64 output, $0.12 input with no cache credit). The handler refuses when `spent + estimate > budget`, so a $1.00 session stops
   after about $0.24 of real spend, and a build's $0.50 can't make one call. `code_session` needs a smaller assumed output, or a rewrite of `max_output_tokens`.
   Contributor's estimate is about $0.01, so tests won't show this.
8. **The firewall needs paths on the platform host,** not just the host: the agent's shell can reach everything the firewall allows. A `match` on method and path, as
   `api.meta.ai` has now, should allow only `POST /api/gateway/v1/responses`. Not tested on that host.
9. **The zip needs the rules under "The binary".** "No shell for users" doesn't help: a user's task can tell the agent to do the copying. This belongs in the owner's
   reading of the terms.
10. **"Worked" means the files, not the exit code.** See task (b). The kit's smoke test and CodeRun must show the final text and the file list.
11. **Decisions section:** the claim that `muse serve` turns a Contributor id back into `muse-spark-1.3` didn't reproduce on the wire. The reason to keep reminders off is
    now cost. Keep `backgroundModelSetting(model)` on Wonder until a live session is watched.
12. **Set a lower context limit,** say `provider_context_limit_tokens: 200000`. Bodies run about 4.6 bytes a token, so the 4.5 MB gateway limit is reached near the
    default 1M limit, and a session would fail instead of compacting. Compaction worked at 30,000. 200,000 itself wasn't run.
13. **A start is fast enough for the plan:** 4 to 8 s to the first event, with the SDK install about 2 s of that, which a snapshot could remove. Stop is under 2 s, and
    nothing survives. No long-running function is needed.

## Fallback

Not needed for traffic, since the endpoint works. The plan's fallback stays as the answer if the real gateway hop fails: firewall broker, a kill at the
cap, and visitors off. Change one thing: **live metering from `session/tokenUsage` undercounts by 28 to 45% when subagents, reminders or compaction run**,
so with reminders off it needs subagents off too, or a margin, or a read of the session logs (`serve-2026-10-31/README.md` found those complete).

## Not measured

- The real gateway. Its code on the live site is old and the laptop site can't be reached, so `handler.ts`, `rewrite.ts` and `estimate.ts` were only read.
- A real public host through the sandbox firewall. HTTPS was tested on the VM's own address with a private CA.
- Wonder, barred here, so nothing about its background model on the wire.
- Web search, web fetch and the Files API. Search stayed off, and no video was read.
- A session past 34,000 input tokens per call or 141 KB per body.
- Catalog answered with anything but 200 or 403. A 404 is what the platform's root would give today.
- What a stream cut off midway costs.
- The earlier copy's sandbox: `list.ts` found no `musecode-spike-*` sandbox before this run started, so there was nothing to stop, and it left no visible spend.

## Meta's terms

Read separately and summarized in `_plan/muse-code-products.md`. Not repeated, and this spike didn't change that reading. The binary result above bears on it.

## Spend

| Run | Paid calls | Cost |
|---|---|---|
| p4 first call | 1 | $0.002517 |
| p5 shell check, subagent, reminders, compact | 23 | $0.019191 |
| p7 tasks, stop, compaction | 25 | $0.025515 |
| p8 task b2, catalog refused | 6 | $0.005708 |
| Others | 0 | $0 |
| **Total** (the proxy's sum of Meta's reported usage, priced as in `lib/meta/pricing.ts`) | **55** | **$0.052931** |

## Files

- `creds.sh` runs a script with a fresh OIDC token from a mode 600 temp file, deleted at once. `run.ts` is the sandbox runner and its firewalls. `list.ts --stop` finds leftovers.
- `proxy.mjs`, `sink.mjs`: the recording proxy, and the catcher for direct calls. `lib.sh`, `report.mjs`: shared by the phases. `inside.mjs`: the shell check. `compact.mjs`: an MSP client for `session/compact`.
- `phase-N.sh`, with output in `results/pN`. Help and strings 0, 0b; forms of the setting 1, 2, 3 (`results/p1` came from an earlier version of phase 1 and the sink, blind to direct calls, so it has no sink log); first call 4; inside check, subagent, reminders 5; settings and locks 6; tasks, stop, compaction 7; task b2 and no catalog 8; cold start 9; path prefix, bearer pin, page check 10.
- Bridge logs were removed from `results`, along with most of the binary's strings. Every run's output was scanned for the key, placeholder and stand-in, and the set here for the Meta key and Vercel tokens: no hits.
