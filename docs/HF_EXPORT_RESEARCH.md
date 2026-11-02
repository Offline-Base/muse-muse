# Publishing tuned Glimmer adapters to the Hugging Face Hub: research notes (Oct 28, 2026)

Read-only research against the live Hub API, its OpenAPI spec, the docs, and the source of `@huggingface/hub` 2.17.9
and `huggingface_hub`. Validated sample cards: `<local scratchpad>/cards/`
(`model_card.md`, `ds_card.md`), both accepted by `POST https://huggingface.co/api/validate-yaml`.

## Upload protocol

The API flow is `repos/create`, then `preupload`, then the LFS `batch` call, then an NDJSON `commit`. The batch call
sends bytes either through Xet (the default for Xet-aware clients) or through the LFS bridge (presigned S3 URLs). The
docs say uploads from non-Xet-aware clients still follow the standard Git LFS path, even on Xet-backed repos; a
background job migrates them later. Leave `"xet"` out of `transfers` to get presigned S3 actions:

- `basic`: one PUT of the whole file to `href`.
- `multipart`: `header.chunk_size`, part URLs in `header["00001"]`, `header["00002"]`, ..., and a completion URL in
  `href`. Keep each part's `ETag` response header.

The byte transfer needs no HF token: both official clients send the part PUTs and the completion POST without an
Authorization header, so a third machine can do them. Only `batch` needs auth (plus an optional `verify` action).
How long the URLs stay valid isn't documented: re-request them on a 403.

```http
POST https://huggingface.co/api/repos/create              (Authorization: Bearer $HF_TOKEN on every HF API call)
{"type":"model","name":"<slug>","organization":"<ns>","visibility":"private","license":"apache-2.0"}
-> 200 {"url","name","id"} | 409 {"error","url"}  (already exists, or "conflicting operation in progress": retry)
   (for a dataset: "type":"dataset")

POST https://huggingface.co/api/models/<ns>/<slug>/preupload/main        (datasets: /api/datasets/<ns>/<slug>/...)
{"files":[{"path":"adapter_model.safetensors","size":224498992,"sample":"<base64 of the first 512 bytes>"}]}
-> {"files":[{"path":"..","uploadMode":"lfs"|"regular","shouldIgnore":false}],"commitOid":".."}

POST https://huggingface.co/<ns>/<slug>.git/info/lfs/objects/batch       (datasets: /datasets/<ns>/<slug>.git/...)
Accept: application/vnd.git-lfs+json
Content-Type: application/vnd.git-lfs+json
{"operation":"upload","transfers":["basic","multipart"],"hash_algo":"sha256","ref":{"name":"main"},
 "objects":[{"oid":"<sha256 hex>","size":224498992}]}
-> {"transfer":"multipart","objects":[{"oid":"..","size":..,"actions":{"upload":{"href":"<completion url>",
    "header":{"chunk_size":"<n>","00001":"<S3 PUT url>","00002":".."}}}}]}
   (no "actions" on an object = already stored)

PUT <part url>          body = bytes [i*n, (i+1)*n); keep the ETag response header
POST <completion url>   Content-Type: application/vnd.git-lfs+json, no token
{"oid":"<sha256>","parts":[{"partNumber":1,"etag":"\"..\""}]}

POST https://huggingface.co/api/models/<ns>/<slug>/commit/main     Content-Type: application/x-ndjson
{"key":"header","value":{"summary":"Publish adapter","description":"job 123"}}
{"key":"lfsFile","value":{"path":"adapter_model.safetensors","algo":"sha256","oid":"<sha256>","size":224498992}}
{"key":"file","value":{"path":"README.md","content":"<base64>","encoding":"base64"}}
-> {"success":true,"commitOid":"..","commitUrl":"..","hookOutput":".."}

PUT  https://huggingface.co/api/models/<ns>/<slug>/settings  {"visibility":"public"}   (datasets: /api/datasets/...)
POST https://huggingface.co/api/validate-yaml  {"repoType":"model","content":"<README>"}  (no auth; 400 lists errors)
GET  https://huggingface.co/api/whoami-v2   (check what a token can do)
```

## @huggingface/hub (2.17.9, 2026-10-22)

Pure JS with an inlined WASM, Node 18+, no native deps (Node runtime, not Edge). `useXet` defaults to true and falls
back to LFS. `content: new URL(...)` streams by HTTP range when the host answers a `Range: bytes=0-0` probe with 206,
otherwise it buffers the whole file. `createRepo({ repo, accessToken, visibility, license })`,
`uploadFiles({ repo, accessToken, files: [{ path, content: Blob | URL }] })`,
`commit({ repo, accessToken, title, operations: [{ operation: "addOrUpdate", path, content }] })`. There is no helper
for visibility; use `PUT .../settings`. The library can't commit LFS objects someone else already uploaded, so a
commit that references GPU-uploaded objects by oid has to call the NDJSON commit API directly (plain fetch).

## Card metadata

Model card front matter accepted by validate-yaml:

```yaml
base_model: unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit
base_model_relation: adapter
library_name: peft
pipeline_tag: text-generation
license: apache-2.0
language: [en]
tags: [lora, peft, unsloth, trl, sft]
datasets: [<ns>/<dataset-slug>]
model-index:
- name: <slug>
  results:
  - task: {type: text-generation, name: Blind pairwise vs base}
    dataset: {name: held-out prompts, type: <ns>/<dataset-slug>, split: eval}
    metrics: [{name: Judge win rate vs base, type: win_rate, value: 1.0}]
    source: {name: Muse Muse blind eval, url: https://muse-muse.vercel.app/fine-tuning/<jobId>}
```

- Set `base_model_relation: adapter` explicitly (the Hub's inference is unreliable). Allowed: adapter, merge,
  quantized, finetune. Adapter repos have no config.json, so set `library_name` and `pipeline_tag` yourself. The Hub
  then tags `base_model:adapter:<id>` and counts the adapter on the base model.
- `base_model` rejects `@sha`. Pin the base revision with `"revision"` in `adapter_config.json` (PEFT's AutoPeftModel
  loads the base at that revision) and state it in the card text.
- `.eval_results/` only accepts allow-listed benchmarks. Use `model-index` plus a README table for a custom judge eval.
- Put the story in a `## Why this exists` section before the method, cost and eval sections.
- Dataset card fields: `license, language, task_categories: [text-generation], size_categories: [n<1K],
  annotations_creators: [machine-generated], language_creators: [machine-generated], source_datasets: [original],
  tags: [synthetic, sft]`, and `configs` with a `default` config over the train and eval JSONL. Results with another
  schema go in their own config. The validator accepts made-up enum values, so check them yourself.

## The base model (live API)

- `unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit`: sha `ecedda395d4d099b477d135a9a573eedaa5a7aad` (our pinned revision is
  current main), not gated, public, `license:apache-2.0`, `baseModels: {relation: quantized, models: [meta-models/Muse-Glimmer-30B]}`,
  `pipeline_tag: image-text-to-text`.
- `meta-models/Muse-Glimmer-30B`: not gated, Apache 2.0, ships `LICENSE` and `USAGE_POLICY.md`, no NOTICE file.
- Apache 2.0 allows publishing adapters, commercially too, with no naming rule. Include the license, state the changes,
  keep notices. Section 6 grants no trademark rights: name the base model to say what the adapter is for, never imply
  Meta endorses it. The Usage Policy says the model "is not intended for individuals under the age of 18"; cite it.

## Tokens and limits

- A fine-grained token with write access to the target namespace ("Write access to contents/settings of all repos
  under your personal namespace", or the org equivalent). Per-repo scopes can't cover repos that don't exist yet.
- Orgs can't be created by API. A dedicated org with a contributor-role bot user is the tidy setup.
- Rate limits per 5-minute window: 1,000 API calls on free accounts, 2,500 on PRO. Creating repos at the same time in
  one namespace returns 409: retry. Over the limit returns 429.

## Pitfalls

- Repo names: 1 to 96 characters of `[A-Za-z0-9._-]`, no leading or trailing `-` or `.`, no `--` or `..`, no `.git`.
- New repos are public unless the org defaults to private: create private, make public after checks.
- Files over 10 MB need LFS or Xet (`preupload` decides). `tokenizer.json` is about 28 MB, so it is LFS. Commits time
  out after 60 s: keep each under about 100 files.
- Escape `|` and newlines inside README table cells. Overwrite the README that TRL/PEFT generate.
- Leave out `checkpoint-*`, `optimizer.pt` and `training_args.bin` (a pickle).
- Never pass the HF token as a workflow step argument or return value (step data is persisted). Read it from the
  environment inside the step.
- Before making anything public, scrub personal data, and mind the teacher and judge models' terms for outputs.
