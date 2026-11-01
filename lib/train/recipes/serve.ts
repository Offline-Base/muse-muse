/**
 * The glimmer-serve recipe's Python (docs/TRAINING.md, "Live demo"): one GPU serves ONE trained glimmer-lora adapter for
 * a fixed number of minutes, so the public result page of that adapter's job can show base and tuned answers to a
 * visitor's prompt side by side. Never put a dollar sign followed by an opening brace, or a backtick, in the Python:
 * this is a template literal.
 *
 * It reuses glimmer-lora's Python as it is (GLIMMER_PY without its docstring and its __main__ block), so the venv, the
 * cache, the pinned model and the final-channel prompts are exactly the ones training used: ensure_venv, base_dir,
 * weights_cached, remove_stale_hf_locks, student_system, eval_prompt, final_answer, emit and relay. glimmer-lora itself
 * is unchanged.
 *
 * The runner imports this file with the system python. run(ctx) checks the adapter in <cache>/models/<adapterJobId>/,
 * gets the venv, then runs this same file as "python recipe.py --serve config.json" inside the venv: the child makes a
 * self-signed certificate (openssl), loads the 4-bit base and the adapter with Unsloth and PEFT, and serves HTTPS on
 * SERVE_PORT until ctx.deadline less a margin, or its minutes after it started serving when that comes first. It reports
 * {type: "serving", port, certSha256, model, adapterJobId} once it listens (ctx.serving), writes an "alive" event every
 * minute so the stall watch never pauses the heartbeats, and returns once it has stopped. The job then ends like any
 * other.
 *
 * The server (every route needs "Authorization: Bearer <serveKey>", job.json's serveKey):
 *   POST /generate {prompt} -> 200 {base, tuned, ms}: the prompt (trimmed, cut to 600 characters, its chat-template
 *        control tokens neutralized) answered by the base model (PEFT's disable_adapter) and then the tuned one,
 *        greedy, 400 new tokens, both within SERVE_ANSWER_SECONDS, on the final channel under the system message the
 *        adapter was trained with. One prompt at a time: 409 {error: "busy"} while another is being answered. 400
 *        no_prompt or bad_json, 411 length_required, 413 too_large (over 16 KB), 503 stopping, 500 generation_failed
 *        (3 in a row stop the server and fail the job).
 *   POST /v1/chat/completions {model, messages, max_tokens?, stop?, temperature?, top_p?, top_k?} -> 200 OpenAI's chat
 *        completion {id, object, created, model, choices: [{index, message: {role, content}, finish_reason}], usage} and
 *        the GPU's ms: products' chat (lib/train/glimmer-serving.ts, docs/TRAINING.md "Products call the hosted tuned
 *        Glimmer"). model "muse-glimmer" is base Glimmer (the adapter off), the adapter's job id the tuned model. Sampled
 *        with Meta's published settings, never greedy, stopping at Meta's two end ids; the tuned model of an adapter
 *        trained before trainChannel answers on the final channel the prompt opens and stops at <|eom|> and <|start|>
 *        too, server side only; anything else reasons first, and its answer is its final-channel message. 1,024 new
 *        tokens by default for a final-only answer, 4,096 for one that reasons, never more than 4,096, within
 *        CHAT_ANSWER_SECONDS. One request at a time, through the same lock as /generate (409 busy). 400 bad_json,
 *        unknown_model, bad_messages, bad_sampling, bad_max_tokens, bad_stop or stream_unsupported, 413 too_large, 422
 *        too_long (a prompt over 4,096 tokens), 503 stopping, 501 chat_unavailable, 500 generation_failed.
 *   GET /health -> 200 {ok, busy, model, adapterJobId, served}, and mode "decide" for a decision model.
 *   401 {error: "unauthorized"} without the key, 404 {error: "not_found"} for any other path.
 *
 * A decision model's adapter (one whose folder has the decide.json glimmer-lora's decide mode writes beside it,
 * docs/DECISION_MODELS.md "On the lab's GPU") is served at POST /decide instead, and /generate and
 * /v1/chat/completions are 404s there:
 *   POST /decide {items: [{messages: [system, user], letters}]} -> 200 {base, tuned, baseMass, tunedMass, ms}: 1 to 3
 *        items (one per group of the decision's labels), each scored from the first answer token by base Glimmer
 *        (PEFT's disable_adapter) and then the tuned model, one forward pass a model, under the system message of the
 *        model's decide.json, which each item must carry exactly. base[i][j] is the log-probability of item i's letter
 *        j (bare and space-led summed, at least -10,000), not renormalized: the platform renormalizes, combines groups
 *        and applies T. Up to 512 KB of body. 400 bad_json, no_items, bad_item (a user message with "<|" in it, which
 *        the platform's renderer never leaves) or wrong_system, 422 too_long (a prompt over 2,048 tokens, as training
 *        dropped them), 409 busy, 503 stopping, 500 scoring_failed (3 in a row stop the server, as for /generate).
 * A connection must finish its TLS handshake and send a whole request with the key within 10 s of being accepted, or
 * it is shut, however slowly it trickles bytes; at most 64 connections at once, and 4 from one address.
 */
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";

/**
 * The longest prompt the demo server answers (it trims a prompt and cuts it to this), and the new tokens each model
 * may write for it. The Python below has the same numbers (PROMPT_MAX_CHARS, SERVE_MAX_NEW_TOKENS); a test keeps them
 * equal, as it does SERVE_PORT (lib/train/types.ts) and the minutes bounds (lib/train/logic.ts).
 */
export const SERVE_PROMPT_MAX = 600;
export const SERVE_MAX_NEW_TOKENS = 400;
/**
 * The seconds one answer (base and tuned together) may take on the GPU, so it ends inside the proxy's wait
 * (serveTiming.answerMs in lib/train/serve.ts) less its connect time. The Python has the same number; a test keeps
 * them equal and checks that it fits.
 */
export const SERVE_ANSWER_SECONDS = 100;
/**
 * A decision model's demo server scores at most this many prompts a POST /decide: one per group of a decision's labels,
 * and 12 labels make 3 (labelGroups in lib/decide/format.ts). The Python has the same number; a test keeps them equal.
 */
export const DECIDE_SERVE_ITEMS_MAX = 3;

/**
 * glimmer-lora's Python without its one-line docstring and its __main__ block: every helper it defines, ready to be
 * followed by another recipe's code. Throws when GLIMMER_PY no longer has that shape, so a change there can't silently
 * break this recipe.
 */
export function glimmerHelpers(source: string = GLIMMER_PY): string {
  const docEnd = source.startsWith('"""') ? source.indexOf('"""\n', 3) : -1;
  const main = source.lastIndexOf('\nif __name__ == "__main__":');
  if (docEnd < 0 || main < docEnd) {
    throw new Error("GLIMMER_PY no longer starts with a one-line docstring and ends with its __main__ block");
  }
  return source.slice(docEnd + 4, main + 1);
}

const SERVE_HEAD = String.raw`"""Muse Glimmer serve: one trained glimmer-lora adapter answering live, base and tuned side by side, over pinned HTTPS."""

# glimmer-lora's own Python (lib/train/recipes/glimmer.ts) follows as it is, without its docstring and its __main__
# block, so this recipe finds the cache, builds or reuses the venv and loads the model exactly as training did, and
# writes its prompts on the final channel with the same template. Its run(ctx) is replaced below; its child_main is
# never called.
`;

const SERVE_BODY = String.raw`

# ---------------------------------------------------------------------------------------------------------------
# glimmer-serve: everything below is this recipe's own.

import hmac
import http.server
import re
import socket
import socketserver
import ssl
import subprocess

# The demo server's port (SERVE_PORT in lib/train/types.ts): the serve firewall ruleset opens it.
SERVE_PORT = 8443
SERVE_HOST = "0.0.0.0"
# Each model writes at most this many new tokens for one prompt, greedy.
SERVE_MAX_NEW_TOKENS = 400
# One answer, base and tuned together, gets this many seconds on the GPU (SERVE_ANSWER_SECONDS in
# lib/train/recipes/serve.ts), so it ends inside the proxy's 120 s wait less its connect time: the base half of it, the
# tuned what is left. Past it a generation stops where it is, and its answer is marked unfinished.
SERVE_ANSWER_SECONDS = 100
# With less than this left of the budget once the base has answered, the tuned answer isn't started.
TUNED_MIN_SECONDS = 5
# A prompt is trimmed and cut to this many characters.
PROMPT_MAX_CHARS = 600
# The largest request body the server reads.
REQUEST_MAX_BYTES = 16 * 1024
# The "minutes" param: how long the demo answers once it is up.
SERVE_MINUTES_DEFAULT = 30
SERVE_MINUTES_MIN = 10
SERVE_MINUTES_MAX = 120
# Serving stops this long before ctx.deadline: an answer in progress finishes, the child exits and the runner posts done.
SERVE_MARGIN_SECONDS = 180
# With less than this before serving must stop, the job fails at once instead of loading a model it can't serve.
MIN_SERVE_START_SECONDS = 600
# The same check after the venv is ready (a venv build may have taken a while).
MIN_LOAD_SECONDS = 300
# With less than this left once the model is loaded, the child doesn't start the server.
MIN_SERVING_SECONDS = 60
# At shutdown, how long the server waits for an answer in progress: a whole answer's budget, and a little more.
DRAIN_SECONDS = SERVE_ANSWER_SECONDS + 15
# How often the serving child writes an "alive" event, so the runner's stall watch sees output and heartbeats go on.
ALIVE_SECONDS = 60
# How often the serving loop looks at the clock and the stop file.
STOP_POLL_SECONDS = 2
# Connections handled at once, in all and from one address; past either a new one is closed at once. The platform's
# proxy sends one prompt at a time, so a few from one address are plenty.
MAX_CONNECTIONS = 64
MAX_CONNECTIONS_PER_IP = 4
# A connection must finish its TLS handshake and send a whole request with the serve key within this many seconds of
# being accepted, or it is shut, however slowly it trickles bytes (a socket timeout starts again with every read). The
# only real client is the platform's proxy, close by. The answer itself isn't under it (SERVE_ANSWER_SECONDS is).
REQUEST_DEADLINE_SECONDS = 10
# Any one read or write that waits longer than this ends the connection.
SOCKET_TIMEOUT_SECONDS = 30
# This many failed answers in a row (a broken CUDA context fails every prompt) stop the server and fail the job, so the
# GPU doesn't bill for minutes nobody can use.
FAILS_TO_STOP = 3
# The self-signed certificate. The platform pins its SHA-256, so its name and lifetime don't matter, and the name says
# nothing about what serves it.
CERT_DAYS = 2
CERT_SUBJECT = "/CN=localhost"
# The serving callback is sent once, then again with each alive event until the platform takes it, this many times in
# all. After that nobody can reach the server, so it stops.
SERVING_TRIES = 5
# job.json's serveKey is an HMAC-SHA256 the platform derives; anything shorter isn't one.
SERVE_KEY_MIN = 32
JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# A decision model's server (its adapter folder has decide.json) scores 1 to this many prompts a POST /decide, one per
# group of the decision's labels (DECIDE_SERVE_ITEMS_MAX in lib/train/recipes/serve.ts).
DECIDE_SERVE_ITEMS_MAX = 3
# The largest /decide body: 3 prompts, each holding a 3,000-character state twice, JSON escaped twice at worst.
DECIDE_REQUEST_MAX_BYTES = 512 * 1024
SERVE_UNFINISHED = (
    "[Unfinished: no complete answer within " + str(SERVE_MAX_NEW_TOKENS)
    + " new tokens or the time limit. The raw output follows, with only the chat template's control tokens taken out.]"
)

# Products' chat, POST /v1/chat/completions in OpenAI's chat shape (lib/train/glimmer-serving.ts is the platform's side,
# and keeps the same numbers; a test checks them). Meta's guidance, content/meta-docs/pages/muse-glimmer/deploy.md: every
# answer samples with temperature 1.0, top_p 0.95 and top_k 64, all three, never greedy (lines 239 and 243); generation
# stops on eos_token_id [200001, 200008], <|end_of_text|> and <|eot|> (line 317, and lines 1015 to 1025 for
# Transformers); and never on <|eom|> (lines 319 to 321), which is taken out of any stop a caller asks for. /generate and
# the eval stay greedy, so their answers compare with the scores.
CHAT_PATH = "/v1/chat/completions"
CHAT_TEMPERATURE = 1.0
CHAT_TOP_P = 0.95
CHAT_TOP_K = 64
CHAT_EOS_TOKENS = ("<|end_of_text|>", "<|eot|>")
CHAT_EOS_IDS = (200001, 200008)
CHAT_EOM = "<|eom|>"
# A final-only adapter (trainChannel 0, every adapter trained before trainChannel) answers on a final channel the prompt
# opens, as it was trained, and also stops at <|eom|> and <|start|> (ggufStops(0) in lib/train/hub-cards.ts): they catch
# it drifting into a second message, and can't cut reasoning, since none follows a prefilled final channel. Server side
# only, and never for base Glimmer or a trainChannel 1 adapter, which reason before they answer.
FINAL_ONLY_STOPS = ("<|eom|>", "<|start|>")
# New tokens an answer may write when the caller doesn't say: a final answer alone, or reasoning and then the answer
# (deploy.md line 22: reasoning needs headroom). Neither may pass the cap.
CHAT_MAX_TOKENS_FINAL = 1024
CHAT_MAX_TOKENS_REASONING = 4096
CHAT_MAX_TOKENS_CAP = 4096
# The longest prompt it takes, in tokens (422 too_long past it), and so the context a chat server loads the model with.
CHAT_PROMPT_TOKENS_MAX = 4096
SERVE_CONTEXT_TOKENS = CHAT_PROMPT_TOKENS_MAX + CHAT_MAX_TOKENS_CAP
# One chat answer's time on the GPU (CHAT_ANSWER_SECONDS in lib/train/glimmer-serving.ts), so it ends inside the
# platform's wait (serveTiming.chatMs) less its connect time. Past it the answer stops where it is, finish "length".
CHAT_ANSWER_SECONDS = 135
CHAT_MESSAGES_MAX = 64
CHAT_CHARS_MAX = 32000
CHAT_STOPS_MAX = 4
CHAT_STOP_CHARS_MAX = 64
# The largest chat body: 32,000 characters JSON escaped at 6 bytes each at worst, and the rest of the request.
CHAT_REQUEST_MAX_BYTES = 256 * 1024
# The "model" that asks for base Glimmer, the adapter off. The adapter's own job id asks for the tuned model.
BASE_MODEL_NAME = "muse-glimmer"


def read_serve_params(params):
    """adapter_job_id (a training job's id, lowercased), minutes (rounded down, as serveMinutes in lib/train/logic.ts
    does, then clamped to 10 to 120, default 30) and train_channel, the adapter's trainChannel the platform writes into
    the params (0 when it has none, as for every job before it did)."""
    adapter = str(params.get("adapterJobId") or "").strip().lower()
    if not JOB_ID_RE.match(adapter):
        raise ValueError("adapterJobId must be the id of a glimmer-lora job, not " + json.dumps(str(params.get("adapterJobId")))[:60])
    span = int(min(SERVE_MINUTES_MAX, max(SERVE_MINUTES_MIN, math.floor(number(params, "minutes", SERVE_MINUTES_DEFAULT)))))
    channel = number(params, "trainChannel", 0)
    if channel not in (0, 1):
        raise ValueError("trainChannel must be 0 or 1")
    return {"adapter_job_id": adapter, "minutes": span, "train_channel": int(channel)}


def serve_key_of(ctx):
    """job.json's serveKey (ctx.serve_key). Raises without one: the server must never answer whoever asks."""
    key = getattr(ctx, "serve_key", None)
    if not isinstance(key, str) or len(key) < SERVE_KEY_MIN:
        raise RuntimeError("job.json has no serveKey, so the demo server couldn't tell the platform's requests from anyone else's")
    return key


def adapter_problem(adapter_dir, adapter_job_id):
    """Why the folder can't be served (no adapter, a dry run's stand-in, no weights), or None when it can."""
    where = "the adapter of job " + adapter_job_id + " in " + adapter_dir
    try:
        with open(os.path.join(adapter_dir, "adapter_config.json"), encoding="utf-8") as f:
            config = json.load(f)
    except OSError:
        return "There is no adapter in the cache at " + adapter_dir + ": job " + adapter_job_id + " saved none in this region"
    except ValueError:
        return "The adapter_config.json of " + where + " isn't JSON"
    if not isinstance(config, dict) or config.get("dry_run"):
        return where + " is a dry run's stand-in, not a trained adapter"
    if not any(os.path.isfile(os.path.join(adapter_dir, n)) for n in ("adapter_model.safetensors", "adapter_model.bin")):
        return where + " has no adapter weights"
    return None


def serve_contract(adapter_dir):
    """The decide.json beside the adapter, which glimmer-lora's decide mode writes there (docs/DECISION_MODELS.md), or
    None for a chat adapter, which has none. A decision model is served at POST /decide under the file's system
    message, the one its training renderings had. Raises when the file is there but isn't the format's."""
    path = os.path.join(adapter_dir, DECIDE_JSON)
    if not os.path.lexists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            contract = json.load(f)
    except (OSError, ValueError, UnicodeDecodeError):
        contract = None
    system = contract.get("system") if isinstance(contract, dict) else None
    if not isinstance(contract, dict) or contract.get("format") != DECIDE_FORMAT or not isinstance(system, str) or not system.strip():
        raise RuntimeError("The " + DECIDE_JSON + " beside the adapter in " + adapter_dir + " isn't a " + DECIDE_FORMAT + " file with a system message")
    return contract


def serve_system(ctx):
    """(system, how): the system message both models answer under, the line glimmer-lora's short student prompt trained
    the adapter with ("You are " and its dataset's title, see student_system), made from the first train page of the
    adapter job's dataset, which the platform's dataset route serves a glimmer-serve job. When the platform answers
    with an error status instead, "You are a helpful assistant.", with how in the log. A network failure raises.
    """
    try:
        page = ctx.get_json("/dataset?part=train&page=0")
    except Exception as e:
        status = getattr(e, "status", None)
        if status is None:
            raise
        system = student_system(None)
        return system, "the platform sent no dataset for this job (HTTP " + str(status) + "), so both models answer under " + json.dumps(system)
    page = page if isinstance(page, dict) else {}
    if page.get("kind") == "decision":
        # A decision model's adapter is served from its decide.json (serve_contract), never as a chat model.
        raise RuntimeError("The adapter's dataset is a decision dataset, but the adapter's folder has no " + DECIDE_JSON + ", so it can't be served")
    items = page.get("items") if isinstance(page.get("items"), list) else []
    title = page.get("title") if isinstance(page.get("title"), str) else None
    system = student_system(title, shared_system(train_examples(items)))
    return system, "both models answer under " + json.dumps(system, ensure_ascii=False) + ", made from the dataset " + json.dumps(title, ensure_ascii=False)


def write_private_json(path, data):
    """Writes JSON readable only by this user (the config holds the serve key)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.chmod(path, 0o600)


def remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def touch(path):
    try:
        with open(path, "w") as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


def clock_text(epoch):
    return time.strftime("%H:%M UTC", time.gmtime(epoch))


def serve_relay(ctx, adapter_job_id, seen, state, stop_path):
    """The ctx.run hook for the serving child: glimmer's relay (progress, phase and log events), plus "serving", which
    becomes ctx.serving (sent again with each "alive" until the platform takes it, at most SERVING_TRIES times, then the
    stop file tells the child to stop), and "served", which becomes a progress message."""
    inner = relay(ctx, seen)

    def announce():
        event = state["serving"]
        state["tries"] += 1
        try:
            taken = ctx.serving(int(event.get("port") or 0), str(event.get("certSha256") or ""), str(event.get("model") or MODEL), adapter_job_id)
        except ValueError as e:
            ctx.log("The demo server reported a serving event the platform can't take: " + str(e))
            taken = False
        state["announced"] = bool(taken)
        if taken:
            until = event.get("until")
            ctx.progress(message="Serving live" + (" until " + clock_text(until) if isinstance(until, (int, float)) else ""))
        elif state["tries"] >= SERVING_TRIES:
            ctx.log("The platform didn't take the serving callback " + str(state["tries"]) + " times, so nobody can reach the demo server and it stops now")
            touch(stop_path)
        else:
            ctx.log("The platform didn't take the serving callback; it is sent again in a minute")

    def on_line(line):
        inner(line)
        at = line.find(EVENT_PREFIX)
        if at < 0:
            return
        event = json.loads(line[at + len(EVENT_PREFIX):])
        kind = event.get("kind")
        if kind == "serving":
            state["serving"], state["tries"] = event, 0
            announce()
        elif kind == "alive" and state["serving"] is not None and not state["announced"] and state["tries"] < SERVING_TRIES:
            announce()
        elif kind == "served":
            state["served"] = int(event.get("count") or 0)
            ctx.progress(message="Serving live: " + str(state["served"]) + " answered")

    return on_line


def run(ctx):
    started = time.time()
    p = read_serve_params(ctx.params)
    key = serve_key_of(ctx)
    base, cache_used = base_dir(ctx)
    if not cache_used:
        raise RuntimeError(
            "The model cache isn't mounted or isn't writable, so the adapter of job " + p["adapter_job_id"]
            + " can't be loaded. A serve job runs in its adapter's region, with that cache mounted"
        )
    adapter_dir = os.path.join(base, "models", p["adapter_job_id"])
    problem = adapter_problem(adapter_dir, p["adapter_job_id"])
    if problem:
        raise RuntimeError(problem)
    contract = serve_contract(adapter_dir)
    deadline = job_deadline(ctx, started)
    stop_by = deadline - SERVE_MARGIN_SECONDS
    if stop_by - time.time() < MIN_SERVE_START_SECONDS:
        raise RuntimeError("Only " + minutes(stop_by - time.time()) + " are left to serve before the job's time limit, too few to load the model and serve")
    if contract is None:
        system, how = serve_system(ctx)
        ctx.log(
            "Serving the adapter of job " + p["adapter_job_id"] + " for up to " + str(p["minutes"]) + " minutes once it is up, "
            + str(SERVE_MAX_NEW_TOKENS) + " new tokens an answer: " + how
        )
        ctx.log(
            "Products' chat at POST " + CHAT_PATH + " too: Meta's sampling (temperature " + str(CHAT_TEMPERATURE) + ", top_p "
            + str(CHAT_TOP_P) + ", top_k " + str(CHAT_TOP_K) + "), stopping at " + ", ".join(CHAT_EOS_TOKENS)
            + (", and for the tuned model, trained before trainChannel, on a final channel the prompt opens, at "
               + " and ".join(FINAL_ONLY_STOPS) if p["train_channel"] == 0 else ", the tuned model reasoning first, as base Glimmer does")
        )
    else:
        system = contract["system"]
        ctx.log(
            "Serving the decision model of job " + p["adapter_job_id"] + " for up to " + str(p["minutes"]) + " minutes once it"
            + " is up, at POST /decide only (" + str(DECIDE_SERVE_ITEMS_MAX) + " prompts a call at most): both models score"
            + " under the system message of its " + DECIDE_JSON + ", " + json.dumps(system, ensure_ascii=False)
        )
    hf_home = os.path.join(base, "hf")
    os.makedirs(hf_home, exist_ok=True)
    python, venv_reused = ensure_venv(ctx, base)
    remove_stale_hf_locks(ctx, hf_home)
    cached = weights_cached(hf_home)
    ctx.log("venv " + ("reused" if venv_reused else "installed") + ", weights " + ("cached" if cached else "not cached yet"))
    left = stop_by - time.time()
    if left < MIN_LOAD_SECONDS:
        raise RuntimeError("Only " + minutes(left) + " are left to serve before the job's time limit, too few to load the model and serve")

    result_path = os.path.join(ctx.work_dir, "serve-result.json")
    stop_path = os.path.join(ctx.work_dir, "serve-stop")
    config_path = os.path.join(ctx.work_dir, "serve-config.json")
    for path in (result_path, stop_path):
        remove_quietly(path)
    config = {
        "model": MODEL,
        "revision": MODEL_REVISION,
        # A chat server takes prompts and answers longer than training's (CHAT_PROMPT_TOKENS_MAX and CHAT_MAX_TOKENS_CAP);
        # a decision model's scores the renderings training read, so it keeps training's length.
        "max_seq_length": MAX_SEQ_LENGTH if contract is not None else max(MAX_SEQ_LENGTH, SERVE_CONTEXT_TOKENS),
        "adapter_dir": adapter_dir,
        "adapter_job_id": p["adapter_job_id"],
        "train_channel": p["train_channel"],
        "system": system,
        "minutes": p["minutes"],
        "stop_by": stop_by,
        "host": SERVE_HOST,
        "port": SERVE_PORT,
        "key": key,
        "work_dir": ctx.work_dir,
        "result_path": result_path,
        "stop_path": stop_path,
    }
    if contract is not None:
        config["mode"] = DECIDE_MODE
    write_private_json(config_path, config)
    env = {
        "HF_HOME": hf_home,
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TOKENIZERS_PARALLELISM": "false",
        # The venv is shared by every job in the region, so nothing writes bytecode into it.
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if contract is not None:
        # Unsloth's forward returns logits only when asked; nothing trains here, so the whole child asks.
        env["UNSLOTH_RETURN_LOGITS"] = "1"
    cmd = shlex.quote(python) + " -u " + shlex.quote(os.path.abspath(__file__)) + " --serve " + shlex.quote(config_path)
    seen = set()
    state = {"serving": None, "announced": False, "tries": 0, "served": 0}
    hook = serve_relay(ctx, p["adapter_job_id"], seen, state, stop_path)
    try:
        out = ctx.run(
            cmd, timeout=int(left) + DRAIN_SECONDS + CHILD_GRACE_SECONDS, check=False, env=env,
            on_line=hook, on_event=hook, stall_seconds=STALL_SECONDS,
        )
    finally:
        remove_quietly(config_path)
    timed_out = bool(getattr(out, "timed_out", False))
    ended = "timed out" if timed_out else "exited with " + str(out.returncode)
    result = read_result(result_path)
    if result is None:
        if state["serving"] is None:
            missing = "ModuleNotFoundError" in (out.stdout or "")
            if venv_reused and out.returncode != 0 and not timed_out and "imported" not in seen and missing:
                mark_broken(ctx, os.path.dirname(os.path.dirname(python)))
            raise RuntimeError("The demo server " + ended + " before it was serving:\n" + last_lines(out))
        raise RuntimeError("The demo server " + ended + " while serving, after " + str(state["served"]) + " answers:\n" + last_lines(out))
    if result.get("note"):
        raise RuntimeError(str(result["note"]))
    if not state["announced"]:
        raise RuntimeError("The platform never took the serving callback, so nobody could reach the demo server")
    served = int(result.get("served") or 0)
    serve_minutes = round(float(result.get("served_seconds") or 0) / 60, 1)
    metrics = {
        "adapter_job_id": p["adapter_job_id"],
        "served": served,
        "busy_refused": int(result.get("busy") or 0),
        "unauthorized": int(result.get("unauthorized") or 0),
        "bad_requests": int(result.get("bad_requests") or 0),
        "errors": int(result.get("errors") or 0),
        "serve_minutes": serve_minutes,
        "load_seconds": result.get("load_seconds"),
        "max_new_tokens": SERVE_MAX_NEW_TOKENS,
        "train_channel": p["train_channel"],
        "system": system,
        "gpu": result.get("gpu"),
        "peak_vram_gb": result.get("peak_vram_gb"),
        "cached_weights": "yes" if cached else "no",
        "cached_venv": "yes" if venv_reused else "no",
        "summary": (
            "Served " + str(served) + " live answer" + ("" if served == 1 else "s") + " (base and tuned) from the adapter of job "
            + p["adapter_job_id"][:8] + " for " + str(serve_minutes) + " minutes."
        ),
    }
    if contract is not None:
        metrics["mode"] = DECIDE_MODE
        metrics["max_new_tokens"] = 0
        metrics["summary"] = (
            "Served " + str(served) + " live decision" + ("" if served == 1 else "s") + " (base and tuned) from the decision"
            + " model of job " + p["adapter_job_id"][:8] + " for " + str(serve_minutes) + " minutes."
        )
    return metrics


# ---------------------------------------------------------------------------------------------------------------
# The serving child: runs inside the venv, with the GPU.


def live_answer(raw):
    """A model's answer to a live prompt, from its raw output: the final channel's text up to its end (final_answer),
    or, when it never finished within SERVE_MAX_NEW_TOKENS, SERVE_UNFINISHED and the raw output with only the chat
    template's control tokens taken out."""
    answer, finished = final_answer(raw)
    if finished:
        return answer
    rest = strip_control(raw)
    return SERVE_UNFINISHED + ("\n\n" + rest if rest else "")


def special_tokens_of(tokenizer):
    """Every special or added token the tokenizer reads as one token when it finds it in text, with the chat
    template's control tokens."""
    found = set(CONTROL_TOKENS)
    for source in (getattr(tokenizer, "all_special_tokens", None), getattr(tokenizer, "added_tokens_encoder", None)):
        try:
            found.update(t for t in (source or ()) if isinstance(t, str))
        except TypeError:
            pass
    return found


def neutral_prompt(prompt, specials=()):
    """A visitor's prompt with nothing left in it that the tokenizer would read as a control token, so it can't close its
    user turn, forge a system or assistant message or open the answer for the model. Every token of Glimmer's chat
    template starts with "<|", which becomes "< |" (that can't make a new "<|"). Any other special token is dropped,
    over and over until none is left, since dropping one can join the halves of another (or of a "<|") around it."""
    tokens = sorted({t for t in specials if isinstance(t, str) and t.strip()}, key=len, reverse=True)
    text = prompt
    while True:
        before = text
        text = text.replace("<|", "< |")
        for token in tokens:
            text = text.replace(token, "")
        if text == before:
            return text


def make_answerer(model, tokenizer, torch, system, max_new_tokens=SERVE_MAX_NEW_TOKENS):
    """answer(prompt) -> (base, tuned): the prompt, its control tokens neutralized (neutral_prompt), as glimmer-lora's
    eval answered it (eval_prompt: the template at low reasoning, under system, with the final channel opened), greedy,
    base first with the adapter disabled, then tuned, both within SERVE_ANSWER_SECONDS: the base gets half, the tuned
    what is left, and isn't started with under TUNED_MIN_SECONDS left. A generation the clock stops is unfinished.
    Raises at once when the template doesn't render as training expects."""
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""
    text_tokenizer.padding_side = "left"
    if text_tokenizer.pad_token is None:
        text_tokenizer.pad_token = text_tokenizer.eos_token
    head = [{"role": "system", "content": system}] if system else []
    specials = special_tokens_of(text_tokenizer)

    def prompt_text(prompt):
        return eval_prompt(tokenizer, head + [{"role": "user", "content": neutral_prompt(prompt, specials)}], bos)

    prompt_text("Check the template.")

    def generate(enc, seconds):
        input_ids = enc["input_ids"].to("cuda")
        attention_mask = enc["attention_mask"].to("cuda")
        with torch.no_grad():
            out = model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=text_tokenizer.pad_token_id,
                # transformers' MaxTimeCriteria: generation stops where it is once this many seconds have passed.
                max_time=max(1.0, float(seconds)),
            )
        return text_tokenizer.decode(out[0][input_ids.shape[1]:], skip_special_tokens=False)

    def answer(prompt):
        give_up = time.time() + SERVE_ANSWER_SECONDS
        enc = text_tokenizer([prompt_text(prompt)], return_tensors="pt", padding=True)
        with model.disable_adapter():
            base = generate(enc, SERVE_ANSWER_SECONDS / 2)
        left = give_up - time.time()
        tuned = generate(enc, left) if left >= TUNED_MIN_SECONDS else ""
        return live_answer(base), live_answer(tuned)

    return answer


class DecideTooLong(Exception):
    """A /decide item whose prompt would pass MAX_SEQ_LENGTH tokens with its answer: it isn't scored, as training dropped
    such renderings instead of cutting them."""


class DecideRefused(Exception):
    """A /decide body the server won't score: the status and the error code it answers with."""

    def __init__(self, status, code):
        Exception.__init__(self, code)
        self.status, self.code = status, code


def decide_request(body, system):
    """The items of a POST /decide body, each {messages, letters}, or raises DecideRefused: 1 to DECIDE_SERVE_ITEMS_MAX
    items (no_items), each exactly a system and a user message and its letters from A, 2 to 5 of them (bad_item); the
    system message the model was trained under, exactly (wrong_system); and a user message with text and no "<|", which
    the platform's renderer never leaves in a task (bad_item). The text is scored as sent, so its bytes are the ones
    training read."""
    items = body.get("items") if isinstance(body, dict) else None
    if not isinstance(items, list) or not 1 <= len(items) <= DECIDE_SERVE_ITEMS_MAX:
        raise DecideRefused(400, "no_items")
    out = []
    for item in items:
        item = item if isinstance(item, dict) else {}
        messages, letters = item.get("messages"), item.get("letters")
        ok = (
            isinstance(messages, list) and len(messages) == 2
            and all(isinstance(m, dict) and isinstance(m.get("content"), str) for m in messages)
            and [m.get("role") for m in messages] == ["system", "user"]
            and isinstance(letters, list) and 2 <= len(letters) <= len(DECIDE_LETTERS)
            and tuple(letters) == DECIDE_LETTERS[:len(letters)]
        )
        if not ok:
            raise DecideRefused(400, "bad_item")
        if messages[0]["content"] != system:
            raise DecideRefused(400, "wrong_system")
        user = messages[1]["content"]
        if not user.strip() or "<|" in user:
            raise DecideRefused(400, "bad_item")
        out.append({"messages": [{"role": m["role"], "content": m["content"]} for m in messages], "letters": list(letters)})
    return out


def make_decider(model, tokenizer, torch, system):
    """decide(items) -> (base, tuned): each item's letter_scores from the first answer token (each shown letter's
    log-probability, its bare and space-led tokens summed and at least DECIDE_LOGPROB_FLOOR, the letter mass, and
    whether the top token was a shown letter), base Glimmer's with the adapter disabled and then the tuned model's. As
    score_all reads them in training: the prompt through eval_prompt (the final channel open), one forward pass a model
    for all the items, left padded, position ids counted from the attention mask, logits_to_keep=1, the last position
    through log_softmax in float32 over the whole vocabulary. Raises DecideTooLong before any pass when an item's prompt
    would pass MAX_SEQ_LENGTH, and RuntimeError for a NaN or +Infinity score. Raises at once when the template doesn't
    render as training expects, or a letter isn't one token."""
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""
    text_tokenizer.padding_side = "left"
    if text_tokenizer.pad_token is None:
        text_tokenizer.pad_token = text_tokenizer.eos_token
    letter_ids = letter_token_ids(text_tokenizer)
    flat = sorted({t for ids in letter_ids.values() for t in ids})
    eval_prompt(tokenizer, [{"role": "system", "content": system}, {"role": "user", "content": "Check the template."}], bos)
    # Unsloth's forward returns logits only when asked (run(ctx) sets it for the child too). Nothing trains here.
    os.environ["UNSLOTH_RETURN_LOGITS"] = "1"
    keep = {"last": True}

    def score(prompts, letters):
        enc = text_tokenizer(prompts, return_tensors="pt", padding=True)
        input_ids = enc["input_ids"].to("cuda")
        attention_mask = enc["attention_mask"].to("cuda")
        positions = (attention_mask.cumsum(-1) - 1).clamp(min=0)
        logits = forward_logits(model, torch, input_ids, attention_mask, positions, keep)
        shape = tuple(logits.shape)
        if len(shape) != 3 or shape[0] != len(prompts) or shape[-1] <= flat[-1]:
            raise RuntimeError("The model's forward pass gave logits of shape " + str(shape) + ", not a row of the vocabulary for each prompt")
        logp = torch.log_softmax(logits[:, -1, :].float(), dim=-1)
        picked = logp[:, flat].tolist()
        tops = logp.argmax(dim=-1).tolist()
        out = []
        for k, shown in enumerate(letters):
            scored = letter_scores(picked[k], flat, shown, letter_ids, tops[k])
            if scored is None:
                raise RuntimeError("A first-token score was NaN or +Infinity, so the model can't decide")
            out.append(scored)
        return out

    def decide(items):
        prompts, too_long = decide_prompts(tokenizer, text_tokenizer, items, bos)
        if too_long:
            raise DecideTooLong()
        letters = [item["letters"] for item in items]
        with model.disable_adapter():
            base = score(prompts, letters)
        tuned = score(prompts, letters)
        return base, tuned

    return decide


class ChatRefused(Exception):
    """A /v1/chat/completions body the server won't answer: the status and the error code it answers with."""

    def __init__(self, status, code):
        Exception.__init__(self, code)
        self.status, self.code = status, code


class ChatTooLong(Exception):
    """A chat prompt over CHAT_PROMPT_TOKENS_MAX tokens: it isn't answered (422 too_long)."""


def chat_number(value, whole=False):
    """value as a number when it is one (not a bool), else None; for whole, only when it is a whole number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if whole and float(value) != math.floor(value):
        return None
    return int(value) if whole else float(value)


def chat_request(body, adapter_job_id, train_channel):
    """What a POST /v1/chat/completions body asks for, or raises ChatRefused (400 unless said):
    - model: BASE_MODEL_NAME for base Glimmer (the adapter off) or this server's adapter job id for the tuned model
      (unknown_model otherwise);
    - messages: 1 to CHAT_MESSAGES_MAX of {role, content} with text content, a system message only first, the last a
      user message with text (bad_messages), CHAT_CHARS_MAX characters in all (413 too_large);
    - temperature, top_p and top_k, when sent, exactly Meta's (bad_sampling), since every answer samples with them;
    - max_tokens (or max_completion_tokens), a whole number from 1, held to CHAT_MAX_TOKENS_CAP (bad_max_tokens); when
      left out, CHAT_MAX_TOKENS_FINAL for a final-only answer and CHAT_MAX_TOKENS_REASONING for one that reasons first;
    - stop, a string or up to CHAT_STOPS_MAX of them, each up to CHAT_STOP_CHARS_MAX characters (bad_stop), with <|eom|>
      taken out of each (deploy.md lines 319 to 321) and the ones left empty dropped;
    - stream: not supported (stream_unsupported).
    Final-only (final_only) is the tuned model of a trainChannel 0 adapter; base Glimmer and a trainChannel 1 adapter
    reason first."""
    if not isinstance(body, dict):
        raise ChatRefused(400, "bad_json")
    if body.get("stream") not in (None, False):
        raise ChatRefused(400, "stream_unsupported")
    model = body.get("model")
    name = model.strip().lower() if isinstance(model, str) else None
    if name == BASE_MODEL_NAME:
        tuned = False
    elif name and name == adapter_job_id:
        tuned = True
    else:
        raise ChatRefused(400, "unknown_model")
    final_only = tuned and train_channel == 0
    for key, want in (("temperature", CHAT_TEMPERATURE), ("top_p", CHAT_TOP_P), ("top_k", CHAT_TOP_K)):
        if key in body and body[key] is not None:
            got = chat_number(body[key])
            if got is None or abs(got - want) > 1e-9:
                raise ChatRefused(400, "bad_sampling")
    messages = body.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= CHAT_MESSAGES_MAX:
        raise ChatRefused(400, "bad_messages")
    out, chars = [], 0
    for i, m in enumerate(messages):
        role = m.get("role") if isinstance(m, dict) else None
        content = m.get("content") if isinstance(m, dict) else None
        if role not in ("system", "user", "assistant") or not isinstance(content, str) or (role == "system" and i != 0):
            raise ChatRefused(400, "bad_messages")
        chars += len(content)
        out.append({"role": role, "content": content})
    if out[-1]["role"] != "user" or not out[-1]["content"].strip():
        raise ChatRefused(400, "bad_messages")
    if chars > CHAT_CHARS_MAX:
        raise ChatRefused(413, "too_large")
    asked = body.get("max_tokens")
    if asked is None:
        asked = body.get("max_completion_tokens")
    if asked is None:
        max_tokens = CHAT_MAX_TOKENS_FINAL if final_only else CHAT_MAX_TOKENS_REASONING
    else:
        n = chat_number(asked, whole=True)
        if n is None or n < 1:
            raise ChatRefused(400, "bad_max_tokens")
        max_tokens = min(n, CHAT_MAX_TOKENS_CAP)
    stop = body.get("stop")
    if stop is None:
        stops = []
    elif isinstance(stop, str):
        stops = [stop]
    elif isinstance(stop, list) and all(isinstance(s, str) for s in stop):
        stops = list(stop)
    else:
        raise ChatRefused(400, "bad_stop")
    if len(stops) > CHAT_STOPS_MAX or any(len(s) > CHAT_STOP_CHARS_MAX for s in stops):
        raise ChatRefused(400, "bad_stop")
    kept = []
    for s in stops:
        s = s.replace(CHAT_EOM, "")
        if s and s not in kept:
            kept.append(s)
    return {
        "model": adapter_job_id if tuned else BASE_MODEL_NAME,
        "tuned": tuned,
        "final_only": final_only,
        "messages": out,
        "max_tokens": max_tokens,
        "stops": kept,
    }


def chat_answer(raw, final_only):
    """(answer, finished) from a chat answer's raw output. A final-only answer starts on the final channel the prompt
    opened. Any other starts where the template's generation prompt leaves the model, which reasons to itself first, so
    its answer is its last message on the final channel ("assistant to=user"), and with none there is no answer yet (an
    empty answer that didn't finish, as Meta's servers give one cut off mid-thought, deploy.md line 690). Either runs to
    the first <|eot|>, <|eom|>, <|end_of_text|> or <|start|>, and is finished only when one came and some text did."""
    body = raw
    if not final_only:
        at = raw.rfind(FINAL_CHANNEL)
        if at < 0:
            return "", False
        body = raw[at + len(FINAL_CHANNEL):]
    cut, end = len(body), None
    for token in FINAL_ENDS + ("<|start|>",):
        at = body.find(token)
        if 0 <= at < cut:
            cut, end = at, token
    text = strip_control(body[:cut])
    return text, end is not None and bool(text)


def cut_at_stops(text, stops):
    """(text up to the first of the stops in it, True), or (text, False) when none is in it."""
    found = [at for at in (text.find(s) for s in stops) if at >= 0]
    if not found:
        return text, False
    return text[:min(found)], True


def token_id(text_tokenizer, token):
    """The tokenizer's id for one of the template's tokens. Raises when it has none."""
    convert = getattr(text_tokenizer, "convert_tokens_to_ids", None)
    if not callable(convert):
        raise RuntimeError("The tokenizer can't look up the id of " + token)
    got = convert(token)
    unknown = getattr(text_tokenizer, "unk_token_id", None)
    if isinstance(got, bool) or not isinstance(got, int) or got < 0 or (unknown is not None and got == unknown):
        raise RuntimeError("The tokenizer has no " + token + " token")
    return got


def chat_eos_ids(text_tokenizer):
    """Meta's eos_token_id list (CHAT_EOS_IDS), once the tokenizer agrees they are <|end_of_text|> and <|eot|>. Raises
    when it doesn't, since answers would then stop somewhere else."""
    got = tuple(token_id(text_tokenizer, t) for t in CHAT_EOS_TOKENS)
    if got != CHAT_EOS_IDS:
        raise RuntimeError(
            "The tokenizer's " + " and ".join(CHAT_EOS_TOKENS) + " are " + str(list(got)) + ", not Meta's "
            + str(list(CHAT_EOS_IDS)) + ", so chat answers wouldn't stop where they should"
        )
    return list(CHAT_EOS_IDS)


def make_chatter(model, tokenizer, torch, system, adapter_job_id, train_channel):
    """chat(req) -> {text, finish, prompt_tokens, completion_tokens}, for a chat_request: the messages, each one's
    control tokens neutralized (neutral_prompt), through the model's chat template at low reasoning. The tuned model of a
    trainChannel 0 adapter answers on the final channel the prompt opens (eval_prompt) and stops at Meta's ids and
    FINAL_ONLY_STOPS; base Glimmer (the adapter off) and a trainChannel 1 adapter answer from the generation prompt,
    reasoning first, and stop at Meta's ids only. The tuned model answers under the adapter's training line when the
    messages have no system message; base Glimmer then gets the template's own. Sampled with Meta's settings, up to
    req's max_tokens and CHAT_ANSWER_SECONDS, then cut at the caller's stops. Raises ChatTooLong for a prompt over
    CHAT_PROMPT_TOKENS_MAX tokens. Raises at once when the tokenizer's ids aren't Meta's or a template doesn't render as
    expected, so a server that would answer wrong never offers the route."""
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""
    text_tokenizer.padding_side = "left"
    if text_tokenizer.pad_token is None:
        text_tokenizer.pad_token = text_tokenizer.eos_token
    pad_id = text_tokenizer.pad_token_id
    specials = special_tokens_of(text_tokenizer)
    eos = chat_eos_ids(text_tokenizer)
    final_eos = eos + [token_id(text_tokenizer, t) for t in FINAL_ONLY_STOPS]
    head = [{"role": "system", "content": system}] if system else []

    def prompt_of(req):
        messages = [{"role": m["role"], "content": neutral_prompt(m["content"], specials)} for m in req["messages"]]
        if req["tuned"] and messages[0]["role"] != "system":
            messages = head + messages
        if req["final_only"]:
            return eval_prompt(tokenizer, messages, bos)
        text = render(tokenizer, messages, True, bos)
        if not text.endswith(GENERATION_PROMPT):
            raise RuntimeError("The chat template's generation prompt doesn't end with " + GENERATION_PROMPT + ": " + clip(text, 300))
        return text

    check = [{"role": "user", "content": "Check the template."}]
    for name in (BASE_MODEL_NAME, adapter_job_id):
        prompt_of(chat_request({"model": name, "messages": check}, adapter_job_id, train_channel))

    def chat(req):
        enc = text_tokenizer([prompt_of(req)], return_tensors="pt", padding=True)
        prompt_tokens = int(enc["input_ids"].shape[1])
        if prompt_tokens > CHAT_PROMPT_TOKENS_MAX:
            raise ChatTooLong()
        settings = {
            "input_ids": enc["input_ids"].to("cuda"),
            "attention_mask": enc["attention_mask"].to("cuda"),
            "max_new_tokens": req["max_tokens"],
            "do_sample": True,
            "temperature": CHAT_TEMPERATURE,
            "top_p": CHAT_TOP_P,
            "top_k": CHAT_TOP_K,
            "eos_token_id": list(final_eos if req["final_only"] else eos),
            "pad_token_id": pad_id,
            # transformers' MaxTimeCriteria: the answer stops where it is once this many seconds have passed.
            "max_time": float(CHAT_ANSWER_SECONDS),
        }
        with torch.no_grad():
            if req["tuned"]:
                out = model.generate(**settings)
            else:
                with model.disable_adapter():
                    out = model.generate(**settings)
        new = out[0][prompt_tokens:]
        ids = [int(t) for t in new]
        while ids and ids[-1] == pad_id:
            ids.pop()
        answer, finished = chat_answer(text_tokenizer.decode(new, skip_special_tokens=False), req["final_only"])
        answer, cut = cut_at_stops(answer, req["stops"])
        return {"text": answer, "finish": "stop" if finished or cut else "length", "prompt_tokens": prompt_tokens, "completion_tokens": len(ids)}

    return chat


def chat_completion(req, got, ms):
    """The reply to POST /v1/chat/completions, in OpenAI's chat completion shape, with the GPU's ms beside it."""
    return {
        "id": "chatcmpl-" + os.urandom(12).hex(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req["model"],
        "choices": [{"index": 0, "message": {"role": "assistant", "content": got["text"]}, "finish_reason": got["finish"]}],
        "usage": {
            "prompt_tokens": got["prompt_tokens"],
            "completion_tokens": got["completion_tokens"],
            "total_tokens": got["prompt_tokens"] + got["completion_tokens"],
        },
        "ms": ms,
    }


def make_certificate(folder):
    """(cert path, key path, SHA-256 of the certificate's DER bytes in lowercase hex): a new self-signed certificate
    from openssl, its key readable only by this user."""
    cert = os.path.join(folder, "serve-cert.pem")
    key = os.path.join(folder, "serve-key.pem")
    for path in (cert, key):
        remove_quietly(path)
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", str(CERT_DAYS),
        "-subj", CERT_SUBJECT, "-keyout", key, "-out", cert,
    ]
    mask = os.umask(0o077)
    try:
        out = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError("openssl couldn't make the demo server's certificate: " + type(e).__name__ + ": " + str(e)[:300])
    finally:
        os.umask(mask)
    if out.returncode != 0 or not os.path.isfile(cert) or not os.path.isfile(key):
        text = out.stdout.decode("utf-8", "replace")[-600:]
        raise RuntimeError("openssl couldn't make the demo server's certificate (exit " + str(out.returncode) + "): " + text)
    with open(cert, encoding="ascii") as f:
        der = ssl.PEM_cert_to_DER_cert(f.read())
    return cert, key, hashlib.sha256(der).hexdigest()


def tls_context(cert, key):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    return context


class RequestDeadline:
    """Shuts a connection down unless cancel() comes within seconds of it being accepted, however slowly it keeps
    sending: a socket timeout starts again with every read, this doesn't. The server cancels it once a whole request
    with the serve key has arrived, so a slow answer is never cut off."""

    def __init__(self, conn, seconds):
        self.conn = conn
        self.expired = False
        self._over = False
        self._lock = threading.Lock()
        self._timer = threading.Timer(max(0.0, float(seconds)), self._expire)
        self._timer.daemon = True
        self._timer.start()

    def _expire(self):
        with self._lock:
            if self._over:
                return
            self._over = self.expired = True
        try:
            # The plain socket's shutdown, not SSLSocket's, which drops its TLS state under the thread still reading it.
            # A read blocked on this connection, the handshake's included, returns at once.
            socket.socket.shutdown(self.conn, socket.SHUT_RDWR)
        except OSError:
            pass

    def cancel(self):
        """Ends the watch. False when the deadline had already shut the connection."""
        with self._lock:
            if self.expired:
                return False
            self._over = True
        self._timer.cancel()
        return True


class ServeState:
    """What the server's threads share: the key, the answerer, the one-at-a-time lock, the counts, the connections held
    (in all and by address), and when to stop."""

    def __init__(self, key, answer, until, info, stop_path=None, decider=None, system=None, chatter=None):
        self.key = ("Bearer " + key).encode("utf-8")
        self.answer = answer
        # A decision model's server: decide(items) for POST /decide (make_decider) and the system message each item
        # must carry. None for a chat adapter's, which answers /generate.
        self.decider = decider
        self.system = system
        # A chat adapter's server: chat(req) for POST /v1/chat/completions (make_chatter). None for a decision model's,
        # or when the route couldn't be set up (the log says why), which then answers 501 chat_unavailable.
        self.chatter = chatter
        self.until = float(until)
        self.info = dict(info)
        self.stop_path = stop_path
        # One answer at a time on the one GPU: a second prompt while one is being answered gets 409 busy.
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.counts = {"served": 0, "busy": 0, "unauthorized": 0, "bad_requests": 0, "errors": 0}
        self.failed_in_row = 0
        # Why the server stopped itself early, for run(ctx) to fail the job with. None while it hasn't.
        self.note = None
        self._counts_lock = threading.Lock()
        self._active = 0
        self._active_cond = threading.Condition()
        self._conns = 0
        self._conns_by_ip = {}
        self._conns_lock = threading.Lock()

    def bump(self, name):
        with self._counts_lock:
            self.counts[name] += 1
            return self.counts[name]

    def take_connection(self, ip):
        """True, holding a connection slot for ip, when fewer than MAX_CONNECTIONS are held in all and fewer than
        MAX_CONNECTIONS_PER_IP from ip; give_connection(ip) gives it back."""
        with self._conns_lock:
            held = self._conns_by_ip.get(ip, 0)
            if self._conns >= MAX_CONNECTIONS or held >= MAX_CONNECTIONS_PER_IP:
                return False
            self._conns += 1
            self._conns_by_ip[ip] = held + 1
            return True

    def give_connection(self, ip):
        with self._conns_lock:
            self._conns = max(0, self._conns - 1)
            held = self._conns_by_ip.get(ip, 0) - 1
            if held > 0:
                self._conns_by_ip[ip] = held
            else:
                self._conns_by_ip.pop(ip, None)

    def answer_failed(self, failure):
        """Counts a failed answer. FAILS_TO_STOP in a row stop the server, with a note that fails the job."""
        self.bump("errors")
        with self._counts_lock:
            self.failed_in_row += 1
            stop = self.failed_in_row >= FAILS_TO_STOP
            if stop and self.note is None:
                self.note = (
                    "The demo server stopped after " + str(FAILS_TO_STOP) + " live answers in a row failed (last: "
                    + type(failure).__name__ + ")"
                )
        if stop:
            self.stopping.set()

    def answer_worked(self):
        with self._counts_lock:
            self.failed_in_row = 0

    def authorized(self, header):
        return hmac.compare_digest(str(header or "").encode("utf-8", "replace"), self.key)

    def begin(self):
        with self._active_cond:
            self._active += 1

    def end(self):
        with self._active_cond:
            self._active -= 1
            self._active_cond.notify_all()

    def drain(self, seconds):
        """Waits up to seconds for the answers in progress to be sent. True when none is left."""
        give_up = time.time() + seconds
        with self._active_cond:
            while self._active > 0:
                left = give_up - time.time()
                if left <= 0:
                    return False
                self._active_cond.wait(left)
        return True

    def should_stop(self):
        return self.stopping.is_set() or time.time() >= self.until or bool(self.stop_path and os.path.exists(self.stop_path))


class ServeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Nothing about who asked, or what, goes to the job log.
        pass

    def send_response(self, code, message=None):
        # No Server header: nothing a scanner reads says what answers here.
        self.send_response_only(code, message)
        self.send_header("Date", self.date_time_string())

    def in_time(self):
        """Ends this connection's request deadline once a whole request with the key has arrived; from here on only the
        answer takes time. False when the deadline had already shut the connection."""
        deadline = getattr(self.server.local, "deadline", None)
        return deadline is None or deadline.cancel()

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        state = self.server.state
        if state.authorized(self.headers.get("Authorization")):
            return True
        state.bump("unauthorized")
        self.reply(401, {"error": "unauthorized"})
        return False

    def route(self):
        return self.path.split("?", 1)[0]

    def do_GET(self):
        if not self.allowed() or not self.in_time():
            return
        if self.route() != "/health":
            return self.reply(404, {"error": "not_found"})
        state = self.server.state
        health = {
            "ok": not state.stopping.is_set(),
            "busy": state.lock.locked(),
            "model": state.info.get("model"),
            "adapterJobId": state.info.get("adapterJobId"),
            "served": state.counts["served"],
        }
        if state.decider is not None:
            health["mode"] = DECIDE_MODE
        self.reply(200, health)

    def read_body(self):
        """The request body, read before any answer: a connection closed with a body still unread is reset, and the
        client would never see the answer. None after answering 411 (no length) or 413 (over REQUEST_MAX_BYTES)."""
        state = self.server.state
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            length = -1
        if length < 0:
            state.bump("bad_requests")
            self.reply(411, {"error": "length_required"})
            return None
        if state.decider is not None:
            limit = DECIDE_REQUEST_MAX_BYTES if self.route() == "/decide" else REQUEST_MAX_BYTES
        else:
            limit = CHAT_REQUEST_MAX_BYTES if self.route() == CHAT_PATH else REQUEST_MAX_BYTES
        if length > limit:
            state.bump("bad_requests")
            self.reply(413, {"error": "too_large"})
            return None
        return self.rfile.read(length)

    def do_POST(self):
        raw = self.read_body()
        if raw is None or not self.allowed() or not self.in_time():
            return
        if self.server.state.decider is not None:
            return self.answer_decide(raw)
        if self.route() == CHAT_PATH:
            return self.answer_chat(raw)
        if self.route() != "/generate":
            return self.reply(404, {"error": "not_found"})
        state = self.server.state
        if state.stopping.is_set():
            return self.reply(503, {"error": "stopping"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            state.bump("bad_requests")
            return self.reply(400, {"error": "bad_json"})
        prompt = body.get("prompt") if isinstance(body, dict) else None
        if not isinstance(prompt, str) or not prompt.strip():
            state.bump("bad_requests")
            return self.reply(400, {"error": "no_prompt"})
        prompt = prompt.strip()[:PROMPT_MAX_CHARS]
        if not state.lock.acquire(blocking=False):
            state.bump("busy")
            return self.reply(409, {"error": "busy"})
        state.begin()
        try:
            began, failure = time.time(), None
            try:
                base, tuned = state.answer(prompt)
            except Exception as e:
                failure = e
            finally:
                state.lock.release()
            if failure is not None:
                state.answer_failed(failure)
                emit("log", text="A live answer failed: " + type(failure).__name__ + ": " + str(failure)[:300])
                if state.note:
                    emit("log", text=state.note)
                return self.reply(500, {"error": "generation_failed"})
            state.answer_worked()
            ms = int(round((time.time() - began) * 1000))
            emit("served", count=state.bump("served"), ms=ms)
            self.reply(200, {"base": base, "tuned": tuned, "ms": ms})
        finally:
            state.end()

    def answer_chat(self, raw):
        """POST /v1/chat/completions on a chat adapter's server: one chat_request answered by base Glimmer or the tuned
        model (make_chatter), one request at a time on the GPU, as /generate is, in OpenAI's chat completion shape.
        400 for a body chat_request refuses (or bad_json), 413 too_large, 422 too_long, 409 busy, 503 stopping, 501
        chat_unavailable when the route couldn't be set up, 500 generation_failed (counting toward FAILS_TO_STOP)."""
        state = self.server.state
        if state.chatter is None:
            return self.reply(501, {"error": "chat_unavailable"})
        if state.stopping.is_set():
            return self.reply(503, {"error": "stopping"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            state.bump("bad_requests")
            return self.reply(400, {"error": "bad_json"})
        try:
            req = chat_request(body, state.info.get("adapterJobId"), state.info.get("trainChannel", 0))
        except ChatRefused as e:
            state.bump("bad_requests")
            return self.reply(e.status, {"error": e.code})
        if not state.lock.acquire(blocking=False):
            state.bump("busy")
            return self.reply(409, {"error": "busy"})
        state.begin()
        try:
            began, failure, got = time.time(), None, None
            try:
                got = state.chatter(req)
            except Exception as e:
                failure = e
            finally:
                state.lock.release()
            if isinstance(failure, ChatTooLong):
                state.bump("bad_requests")
                return self.reply(422, {"error": "too_long"})
            if failure is not None:
                state.answer_failed(failure)
                emit("log", text="A chat answer failed: " + type(failure).__name__ + ": " + str(failure)[:300])
                if state.note:
                    emit("log", text=state.note)
                return self.reply(500, {"error": "generation_failed"})
            state.answer_worked()
            ms = int(round((time.time() - began) * 1000))
            emit("served", count=state.bump("served"), ms=ms)
            self.reply(200, chat_completion(req, got, ms))
        finally:
            state.end()

    def answer_decide(self, raw):
        """POST /decide on a decision model's server: the items (decide_request) scored by both models, one request at
        a time on the GPU, as /generate is. Its only route besides /health: /generate is a 404 here."""
        if self.route() != "/decide":
            return self.reply(404, {"error": "not_found"})
        state = self.server.state
        if state.stopping.is_set():
            return self.reply(503, {"error": "stopping"})
        try:
            items = decide_request(json.loads(raw.decode("utf-8")), state.system)
        except (ValueError, UnicodeDecodeError):
            state.bump("bad_requests")
            return self.reply(400, {"error": "bad_json"})
        except DecideRefused as e:
            state.bump("bad_requests")
            return self.reply(e.status, {"error": e.code})
        if not state.lock.acquire(blocking=False):
            state.bump("busy")
            return self.reply(409, {"error": "busy"})
        state.begin()
        try:
            began, failure, scores = time.time(), None, None
            try:
                scores = state.decider(items)
            except Exception as e:
                failure = e
            finally:
                state.lock.release()
            if isinstance(failure, DecideTooLong):
                state.bump("bad_requests")
                return self.reply(422, {"error": "too_long"})
            if failure is not None:
                state.answer_failed(failure)
                emit("log", text="A live decision failed: " + type(failure).__name__ + ": " + str(failure)[:300])
                if state.note:
                    emit("log", text=state.note)
                return self.reply(500, {"error": "scoring_failed"})
            state.answer_worked()
            base, tuned = scores
            ms = int(round((time.time() - began) * 1000))
            emit("served", count=state.bump("served"), ms=ms)
            self.reply(
                200,
                {
                    "base": [s["logprobs"] for s in base],
                    "tuned": [s["logprobs"] for s in tuned],
                    "baseMass": [round(s["mass"], 6) for s in base],
                    "tunedMass": [round(s["mass"], 6) for s in tuned],
                    "ms": ms,
                },
            )
        finally:
            state.end()


class ServeServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """HTTPS with a thread a connection, at most MAX_CONNECTIONS at once and MAX_CONNECTIONS_PER_IP from one address
    (more are closed at once). The TLS handshake runs on the connection's own thread, and the handshake and the request
    together must arrive within REQUEST_DEADLINE_SECONDS, so slow clients can't hold the slots the platform needs."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, state, tls):
        self.state = state
        self.tls = tls
        # The connection's RequestDeadline, for its handler (each connection has a thread of its own).
        self.local = threading.local()
        http.server.HTTPServer.__init__(self, address, ServeHandler)

    def server_bind(self):
        # http.server's own looks the host's name up in DNS, which only slows the start.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = str(self.server_address[0]), self.server_address[1]

    def process_request(self, request, client_address):
        ip = client_address[0]
        if not self.state.take_connection(ip):
            self.shutdown_request(request)
            return
        try:
            socketserver.ThreadingMixIn.process_request(self, request, client_address)
        except BaseException:
            self.state.give_connection(ip)
            raise

    def process_request_thread(self, request, client_address):
        try:
            socketserver.ThreadingMixIn.process_request_thread(self, request, client_address)
        finally:
            self.state.give_connection(client_address[0])

    def finish_request(self, request, client_address):
        request.settimeout(SOCKET_TIMEOUT_SECONDS)
        # The handshake runs below, under the deadline, rather than inside wrap_socket.
        conn = self.tls.wrap_socket(request, server_side=True, do_handshake_on_connect=False)
        deadline = RequestDeadline(conn, REQUEST_DEADLINE_SECONDS)
        self.local.deadline = deadline
        try:
            conn.do_handshake()
            self.RequestHandlerClass(conn, client_address, self)
        finally:
            deadline.cancel()
            self.local.deadline = None
            try:
                conn.close()
            except OSError:
                pass

    def handle_error(self, request, client_address):
        # A scanner's broken handshake or a dropped connection: nothing for the job log.
        pass


def make_server(state, host, port, cert, key):
    """The demo server, bound and listening but not yet serving (serve_until runs it)."""
    return ServeServer((host, int(port)), state, tls_context(cert, key))


def serve_until(server, state, alive_seconds=None, poll_seconds=None):
    """Serves until state.until, the stop file or state.stopping, writing an "alive" event every ALIVE_SECONDS, then
    stops: no new connections (the listening socket is closed), the answer in progress finishes (up to DRAIN_SECONDS).
    Returns the counts and how long it served."""
    alive_seconds = ALIVE_SECONDS if alive_seconds is None else alive_seconds
    poll_seconds = STOP_POLL_SECONDS if poll_seconds is None else poll_seconds
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, name="muse-serve", daemon=True)
    thread.start()
    started = last_alive = time.time()
    while not state.should_stop():
        time.sleep(max(0.0, min(poll_seconds, state.until - time.time())))
        if time.time() - last_alive >= alive_seconds and not state.should_stop():
            last_alive = time.time()
            emit("alive", served=state.counts["served"])
    state.stopping.set()
    server.shutdown()
    server.server_close()
    thread.join(5)
    drained = state.drain(DRAIN_SECONDS)
    served_seconds = time.time() - started
    emit("phase", message="Stopped serving after " + str(state.counts["served"]) + " answers in " + minutes(served_seconds))
    out = dict(state.counts)
    out["served_seconds"] = round(served_seconds, 1)
    out["drained"] = drained
    if state.note:
        out["note"] = state.note
    return out


def serve_child_main(config_path):
    with open(config_path) as f:
        cfg = json.load(f)
    result_path = cfg["result_path"]
    # Made before the model loads, so a missing openssl fails in seconds.
    cert, key, fingerprint = make_certificate(cfg["work_dir"])
    # Unsloth patches transformers and peft, so it is imported first, as in glimmer-lora's child.
    from unsloth import FastModel
    import torch
    from peft import PeftModel

    emit("imported")
    began = time.time()
    emit("phase", message="Loading " + cfg["model"] + " and the adapter of job " + cfg["adapter_job_id"])
    model, tokenizer = FastModel.from_pretrained(
        model_name=cfg["model"], revision=cfg.get("revision"), max_seq_length=cfg["max_seq_length"]
    )
    model = PeftModel.from_pretrained(model, cfg["adapter_dir"], is_trainable=False)
    if hasattr(FastModel, "for_inference"):
        try:
            FastModel.for_inference(model)
        except Exception as e:
            emit("log", text="Unsloth's inference mode didn't take (" + type(e).__name__ + ": " + str(e)[:200] + "); answering without it")
    decider, chatter = None, None
    channel = int(cfg.get("train_channel") or 0)
    if cfg.get("mode") == DECIDE_MODE:
        # A decision model answers POST /decide only (docs/DECISION_MODELS.md, "On the lab's GPU").
        answer, decider = None, make_decider(model, tokenizer, torch, cfg.get("system"))
    else:
        answer = make_answerer(model, tokenizer, torch, cfg.get("system"))
        try:
            chatter = make_chatter(model, tokenizer, torch, cfg.get("system"), cfg["adapter_job_id"], channel)
        except Exception as e:
            # The room's Try it live (/generate) still serves; only products' chat is off on this server.
            emit("log", text="Products' chat at " + CHAT_PATH + " is off on this server: " + type(e).__name__ + ": " + str(e)[:300])
    result = {"load_seconds": round(time.time() - began, 1), "gpu": torch.cuda.get_device_name(0)}
    until = min(float(cfg["stop_by"]), time.time() + float(cfg["minutes"]) * 60)
    if until - time.time() < MIN_SERVING_SECONDS:
        result["note"] = (
            "The model took " + minutes(time.time() - began) + " to load, which left too little time to serve before the job's time limit"
        )
        write_result(result_path, result)
        return
    state = ServeState(
        cfg["key"], answer, until, {"model": cfg["model"], "adapterJobId": cfg["adapter_job_id"], "trainChannel": channel},
        cfg.get("stop_path"), decider=decider, system=cfg.get("system"), chatter=chatter,
    )
    server = make_server(state, cfg.get("host") or SERVE_HOST, cfg["port"], cert, key)
    emit("serving", port=server.server_address[1], certSha256=fingerprint, model=cfg["model"], until=int(until))
    result.update(serve_until(server, state))
    try:
        result["peak_vram_gb"] = round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2)
    except Exception:
        # After a broken CUDA context torch.cuda itself may raise, and the result, with its note, must still be written.
        result["peak_vram_gb"] = None
    write_result(result_path, result)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--serve":
        serve_child_main(sys.argv[2])
    else:
        sys.stderr.write("usage: recipe.py --serve config.json\n")
        sys.exit(2)
`;

/** The glimmer-serve recipe: glimmer-lora's helpers, then the demo server and its run(ctx). */
export const SERVE_PY = SERVE_HEAD + glimmerHelpers(GLIMMER_PY) + SERVE_BODY;
