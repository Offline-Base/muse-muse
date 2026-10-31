# Compare lab: side-by-side chat and evals for Muse Glimmer and its peers

This is how to chat with, and run the same evals on, the tuned Muse Glimmer 30B, base Muse Glimmer 30B, and three open
models of the same size, side by side.

Everything model-related runs on one rented Lambda GPU machine (the lab), up only while it is used. Each model there sits
behind its own llama-server bound to 127.0.0.1 on the lab. The Mac reaches them through one ssh tunnel. The Mac runs only
the chat page, the tunnel and scripts: no Muse Glimmer model ever runs on this laptop.

Code: `scripts/knowledge/compare/`. Run data: `.data/compare/` (gitignored).

```
PY=.data/aws/venv/bin/python          # Python 3.12 with boto3 (any python3 from 3.10 works for the chat page and evals)
L=scripts/knowledge/compare/lab.py
```

## Quick start

```
aws login --profile offlinebase                     # if the login has lapsed (it lasts about 15 minutes at a time)
$PY $L types                                        # live prices and capacity, how many models fit each type
$PY $L up --dry-run                                 # the plan, price, command lines and a preflight; launches nothing
$PY $L up --yes                                     # launch, set up (about 8 min on Oct 31, allow 20), then status
python3 scripts/knowledge/compare/chat_server.py    # then open http://127.0.0.1:8788/
python3 scripts/knowledge/compare/evals.py run --limit 50
$PY $L down                                         # or let the idle stop end it
```

Keep the Mac awake, open and on power while a lab is up. Lambda machines can't stop themselves; the watch on this Mac is
the only kill switch. `caffeinate` stops idle sleep but not lid-close sleep. If you need to close the lid, run
`lab.py down` first.

## The models

All five share the same server flags, the same neutral sampling on every request, the same token limits per set and
mode, and the same system prompt, "You are a helpful assistant." (`common.SYSTEM`, the training system line).

| name | role | port (local) | publisher | license | source | file | bytes | bits per weight | reasoning on |
|---|---|---|---|---|---|---|---|---|---|
| glimmer-stage2 | tuned | 8201 (18201) | Meta, tuned by us | Apache-2.0 | writer-1 `~/q/stage2/`, then S3 `knowledge/models/stage2/` | glimmer-stage2-Q4_K_M.gguf | 16,935,294,432 | 4.86 | low (reasoning_strength); known to fail (HTTP 500) on stage 2 |
| glimmer-base | base (the paired reference) | 8202 (18202) | Meta | Apache-2.0 | writer-1 `~/q/base/` (local disk, not the NFS), then S3 `knowledge/models/base/` | glimmer-base-Q4_K_M.gguf | 16,935,294,528 | 4.86 | low (reasoning_strength) |
| qwen3.8-27b | other | 8203 (18203) | Alibaba Qwen, GGUF by ggml-org | Apache-2.0 | `ggml-org/Qwen3.8-27B-GGUF` @ a316ea527fde32c12487be7574e2db5ac2ad2a7e | Qwen3.8-27B-Q4_K_M.gguf | 18,973,870,528 | 5.64 | low (reasoning_effort) |
| gemma-4-31b | other | 8204 (18204) | Google | Apache-2.0 | `google/gemma-4-31B-it-qat-q4_0-gguf` @ 59dde24573e7e61570dba08b18a2e1fe246955ed | gemma-4-31B_q4_0-it.gguf (QAT Q4_0) | 17,651,001,568 | 4.60 | default; the template has no effort levels, so it thinks in full |
| granite-4.2-30b | other | 8205 (18205) | IBM | Apache-2.0 | `ibm-granite/granite-4.2-30b-GGUF` @ 27b350a791e81d9a4d1ddca1c49282e9ec533768 | granite-4.2-30b-Q4_K_M.gguf | 17,721,455,328 | 4.84 | low (reasoning_effort) |
| glimmer-final | tuned, replaces glimmer-stage2 | 8206 (18206) | Meta, tuned by us | Apache-2.0 | writer-1 `~/q/stage-b-r30/`, then S3 `knowledge/models/stage-b-r30/` | glimmer-stage-b-r30-Q4_K_M.gguf | filled by s3-put (16,935,294,432 on writer-1) | | low, as stage 2; disabled until added. Likely HTTP 500 on plain questions (see below) |

sha256 of the three public files (checked on Hugging Face at the pinned revisions, and again on the lab before use):

- Qwen3.8 27B: `c600de0300ae8a0eb3a6c0b8b5561b8b96f16bd2c863c2a66c42de29d391a747`
- Gemma 4 31B QAT: `179cfb99212709597eae5929112cfca677e1bbf566178b479ae1da0c4772874b`
- Granite 4.2 30B: `f299dace85d77ee0e24ca0b6720bd211b1f4cd1f65b9c0a2111e79692e29c9be`

Our own files get their sha256 when `lab.py s3-put` uploads them; it writes it into `models.json` and next to the object
in S3 as `<key>.sha256`.

Things to know when reading results:

- Every file is labelled 4-bit, but bits per weight differ: Qwen 5.64, Glimmer 4.86, Granite 4.84, Gemma 4.60. The chat
  page and the eval report show it.
- Training cutoffs: Gemma 4's card says its pretraining data ends January 2025. Qwen3.8 and Granite 4.2 cards don't state
  one. Base Glimmer's template defaults to 2026-01-04. The tuned files were trained on a corpus up to 2026-10-29.
- Tuned and base Glimmer are served with `tuned-reasoning-off.jinja` and `--reasoning-format none`; reasoning off sends
  `"stop": ["<|eot|>"]` (without both, tuned files give HTTP 500 or markup in the reply). Reasoning on uses the model's
  own path: `"reasoning_format": "auto"` and `chat_template_kwargs` `{"reasoning_strength": "low", "allow_reasoning": true}`.
- Thinking on with the tuned models: stage 2 gave HTTP 500 on every reasoning-on row (60 of 60 on Oct 31). glimmer-final
  copies stage 2's request, and stage-b-r30 in that setup (low strength, a bare generation prompt) left 64 of 120
  honesty replies and 96 of 300 controls with no header and no final channel, which the chat endpoint rejects (run log,
  Oct 31, 5:31 PM). So expect HTTP 500 from glimmer-final with thinking on for plain questions in chat and on
  honesty-dev; its reasoning items were fine. The untracked `job/tuned-reasoning-on.jinja` does not fix this here: the
  chat endpoint with `reasoning_format` auto rejected all of its output (0 of 160, run log, 6:40 PM; it is marked not
  recommended). And `--chat-template-file` applies to a whole server, so any reasoning-on template would need a second
  server for each tuned model. The run log's decision stands: tuned models with thinking off for knowledge questions,
  thinking on for reasoning tasks only.
- llama.cpp b11970 (commit 522021325546ea322b0b1e58a50f9dbf03a5f197) loads sampling defaults from each GGUF. So every
  request pins neutral sampling (`common.NEUTRAL`: min_p 0, typical_p 1, no repeat, presence, frequency, DRY or XTC
  penalties, mirostat off, and llama.cpp's default sampler order ending in temperature).
- Every request has a system message. Without one, Glimmer's template inserts "Knowledge cutoff: 2026-01-04" and today's
  date, which is wrong for the tuned model and unfair to the others.

`models.json` holds all of this. Model fields: name, label, role (exactly one "base"), publisher, license, port
(8201..8209), enabled, quant, params_b, cutoff, file, bytes, sha256, source (`s3_key` and `writer1_path`, or `hf_repo`,
`hf_revision` and `hf_file`), serve (extra server flags; `@template/X` means the lab's templates folder), request (`off`
and optional `on` bodies, merged into each request), reasoning_level, final (how the answer is cut out: glimmer, think,
gemma4 or plain), gpu_gb, and for a copy: like, run, replaces. `common.load_config` refuses repeated names or ports, port
5037, a request without `off`, a missing `like`, anything but one base, and flags that would log prompts or open slots.

## Adding the final candidate (stage-b-r30)

The config line is already there (`glimmer-final`, enabled false, replaces glimmer-stage2). The file `add` needs is
already on writer-1: quantize.sh wrote `~/q/stage-b-r30/glimmer-stage-b-r30-Q4_K_M.gguf` (16,935,294,432 bytes) at 5:01 PM
ET on Oct 31 (a read-only `ls -ln` at 6:35 PM ET showed it; the run log says the same). It renames `.part` only on
success. The later step, the copy to the NFS `models/stage-b-r30/`, came after the quants were scored (run log, 6:32 PM);
`add` never reads the NFS. So this can run now:

```
aws login --profile offlinebase     # if the login has lapsed
$PY $L add glimmer-final --wait
```

If the pick changes to another run (for example stage-b-r30b, training since 5:32 PM), change glimmer-final's `run`
field (and its label) in `models.json` to that run's name first: the file name, S3 key and writer-1 path follow from it.

`add` uploads it to S3 if its sha256 is unknown (`--wait` looks for the file every 5 minutes with `ls` only), records
sha256 and bytes, sets enabled true, and if a lab is up, unloads glimmer-stage2 and loads glimmer-final in its place.
From then on `up` loads glimmer-final instead of glimmer-stage2. To load both, name them: `up --models
glimmer-stage2,glimmer-final,glimmer-base,qwen3.8-27b,gemma-4-31b` (six do not fit one GH200 with Granite as well).

## Moving our GGUFs: writer-1 to S3 to the lab

```
$PY $L s3-put glimmer-base
$PY $L s3-put glimmer-stage2
```

- The source is writer-1's local disk (`/home/ubuntu/q/...`), never the NFS (it stalled under writes before, and
  quantize.sh writes there around midnight). Nothing goes through the laptop.
- writer-1 runs a fixed bootstrap, `nice -n 19 ionice -c 3 python3 -I -c '...'`, that reads a program from ssh stdin
  (`s3_put_remote.py`). The program reads the file once in order, hashes it, holds at most 3 parts of 128 MiB in memory,
  PUTs with 3 threads, and keeps under 150 MB/s. It writes nothing on writer-1, takes no lock, and never touches the GPU,
  `~/q/gpu.lock`, `~/mp-gpu` or anything else in `~/q`.
- Presigned URLs: `offlinebase` is an `aws login` session whose credentials last about 15 minutes, and a presigned URL
  dies with its session token whatever its expiry says. So the Mac presigns in batches of 16 parts, each batch from
  freshly frozen credentials, with 900 s expiries, and sends them only over ssh stdin. When S3 refuses one (expired), the
  uploader asks again for that part, up to 5 tries. URLs are never printed, logged, written to a file or put in a
  command line.
- The Mac completes the upload, checks the size with a HEAD, writes `<key>.sha256`, and records sha256 and bytes in
  `models.json`. On failure it aborts only the upload id it created (others exist under `knowledge/models/`; they are
  left alone). S3's lifecycle rule ends any forgotten upload after 3 days. S3 access logging is off and there are no
  CloudTrail trails, so presigned URLs are not written to a bucket log.
- On the lab, `lab_remote.py fetch` downloads with Python's urllib only (no curl, wget or any subprocess that would hold
  a URL), 8 ranged streams per file, resumable, sha256-checked before the rename. Our files come by presigned GET from the
  Mac over the same kind of stdin channel; a refused URL is replaced. The three public files come straight from
  huggingface.co with no token (the resolve redirect is followed by hand, and its size, sha256 and commit headers are
  checked first).
- Rerunning `s3-put` on a file already in S3 at the right size reads the recorded sha256 instead of uploading again.

## The lab machine

### Choosing a type

`up` launches only `lab.type` in `models.json` (gpu_1x_gh200, $2.29/h on Oct 31, about 102.6 GB of GPU memory, holds all
five). If Lambda has no capacity for it, `up` prints the other types with price, capacity and how many models fit, and
stops. It never switches to a pricier type on its own: pass `--type gpu_1x_h100_sxm5` (or another) to choose. On an 80 GB
type four models load and Granite is swapped (`lab.py load` and `unload`).

Prices seen on Oct 31 (Lambda by the started minute): GH200 $2.29/h (us-east-3 only, capacity comes and goes), H100 SXM5
$4.29/h, H100 PCIe $3.29/h, A100 40 GB $1.99/h (holds 2), 2x H100 $8.38/h (no capacity that day).

### What `up` does

1. Removes the stop file, checks the AWS login, reads Lambda's live list and prints the type's price and capacity.
2. Refuses if less than one hour at that price is left under the cap.
3. Preflight, before any rent: every model to load has sha256 and bytes in `models.json`, and our files are in S3 at
   that size.
4. Writes a "launching" record to the state, starts the watch, then POSTs the launch with image lambda-stack-22-04 (once
   more without the image field if Lambda rejects it). The machine's deadline is launch time plus the smaller of
   `max_hours` (4) and what the cap leaves at that price, minus 5 minutes.
5. Waits for the machine to be active (5 to 10 min), clears its IP from `.data/compare/lab/known_hosts`, copies
   `lab_remote.py` and the template, and opens the tunnel.
6. Builds llama.cpp b11970 on the lab (llama-server only, CUDA arch from nvidia-smi, `-DLLAMA_CURL=OFF`; stops if the
   commit isn't 522021325546ea322b0b1e58a50f9dbf03a5f197), while the downloads run. Lambda Stack ships the Debian-style
   CUDA toolkit (nvcc in /usr/bin, headers in /usr/include; /usr/local/cuda holds no headers), so the build uses the
   nvcc already on PATH and passes it as `CMAKE_CUDA_COMPILER`. On the GH200 the build takes about 3 minutes.
7. Memory ladder: starts the servers one at a time with the same flags for all (q8_0 K and V cache, 8,192 tokens per
   slot, 2 slots), then sends every slot of every server a synthetic prompt of about 1,500 tokens at once (random numbers,
   no model text) and requires 3,000 MiB free after it. If short, or a server failed, all five go to 4,096 tokens per slot
   (the reasoning-on limit drops to 3,072). A server that fails at both sizes with memory to spare is left out and shown
   "failed" (see `lab.py logs NAME`). If memory is still short, the last "other" model stays unloaded ("not loaded
   (memory)"). When a later try fails only on such a broken server while memory is fine, the next try leaves out just
   that server; a healthy model is dropped only when memory was really short. There is no unified memory and no
   per-model KV change. Steps are kept in the state and in `.data/compare/lab/memory.json`.
8. Smoke check, one model at a time: "What is 17 + 25?" in each mode. It prints only the HTTP status, the final's length,
   whether 42 appears, reasoning character count and tok/s, and flags anything under 5 tok/s on its own.
9. Marks the lab ready and prints the status.

`up` is idempotent: on a ready lab it only makes sure the tunnel and watch run; on a lab that is up but not ready it
resumes the setup (the build, downloads and ladder all skip what is done). If setup stops on an error, the machine keeps
billing until you rerun `up`, run `down`, or the watch ends it at the setup limit.

`up --dry-run` never runs a setup step. With no lab up it prints the plan, price and preflight. On a ready lab it does
what `up` does there (makes sure the tunnel and watch run, then prints the status). On a lab that is up but not ready it
prints the machine's state, what it has cost so far, when the watch ends it, and which setup steps are done or still to
do, then stops. The only thing it may start then is the watch, when it is not running, since nothing else stops a
machine that is billing.

`up` took about 8 minutes on Oct 31 (GH200 in us-east-3: about 2.5 minutes to boot, about 3 to build llama.cpp, the five
downloads alongside the build, then about 1.5 for the ladder and the smoke check); allow up to 20. Run it in a terminal
you keep open, or in the background (an agent's 10-minute command limit could cut it short). If it is cut off, just run `up` again: the build and the servers run detached on the lab, and
an interrupted download stops at once, keeps its progress and resumes, so nothing is fetched twice and no file gets two
writers. The watch keeps guarding the machine meanwhile.

### First run

1. `aws login --profile offlinebase` if needed, then `s3-put glimmer-base` and `s3-put glimmer-stage2` (no lab rent, low
   priority on writer-1, no GPU).
2. `up --dry-run`, then `up --yes --idle-minutes 15` (prints the price first).
3. Chat: a two-turn conversation with all loaded models in both modes, then blind mode, vote and reveal.
4. `evals.py run --limit 20 --reasoning both`, then open the report in the Reports tab.
5. Stop all requests and let the watch end the machine for idle (`status` shows the idle minutes); if it hasn't within
   20 minutes, `down`.
6. `status` reads Lambda's live list: it should say "Lambda lists 0 muse-compare-lab-* machine(s)".

Server command line on the lab (one per model, from `lab.py up --dry-run`):

```
LD_LIBRARY_PATH=/home/ubuntu/compare/llama.cpp-b11970/build/bin setsid nohup /home/ubuntu/compare/llama.cpp-b11970/build/bin/llama-server \
  -m /home/ubuntu/compare/models/FILE --host 127.0.0.1 --port PORT --alias NAME -c 16384 -np 2 -t 8 \
  -ngl all -fa on --fit off -ctk q8_0 -ctv q8_0 --no-webui --no-slots --metrics --ctx-checkpoints 4 SERVE_FLAGS \
  > /home/ubuntu/compare/logs/NAME.log 2>&1 < /dev/null &
```

Never `-v`, `--log-verbose`, `--log-prompts-dir` or `--slot-save-path`; `/slots` is off.

### The tunnel

One ssh process forwards 127.0.0.1:18201..18209 on the Mac to 127.0.0.1:8201..8209 on the lab (lab port plus 10000).
Nothing binds anything but 127.0.0.1. Port 5037 (adb) and 18000 (another session's tunnel) are never used. The chat
page refuses those two and 18201 to 18209 for `--port`, so it can't take a port the tunnel needs. `lab.py tunnel`
restarts it; the watch also restarts it while the lab is ready.

### The kill switch (watch)

`up` starts `nohup caffeinate -ims bash -c 'until PY lab.py watch; do sleep 30; done'`: it restarts the watch only after a
non-zero exit, and a lock (`watch.lock`) keeps a second one from running. Every 60 s it reads Lambda's list through
`train_multi.lam` and terminates a lab machine when any of these holds:

- lifetime lab spend plus two minutes at the current rate reaches `cap_usd` ($30, across all lab machines)
- the machine's own deadline (launch plus at most 4 h)
- `deadline_utc` (2026-11-05T03:00Z, 10 PM EST on Nov 4, an hour after the 9 PM ET due time)
- not ready 45 minutes after launch
- ready and idle for `idle_minutes` (30; `up --idle-minutes N` per machine)
- the stop file (`lab.py down` writes it)

Idle counts from the latest of: ready, the chat page or eval runner touching `.data/compare/lab/last_use`, `lab.py keep`
(keep_until minus the idle limit), and the last minute the watch saw activity. Activity is any request in progress or
waiting (`llamacpp:requests_processing` or `requests_deferred` above 0) or a token counter that grew, read from each
server's `/metrics` through the tunnel. Unreadable counts as no activity.

It terminates only an id whose Lambda record is named `muse-compare-lab-*`. A failed Lambda list changes nothing. A
machine is marked ended only when Lambda confirms the terminate or after 3 lists in a row leave it out. A launch whose
reply was lost is adopted by name; any other `muse-compare-lab-*` machine not in the state is terminated at once. Each
cycle stops our own machines first, so a stray's terminate failing (a network error) can't skip them. It notifies with
a macOS notification, about a stray only once Lambda confirms its terminate. It exits when nothing is up. It never touches train-1, train_multi's state or watch,
or any machine with another name.

It can't run while the Mac sleeps: Lambda keeps billing ($2.29/h is about $18 overnight) and the cap can be overshot
before the Mac wakes. Keep the Mac open and on power while a lab is up, or run `down` first.

### Commands

| command | what it does |
|---|---|
| `types` | Lambda's live list: price, GPU memory, regions with capacity, how many enabled models fit |
| `s3-put NAME [--wait]` | our GGUF from writer-1 to S3 (above) |
| `up [--yes] [--dry-run] [--type T] [--models a,b] [--idle-minutes N] [--max-hours H]` | launch and set up, or resume |
| `status [--json]` | machine, uptime, spend (this machine and lifetime) against the cap, ends-by time in ET, idle minutes, keep_until, watch and tunnel (a loud warning if the watch isn't running), KV and context, ladder steps, and per model: health, port, GPU MiB, bits per weight |
| `down` | terminate now (also strays named muse-compare-lab-*); stops the tunnel |
| `tunnel` | start the tunnel again |
| `load NAME` / `unload NAME` | swap one model on a ready lab; `load` downloads if needed and refuses if free GPU memory is under gpu_gb x 1000 + 3,000 MiB |
| `add NAME [--wait]` | the final candidate, above |
| `keep [--minutes N]` | hold off the idle stop for N minutes (60 by default), capped at the machine's deadline |
| `logs NAME` | at most 40 of the last 400 lines of a lab server log (or `build`) that match error, fail, CUDA, out of memory, loaded, listening or template; any line with "unparsed" or "output:" is dropped, since those can hold model text. Nothing else reads lab logs. |
| `watch` | the kill switch itself (started by `up`) |
| `s3-selftest` | the real presigned multipart upload and the lab's ranged fetch against a ~12 MB random object under `knowledge/compare-test/`, with one spoiled URL of each kind to prove the re-presign path; deletes everything it made |

## The chat page

```
python3 scripts/knowledge/compare/chat_server.py [--port 8788]
open http://127.0.0.1:8788/
```

- It listens on 127.0.0.1 only, refuses other Host headers and cross-origin POSTs, proxies only to the tunnel ports in
  `models.json`, and never starts a model.
- Pick models, type a prompt (Cmd or Ctrl+Enter sends). One column per model streams in parallel, each with its own
  history (multi-turn). New chat starts over.
- Per column: reasoning on or off (disabled where a model has no "on" mode), a collapsed Thinking panel with a character
  count, Stop, and a health dot. Under each reply: prompt and completion tokens, time to first token, total seconds,
  tok/s (a shared GPU, so not a model property), finish reason and any error. A full context says "context full, start a
  new chat". Stage 2 Glimmer with reasoning on returns HTTP 500 (its parser rejects the channels), and glimmer-final
  likely does too on plain questions (above); that shows as an error.
- A model the lab has not loaded shows its state as stored by `lab.py`: "not loaded (memory)" (left out by the
  ladder), "not loaded" (`unload`) or "not loaded (replaced)" (`add`). `lab.py load NAME` swaps it in.
- Sampling is the same for every column (default temperature 0.7, top_p 0.95, top_k 40, max tokens 2,048, or 4,096 with
  reasoning on, lower when the lab runs the 4,096 context), with a greedy toggle. Vendors recommend different settings;
  equal settings are the fair choice. Neutral sampling is always added.
- An empty system prompt means "You are a helpful assistant."
- Blind mode: columns get letters A to E in a shuffled order, with Prefer and Reveal. Blind hides names, not behavior.
- Transcripts: `.data/compare/chats/<session>.json`, final answers only unless "save reasoning" is ticked for that chat.
- A banner shows the lab: uptime, spend against the cap, idle minutes, ends-by time in ET, the watch (red if not
  running), KV and context, and a keep alive button (it touches `last_use`).
- Sessions list (read-only) and a Reports tab for eval reports.

Details beyond the plan (for anyone calling the API):

- `POST /api/turns` sends every column of a turn on one stream (each event tagged `"c": col`, ending with
  `{"t": "end"}`), so a 5 or 6 column turn uses one browser connection. `POST /api/turn` (one column) also works.
- `POST /api/stop {session, col?}` stops one column or the whole chat. `GET /api/health?session=ID` gives health per
  column, so a blind chat doesn't leak names.
- Extra events: `start`, `tick` (content arrived that the final-answer cleanup hides), and `content` with
  `"replace": true` when a cleanup changed earlier text. Model text never reaches the page as raw markup.
- Chat requests use `cache_prompt: true` for faster multi-turn (evals keep it off). A blank seed becomes a random one,
  recorded with the reply. Thinking-on replies are capped at the lab's `max_tokens_on_cap`, thinking-off ones at its
  context per slot. A column still answering refuses a second request (409).
- The transcript also keeps the lab type, KV and context, `revealed_at`, and per turn `vote_at` and whether the vote
  was cast with names hidden. Files are mode 600.
- `POST /api/keepalive` touches `last_use` only (the same as any request). For a longer hold, run `lab.py keep`.
- Reports are served sandboxed (scripts only, no same-origin), so nothing in a report can call the chat API.

## The eval runner

```
python3 scripts/knowledge/compare/evals.py run [--sets honesty-dev,reasoning,salient,probes,old-facts] [--models all|a,b] \
    [--reasoning default|off|on|both] [--limit N] [--probes-n 500] [--parallel 2] [--max-tokens-on N] \
    [--max-tokens-off auto|glimmer|compare|N|SET=N,...] [--run-id ID] [--resume] [--python-on-lab] [--base NAME]
python3 scripts/knowledge/compare/evals.py report RUN_DIR [--base NAME]
python3 scripts/knowledge/compare/evals.py sets
```

Every model gets the same items through the same chat endpoint, greedy (temperature 0, top_k 1, top_p 1, seed 7, no
prompt cache, plus neutral sampling), 2 requests at a time per model with all models at once, and is graded with this
repo's graders.

| set | file | items | default modes | max tokens off: glimmer / compare | max tokens on | grader |
|---|---|---|---|---|---|---|
| honesty-dev | `.data/knowledge/dataset/stage-b-honesty-dev.jsonl` | 120 | off | 192 / 768 | 2048 | honesty_grade.grade (right = honest) |
| reasoning | `scripts/knowledge/aws/job/reasoning_probes.jsonl` | 260 | 260 on, plus the 40 also_off items off | 2048 / 2048 | 4096 | score_reasoning.grade_row |
| salient | `scripts/knowledge/aws/job/salient_probes.jsonl` | 246 | off | 96 / 384 | 2048 | train_glimmer.answered |
| probes | `.data/knowledge/dataset/stage2-eval-probes.jsonl` | first 500 of 2,500 after a seed 7 shuffle | off | 96 / 384 | 2048 | answered, plus declines |
| old-facts | `scripts/knowledge/aws/forget.jsonl` | 40 | off | 96 / 384 | 2048 | answered |

- Thinking-off limits (`--max-tokens-off`): "glimmer" suits Glimmer's short answers and matches the earlier Glimmer
  tables; on Oct 31 it cut most thinking-off replies of the other models (probes: Qwen 86 of 100, Granite 79, Gemma 15,
  base 6, stage 2 3; honesty-dev: Qwen 39 of 40, Granite 33, Gemma 24). "compare" gives them room. The default, auto,
  takes compare when the run asks any model with role "other", else glimmer, and the run says which. Every model in a
  run gets the same limits. Also `--max-tokens-off N`, or per set: `--max-tokens-off compare,honesty-dev=1024`. A
  resume keeps the run's own limits, and a run that asks other models with the glimmer limits prints a warning.
- `--reasoning off`: every set off (reasoning runs its 40 also_off items). `on`: every set on (all 260). `both`: every
  set in both modes (reasoning 260 each way). One set can get its own mode: `--reasoning off,reasoning=both` asks
  every set off and the reasoning set in both modes.
- `--limit N` takes the first N of every set. Per set: `--limit probes=100,salient=60,old-facts=40,honesty-dev=40`,
  and `reasoning.multistep=30,reasoning.hard=10,reasoning.skills=20` caps one part of the reasoning set. A set not
  named is not cut (probes still stop at `--probes-n`).
- Every set is shuffled with `random.Random(7)` (not only the probes), so a limit still covers every kind. Probe and
  old-fact ids come from their position in the file before the shuffle.
- A resume (`--run-id ID --resume`) keeps the run's sets, modes, limits and `--probes-n`; typing a different one is
  refused. `--models` may differ, so `evals.py run --run-id ID --resume --models glimmer-final` adds the final
  candidate to an earlier run and pairs it with the same items. The report lists each session.
- The reasoning-on limit is capped at the lab's `max_tokens_on_cap` (3,072 when the lab fell back to the 4,096
  context); the report says so.
- A python reply with no code block is wrong without running anything. A reply cut at the token limit with no final
  answer is wrong; a cut reply with some text is graded on that text, and the report counts cut rows separately.
  `report.html#probes` opens that set's tab.
- The reasoning-on limits are the same for every model and higher than Glimmer needs, so long thinkers (Gemma has no low
  setting) are not cut short unfairly. Length cuts and median reasoning characters are reported per model.
- Python items (20) stay ungraded unless `--python-on-lab`, which runs their tests on the lab in a temporary folder that
  is deleted after. Nothing model-written runs on the Mac.
- The 190-item final honesty test (`honesty_probes.jsonl`) is never run by default or by "all", only with
  `--final-honesty-test`, which warns and waits 15 s first.
- Output in `.data/compare/evals/<run_id>/` (folder mode 700, files mode 600): meta.json (sets with sha256, models with
  file, sha256, bits per weight and the server flags actually used, KV and context, ladder, lab type, llama.cpp commit
  and each server's default_generation_settings, sampling, limits, git HEAD), rows.jsonl (final answers and verdicts,
  never reasoning text), summary.json, report.md and report.html.
- The report: accuracy with Wilson 95% intervals and, per cell, how many replies were cut at the limit (and how many of
  those still counted right); paired differences against base Glimmer on the same items (Newcombe interval, exact sign
  test); honesty verdicts with a cut column; a Declines table; by-month tables for salient and probes; a serving table
  (errors, length cuts, median tokens, reasoning characters, final words, seconds, tok/s); and an HTML view of every
  item's answers side by side, filterable to items where models disagree, tuned and base differ, or a reply was cut or
  is "right but declining".
- Declines: a wrong reply that declines counts as over-refusal only for the tuned models (taught these events) and on the
  old facts. Probe and salient events run to Oct 2026, after the cutoff of base Glimmer (template default 2026-01-04)
  and of the other models (Gemma 4: January 2025; Qwen3.8 and Granite 4.2 state none), so for them declining is the
  honest reply and the table says "declined". It also counts declines on items dated before each stated cutoff (the
  Oct 31 probes and salient items have none before 2026-01).
- "Right but declining": `answered()` finds the expected name anywhere, so a reply that denies the event but names the
  answer as background, an example or a list item is graded right. Such rows keep their grade (so runs stay
  comparable), carry `review: true` in rows.jsonl, are counted in the Declines table and say so on their cards. On Oct
  31 there were 25 (Granite 10, Qwen 8, Gemma 7, Glimmer 0), and 14 of them were denials, so the other models' salient
  and probe rates are upper bounds.
- Caveats printed in every report: honesty_grade was never audited on Qwen, Gemma or Granite wording; `answered()`
  rewards an alias anywhere in the reply, so wordy replies gain, and can count a denial as right; cut replies are graded
  as they stand; declining after a model's cutoff is honest, not over-refusal; these numbers are not comparable with
  earlier /completion tables; greedy with 2 slots is not bit-for-bit repeatable; HTTP 500 with thinking on is expected
  from stage 2 and likely from glimmer-final. Read a sample by hand before claiming a gap.

Speed: the five servers share one GPU by time-slicing, so with all of them busy each stream gets about 12 to 15 tok/s
(one model alone ran about 80 tok/s in the smoke check). Gemma 4 with thinking on is the slowest column: a median of
about 1,250 tokens per reasoning item, up to the 4,096 limit. With the compare limits the other models may write up to
four times longer thinking-off replies than on Oct 31, so a run with them takes longer.

A small run that touches every set (the Oct 31 live test: 1,800 requests in 38 minutes on the GH200, 21:21 to 21:59 UTC,
mostly Gemma and Qwen thinking; it ran with the glimmer thinking-off limits, before `--max-tokens-off` existed):

```
python3 scripts/knowledge/compare/evals.py run --reasoning off,reasoning=both --python-on-lab \
    --limit probes=100,old-facts=40,salient=60,honesty-dev=40,reasoning.multistep=30,reasoning.hard=10,reasoning.skills=20
```

To compare Glimmer against Glimmer only (with the glimmer limits, the same as the earlier tables), name them:
`--models glimmer-stage2,glimmer-base` (or `--max-tokens-off glimmer`).

Reports and transcripts hold private honesty dev questions. They stay under `.data/compare/` and are not published.

## Not yet run on a live lab

The Oct 31 live test (machine up 21:11 to 22:14 UTC) ran the code as it was then. These changes came after it and have
passed only the offline tests:

- lab.py at 22:16 UTC: fetch progress goes through `log()`, so `lab.log` gets "fetch ...: ok, sha256 checked" lines (the
  live `lab.log` has none), and `s3-put` builds its S3 client only after `--wait` finds the file, from credentials
  frozen then.
- Later the same evening: `log()` reads its path when called (tests no longer write the real `lab.log`), `up --dry-run`
  on a lab that is up but not ready, the ladder's retry without only a broken server, the watch's order (our machines
  before strays) and its guard on a stray's terminate, the chat page's port check, private eval files, the
  "not loaded" states on the page and in the eval runner, `--max-tokens-off` and the report's cut, decline and "right
  but declining" counts.
- `lab.py add glimmer-final` has not been run: it would be the first upload of stage-b-r30's Q4_K_M.

The test lines in `.data/compare/lab/lab.log` that say "s3-put glimmer-stage2: 0.00 GB from writer-1 in 6 parts of 0 MiB"
(with "done ... sha256" and "aborted our upload (LabError)" lines around them), and the lines at 22:25:42Z about a
machine named muse-compare-lab-9, came from the unit tests and an offline dry-run check before the `log()` fix. No such
uploads or machine existed; the lines are left in place (logs are never edited).

## Costs

- Lab rent: GH200 $2.29/h by the started minute. Setup is about 8 to 20 minutes ($0.30 to $0.76) per `up`. The idle stop wastes at most
  about $1.15 at 30 minutes. One session is capped at 4 h ($9.16). Lifetime cap $30 across all lab machines (raise
  `cap_usd` in `models.json` for more sessions; about $60 covers several through Nov 4).
- S3 egress for one `up`: our two files, 33.9 GB at $0.09/GB, about $3.05 (AWS credits; outside the Lambda cap). With the
  final added, about $4.60. S3 storage about $0.39 a month per file.
- Uploads from writer-1 cost no extra rent (it is up anyway) and take a few minutes at low priority.
- A full default eval suite is about 2 to 3 h of shared GPU ($4.60 to $6.90); `--limit 50` is about 30 to 40 min
  ($1.30); `--reasoning both` roughly doubles a suite.

## Safety rules this code keeps

- No model runs on the Mac. The Mac binds only 127.0.0.1, never port 5037.
- The Lambda API key stays in `.env.local` and is used only through `train_multi.lam`, which never prints it. No other
  train_multi function is called (its `stop()` with no name would terminate train-1).
- No Hugging Face token anywhere; only ungated public files, at pinned revisions.
- No long-lived AWS keys on any machine. Presigned URLs are short-lived, made in batches, sent only over ssh stdin, and
  never printed, logged, put in a file or in a command line. Lambda machines hold no keys to each other.
- No training files go to the lab.
- No log or system file is edited or deleted on any machine. The code deletes only files it created in its own folders.
- Reasoning text is never stored in bulk: counts and verdicts are kept, and final answers. Lab logs are read only through
  `lab.py logs`, which drops lines that could hold model text.

## Files

| file | owner | what |
|---|---|---|
| `models.json` | lab | models and lab settings; `s3-put` and `add` write sha256, bytes and enabled |
| `common.py` | lab | config, request bodies, final-answer cleanup, lab state views (imported by the chat page and evals) |
| `lab.py` | lab | the Mac CLI above |
| `lab_remote.py` | lab | runs on the lab only (refuses macOS): build, fetch, start and stop servers, GPU memory, filtered logs |
| `s3_put_remote.py` | lab | the uploader program sent to writer-1 over ssh stdin, never copied there as a file |
| `test_lab.py` | lab | unit tests, no network |
| `chat_server.py`, `web/` | chat | the side-by-side chat page |
| `test_chat_server.py` | chat | unit tests |
| `evals.py`, `report.py` | evals | the eval runner and its report |
| `test_evals.py` | evals | unit tests |

Run data in `.data/compare/`: `lab/` (state.json, watch.log, watch.pid, watch.lock, lab.log, tunnel.pid, known_hosts,
last_use, stopped, memory.json, uploads.json), `chats/`, `evals/<run_id>/`.

Tests: `python3 -m unittest discover -s scripts/knowledge/compare -p 'test_*.py'` (110 on Oct 31). test_lab.py points
every state path at a temp folder for the whole module and fails if the real `lab.log`, `memory.json`, `uploads.json`,
`known_hosts` or `stopped` changed while it ran (so don't run it beside a live `lab.py` command).

## Troubleshooting

- "AWS login expired: run `aws login --profile offlinebase`, then retry": the login lasts about 15 minutes at a time and
  is checked before `s3-put`, `up`, `load` and `add`, so no rent is spent.
- No capacity for the GH200: `up` lists the other types; choose one with `--type`.
- `status` says the watch is NOT RUNNING while a lab is up: run `lab.py up` (it starts the watch) or `lab.py down`.
- A model shows failed: `lab.py logs NAME`.
- "llama.cpp build failed at configure": `lab.py logs build`, then rerun `lab.py up` (it clears the failed CMake cache
  and resumes; downloads keep their progress). The watch ends a lab that is not ready 45 minutes after launch.
- The page shows a model down: `lab.py status`, then `lab.py tunnel` if the tunnel stopped.
- Granite (or another "other" model) shows "not loaded (memory)": `lab.py unload qwen3.8-27b && lab.py load
  granite-4.2-30b` to swap.
