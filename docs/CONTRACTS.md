# Contracts

Every module codes against this file. Shared dataclasses are in `base/types.py`, settings in `base/config.py`. If you need a contract change, make it here and in the code together, and say so in your report. This file describes the code as of Oct 27, after integration and the review fixes (see the last section).

## Data flow

```
Muse (cloud VM) --MCP over HTTPS--> relay (Cloudflare Worker) <--WebSocket dialed out by device-- base/connector/relay_client.py
                                                                                       |
                                                                         base/connector/server.py (127.0.0.1:8790)
                                                                                       |
     tool call -> restore tags in arguments -> workspace / jobs -> raw local result (real names, stays here)
                                                                                       |
            guard.tag(raw, llm_names=Glimmer's second pass) -> TagResult
            + request topics (never-share keywords in Muse's request, Glimmer's request_topics pass) -> router.decide() -> RouteDecision
                                                                                       |
               share_tagged: tagged text | share_summary: local summary, tagged | ask_user: approval row, wait | refuse: held message
                                                                                       |
                                         egress.final_check(text) (leak check, last line of defense) -> Muse
```

`base/egress.py` is the single exit. Every connector tool result goes through `egress.release(...)` or `egress.resolve(...)`, which run the router outcome and a final leak check against the roster, the persistent tag map and `guard.find_identifiers`. If the final check finds anything, the result is replaced with "Held on your device." and an audit row records `egress_blocked`. No other code path returns document-derived text to Muse.

## Settings (`base/config.py`)

`load_settings(env=None) -> Settings`, reading `.env` in the repo root then `env` (default `os.environ`; it wins). `read_dotenv` strips quotes, and an unquoted value ends at an inline ` # comment`, so `.env.example` copies straight to `.env`. Fields:

| Field | Env | Default |
|---|---|---|
| device | BASE_DEVICE | laptop (laptop or jetson) |
| home | BASE_HOME | ~/.base |
| glimmer_backend | GLIMMER_BACKEND | openrouter (openrouter or llama_server) |
| answer_url / answer_model | derived | openrouter: OPENROUTER_BASE + GLIMMER_MODEL (meta/muse-glimmer-30b); llama_server: ANSWER_URL or http://127.0.0.1:8081/v1, model "glimmer" |
| router_url / router_model | derived | openrouter: same as answer; llama_server: ROUTER_URL, else laptop 8082, jetson the answer URL |
| model_api_key | OPENROUTER_API_KEY when openrouter; LLAMA_API_KEY when llama_server, else the file BASE_HOME/llama_api_key (llama-server reads the same file with --api-key-file) | None |
| heavy_queue | HEAVY_QUEUE | "1" on jetson, else "0" |
| spark_base / spark_model / meta_api_key | META_API_BASE / SPARK_MODEL / META_API_KEY | https://api.meta.ai/v1, muse-spark-1.3 |
| workspace_root | WORKSPACE_ROOT | <repo>/demo (resolved) |
| roster_path / policy_path | ROSTER_PATH / USER_POLICY | <repo>/eval/roster.json, <repo>/eval/user_policy.yaml |
| approval_host / approval_port | APPROVAL_HOST / APPROVAL_PORT | 127.0.0.1 / 8787 (a laptop refuses any non-loopback host) |
| connector_port | CONNECTOR_PORT | 8790, always bound to 127.0.0.1 |
| relay_url / jetson_url | RELAY_URL / JETSON_URL | None |
| dreaming_backend | DREAMING_BACKEND | prompt (prompt or lora) |
| light_serial | LIGHT_SERIAL | None |
| approval_tls_cert / approval_tls_key | APPROVAL_TLS_CERT / APPROVAL_TLS_KEY | None; with both set the approval port serves TLS and `approval_tls` is True |
| is_cloud_backend | property | True when glimmer_backend is openrouter |

`Settings.paths` gives `db` (home/base.db: decisions, jobs, audit, heavy and dreaming tables), `output` (home/output), `adapters`, `tagmap` (home/tagmap.json), `router_prompt` (home/router_rules.md), `connector_token` (home/connector_token). `ensure_home()` makes home, output and adapters with mode 0700. Not in Settings, read only by scripts: HEAVY_TOKEN (base/heavy/worker.py), LLAMA_SERVER_BIN, GLIMMER_GGUF, ANSWER_CTX, ROUTER_CTX (scripts/start.sh). All are in `.env.example`.

`assert_synthetic(settings, folder)` raises `CloudBackendRefused` when the backend is a cloud endpoint and neither the folder nor a parent of it up to and including `settings.workspace_root` has a `.synthetic` file (`synthetic_marked(folder, root)`). A marker above the workspace root never counts, and a folder outside the root is refused. The index, the agent and egress call it before any document text can reach a cloud model.

## Types (`base/types.py`)

- `Person(name, first, last, nicknames=(), role="student", student_id=None)`; `Roster(teacher, students: tuple[Person, ...], school=None)`; `Roster.people()` yields teacher then students. Frozen; `load_roster` returns tuples.
- `Hit(kind, value, start, end)`, kind one of `student, teacher, person, phone, email, ssn, card, otp, student_id, address, dob` (`IDENTIFIER_KINDS` is the last eight). Egress may also report `check_failed`.
- `TagResult(text, tag_map, hits, blocked, topics)`: `tag_map` maps each tag used in this text (like `[Student C]`) to its real value; `blocked` holds plain reasons, `topics` the never-share topic names.
- `Decision` is `share_tagged | share_summary | ask_user | refuse`; `STRICTNESS`, `stricter(a, b)`, `default_share_form(kind, topics=())` (`share_summary` for `class_aggregate` or when `CLASS_LEVEL_TOPIC` (`"class_level"`, a request topic) is in `topics`, else `share_tagged`).
- `RouteInput(request, result_kind, tagged_text, hits=[], blocked=[], summary=None, topics=[])`; `RouteDecision(decision, reason, source, latency_ms=0, floors=[])`, source `model | rule | fallback | cache`.
- Result kinds: `document_list, snippet, per_student, class_aggregate, contact_info, sensitive_record, free_text, dreaming_report`.

## Guard (`base/guard.py`)

- `load_roster(path) -> Roster`. `GuardError` for an unreadable tag map or text that still has private values after tagging.
- `find_identifiers(text, roster=None, *, allow_test_ssn=True) -> list[Hit]`: Luhn-valid 13 to 19 digit cards, SSNs (000 and 9xx areas accepted unless `allow_test_ssn=False`), US phone formats, emails, one-time codes next to code/OTP/PIN/verification, student ids (`S` or `ID` plus 5 to 8 digits, and the roster's id shape when a roster is given), numbered street addresses, dates of birth next to born/DOB/birthday. Plain calendar dates are not identifiers.
- `find_names(text, roster)`: full names, first names, capitalized last names, nicknames, possessives, a teacher's title plus last name, one-edit misspellings of capitalized 4+ letter tokens that are not common words. A first name two students share becomes `[Person N]`; relatives with a roster surname too.
- `TagMap(path=None, *, seed=None)`, `TagMap.load(path)`, `TagMap.for_settings(settings)`: persistent at `settings.paths.tagmap`, written 0600 atomically. Students get `[Student A]`... in a per-device shuffled order, the teacher `[Teacher]`, others `[Phone 1]`, `[Email 1]`, `[SSN 1]`, `[Card 1]`, `[Code 1]`, `[ID 1]`, `[Address 1]`, `[DOB 1]`, `[Person 1]`. Same value, same tag. Methods: `tag_for(kind, key, value)`, `ensure_roster(roster)`, `get(tag)`, `kind_of(tag)`, `as_dict() -> {tag: real value}` (a student's value is the full name), `values()`, `save()`, `flush()`.
- Every scan (tag, leaks, find_names, find_identifiers, blocked_topics) runs on a normalized copy of the text and maps spans back: NFKC, format characters removed (soft hyphen, zero-width spaces), every dash as `-`, modifier apostrophes as `’`, `_` as a space, and line-break hyphenation joined. Name and keyword matches need a non-letter on each side, so `camila_iep_goals.md` shows a name and the `iep` topic. A lowercase last name of 4+ letters that is not a common word counts. Identifiers also cover en dashes and non-breaking hyphens, dotted card numbers, `S-401127`, a 9-digit run within 30 characters of ssn/itin/social, and lowercase street addresses with a plain street word. `long_digit_runs(text)` lists runs of 7+ digits (alone or joined by `-` or `.`) that are not dates. `name_occurs(name, text)` is the flexible check the model's name pass uses.
- `tag(text, roster, tagmap, llm_names=None, never_share=None) -> TagResult`: identifiers, roster names, every real value already in the tag map, then names from `llm_names(text)` (the local model's second pass) as `[Person N]`, lowercase ones included; a name that is also a common word (Mason, Grace) is tagged where the text capitalizes it. Longest span first, never inside a tag, re-scanned until clean. If `llm_names` raises, so does `tag`.
- `restore(text, tag_map)`: tags back to values, tolerant of `Student A`, `student a`, `Student A's`, `(Student A)`; accepts a dict or a TagMap.
- `blocked_topics(text, never_share)`, `blocked_reasons(text, never_share)` (wording in `TOPIC_REASONS`, else "Mentions <topic>"), `leaks(text, roster, tagmap) -> list[Hit]` (used by egress and the eval): everything tag() would find plus full names of 8+ letters spelled run together, letter by letter, slugged or reversed, so final_check is stricter than tag().

## Model clients

`base/local_llm.py`:
- `LocalLLM(settings, role="answer"|"router", *, client=None)`. The httpx client has `trust_env=False`: no environment or system proxy. `chat(messages, *, max_tokens=2000, json_schema=None, tools=None, tool_choice=None, reasoning="low", adapter=None, timeout=None, synthetic=False)` (timeout None: 120 s, or on llama_server `max(120, max_tokens / 5 + 60)` s; connect 10 s; a read timeout on llama_server is not retried) -> ChatResult(content, tool_calls, reasoning_tokens, prompt_tokens, completion_tokens, latency_ms, model, finish_reason, provider)`.
- On a cloud backend every call must pass `synthetic=True` or it raises `CloudBackendRefused`. openrouter sends `reasoning: {"effort": ...}`; llama_server sends `chat_template_kwargs.reasoning_strength` and, with `adapter`, `lora: [{"id": int, "scale": 1.0}]` (an adapter on openrouter is a `ValueError`). A `Reasoning strength:` line is added to the system prompt if missing. A reply cut off with no content is retried once with double the budget, then `LLMTruncated`.
- `chat_json(messages, schema, **kw) -> dict` (schema plain or `{name, strict, schema}`), one retry, then `LLMParseError`. Both subclass `LLMError`.
- `llm_names(text, *, synthetic=False, max_tokens=1500) -> list[str]`: names Glimmer finds, kept only if they occur in the text (`guard.name_occurs`: apostrophe, space and case differences allowed). `health()`, `close()`.
- `request_topics(request, topics: Mapping[str, str], *, synthetic=False, max_tokens=1500) -> list[str]`: the policy's request topics (name -> description) that Muse's tagged request matches, one strict-JSON call whose schema enumerates the names; returned in policy order. No call for an empty request or no topics. Measured against hand labels in eval/reports/request_topics.md (`scripts/check_request_topics.py`).

`base/spark.py` (eval and synthetic data only):
- `Spark(settings, roster=None)`: `chat(messages, *, max_tokens=4000, json_schema=None, effort="minimal", cache=True) -> SparkResult(content, usage, cached, finish_reason)`, `chat_json(messages, schema, **kw)`. Cache and usage in `eval/.cache/spark.db`, table `spark_calls(ts, model, prompt_tokens, completion_tokens, reasoning_tokens, cached, cached_tokens)`; `usage_summary(cache_path, since=None)`.
- Raises `SparkRefused` (a `SparkError`) for any roster name, nickname or identifier, and for every call if base.guard cannot be imported.

## Workspace (`base/workspace/`)

- `index.py`: `DocumentIndex(settings)`: `list(folder) -> list[Doc(id, path, title, size, modified)]` (recursive; `id` and `path` are the POSIX path relative to the workspace root, never absolute; `title` is the first markdown heading or the file stem), `read(doc_id) -> str`, `search(query, k=5, folder=None) -> list[Snippet(doc_id, title, text, score)]` (BM25 over .md/.txt, no embeddings), `resolve(name)`. Titles are found with a linear pattern on the first 2000 characters. list and search also check the marker on each file's resolved folder. Hidden files, files over 5 MB and links out of the root are skipped. A missing folder raises `FileNotFoundError`; `..`, `~` or an absolute path raises `WorkspacePathError` (a ValueError).
- `jobs.py`: `JobStore(db)`, table `jobs(id, kind, instructions, folder, status, created_at, finished_at, result_kind, raw_result, summary, approval_id INTEGER, error, model_log, release_status, released_text, topics)`. Status `queued, running, waiting_for_approval, done, refused, failed`; release status `none, releasing, shared, waiting, refused`. Methods: `create(kind, instructions, folder) -> id`, `start`, `set_status`, `set_kind`, `add_model_step`, `finish(job_id, raw_result, result_kind, summary=None, topics=())`, `fail`, `set_release(job_id, status, approval_id: int | None = None, released_text=None)`, `get(job_id) -> dict | None` (model_log and topics decoded, approval_id an int), `list_recent(limit=20)`, `claim_release(job_id) -> bool` (none to releasing; one caller wins), `reset_release(job_id)`, `fail_unfinished(error) -> int` (queued and running jobs become failed with "The device restarted before the job finished.", releasing goes back to none; Services.create calls it), `active_count()`. `set_release` moves a finished job to `waiting_for_approval`, `refused` or `done`; a failed job stays failed. `error` holds fixed messages only, never exception text.
- `agent.py`: `Agent(settings, llm, index, jobs, heavy=None, roster=None, tagmap=None, restore=None)`. `run_private_task(instructions, folder) -> job_id` starts a daemon thread, or raises `AgentBusy` when `MAX_ACTIVE_JOBS` (5) are queued or running; jobs take one model slot at a time on the device, two on the cloud backend. `run_sync` finishes first. `stop()` makes queued model steps fail at once (Services.close calls it). It stores Muse's tag-only instructions and restores tags locally only to choose what to do. The model gets Muse's instructions with their tags and every document, title and rubric with roster names, known tag-map values and identifiers swapped for the same tags; its answers are restored to real names on the device. It grades when the instructions mention grade/feedback/score/rubric and a `rubric.md` is in the folder or the nearest parent folder inside the workspace root (`demo/rubric.md` for `demo/essays`). Grading: one strict-JSON step per essay (`grade:<n>`, scores 1 to 4 for ideas, organization, evidence, conventions, total recomputed), all grades before any file, then `<Student Name> feedback.md` (0600) under `settings.paths.output / job_id`, a raw per-student table with real names for roster students and `Essay N` for anyone the roster does not know (`per_student`, topics `grades, writing`) and a class summary with names scrubbed. Otherwise map per document then reduce (`free_text`, no summary). Up to 4 steps at once on the cloud backend, 1 locally. `model_log` entries are `{step, model, backend, device, latency_ms, via: local|heavy}`. Emits `working`, then `idle` when no job is left.

## Router (`base/router.py`)

- `Router(settings, llm, policy, rules_text=None, adapter=None)`, `decide(inp, *, synthetic=False) -> RouteDecision`. `rules_text=None` re-reads `settings.paths.router_prompt` on every call.
- Rule path, no model call: `document_list` with a `person` hit (the name pass found someone the roster does not know) asks the user; otherwise `document_list` and `dreaming_report` share tagged; a policy rule marked `pre_approved` (matched on request, kind and topics) when nothing is blocked. Otherwise one strict-JSON call (`ROUTE_SCHEMA`, reasoning low, 1500 tokens) with the system prompt, the learned rules and the RouteInput (hit kinds only, real values scrubbed, text cut at 1500 characters).
- Floors on every path: a blocked reason or never-share topic -> `refuse`, or at least `ask_user` when every blocked topic is in `ask_first`; an identifier hit -> at least `ask_user`; a model or parse error -> `ask_user`, source `fallback`. Also: a long digit run (`guard.long_digit_runs`) in anything but `class_aggregate` and `dreaming_report` -> at least `ask_user`; every policy rule that wants `refuse` and matches the request, kind and topics -> `refuse` (a rule over never-share topics only is the blocked floor already); a learned `ask_user` or `refuse` rule (the dreaming file, matched with `train.rule_key`) -> at least that. When a floor decides the result, its fixed reason replaces the model's. Floor labels: `blocked:<topic>`, `ask_first:<topic>`, `identifier:<kind>`, `identifier:digits`, `policy:<rule id>`, `learned:ask_user`, `learned:refuse`, `blocked`, plus egress's `summary` and `name_check`.
- `build_user_message(inp, learned=None)` adds a "Learned rule for this result" line; `Router.learned_rule(inp)` returns the `train.RuleLine` that fits. router.py imports `base.dreaming.train` and `base.guard`.

## Approvals (`base/approvals.py`)

- `ApprovalStore(db_path)`, SQLite WAL behind one lock. Table `decisions(id, ts, day, job_id, tool, request, result_kind, topics, blocked, tagged_text, shown_form, router_decision, router_reason, router_source, status, user_decision, remember, decided_by, decided_at, deleted, item_id)`. Ids are ints. `blocked` is a JSON list of plain reasons from `TagResult.blocked`; the approval page shows it as is. Older dbs get the column on open.
- `record_auto(**kw) -> id` and `create_pending(**kw) -> id` take keywords `tool, request, result_kind, tagged_text, router_decision` and optionally `router_reason, router_source, topics, blocked, shown_form, job_id, day (default today(): days since 1970-01-01), item_id`. `decide(id, approve, remember=False, by="user"|"policy_sim")` returns the row; `KeyError` for no row, `ValueError` if it is not pending or was deleted. `get`, `pending()`, `history(limit=50)` (both skip deleted rows), `delete(id)` (deleted=1, request and tagged_text blanked), `training_rows()` (decided, not deleted, with `label`), `counts_by_day()` (rows that were not auto, per day), `close()`.
- `label_for(row)`: approve + remember -> `shown_form`; deny + remember -> `refuse`; no remember -> `ask_user`; undecided -> None.
- The approval page shows the exact tagged text, the router's reason, the blocked reasons, Share it / Keep it here and the remember box.

### Policy (`base/policy.py`, `eval/user_policy.yaml`)

`UserPolicy.load(path)` (or `from_dict`), `PolicyError` naming the file and field. Top-level keys `name, description, never_share, ask_first, request_topics, rules, default`; rule keys `id, kinds, topics_any, topics_all, request_any, wants, pre_approved, on_ask, note`. First match wins, else `default`. `ask_first` topics must be in `never_share`; `pre_approved` only with a share form; a rule without `on_ask` answers the way its `wants` implies.

```yaml
never_share:            # topic -> keywords; guard.blocked_topics uses these
  iep: ["IEP", "504 plan", "individualized education", "special education", "speech therapy", "accommodation plan"]
ask_first: []
request_topics:         # topic -> plain description; Glimmer labels Muse's request with these
  parents: "meant for a student's family: parents, guardians, a note or letter home, a family newsletter"
  class_level: "asks for class-level numbers or patterns (an average, a count, a trend)"
rules:
  - id: class_averages
    kinds: [class_aggregate]
    request_any: ["average"]
    wants: share_summary
    pre_approved: true
    on_ask: {approve: true, remember: true}
default: {wants: ask_user, on_ask: {approve: false, remember: false}}
```

`match(item) -> Rule`, `wants(item)`, `answer(item) -> (approve, remember)`, `pre_approved(kind, topics, request="")`, `never_share -> dict`, `ask_first -> set`, `request_topics -> dict[str, str]`. Request topic names are lowercase words and may not repeat a never-share topic; descriptions are whitespace-collapsed. `item` is any mapping or object with `request`, `result_kind`, `topics`. For every eval item `expected == policy.wants(item)` (tested).

### Egress (`base/egress.py`)

`Egress(services, guard=None)`. `release(tool, request, raw_text, result_kind, *, job_id=None, summary=None, topics=(), item_id=None, day=None, synthetic=None) -> Released(status, text, approval_id, decision, tag_result, retryable=False)`, status `shared | waiting | refused`.
- `synthetic=None` means: True only on a cloud backend whose workspace root is marked `.synthetic`. The eval passes True.
- Tagging calls `guard.tag` with `llm_names=functools.partial(answer_llm.llm_names, synthetic=...)` for every kind except `dreaming_report` (`NO_NAME_PASS`; document titles and paths get the pass). If tagging or the name pass raises, the result is held: "Held on your device.", decision refuse with floor `name_check`, audit `name_check_failed`, no decision row, and `Released.retryable` True. A summary the model could not write is held the same way (audit `summary_failed`). Muse's `request` is tagged with the roster pass before it is routed or stored.
- Request topics: never-share keywords found in the tagged request (`guard.blocked_topics`, so "Which students have an IEP?" is floored even when the answer has no keyword), plus `answer_llm.request_topics(request, policy.request_topics)` for every kind except `document_list` and `dreaming_report` (`NO_TOPIC_PASS`). Both join `topics` and the result's own keyword topics in the RouteInput and the decision row. If the model pass raises, the result is held like a failed name check: floor `topic_check`, audit `topic_check_failed`, no decision row, `retryable` True. The row's `shown_form` is `default_share_form(kind, topics)`.
- Then route, record one decision row (with `blocked`), and return. `share_summary` (and `ask_user` whose shown form is a summary: `class_aggregate`, or a `class_level` request) shares the tagged `summary`, or one the answer model writes from the tagged text; a summary that still has a `[Student X]` or `[Person N]` tag is refused.
- `resolve(approval_id: int) -> Released`: pending -> waiting, approved -> the stored tagged text, denied or deleted -> "Kept on your device.". `approval_id` is set for waiting rows and resolve results only.
- Texts to Muse: "Waiting for your OK on the device.", "Kept on your device. <one fixed sentence for the floor that kept it>" (`refusal_text(floors)`; the router's own reason is model text and stays on the approval page), "Held on your device.". After a shared result egress emits `sending`, then `waiting` or `idle`. Every one passes `final_check(text) -> list[Hit]` (`guard.leaks`; fails closed).

### Services (`base/services.py`)

`Services.create(settings, *, light=True, heavy=None)` wires one of each: `settings, events (base.events), roster (guard.load_roster), tagmap (TagMap.for_settings), policy, answer_llm, router_llm (LocalLLM roles), router, approvals, jobs, index, heavy (HeavyQueue on paths.db with wait_seconds=HEAVY_WAIT_SECONDS=120 when settings.heavy_queue, else None), agent (with heavy), audit (connector.audit.Audit on paths.db), egress, night (NightRunner), light (start_light)`. `Services.create(..., owner=True)` also fails jobs a stopped process left unfinished, tells `events` how many approvals are pending, and on llama_server with `DREAMING_BACKEND=lora` finds the router adapter's id (`GET /lora-adapters`, the entry ending in router.gguf) for `Router(adapter=...)`. `Services.for_eval(settings)` is the same with no light, no heavy queue, `owner=False` and a `QuietEvents` bus, so a night never drives the light or the page; `eval/run_eval.py` and the dreaming gate use it. `close()` stops the agent's model steps and the light and closes the store and model clients. Modules that need others take a `services` object; tests pass a `types.SimpleNamespace` with only what they use.

`python -m base` (or `python -m base.server`) builds Services, the approval page and the connector, and runs both uvicorn servers in one loop until Ctrl+C or SIGTERM, then closes Services. httpx request logging is turned down so no model or worker URL is logged.

## Connector (`base/connector/`)

- `server.py`: `connector_app(services, *, token=None)` is the MCP server (official `mcp` SDK, streamable HTTP, stateless, JSON responses) at `/mcp` plus `GET /health` without auth, served on 127.0.0.1:8790. Every other path needs `Authorization: Bearer <token>` from `settings.paths.connector_token` (made 0600 on first use). The SDK only accepts Host headers 127.0.0.1 or localhost. A standalone GET stream gets 405.
- Tools and annotations (Muse classes tools Read, Write, Sensitive write):

| Tool | Muse class | Input | Returns |
|---|---|---|---|
| list_documents | Read | folder | tagged titles and relative paths, through egress. A title or path with a never-share keyword is left out and counted: "N documents held back on the device." |
| search_documents | Read | query (tags restored locally) | up to 5 snippets of 300 characters, through egress |
| run_private_task | Write | instructions, folder | `{job_id, status}` |
| get_result | Read | job_id | `{job_id, status, result}`: still working, failed, or the release (see Jobs and releases); a `dream-` id gives `running` while that night runs, then `done` with its aggregate numbers |
| run_dreaming | Write | none | `{job_id, status}`, the same job while one runs (not idempotent: a call after a night ends starts another) |
| dreaming_report | Read | none | aggregate numbers only, through egress, with "A dreaming run is in progress." first while one runs |
| | | | A run_private_task above MAX_ACTIVE_JOBS gets one sentence with the count (audit `busy`). |

- Failures reach Muse as one plain sentence. Audit outcomes: `shared, waiting, refused, started, pending, failed, bad_input, busy, error, cloud_refused`; egress adds `egress_blocked`, `name_check_failed` and `summary_failed`.
- `audit.py`: `audit(db, tool, outcome, ms=0)`, `recent(db, limit=50)`, `Audit(db)` callable as `services.audit(tool, outcome, ms=0)`, table `audit(ts, tool, outcome, ms)`. Labels must be short lowercase words; never content.
- `relay_client.py`: dials out to `RELAY_URL` over WebSocket with the device secret, forwards each JSON-RPC message to the local MCP server, returns responses. Reconnects with backoff. `python -m base.connector.relay_client pair` asks the relay for an 8 character one-time pairing code (single use, 10 minute expiry) and prints it; `unlink` revokes every Muse link. A cleartext RELAY_URL is refused unless it is loopback. `run` exits 3 (the unit's RestartPreventExitStatus) when the secret is rejected or another copy took over.

## Relay (`relay/`, Cloudflare Worker, TypeScript)

- Worker + one Durable Object per device. Device endpoint `GET /device/connect` (WebSocket, `Authorization: Bearer <device secret>`), `POST /device/register` (returns device id + secret once), `POST /device/pair` (device asks for a pairing code). `POST /device/unlink` (bearer secret) revokes every OAuth grant bound to the device and returns `{"revoked": n}`. Muse endpoint `POST /mcp` (streamable HTTP, OAuth bearer), OAuth via `@cloudflare/workers-oauth-provider` with dynamic client registration; the authorize page asks for the pairing code, which binds the grant to that device. The relay stores no tool content; it forwards bytes and keeps only device ids, hashed secrets and grants.

## Dreaming (`base/dreaming/`)

- `dataset.py`: `build(store, synthetic_path, holdout_ids=()) -> list[Example(request, result_kind, tagged_text, label, weight, topics, source, approved, remember, row_id, item_id)]`. User rows weigh 3, synthetic rows 1. Skips deleted rows and holdout ids. Labels come from `approvals.label_for`.
- `train.py`: `train(examples, settings, backend=None, *, out_path=None, day=None, policy=None) -> TrainResult(backend, path, rules, examples, user_examples, cloud_required, message)`. Backend `prompt` (default) groups examples by `rule_key(kind, topics, relevant_topics(policy))` (relevant topics: never-share topics, request topics and every rule's topics) and writes one rule line per group with exact counts, plus strict topic rules `(topic: X)` that need evidence of their own, from scratch each night (deterministic, no model call). Groups the never-share floor always refuses (`floored_topics`) get no rule. `read_rules(text) -> list[RuleLine(kind, topics, decision, source, text)]` and `match_rule(rules, kind, topics)` read them back for the router. Backend `lora` writes `adapters/train-<date>.jsonl` and says to run `scripts/cloud/train_lora_modal.py`; it never launches it. In that file a row the user did not approve has its request and text withheld, and a row in which `guard.leaks` (roster and tag map) still finds anything is left out; with no roster or tag map nothing is written.
- `gate.py`: `gate(services, candidate_rules_path, current_rules_path, holdout_items, *, force=False) -> GateResult(keep, before, after, reasons)`. Both rule files are scored with `run_eval.evaluate` on the holdout in fresh temp homes; keep only if overall accuracy, every category and agreement are no worse and leaks are 0, and neither run has more than 10% of items that errored or fell back (`MAX_UNSCORED_SHARE`), so a night scored while the model was down keeps the current rules. `force` replaces rules learned from since-deleted decisions as long as the candidate leaks nothing.
- `night.py`: `NightRunner(services, *, holdout_path=None, synthetic_path=None)`: `start() -> job id` (the running one if a night is going), `run_night() -> NightReport` (raises `DreamingBusy(job_id)`), `running_job()`, `wait(timeout)`, `last_report() -> dict` with `learned_from, accuracy_before, accuracy_after, agreement_before, agreement_after, kept, leaks, seconds, night_number` (night 0, learned_from 0 and None for the rest before the first night). Lock and history in tables `dreaming_lock` (with an `owner` of pid and a per-process token: a lock whose process is gone is not a running night) and `dreaming_nights`. `report_for(job_id)` gives one night's numbers. `NightReport.categories` holds holdout accuracy per expected decision. `synthetic_path=""` means no practice data; `raw_dir` (set by the simulation) gets each night's gate rows.

## Eval (`eval/`)

- `roster.json`: invented teacher and 24 invented students with nicknames and student ids.
- `tasks.jsonl`: 100 items, 25 per expected decision. Fields: `id, request, result, result_kind, topics, expected, names, identifiers, tricky, notes`, plus `summary` on `class_aggregate` items, `other_names` on items whose result mentions people who are not on the roster (siblings, guardians, staff), and `dates` on items with plain calendar dates. `names`, `other_names` and `identifiers` must never appear in anything returned. Dates of birth are identifiers; other dates are not. eval/DATASET.md has the details.
- `holdout.jsonl`: 20 of the 100 (5 per decision), identical rows, never trained on but selected on by the gate. t016 replaced t015 on Oct 27 so the holdout has a shared item naming someone off the roster. `synthetic.jsonl`: invented items in the same shape, written by Muse Spark. `user_policy.yaml`: the simulated teacher.
- `run_eval.py`: `python -m eval.run_eval --set PATH --name NAME [--holdout [--holdout-file PATH]] [--limit N] [--rules PATH|none | --home DIR] [--device-label LABEL] [--out DIR]`. Each item goes through `egress.release(..., synthetic=True)` on `Services.for_eval` in a fresh temp home, with production inputs: the kind the connector really sends (`PRODUCTION_KIND`: sensitive_record and contact_info as snippet, class_aggregate as free_text), no hand-labeled topics, and a summary only for per_student. `--oracle-labels` passes the hand labels instead, for comparison with earlier reports. A waiting item the simulated teacher approves is decided and resolved in the temp home and the released text is leak-checked too. A row whose router fell back or whose name check failed is never counted correct (`fallbacks`); the report also gives `outcome_accuracy` (what Muse got) and the decision sources, and the command exits 2 when any item errored or fell back. Scores accuracy vs `expected` per category, agreement vs `policy.wants(item)`, approval requests, leaks (any `names`, `other_names`, `identifiers`, roster name or nickname, or `guard.leaks` hit in the released text), held, errors and latency. Writes `eval/reports/NAME.md` (command at the top) and `eval/reports/raw/NAME.jsonl` (ids and decisions only). `EvalReport` also has `model_calls`, `model_latency_mean_ms` and `model_latency_p95_ms` (router latency on model-decided items). API: `run, evaluate, services_for, release_item, find_leaks, load_items, write_report, write_raw_rows`.
- `scripts/simulate_nights.py`: no practice data by default (`--synthetic none`; eval/synthetic.jsonl is labeled with the simulated teacher's own policy, so a run with it is an ablation). nights.csv columns: night, approval_requests, accuracy, agreement, leaks, kept, seconds, wanted_requests, unneeded_requests, day_mix, acc_<decision>, day_leaks (every text Muse got that day, approvals included), user_rules, practice_rules. Gate rows per night go to `raw/nights/`.
- `scripts/bench_speed.py --label NAME` writes `NAME_speed.md` (Latency, Tokens/s) and raw rows; `scripts/secrets_scan.py [--history]` checks the tree and git history for key shapes, addresses, host names and the user name.

## Light and events (`base/events.py`, `base/light.py`)

- `events.emit(state, detail=None)`, states `idle, working, waiting, sending`; `subscribe(fn) -> unsubscribe`, `last()`, `settle(detail)` (waiting while an approval is pending, else idle; the agent, the night and the approval page use it instead of a bare idle), `set_pending_source(fn)`. The approval page streams them at `GET /events` (SSE). Details are job ids or counts, never text.
- `start_light(settings) -> Light` (called by `Services.create`) subscribes and writes `STATE <name>\n` to `LIGHT_SERIAL` for every event, repeats included, and writes the current state again every 5 s, so a board that reloaded catches up; with no port it only logs. The firmware plays `sending` as one 2 s sweep, then shows the state that came after it, and turns off CircuitPython's autoreload. `Light.stop()` detaches. Firmware in `hardware/light/`.

## Heavy steps (`base/heavy/`)

- `queue.py`: `HeavyQueue(db_path, wait_seconds=30)` (Services uses 120), tables `heavy_steps` and `heavy_workers` in the device db. `run(kind, messages, schema, *, synthetic=False) -> dict | None`: None at once when no worker said hello in the last 30 s (or holds a claimed step), None after `wait_seconds` without a result. A worker on a cloud backend only gets steps marked synthetic. Step messages are blanked when a step ends. `hello`, `worker_present(*, synthetic=False)`, `next`, `submit`, `status`.
- `routes.py`: `make_router(queue, token)`, `router_for(settings, queue=None)`, `load_token`, `print_token` (`python -m base.heavy.routes` prints the worker token). `TokenGate` checks the bearer token for every /heavy/ path before any body is read; the approval app's `BodyLimit` answers 413 above 64 KB (2 MB for /heavy/<id>/result). `python -m base.heavy.routes rotate` replaces the token. `POST /heavy/hello {worker, cloud}`, `GET /heavy/next?worker&cloud&wait` -> `{id, kind, messages, schema, synthetic}` or 204, `POST /heavy/{id}/result {result} | {error}` -> 200, 409 if abandoned, 404 for a bad id; 401 for a bad token. The approval page includes these routes when `settings.heavy_queue` is on.
- `worker.py` on the laptop: `python -m base.heavy.worker --jetson-url URL --token TOKEN [--synthetic] [--ca-cert PEM] [--allow-plain-http]` dials out to the Jetson and runs each step on the laptop's Glimmer. A non-loopback http URL is refused unless `--allow-plain-http`; with `--ca-cert` the Jetson's self-signed certificate is the only one trusted. Each step's model timeout stays 10 s under the `wait_seconds` that /heavy/hello returns. A worker counts as present while it holds a step claimed within wait_seconds, and a submitted result counts as a hello.

## Cross-module details pinned on Oct 27

### Jobs and releases
The connector's `get_result` first claims the release (`jobs.claim_release`); a call that loses the claim, or finds release status `releasing`, answers `{status: "running"}` with "The device is still checking this result.". The winner runs the release on a thread and waits up to `RELEASE_WAIT_SECONDS` (40, under the relay's 55); past that it answers `running` and the release finishes in the background. A retryable release resets the claim and answers `running`, up to `MAX_CHECK_FAILURES` (3) in a row, after which it is stored as refused. The release itself calls `egress.release("get_result", job.instructions, job.raw_result, job.result_kind, job_id=..., summary=job.summary, topics=job.topics)` the first time a finished job is read and stores the outcome with `jobs.set_release(job_id, status, approval_id=int | None, released_text=...)`. While the release status is `waiting` it calls `egress.resolve(int(approval_id))` and stores the outcome once it changes. Shared and refused releases are resent from `released_text`. The approval page decides rows through `ApprovalStore.decide`; nothing is pushed to Muse.

### Heavy-step hook
The workspace agent takes an optional `heavy` object with `run(kind, messages, schema, *, synthetic=False) -> dict | None`. `None` means no laptop worker is available and the step runs on the device's own Glimmer; an exception does the same. The agent passes `synthetic=True` only for folders marked `.synthetic`. Services builds one `HeavyQueue` and shares it between the agent and the `/heavy` routes.

### Relay frames (relay/ and base/connector/relay_client.py must agree)
The device opens `wss://<relay>/device/connect` with `Authorization: Bearer <device secret>`. Frames are JSON text messages.
- Relay to device: `{"type": "request", "id": "<uuid>", "method": "POST" | "GET" | "DELETE", "headers": {"content-type": ..., "accept": ..., "mcp-session-id": ..., "mcp-protocol-version": ...}, "body": "<raw request body text>"}`
- Device to relay: `{"type": "response", "id": "<same uuid>", "status": 200, "headers": {"content-type": ..., "mcp-session-id": ...}, "body": "<raw response body text>"}`. If the local server answers with `text/event-stream`, the device collects the SSE `data:` lines for that request and sends them as one body with content-type `text/event-stream` (no long-lived streams in v1).
- Keepalive: either side may send `{"type": "ping"}`; the other answers `{"type": "pong"}`.
- Registration: `POST /device/register` with JSON `{"name": "<device label>"}` returns `{"device_id": "...", "secret": "..."}` once; the relay keeps only a SHA-256 of the secret. `POST /device/pair` with the bearer secret returns `{"code": "ABCD2345", "expires_in": 600}`, eight characters from an alphabet without 0/O/1/I, single use.
- The relay answers `503 {"error": "device offline"}` when no device socket is connected, and `504` after 60 seconds with no response frame.

### Approval page (review fixes)
Pairing codes: wrong codes are counted in `BASE_HOME/pairing_misses` across restarts; after 10 the server stops printing a code at start and only `POST /api/pair-code` from the device itself issues one (and clears the count). `POST /api/sessions/clear` signs out every other browser. The session cookie is Secure when TLS is on. uvicorn runs the approval port with `limit_concurrency=64`; a port that is already in use ends `python -m base` with one sentence and exit 3.
- Header names in frames are lowercase. The relay never logs bodies.
