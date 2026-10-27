# Contracts

Every module codes against this file. Shared dataclasses are in `base/types.py`, settings in `base/config.py`. If you need a contract change, make it here and in `base/types.py` together, and say so in your report.

## Data flow

```
Muse (cloud VM) --MCP over HTTPS--> relay (Cloudflare Worker) <--WebSocket dialed out by device-- base/connector/relay_client.py
                                                                                       |
                                                                         base/connector/server.py (127.0.0.1:8790)
                                                                                       |
     tool call -> restore tags in arguments -> workspace / jobs -> raw local result (real names, stays here)
                                                                                       |
                                       guard.tag(raw) -> TagResult -> router.decide() -> RouteDecision
                                                                                       |
               share_tagged: tagged text | share_summary: local summary, tagged | ask_user: approval row, wait | refuse: held message
                                                                                       |
                                         egress.check(final_text) (leak check, last line of defense) -> Muse
```

`base/egress.py` is the single exit. Every connector tool result goes through `egress.release(...)`, which runs the router outcome and a final leak check against the roster, the persistent tag map and `guard.find_identifiers`. If the final check finds anything, the result is replaced with a refusal and an audit row records "egress_blocked". No other code path may return document-derived text to Muse.

## Settings (`base/config.py`)

`load_settings(env=None) -> Settings`, reading `.env` in the repo root then the process env (process env wins). Fields:

| Field | Env | Default |
|---|---|---|
| device | BASE_DEVICE | laptop (laptop or jetson) |
| home | BASE_HOME | ~/.base |
| glimmer_backend | GLIMMER_BACKEND | openrouter (openrouter or llama_server) |
| answer_url / answer_model | derived | openrouter: OPENROUTER_BASE + GLIMMER_MODEL; llama_server: http://127.0.0.1:8081/v1 + "glimmer" |
| router_url / router_model | derived | openrouter: same as answer; llama_server laptop: http://127.0.0.1:8082/v1, jetson: 8081 |
| model_api_key | OPENROUTER_API_KEY when openrouter, LLAMA_API_KEY when llama_server | None |
| heavy_queue | HEAVY_QUEUE | True on jetson: heavy steps may go to the dial-out worker |
| spark_base / spark_model / meta_api_key | META_API_BASE / SPARK_MODEL / META_API_KEY | https://api.meta.ai/v1, muse-spark-1.3 |
| workspace_root | WORKSPACE_ROOT | <repo>/demo |
| roster_path | ROSTER_PATH | <repo>/eval/roster.json |
| policy_path | USER_POLICY | <repo>/eval/user_policy.yaml |
| approval_host / approval_port | APPROVAL_HOST / APPROVAL_PORT | 127.0.0.1 / 8787 (jetson may set APPROVAL_HOST to its LAN address) |
| connector_port | CONNECTOR_PORT | 8790, always bound to 127.0.0.1 |
| relay_url | RELAY_URL | None |
| dreaming_backend | DREAMING_BACKEND | prompt (prompt or lora) |
| is_cloud_backend | property | True when glimmer_backend is openrouter |

`Settings.paths` gives `db` (home/base.db), `output` (home/output), `adapters` (home/adapters), `tagmap` (home/tagmap.json), `audit` (home/audit.db is the same db, table audit), `router_prompt` (home/router_rules.md).

`assert_synthetic(folder)` raises `CloudBackendRefused` when the backend is a cloud endpoint and the folder (or a parent up to the repo root) has no `.synthetic` file. The workspace calls it before reading any document.

## Types (`base/types.py`)

- `Person(name, first, last, nicknames=[], role="student", student_id=None)`; `Roster(teacher: Person, students: list[Person], school=None)`; `Roster.people()` yields teacher then students.
- `Hit(kind, value, start, end)` where kind is one of `student, teacher, person, phone, email, ssn, card, otp, student_id, address, dob`.
- `TagResult(text, tag_map: dict[str, str], hits: list[Hit], blocked: list[str])`: tag_map maps a tag like `[Student C]` to its real value.
- `Decision = Literal["share_tagged", "share_summary", "ask_user", "refuse"]`, `STRICTNESS = {"share_tagged": 0, "share_summary": 1, "ask_user": 2, "refuse": 3}`, `stricter(a, b)`.
- `RouteInput(request, result_kind, tagged_text, hits, blocked, summary=None, topics=[])`: request is Muse's request text (already tag-only), result_kind is one of the kinds below, topics are policy topic names the guard or workspace detected (for example `iep`, `grades`).
- `RouteDecision(decision, reason, source, latency_ms, floors=[])`: source is `model`, `rule`, `fallback` or `cache`.
- Result kinds: `document_list, snippet, per_student, class_aggregate, contact_info, sensitive_record, free_text, dreaming_report`.

## Guard (`base/guard.py`)

- `load_roster(path) -> Roster`.
- `find_identifiers(text) -> list[Hit]`: exact checks only. Luhn-valid 13 to 19 digit card numbers, US SSNs (###-##-####, not 000/666/9xx area unless the fixture says test), phone numbers (US formats incl. (512) 555-0143, 512.555.0143, +1 512 555 0143), emails, one-time codes (4 to 8 digits next to words like code, OTP, PIN, verification), student IDs (pattern from roster ids, plus `S` or `ID` followed by 5 to 8 digits), street addresses (number + street suffix), dates of birth next to "born"/"DOB"/"birthday".
- `find_names(text, roster) -> list[Hit]`: full names, first names alone, last names alone when capitalized, listed nicknames, possessives ("Maya's"), and misspellings within one edit (Damerau-Levenshtein 1, only for tokens of 4+ letters, never for common English words; keep a stoplist).
- `TagMap`: persistent, per device, at `settings.paths.tagmap`. Students get `[Student A]`, `[Student B]`, ... in a shuffled order chosen once per device (not roster order). Teacher is `[Teacher]`. Other kinds get numbered tags `[Phone 1]`, `[Email 1]`, `[SSN 1]`, `[Card 1]`, `[Code 1]`, `[ID 1]`, `[Address 1]`, `[DOB 1]`, `[Person 1]`. The same real value always gets the same tag on the device. The file is written 0600 and never leaves.
- `tag(text, roster, tagmap, llm_names=None, policy=None) -> TagResult`: runs identifiers, roster names, then optional `llm_names(text) -> list[str]` (the local model's second pass for person names the roster missed, tagged as `[Person N]`), then `blocked_reasons`. Replacement is longest-span-first and never splits a tag. After tagging, re-scan the output; anything still found is replaced too.
- `restore(text, tag_map) -> str`: swaps tags back, tolerant of Muse rephrasing: `Student A`, `[Student A]`, `Student A's`, `student a`, `(Student A)`.
- `blocked_reasons(text, policy) -> list[str]`: plain-language reasons for content the policy never allows out (IEP or 504 details, medical or diagnosis, discipline records, custody, immigration status, home address of a student, parent contact info). Keyword based from the policy's `never_share` topics.
- `leaks(text, roster, tagmap) -> list[Hit]`: everything in text that is a real roster name, nickname, tagged real value, or identifier. Used by egress and the eval.

## Model clients

`base/local_llm.py`:
- `class LocalLLM(settings, role="answer"|"router")` with `chat(messages, *, max_tokens=2000, json_schema=None, tools=None, reasoning="low", adapter=None, timeout=120) -> ChatResult(content, tool_calls, reasoning_tokens, prompt_tokens, completion_tokens, latency_ms, model)`.
- Speaks OpenAI chat completions to either backend. openrouter: model from settings, `reasoning: {"effort": ...}`. llama_server: `chat_template_kwargs: {"reasoning_strength": ...}`, and when `adapter` is set, `lora: [{"id": <id>, "scale": 1.0}]` per request.
- `chat_json(messages, schema, **kw) -> dict` parses content as JSON, retrying once on parse failure, raising `LLMParseError` after.
- `health() -> bool`.
- Raises `CloudBackendRefused` if called with `settings.is_cloud_backend` and `synthetic=False` was passed by the caller; workspace callers pass `synthetic=True` only after `assert_synthetic`.
- `llm_names(text) -> list[str]`: the guard's second pass helper (asks Glimmer for person names as JSON).

`base/spark.py`:
- `class Spark(settings, roster=None)` with `chat(messages, *, max_tokens=4000, json_schema=None, effort="minimal", cache=True) -> SparkResult(content, usage, cached)`.
- SQLite response cache at `eval/.cache/spark.db` keyed by a hash of the full request body; token counts per call logged in table `spark_calls(ts, model, prompt_tokens, completion_tokens, reasoning_tokens, cached)`.
- Refuses (raises `SparkRefused`) if any message contains a roster name, nickname or `find_identifiers` hit.

## Workspace (`base/workspace/`)

- `index.py`: `DocumentIndex(settings)`. `list(folder) -> list[Doc(id, path, title, size, modified)]`, `read(doc_id) -> str`, `search(query, k=5) -> list[Snippet(doc_id, title, text, score)]` (BM25 over .md/.txt files, no embeddings), all under `settings.workspace_root`. Folder names are relative to the root; reject `..` and absolute paths.
- `jobs.py`: `JobStore(db)`: tables `jobs(id, kind, instructions, folder, status, created_at, finished_at, result_kind, raw_result, summary, approval_id, error, model_log)`. Status: `queued, running, waiting_for_approval, done, refused, failed`. `raw_result` is stored on the device only.
- `agent.py`: `run_private_task(instructions, folder) -> job_id` starts a background thread. The agent restores tags in the instructions, reads each document, and for a rubric job grades each essay against `rubric.md` in the folder (JSON per essay: score 1 to 4 per criterion, total, strengths, next_step, feedback paragraph), writes one feedback file per student with real names to `settings.paths.output / job_id / "<Student Name> feedback.md"`, and builds a raw result: per-student scores table plus a class summary. For non-rubric instructions, it applies the instructions to each document and then writes a combined answer. Emits light events: `working` while it runs.
- Each model step is logged in `model_log` as `{step, model, backend, device, latency_ms}` so reports can say which model did which step.

## Router (`base/router.py`)

- `class Router(settings, llm, policy, rules_text=None, adapter=None)`, `decide(inp: RouteInput) -> RouteDecision`.
- Short system prompt + the rules learned by dreaming (prompt backend: `settings.paths.router_prompt`) and the RouteInput, asking for JSON `{"decision": ..., "reason": ...}` via json_schema. Reasoning strength low.
- Floors, applied after the model: any `blocked` reason -> `refuse`, unless the policy marks that topic `ask_first`, in which case at least `ask_user`. Any `hits` of kind phone/email/ssn/card/otp/address/dob/student_id in the raw text -> at least `ask_user`. Parse error or model error -> `ask_user` with source `fallback`. Result kind `dreaming_report` and `document_list` -> rule path, `share_tagged`, no model call.
- `decide_many` is not needed; keep it simple.

## Approvals (`base/approvals.py`)

- `ApprovalStore(db)`. Table `decisions(id, ts, job_id, tool, request, result_kind, tagged_text, router_decision, router_reason, router_source, status, user_decision, decided_by, decided_at, deleted)`. Every routed result gets a row. `status`: `auto` (router did not ask), `pending`, `approved`, `denied`. `user_decision`: `approve` or `deny` when asked. `decided_by`: `user`, `policy_sim`.
- `create_pending(...) -> id`, `decide(id, approve: bool, by="user")`, `pending()`, `history(limit)`, `delete(id)` (sets deleted=1 and blanks request and tagged_text), `training_rows(exclude_ids) -> list[dict]` (only non-deleted rows with a user decision).
- `eval/user_policy.yaml` is loaded by `base/policy.py`: `UserPolicy.load(path)`, `policy.wants(item) -> Decision` (what this teacher wants for a request, from `kind` and `topics`), `policy.answer(item) -> "approve" | "deny"` (how the simulated teacher answers an approval request), `policy.never_share` (topic -> keywords), `policy.pre_approved(kind, topics) -> bool`.

## Connector (`base/connector/`)

- `server.py`: MCP server (official `mcp` Python SDK, streamable HTTP) on 127.0.0.1:8790 at path `/mcp`. Requires `Authorization: Bearer <device connector token>` from the relay client (local only), token in `settings.home / "connector_token"`.
- Tools and annotations (Muse classes tools Read, Write, Sensitive write):

| Tool | Muse class | Input | Returns |
|---|---|---|---|
| list_documents | Read | folder | tagged titles, through egress |
| search_documents | Read | query | up to 5 short tagged snippets, through egress |
| run_private_task | Write | instructions, folder | job id and status |
| get_result | Read | job_id | status, then the tagged or summarized result, or "waiting for your OK on the device", or "kept on the device" |
| run_dreaming | Write | none | job id, idempotent while one runs |
| dreaming_report | Read | none | aggregate numbers only |

- `audit.py`: `audit(tool, outcome)` writes `audit(ts, tool, outcome, ms)`; never content.
- `relay_client.py`: dials out to `RELAY_URL` over WebSocket with the device secret, forwards each JSON-RPC message to the local MCP server, returns responses. Reconnects with backoff. `python -m base.connector.relay_client pair` asks the relay for an 8 character one-time pairing code (single use, 10 minute expiry) and prints it.

## Relay (`relay/`, Cloudflare Worker, TypeScript)

- Worker + one Durable Object per device. Device endpoint `GET /device/connect` (WebSocket, `Authorization: Bearer <device secret>`), `POST /device/register` (returns device id + secret once), `POST /device/pair` (device asks for a pairing code). Muse endpoint `POST /mcp` (streamable HTTP, OAuth bearer), OAuth via `@cloudflare/workers-oauth-provider` with dynamic client registration; the authorize page asks for the pairing code, which binds the grant to that device. The relay stores no tool content; it forwards bytes and keeps only device ids, hashed secrets and grants.

## Dreaming (`base/dreaming/`)

- `dataset.py`: `build(store, synthetic_path, holdout_ids) -> list[Example(request, result_kind, tagged_text, label, weight)]`. User rows weigh 3, synthetic rows 1. Skips deleted rows and holdout ids. Label from the user: approve -> the decision shown when asked becomes `share_tagged` (or `share_summary` if a summary was shown), deny -> `refuse`.
- `train.py`: backend `prompt` (default): writes `router_rules.md`, a short list of this user's rules learned from their decisions, using Glimmer to compress the log into rules plus exact counts; trained from scratch each night. Backend `lora`: writes a training JSONL and launches `scripts/cloud/train_lora_modal.py` (not run locally), producing a GGUF LoRA in `adapters/`.
- `gate.py`: `gate(candidate, current) -> GateResult(keep: bool, scores)`, runs `eval/run_eval.py` logic on the holdout; keep only if accuracy and agreement are no worse in every category and leaks stay 0.
- `night.py`: `run_night(settings) -> NightReport(learned_from, accuracy_before, accuracy_after, agreement_before, agreement_after, kept, leaks, seconds)`; idempotent lock in the db so a second call while running returns the running job id.

## Eval (`eval/`)

- `roster.json`: invented teacher and 24 invented students (24 essays, one per student), with nicknames and student ids.
- `tasks.jsonl`: 100 items, 25 per expected decision. Item fields: `id, request, result, result_kind, topics, expected, names, identifiers, tricky, notes`. `request` is what Muse sends (it never contains real names). `result` is the raw local result that would leave, with real names. `names` and `identifiers` are the ground truth that must never appear in anything returned.
- `holdout.jsonl`: 20 of the 100 (5 per expected decision), never trained on.
- `synthetic.jsonl`: 2,000 invented items in the same shape, written by Muse Spark, none overlapping tasks or holdout.
- `user_policy.yaml`: the simulated teacher.
- `run_eval.py`: `python -m eval.run_eval --set eval/tasks.jsonl --device laptop --out eval/reports/<name>.md`. Per item: guard.tag the result, router.decide, egress.release, then score: accuracy vs `expected` per category, agreement vs `policy.wants(item)`, approvals requested, leaks (any `names`/`identifiers`/roster value in the released text), latency. Writes markdown + `eval/reports/raw/<name>.jsonl`, and puts the exact command at the top of the report.

## Light and events (`base/events.py`, `base/light.py`)

- `events.emit(state, detail=None)`, states `idle, working, waiting, sending`. In-process subscribers plus an SSE stream at `GET /events` on the approval page.
- `light.py` subscribes and writes one line per state change to a USB serial device (`LIGHT_SERIAL`, e.g. /dev/ttyACM0), protocol `STATE <name>\n`; firmware in `hardware/light/`. No serial device configured -> logs only.

## Heavy steps (`base/heavy/`)

- On the Jetson, `queue.py` keeps heavy steps (grading) in the db; the approval server exposes `GET /heavy/next` (long poll) and `POST /heavy/<id>/result`, authenticated with the paired worker token.
- `worker.py` runs on the laptop, dials out to the Jetson (`JETSON_URL`), runs each step against the laptop's Glimmer, posts the result back. If no worker has checked in within 30 s, the Jetson runs the step on its own 1-bit Glimmer and logs that.
