/**
 * The glimmer-lora recipe's Python (docs/TRAINING.md, "glimmer-lora recipe"): a LoRA fine-tune of Muse Glimmer 30B
 * (4-bit) with Unsloth on one dataset, with the held-out prompts answered by the base and the tuned model as eval
 * items. It follows Unsloth's Muse Glimmer guide and its Conversational notebook for the install pins, the model, the
 * ATEM chat template, the LoRA targets, the SFT trainer and train-on-responses-only. Never put a dollar sign followed
 * by an opening brace, or a backtick, in the Python: this is a template literal.
 *
 * The runner imports this file with the system python (standard library only). The heavy work runs in a child process,
 * this same file run as "python recipe.py --child config.json" inside a uv venv kept on the cache filesystem, so the
 * venv and the weights (HF_HOME) are reused by the next job in the region. One job builds a missing venv while the
 * others in the region wait and reuse it. The child works to ctx.deadline: it writes the base answers as soon as it has
 * them, stops training early when it must, and saves the adapter before the tuned answers. Params: datasetId,
 * maxSteps, learningRate, loraRank, studentPrompt ("short" or "full", see student_setup), dryRun (1 skips the venv, the
 * model and the GPU and fakes the answers, for tests), publish (0 keeps the adapter off the Hugging Face Hub) and why
 * (the admin's own words for the model card, which only the platform reads).
 *
 * The adapter's adapter_config.json gets the base model's pinned revision as soon as it is saved. Once the eval items
 * are sent and the adapter archive is offered for upload, the recipe sends the adapter folder to the Hugging Face Hub's
 * storage (ctx.hub_upload, publish_adapter), which the platform commits with its model card once the job is judged.
 *
 * The answers train on the final (to=user) channel with no reasoning, and the eval prompts open that channel, so both
 * models answer the way the tuned one was trained (see RESPONSE_PART and eval_prompt). The child checks the masks
 * train_on_responses_only made and logs the first training example and eval item 0's raw outputs.
 *
 * mode "decide" (docs/DECISION_MODELS.md, "The GPU side") trains a decision model on a decision dataset instead: the
 * platform renders every training row (one letter to answer) and every dev and test item (no answer), the child scores
 * the items with the base and then the tuned model from the first answer token's log-probabilities over the shown
 * letters (score_all), trains 32 renderings a step in between, and the parent sends the scores with ctx.decide in place
 * of eval items and writes decide.json next to the adapter. Its params: epochs (1 to 4, the steps follow from the
 * renderings), scoreOnly (1 scores the base and trains nothing) and dryRun; publish stays 0. Everything chat mode does
 * is unchanged when mode isn't set.
 */
export const GLIMMER_PY = String.raw`"""Muse Glimmer LoRA: fine-tunes Muse Glimmer 30B with Unsloth and answers held-out prompts before and after."""

import base64
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import sys
import tarfile
import threading
import time
import urllib.request

# The base every new job trains on (owner, Oct 31 2026: "Switch outright to r30b"): Muse Muse's 2026-knowledge Glimmer,
# OfflineBase/Glimmer-30B-2026-Knowledge, quantized to nf4 the way unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit is (same 5
# shard names, 3,516 tensors, dtypes, shapes and quantization_config; checked by the training session on Oct 31). Part
# of its training data was written by Muse Spark Open, so every adapter trained on it is a Derivative under the Muse
# Model License (lib/train/base.ts). Change MODEL and MODEL_REVISION together: weights_cached keys on both. Jobs before
# the switch trained on unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit at ecedda395d4d099b477d135a9a573eedaa5a7aad.
MODEL = "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"
# The model's commit on the Hugging Face hub (public, no token), so every job loads the same weights.
MODEL_REVISION = "6f12bf5288dd4d83374e1d6cab3b6b80da258eb1"
# The Conversational notebook's install cell as uv pip installs, pinned to what it resolved to on 2026-10-27 for
# Python 3.12 on x86_64 Linux. Changing any line makes a new venv.
INSTALL = (
    "torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 xformers==0.0.35 --index-url https://download.pytorch.org/whl/cu128",
    "unsloth==2026.10.9 unsloth_zoo==2026.10.9 peft==0.21.2 accelerate==1.15.0 bitsandbytes==0.50.2 datasets==4.8.5",
    "--no-deps torchao==0.18.0",
    "transformers==5.15.0",
    "--no-deps trl==0.22.2",
)
TRANSFORMERS_VERSION = "5.15.0"
TRL_VERSION = "0.22.2"
PYTHON = "3.12"
# uv from its GitHub release, checked against the release's sha256 before it is used. A uv on PATH is never used.
UV_VERSION = "0.13.1"
UV_URL = "https://github.com/astral-sh/uv/releases/download/" + UV_VERSION + "/uv-x86_64-unknown-linux-gnu.tar.gz"
UV_SHA256 = "eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220"
UV_MEMBER = "uv-x86_64-unknown-linux-gnu/uv"
READY_MARKER = ".muse-ready"
# A reused venv the child couldn't import from gets its marker renamed to this, so the next job builds it again.
BROKEN_MARKER = ".muse-broken"
# Every job stamps the venv it runs from, so a venv of other pins that nobody stamped for LEFTOVER_SECONDS is removed.
LAST_USED = ".muse-last-used"
# A new venv is ready once it imports what the child imports and sees the GPU.
READY_CHECK = (
    "from unsloth import FastModel; "
    "from unsloth.chat_templates import train_on_responses_only; "
    "import torch, datasets, peft, bitsandbytes, transformers, trl; "
    "from transformers import TrainerCallback; "
    "from trl import SFTConfig, SFTTrainer; "
    "assert torch.cuda.is_available(), 'CUDA is not available'; "
    "print('MUSE_CHECK transformers=' + transformers.__version__ + ' trl=' + trl.__version__)"
)
READY_LINE = "MUSE_CHECK transformers=" + TRANSFORMERS_VERSION + " trl=" + TRL_VERSION
# The venv build lock: its holder touches it every minute, and one nobody touched for 10 minutes is a dead job's.
LOCK_TOUCH_SECONDS = 60
LOCK_STALE_SECONDS = 600
LOCK_POLL_SECONDS = 15
# Build and stale folders older than this are dead jobs' (no job lives this long), so a job deletes them, and a venv of
# other pins that no job used for this long goes too.
LEFTOVER_SECONDS = 12 * 3600
# The longest a build step may run. Each one also stops in time for the job to train after it.
VENV_TIMEOUT_SECONDS = 900
INSTALL_TIMEOUT_SECONDS = 2400
MIN_STEP_SECONDS = 60
# A Hugging Face download lock nobody took for this long is a dead download's (one file never takes this long), so it
# is removed before the model loads: on the shared cache it could otherwise hold up that file's download for good.
HF_LOCK_STALE_SECONDS = 3600
# An install, download or training step that writes nothing this long is reported stalled (runner.py's Heartbeat).
STALL_SECONDS = 1200
# The parent's time after the child: the eval callbacks, then the adapter's tar.gz and upload.
PARENT_RESERVE_SECONDS = 300
# The child is killed this long after its own deadline.
CHILD_GRACE_SECONDS = 60
# With less than this left for the child, the job fails at once instead of loading a model it can't train.
MIN_CHILD_SECONDS = 900
# What the child keeps back after training: the tuned answers (1.3 times the base answers' time) plus this, to free
# the training memory and save the adapter.
TUNED_PASS_FACTOR = 1.3
SAVE_RESERVE_SECONDS = 180
# The ATEM markers (the model's chat_template.jinja), which the notebook passes to train_on_responses_only. A user turn
# opens with INSTRUCTION_PART. An assistant message with no reasoning_content renders as RESPONSE_PART, the answer and
# <|eot|>, with no to=self message before it, and train_on_responses_only trains on what follows RESPONSE_PART.
INSTRUCTION_PART = "<|start|>user<|message|>"
RESPONSE_PART = "<|start|>assistant to=user<|message|>"
# The template's generation prompt ends here and leaves the channel to the model, which then opens its to=self
# reasoning: a choice the training text never trains, since it sits inside RESPONSE_PART. So the eval prompts open the
# final channel themselves (FINAL_CHANNEL) and end exactly as a training text does before its answer.
GENERATION_PROMPT = "<|start|>assistant"
FINAL_CHANNEL = RESPONSE_PART[len(GENERATION_PROMPT):]
# What closes a message on the final channel: <|eot|> ends the turn and generation, <|eom|> only the message.
FINAL_ENDS = ("<|eot|>", "<|eom|>", "<|end_of_text|>")
PAD_TOKEN = "<|finetune_right_pad|>"
# The template's control tokens, the only thing taken out of an unfinished answer's raw text.
CONTROL_TOKENS = ("<|begin_of_text|>", "<|end_of_text|>", "<|start|>", "<|message|>", "<|eot|>", "<|eom|>", PAD_TOKEN)
# The template writes "Reasoning strength: <level>." into the system block (high by default). Training text and eval
# prompts carry no reasoning, and both use low.
REASONING = "low"
MAX_SEQ_LENGTH = 2048
MAX_NEW_TOKENS = 1024
UNFINISHED = (
    "[Unfinished: no complete final answer within " + str(MAX_NEW_TOKENS)
    + " new tokens. The raw output follows, with only the chat template's control tokens taken out.]"
)
# The masking check: an example's first trained span must start with this much of its answer.
ANSWER_HEAD = 40
TRAIN_OPEN = "[train]"
TRAIN_CLOSE = "[/train]"
# How much of the first training example, and of eval item 0's raw outputs, the job log shows.
DIAGNOSIS_CHARS = 1500
RAW_CHARS = 600
LOG_EVENT_MAX = 3000
# studentPrompt: "short" answers under student_system(title), "full" under the dataset's own task prompt.
STUDENT_PROMPTS = ("short", "full")
ROLE_MAX = 80
FALLBACK_ROLE = "a helpful assistant"
# How datasetSystemPrompt(task) in lib/train/logic.ts starts. A dataset made with no name is titled with the start of
# its task, which isn't a role.
TASK_PROMPT_START = "You are an assistant for this task: "
GEN_BATCH = 8
PROGRESS_EVERY = 10
EVAL_MAX = 120
EVENT_PREFIX = "MUSE_EVENT "
UPLOAD_MAX_BYTES = 1024 * 1024 * 1024
JOB_DIR = "/opt/muse"
ADAPTER_CONFIG = "adapter_config.json"
# A Hugging Face Hub upload (ctx.hub_upload) isn't started with less than this left before ctx.deadline: the
# glimmer-publish recipe can send the adapter later.
HUB_MIN_SECONDS = 480

# Decide mode (docs/DECISION_MODELS.md, "The GPU side"): a decision dataset's renderings train the adapter to answer
# with one letter, and base and tuned Glimmer score its dev and test items from the first answer token's
# log-probabilities. The mode param: "chat" (everything above, unchanged) when it isn't set.
MODES = ("chat", "decide")
DECIDE_MODE = "decide"
# epochs as decideEpochs in lib/train/decision-datasets.ts reads it: a whole number from 1 to 4, else 2.
DECIDE_EPOCHS_DEFAULT = 2
DECIDE_EPOCHS_MIN = 1
DECIDE_EPOCHS_MAX = 4
# The letters a prompt shows, by position (DECIDE_LETTERS in lib/decide/format.ts).
DECIDE_LETTERS = ("A", "B", "C", "D", "E")
# 16 renderings a device step and 2 accumulated, 32 a step, lengths grouped: what the knowledge run measured on an A100
# 40 GB. ceil(renderings / 32) steps, at most DECIDE_STEPS_MAX (DECIDE_STEP_ROWS and DECIDE_STEPS_MAX in logic.ts).
DECIDE_TRAIN_BATCH = 16
DECIDE_GRAD_ACCUM = 2
DECIDE_STEPS_MAX = 2000
# Prompts a forward pass scores, left padded, and how many passes go between progress messages.
DECIDE_SCORE_BATCH = 8
DECIDE_PROGRESS_BATCHES = 10
# JSON has no -Infinity, so a letter with no probability is scored as this (runner.py's DECIDE_LOGPROB_FLOOR).
DECIDE_LOGPROB_FLOOR = -10000.0
# A rendering's tokens besides its prompt's: the tokenizer's <|begin_of_text|>, the answer's letter and <|eot|>. One
# over MAX_SEQ_LENGTH with them is dropped and counted (too_long), never cut, since cutting would take the answer off.
DECIDE_EXTRA_TOKENS = 3
# The format's contract (decideJson in lib/decide/format.ts), which the dataset's pages carry and the job writes next to
# the adapter, so an app renders the prompts the model trained on from that file alone.
DECIDE_JSON = "decide.json"
DECIDE_FORMAT = "muse-decide/1"

# The families a job may train on (lib/train/bases.ts, docs/TRAINING.md "Any Meta base"). Each brings its chat template's
# markers, which the functions below read as globals. Without a baseFamily param the job is exactly the glimmer one above.
# Markers read from each family's chat_template.jinja on the Hub. Only "glimmer" has ever run on a GPU here.
FAMILIES = {
    "llama3": {
        "instruction": "<|start_header_id|>user<|end_header_id|>\n\n",
        "response": "<|start_header_id|>assistant<|end_header_id|>\n\n",
        "generation": "<|start_header_id|>assistant<|end_header_id|>\n\n",
        "next_message": "<|start_header_id|>",
        "ends": ("<|eot_id|>", "<|eom_id|>", "<|end_of_text|>"),
        "pad": "<|finetune_right_pad_id|>",
        "control": ("<|begin_of_text|>", "<|end_of_text|>", "<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>", "<|eom_id|>", "<|finetune_right_pad_id|>"),
        # Unsloth's Llama 3 notebooks: FastLanguageModel and these modules, every one a Linear in LlamaDecoderLayer.
        "targets": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    },
    "llama4": {
        "instruction": "<|header_start|>user<|header_end|>\n\n",
        "response": "<|header_start|>assistant<|header_end|>\n\n",
        "generation": "<|header_start|>assistant<|header_end|>\n\n",
        "next_message": "<|header_start|>",
        "ends": ("<|eot|>", "<|eom|>", "<|end_of_text|>"),
        "pad": "<|finetune_right_pad|>",
        "control": ("<|begin_of_text|>", "<|end_of_text|>", "<|header_start|>", "<|header_end|>", "<|eot|>", "<|eom|>", "<|finetune_right_pad|>"),
        # Multimodal like Glimmer, so FastModel's finetune_* choice leaves its vision tower out.
        "targets": None,
    },
}
# What the Llama templates do to a message's text: | trim. Glimmer's writes it as it is.
TRIM_CONTENT = False
NEXT_MESSAGE = "<|start|>"
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
# Files a gated base's download keeps, as the platform's /base-files route lists them.
GATED_READY = ".muse-complete"
GATED_TRIES = 3


def use_family(family):
    """Points the template markers at a family's. None or "glimmer" leaves them as they are."""
    global INSTRUCTION_PART, RESPONSE_PART, GENERATION_PROMPT, FINAL_CHANNEL, FINAL_ENDS, PAD_TOKEN, CONTROL_TOKENS, TRIM_CONTENT, NEXT_MESSAGE
    if family in (None, "", "glimmer"):
        return
    f = FAMILIES.get(family)
    if not f:
        raise ValueError("baseFamily must be glimmer, llama3 or llama4")
    INSTRUCTION_PART, RESPONSE_PART, GENERATION_PROMPT = f["instruction"], f["response"], f["generation"]
    FINAL_CHANNEL = RESPONSE_PART[len(GENERATION_PROMPT):]
    FINAL_ENDS, PAD_TOKEN, CONTROL_TOKENS = f["ends"], f["pad"], f["control"]
    TRIM_CONTENT, NEXT_MESSAGE = True, f["next_message"]


def use_base(params):
    """The job's base from the params the platform wrote after checking it (lib/train/launch.ts), held to the same shape
    again here: no baseFamily means the MODEL and MODEL_REVISION above. Returns the family, or None."""
    global MODEL, MODEL_REVISION
    family = params.get("baseFamily")
    if family in (None, ""):
        return None
    repo, revision = params.get("baseModel"), params.get("baseRevision")
    if not isinstance(repo, str) or not REPO_RE.match(repo) or not isinstance(revision, str) or not COMMIT_RE.match(revision):
        raise ValueError("The job's base isn't a repo at a pinned commit")
    use_family(family)
    MODEL, MODEL_REVISION = repo, revision
    return family


def gated_dir(hf_home):
    return os.path.join(hf_home, "gated", MODEL.replace("/", "--"), MODEL_REVISION)


def fetch_gated_base(ctx, hf_home):
    """A gated base's files into the region's cache, from links the platform makes with its Hub token, which never comes
    here. Each large file is held to the sha256 the Hub lists. Returns the folder."""
    folder = gated_dir(hf_home)
    if os.path.exists(os.path.join(folder, GATED_READY)):
        return folder
    os.makedirs(folder, exist_ok=True)
    for f in ctx.base_files():
        name = os.path.basename(f["path"])
        path = os.path.join(folder, name)
        if name != f["path"]:
            raise RuntimeError("The platform listed a base file outside the repo's root")
        if f.get("inline") is not None:
            with open(path, "wb") as out:
                out.write(base64.b64decode(f["inline"]))
            continue
        for attempt in range(GATED_TRIES):
            try:
                digest = hashlib.sha256()
                part = path + ".part" + str(os.getpid())
                with urllib.request.urlopen(f["url"], timeout=120) as res, open(part, "wb") as out:
                    while True:
                        block = res.read(8 * 1024 * 1024)
                        if not block:
                            break
                        digest.update(block)
                        out.write(block)
                if f.get("sha256") and digest.hexdigest() != f["sha256"]:
                    raise RuntimeError("its sha256 isn't the one the Hub lists")
                os.replace(part, path)
                break
            except Exception as e:
                # Never the error's own text alone with the URL in it: that link works without a token while it lives.
                if attempt + 1 == GATED_TRIES:
                    raise RuntimeError("Downloading " + name + " from the gated base failed: " + type(e).__name__) from None
        ctx.progress(message="Downloaded " + name)
    with open(os.path.join(folder, GATED_READY), "w") as out:
        out.write(MODEL_REVISION)
    return folder


def number(params, key, fallback):
    try:
        value = float(params.get(key, fallback))
    except (TypeError, ValueError):
        return float(fallback)
    return value if math.isfinite(value) else float(fallback)


def read_params(params):
    dataset_id = str(params.get("datasetId") or "").strip()
    if not dataset_id:
        raise ValueError("datasetId is required")
    p = {
        "dataset_id": dataset_id,
        "max_steps": int(min(2000, max(10, round(number(params, "maxSteps", 120))))),
        "learning_rate": number(params, "learningRate", 0.0002),
        "lora_rank": int(min(128, max(4, round(number(params, "loraRank", 16))))),
        "dry_run": number(params, "dryRun", 0) >= 1,
        "student_prompt": str(params.get("studentPrompt") or "short").strip().lower(),
        # Published to the Hugging Face Hub unless the admin set publish to 0.
        "publish": number(params, "publish", 1) != 0,
    }
    if not (0 < p["learning_rate"] <= 0.01):
        raise ValueError("learningRate must be above 0 and at most 0.01")
    if p["student_prompt"] not in STUDENT_PROMPTS:
        raise ValueError("studentPrompt must be short or full, not " + json.dumps(str(params.get("studentPrompt")))[:60])
    p["mode"] = str(params.get("mode") or "chat").strip().lower()
    if p["mode"] not in MODES:
        raise ValueError("mode must be chat or decide, not " + json.dumps(str(params.get("mode")))[:60])
    if p["mode"] == DECIDE_MODE:
        p.update(decide_params(params))
    return p


def decide_epochs(params):
    """The epochs param as decideEpochs in lib/train/decision-datasets.ts reads it, so the GPU counts the epochs the
    platform paged: a whole number from 1 to 4 (or text that is one), else 2."""
    raw = params.get("epochs")
    if isinstance(raw, bool):
        return DECIDE_EPOCHS_DEFAULT
    try:
        n = float(raw.strip()) if isinstance(raw, str) else float(raw)
    except (TypeError, ValueError, AttributeError):
        return DECIDE_EPOCHS_DEFAULT
    if not math.isfinite(n) or not n.is_integer() or not DECIDE_EPOCHS_MIN <= n <= DECIDE_EPOCHS_MAX:
        return DECIDE_EPOCHS_DEFAULT
    return int(n)


def decide_params(params):
    """Decide mode's own params: epochs, scoreOnly (1 scores base Glimmer and trains nothing), and publish, which is 0
    and must stay 0, as the platform also says: a person's rows are never published, and publishing a decision model on
    its own is later work. maxSteps and studentPrompt don't apply: the steps come from the renderings, and the renderings
    keep the dataset's own system message."""
    if number(params, "publish", 0) != 0:
        raise ValueError("publish must be 0 in decide mode: a decision model isn't published to the Hugging Face Hub yet")
    return {"epochs": decide_epochs(params), "score_only": number(params, "scoreOnly", 0) >= 1, "publish": False}


def minutes(seconds):
    return str(max(0, int(seconds // 60))) + " min"


def job_deadline(ctx, started):
    """Unix time the job must be done by: ctx.deadline, stamped before the launch so never after the platform's time or
    dollar limit, or for a runner without one the recipe's start plus maxMinutes."""
    deadline = getattr(ctx, "deadline", None)
    if isinstance(deadline, (int, float)) and not isinstance(deadline, bool) and deadline > 0:
        return float(deadline)
    return started + float(ctx.max_minutes or 120) * 60


def writable(path):
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".muse-write-" + str(os.getpid()))
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def base_dir(ctx):
    """(folder, cached): the cache filesystem, or the job folder (/opt/muse on the instance) without a usable cache."""
    if ctx.cache_dir and writable(ctx.cache_dir):
        return ctx.cache_dir, True
    if ctx.cache_dir:
        ctx.log("The cache folder " + ctx.cache_dir + " isn't writable, so this job runs without the cache")
    parent = os.path.dirname(os.path.abspath(ctx.work_dir))
    return parent or JOB_DIR, False


def train_examples(items):
    """The dataset's well-formed conversations: a messages list of role and content strings with an assistant turn."""
    out = []
    for item in items:
        messages = item.get("messages") if isinstance(item, dict) else None
        if not isinstance(messages, list):
            continue
        clean = [
            {"role": m["role"], "content": m["content"]}
            for m in messages
            if isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str)
        ]
        if any(m["role"] == "assistant" for m in clean):
            out.append({"messages": clean})
    return out


def shared_system(train):
    """The system message every training conversation starts with, or None when they don't share one.

    The eval prompts are answered under it too, so the base and the tuned model see what training saw.
    """
    found = None
    for row in train:
        first = row["messages"][0] if row["messages"] else None
        text = first["content"] if first and first["role"] == "system" else None
        if text is None or (found is not None and text != found):
            return None
        found = text
    return found


def student_system(title, dataset_system=None):
    """The short system message: "You are " and the dataset's title as a role, as in "You are Muse Muse's brief writer.".

    A title that is missing, longer than ROLE_MAX or only the start of the task (the name a dataset gets when it is made
    without one; its system message then starts with TASK_PROMPT_START and the title) gives "You are a helpful
    assistant." instead.
    """
    role = " ".join(str(title or "").split()).rstrip(".!?:; ")
    if role[:8].lower() == "you are ":
        role = role[8:].lstrip()
    from_task = bool(role) and isinstance(dataset_system, str) and dataset_system.startswith(TASK_PROMPT_START + role)
    if not role or len(role) > ROLE_MAX or from_task:
        role = FALLBACK_ROLE
    # A bare noun phrase reads as a role with "the" ("the Muse Muse brief writer"); keep articles and possessives.
    words = role.lower().split()
    if words[0] not in ("a", "an", "the", "your", "my", "our") and not any(w.endswith("'s") for w in words[:3]):
        role = "the " + role
    return "You are " + role + "."


def with_system(messages, system):
    """The conversation with system as its only system message, first."""
    return [{"role": "system", "content": system}] + [m for m in messages if m["role"] != "system"]


def student_setup(mode, train, title):
    """(train, system): the training conversations and the system message the eval prompts are answered under.

    "short" puts student_system(title) in place of every conversation's system message, so training and both models'
    answers see one short line instead of the dataset's task prompt, and the comparison measures what training taught.
    "full" keeps the conversations as they are and answers under the system message they share (none when they
    differ), which measures how well each model follows the task prompt.
    """
    own = shared_system(train)
    if mode == "short":
        system = student_system(title, own)
        return [{"messages": with_system(row["messages"], system)} for row in train], system
    return train, own


def eval_examples(items):
    out = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("prompt"), str) and item["prompt"].strip():
            out.append({"prompt": item["prompt"], "reference": str(item.get("reference") or "")})
    return out[:EVAL_MAX]


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_result(path, result):
    """Writes the child's result file whole (written aside, then renamed), so a killed child never leaves half of one."""
    part = path + ".part"
    with open(part, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(part, path)


def read_result(path):
    """The child's result file, or None when it never wrote one."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def venv_name():
    spec = "\n".join((PYTHON, UV_VERSION) + INSTALL)
    return "glimmer-" + hashlib.sha256(spec.encode("utf-8")).hexdigest()[:12]


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(url, path, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as res, open(path, "wb") as f:
                shutil.copyfileobj(res, f)
            return
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def uv_binary(ctx, base):
    """The pinned uv, downloaded once into the cache and checked against UV_SHA256 before it is kept."""
    path = os.path.join(base, "uv", UV_VERSION, "uv")
    if os.access(path, os.X_OK):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tag = str(ctx.job_id or "job")[:8]
    archive_path = os.path.join(ctx.work_dir, "uv-" + UV_VERSION + ".tar.gz")
    ctx.log("Downloading uv " + UV_VERSION)
    fetch(UV_URL, archive_path)
    digest = sha256_of(archive_path)
    if digest != UV_SHA256:
        os.remove(archive_path)
        raise RuntimeError("The uv " + UV_VERSION + " download has sha256 " + digest + ", not the pinned " + UV_SHA256)
    part = path + ".part-" + tag
    with tarfile.open(archive_path, "r:gz") as tar:
        member = tar.getmember(UV_MEMBER)
        source = tar.extractfile(member) if member.isfile() else None
        if source is None:
            raise RuntimeError("The uv " + UV_VERSION + " archive has no " + UV_MEMBER)
        with source, open(part, "wb") as f:
            shutil.copyfileobj(source, f)
    os.chmod(part, 0o755)
    os.replace(part, path)
    os.remove(archive_path)
    return path


def venv_ready(venv):
    return os.path.isfile(os.path.join(venv, READY_MARKER)) and os.path.exists(os.path.join(venv, "bin", "python"))


def age_of(path):
    """Seconds since path last changed, or None when it is gone."""
    try:
        return time.time() - os.stat(path).st_mtime
    except OSError:
        return None


class LockKeeper(threading.Thread):
    """Touches the build lock every minute while this job holds it, so a waiter can tell a live build from a dead one."""

    def __init__(self, lock):
        threading.Thread.__init__(self, name="muse-venv-lock", daemon=True)
        self.lock = lock
        self.stopped = threading.Event()

    def run(self):
        while not self.stopped.wait(LOCK_TOUCH_SECONDS):
            try:
                os.utime(self.lock, None)
            except OSError:
                pass

    def stop(self):
        self.stopped.set()
        self.join(timeout=5)


def lock_owner(lock):
    try:
        with open(os.path.join(lock, "owner")) as f:
            return json.load(f).get("job")
    except (OSError, ValueError, AttributeError):
        return None


def take_lock(ctx, lock, venv, tag):
    """Takes the venv's build lock and returns True, or returns False once another job's build made the venv ready.

    The lock is a folder (os.mkdir is atomic, on NFS too). One nobody touched for LOCK_STALE_SECONDS is a dead job's
    and is broken. The lock only saves duplicate installs: settle_venv keeps two builds safe without it.
    """
    waiting = False
    while True:
        try:
            os.mkdir(lock)
        except FileExistsError:
            pass
        else:
            try:
                with open(os.path.join(lock, "owner"), "w") as f:
                    f.write(json.dumps({"job": str(ctx.job_id or "job"), "at": int(time.time())}))
            except OSError:
                pass
            return True
        if venv_ready(venv):
            return False
        age = age_of(lock)
        if age is not None and age >= LOCK_STALE_SECONDS:
            ctx.log("Breaking the venv build lock " + lock + ", untouched for " + minutes(age))
            aside = lock + ".stale-" + tag + "-" + str(int(time.time()))
            try:
                os.rename(lock, aside)
            except OSError:
                pass
            else:
                shutil.rmtree(aside, ignore_errors=True)
            continue
        if not waiting:
            waiting = True
            ctx.progress(message="Waiting for another job in the region to finish installing Unsloth")
        deadline = getattr(ctx, "deadline", None)
        if deadline and time.time() > deadline - PARENT_RESERVE_SECONDS - MIN_CHILD_SECONDS:
            raise RuntimeError("Gave up waiting for another job's venv build: too little time is left to train")
        time.sleep(LOCK_POLL_SECONDS)


# The threads deleting old folders while the job goes on (a venv is thousands of files on NFS). Tests join them.
CLEANUPS = []


def remove_later(path):
    """Deletes path on a thread of its own. One the job doesn't live to finish is a leftover for a later job."""
    thread = threading.Thread(target=shutil.rmtree, args=(path,), kwargs={"ignore_errors": True}, name="muse-cleanup", daemon=True)
    thread.start()
    CLEANUPS.append(thread)


def remove_leftovers(folder):
    """Deletes build and stale folders in the venvs folder older than LEFTOVER_SECONDS. A venv itself is never one."""
    try:
        names = os.listdir(folder)
    except OSError:
        return
    for name in names:
        if ".building-" not in name and ".stale-" not in name:
            continue
        path = os.path.join(folder, name)
        age = age_of(path)
        if age is not None and age >= LEFTOVER_SECONDS:
            remove_later(path)


def mark_used(venv):
    """Stamps a venv as used now (its .muse-last-used), so remove_old_venvs leaves it alone for LEFTOVER_SECONDS."""
    try:
        with open(os.path.join(venv, LAST_USED), "w") as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


def remove_old_venvs(ctx, folder, keep, tag):
    """Removes the venvs of other pins that no job used for LEFTOVER_SECONDS. The venv named keep is never touched.

    A venv's last use is its .muse-last-used. One without it (built before these stamps) is stamped now, so it goes
    LEFTOVER_SECONDS after a job first saw it, by when every job launched with its pins has ended.
    """
    try:
        names = os.listdir(folder)
    except OSError:
        return
    for name in names:
        path = os.path.join(folder, name)
        if name == keep or not name.startswith("glimmer-") or "." in name or not os.path.isdir(path):
            continue
        age = age_of(os.path.join(path, LAST_USED))
        if age is None:
            mark_used(path)
            continue
        if age < LEFTOVER_SECONDS:
            continue
        aside = path + ".stale-" + tag + "-" + str(int(time.time()))
        try:
            os.rename(path, aside)
        except OSError:
            continue
        ctx.log("Removing the venv " + name + ": it has other pins, and no job used it for " + str(int(age // 3600)) + " hours")
        remove_later(aside)


def use_venv(ctx, venv, tag):
    """Stamps the venv this job runs from, then clears dead jobs' leftovers and venvs nobody uses any more."""
    mark_used(venv)
    folder = os.path.dirname(venv)
    remove_leftovers(folder)
    remove_old_venvs(ctx, folder, os.path.basename(venv), tag)


def mark_broken(ctx, venv):
    """Takes a reused venv the child couldn't import from out of use: its marker is renamed, so the next job builds it
    again. Nothing is deleted, since another job may still be running from it."""
    try:
        os.rename(os.path.join(venv, READY_MARKER), os.path.join(venv, BROKEN_MARKER))
    except OSError:
        return False
    ctx.log("The venv " + venv + " is missing a module the child imports, so it is marked broken and the next job builds it again")
    return True


def settle_venv(building, venv, tag):
    """Renames a finished build into place and returns False, or returns True when a ready venv is already there.

    The rename settles a race: onto a folder that isn't empty it fails, and the venv in place wins. A ready venv is
    never deleted or moved, since other jobs may be running from it. A folder in its place that isn't ready (a dead
    build, or a venv marked broken that a job may still run from) is moved aside and left for remove_leftovers, which
    deletes it LEFTOVER_SECONDS later.
    """
    last = None
    for attempt in range(3):
        if venv_ready(venv):
            shutil.rmtree(building, ignore_errors=True)
            return True
        try:
            os.rename(building, venv)
            return False
        except OSError as e:
            last = e
        if venv_ready(venv) or not os.path.lexists(venv):
            continue
        aside = venv + ".stale-" + tag + "-" + str(int(time.time())) + "-" + str(attempt)
        try:
            os.rename(venv, aside)
        except OSError:
            continue
        if venv_ready(aside):
            # Another job's venv landed between the check and the move: it goes back, and this job uses it.
            try:
                os.rename(aside, venv)
            except OSError:
                pass
            continue
        try:
            os.utime(aside, None)
        except OSError:
            pass
    raise RuntimeError("Could not move the new venv into place at " + venv + ": " + str(last))


def build_timeout(ctx, cap):
    """A build step's timeout: cap, or less so the job still has time to train after it. Raises when too little is left,
    so a job that couldn't train anyway fails before paying for the install."""
    now = time.time()
    left = job_deadline(ctx, now) - PARENT_RESERVE_SECONDS - MIN_CHILD_SECONDS - now
    if left < MIN_STEP_SECONDS:
        raise RuntimeError("Too little time is left before the job's time limit to install Unsloth and still train")
    return int(min(cap, left))


def build_venv(ctx, base, venv, tag):
    """Builds the venv aside, checks it and renames it into place. True when another job's venv got there first."""
    ctx.progress(message="Installing Unsloth into a new venv")
    uv = uv_binary(ctx, base)
    building = venv + ".building-" + tag
    shutil.rmtree(building, ignore_errors=True)
    env = {
        # The interpreter lives in the cache too, since the venv points at it.
        "UV_PYTHON_INSTALL_DIR": os.path.join(base, "uv", "python"),
        "UV_CACHE_DIR": os.path.join(ctx.work_dir, "uv-cache"),
        "UV_LINK_MODE": "copy",
    }
    q = shlex.quote
    try:
        # A uv-managed interpreter, so a cached venv never points at one image's system python.
        venv_cmd = q(uv) + " venv --relocatable --python-preference only-managed --python " + PYTHON + " " + q(building)
        ctx.run(venv_cmd, timeout=build_timeout(ctx, VENV_TIMEOUT_SECONDS), check=True, env=env, stall_seconds=STALL_SECONDS)
        target = q(os.path.join(building, "bin", "python"))
        for i, line in enumerate(INSTALL):
            # uv compiles the whole venv when asked, so only the last line asks; jobs then never write bytecode into it.
            flags = " --compile-bytecode" if i == len(INSTALL) - 1 else ""
            cmd = q(uv) + " pip install" + flags + " --python " + target + " " + line
            ctx.run(cmd, timeout=build_timeout(ctx, INSTALL_TIMEOUT_SECONDS), check=True, env=env, stall_seconds=STALL_SECONDS)
        check_env = {"HF_HOME": os.path.join(base, "hf"), "HF_HUB_DISABLE_TELEMETRY": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        check_cmd = target + " -c " + q(READY_CHECK)
        out = ctx.run(check_cmd, timeout=build_timeout(ctx, VENV_TIMEOUT_SECONDS), check=True, env=check_env, stall_seconds=STALL_SECONDS)
        if READY_LINE not in (out.stdout or ""):
            raise RuntimeError("The new venv doesn't have " + READY_LINE + ": " + (out.stdout or "")[-300:])
        with open(os.path.join(building, READY_MARKER), "w") as f:
            f.write(json.dumps({"install": INSTALL, "python": PYTHON, "uv": UV_VERSION, "at": int(time.time())}))
    except BaseException:
        shutil.rmtree(building, ignore_errors=True)
        raise
    return settle_venv(building, venv, tag)


def ensure_venv(ctx, base):
    """The venv's python and whether it was reused.

    One job in the region builds a missing venv, holding its lock, while the others wait and then reuse it. The build
    goes into a folder of its own that is renamed into place once it works, and a ready venv is never deleted. The job
    then stamps the venv it uses and clears what nobody uses any more (use_venv).
    """
    venv = os.path.join(base, "venvs", venv_name())
    python = os.path.join(venv, "bin", "python")
    tag = str(ctx.job_id or "job")[:8]
    if venv_ready(venv):
        use_venv(ctx, venv, tag)
        return python, True
    os.makedirs(os.path.dirname(venv), exist_ok=True)
    lock = venv + ".lock"
    if not take_lock(ctx, lock, venv, tag):
        ctx.log("Another job in the region installed the venv while this one waited")
        use_venv(ctx, venv, tag)
        return python, True
    keeper = LockKeeper(lock)
    keeper.start()
    try:
        reused = venv_ready(venv) or build_venv(ctx, base, venv, tag)
    finally:
        keeper.stop()
        # A lock another job broke and took over is that job's to remove.
        if lock_owner(lock) in (str(ctx.job_id or "job"), None):
            shutil.rmtree(lock, ignore_errors=True)
    use_venv(ctx, venv, tag)
    return python, reused


def remove_stale_hf_locks(ctx, hf_home):
    """Deletes Hugging Face download locks nobody took for HF_LOCK_STALE_SECONDS: their downloads died with their
    instance, and on the shared cache such a lock could hold up every later download of its file. Returns how many."""
    removed = 0
    for root, _dirs, files in os.walk(os.path.join(hf_home, "hub", ".locks")):
        for name in files:
            path = os.path.join(root, name)
            age = age_of(path)
            if not name.endswith(".lock") or age is None or age < HF_LOCK_STALE_SECONDS:
                continue
            try:
                os.remove(path)
                removed += 1
            except OSError:
                pass
    if removed:
        ctx.log("Removed " + str(removed) + " Hugging Face download lock" + ("" if removed == 1 else "s") + " nobody took for an hour")
    return removed


def weights_cached(hf_home):
    if os.path.exists(os.path.join(gated_dir(hf_home), GATED_READY)):
        return True
    snapshot = os.path.join(hf_home, "hub", "models--" + MODEL.replace("/", "--"), "snapshots", MODEL_REVISION)
    return os.path.isdir(snapshot) and any(os.scandir(snapshot))


def relay(ctx, seen=None):
    """The ctx.run hook for the child's events: a MUSE_EVENT line becomes a progress event, or a log line for a "log"
    event (its text cut to LOG_EVENT_MAX), and nothing else does. Each event's kind is added to seen, when given.

    The event can start anywhere in the line: on stdout (the fallback channel) a progress bar can be glued in front.
    """

    def on_line(line):
        at = line.find(EVENT_PREFIX)
        if at < 0:
            return
        event = json.loads(line[at + len(EVENT_PREFIX):])
        if seen is not None:
            seen.add(str(event.get("kind")))
        if event.get("kind") == "progress":
            ctx.progress(step=event.get("step"), total_steps=event.get("total"), loss=event.get("loss"), message=event.get("message"))
        elif event.get("kind") == "phase":
            ctx.progress(message=str(event.get("message") or "")[:200])
        elif event.get("kind") == "log":
            ctx.log(str(event.get("text") or "")[:LOG_EVENT_MAX])

    return on_line


def run_child(ctx, cmd, timeout, env, seen=None):
    """Runs the child: its events come on their own pipe (stdout is the fallback), and a quiet child is reported
    stalled. Never raises for the exit code; the caller reads the result file. seen collects the events' kinds."""
    hook = relay(ctx, seen)
    return ctx.run(cmd, timeout=timeout, check=False, env=env, on_line=hook, on_event=hook, stall_seconds=STALL_SECONDS)


def archive(adapter_dir, path):
    with tarfile.open(path, "w:gz") as tar:
        tar.add(adapter_dir, arcname="adapter")
    return os.path.getsize(path)


def upload_adapter(ctx, adapter_dir, metrics):
    """Uploads the adapter folder as one tar.gz. A failed or skipped upload is logged; the adapter stays in the cache."""
    name = "glimmer-lora-" + str(ctx.job_id or "job")[:8] + ".tar.gz"
    path = os.path.join(ctx.work_dir, name)
    try:
        size = archive(adapter_dir, path)
        metrics["adapter_mb"] = round(size / 1e6, 1)
        if size > UPLOAD_MAX_BYTES:
            ctx.log("The adapter archive is over 1 GB, so it was kept in " + adapter_dir + " and not uploaded")
            metrics["adapter_uploaded"] = "no"
            return
        url = ctx.upload(path, name, "adapter")
    except Exception as e:
        ctx.log("Uploading the adapter failed (" + type(e).__name__ + ": " + str(e)[:300] + "); it is kept in " + adapter_dir)
        metrics["adapter_uploaded"] = "no"
        return
    metrics["adapter_uploaded"] = "yes" if url else "no"
    if url:
        metrics["adapter_url"] = url


def hub_config_fixes(config, revision, model):
    """What a PEFT adapter_config.json needs so the adapter loads from the Hugging Face Hub onto the weights it was
    trained on: "revision", the base model's commit, when it has none (PEFT's AutoPeftModel loads the base at it, and a
    model card's base_model can't pin one), and base_model_name_or_path as model when it is missing or a local path.
    {} when it needs nothing."""
    fixes = {}
    if revision and not config.get("revision"):
        fixes["revision"] = revision
    base = config.get("base_model_name_or_path")
    if model and (not isinstance(base, str) or not base.strip() or os.path.isabs(base)):
        fixes["base_model_name_or_path"] = model
    return fixes


def fix_adapter_config(source, revision, model, target=None):
    """Applies hub_config_fixes to the adapter_config.json at source: in place, or into a copy at target (source is then
    left as it is). Written the way PEFT writes it (top-level keys sorted, a 2-space indent), aside and then renamed.
    Returns the keys it set."""
    with open(source, encoding="utf-8") as f:
        config = json.load(f)
    if not isinstance(config, dict):
        raise ValueError(source + " isn't a JSON object")
    fixes = hub_config_fixes(config, revision, model)
    out = target or source
    if fixes or out != source:
        config.update(fixes)
        part = out + ".part"
        with open(part, "w", encoding="utf-8") as f:
            f.write(json.dumps(dict(sorted(config.items())), indent=2))
        os.replace(part, out)
    return sorted(fixes)


def publish_adapter(ctx, p, adapter_dir, metrics):
    """Sends the adapter folder to the Hugging Face Hub's storage through the platform (ctx.hub_upload), which commits
    it with its model card once the job is judged. Not for a dry run (its adapter is a stand-in), with publish 0, or
    with under HUB_MIN_SECONDS left before ctx.deadline (glimmer-publish can send it later). The outcome goes to the log
    and the metrics: hub_uploaded (yes or no), hub_skip_reason when it is no, and hub_repo once the platform named one.
    Nothing here fails the job."""
    reason, out = None, None
    deadline = getattr(ctx, "deadline", None)
    timed = isinstance(deadline, (int, float)) and not isinstance(deadline, bool) and deadline > 0
    left = deadline - time.time() if timed else None
    if p.get("dry_run"):
        reason = "a dry run's adapter is a stand-in"
    elif not p.get("publish", True):
        reason = "publish is 0 for this job"
    elif left is not None and left < HUB_MIN_SECONDS:
        reason = "only " + minutes(left) + " were left before the job's time limit"
    else:
        try:
            out = ctx.hub_upload(adapter_dir)
        except Exception as e:
            reason = "the upload failed (" + type(e).__name__ + ": " + str(e)[:300] + ")"
    if out is not None:
        if out.get("repo"):
            metrics["hub_repo"] = str(out["repo"])
        failed = out.get("failed") or []
        if out.get("skipped"):
            reason = str(out["skipped"])
        elif failed:
            first = failed[0] if isinstance(failed[0], dict) else {}
            reason = (
                str(len(failed)) + " file" + ("" if len(failed) == 1 else "s") + " didn't reach the Hub's storage ("
                + str(first.get("path")) + ": " + str(first.get("error")) + ")"
            )
    metrics["hub_uploaded"] = "no" if reason else "yes"
    if reason:
        metrics["hub_skip_reason"] = reason
        ctx.log("The adapter wasn't sent to the Hugging Face Hub: " + reason)
    else:
        count = out.get("uploaded")
        ctx.log(
            "The adapter is in the Hugging Face Hub's storage for " + str(out.get("repo")) + " (" + str(count) + " file"
            + ("" if count == 1 else "s") + "); the platform publishes it with its model card once the job is judged"
        )


def fake_answer(kind, index, prompt):
    digest = hashlib.sha256((kind + ":" + prompt).encode("utf-8")).hexdigest()[:8]
    return "Dry run " + kind + " answer " + str(index) + " (" + digest + ")"


def dry_run(ctx, p, evals, adapter_dir):
    """Everything but the model: progress ticks, deterministic answers and a stand-in adapter folder."""
    total = p["max_steps"]
    every = max(PROGRESS_EVERY, PROGRESS_EVERY * math.ceil(total / 300.0))
    for step in range(every, total + 1, every):
        ctx.progress(step=step, total_steps=total, loss=round(2.0 * 0.99 ** step, 4))
    if total % every:
        ctx.progress(step=total, total_steps=total, loss=round(2.0 * 0.99 ** total, 4))
    os.makedirs(adapter_dir, exist_ok=True)
    with open(os.path.join(adapter_dir, ADAPTER_CONFIG), "w") as f:
        json.dump({"dry_run": True, "base_model_name_or_path": MODEL, "revision": MODEL_REVISION, "r": p["lora_rank"], "lora_alpha": p["lora_rank"]}, f)
    return {
        "base": [fake_answer("base", i, e["prompt"]) for i, e in enumerate(evals)],
        "tuned": [fake_answer("tuned", i, e["prompt"]) for i, e in enumerate(evals)],
        "metrics": {
            "train_loss_final": round(2.0 * 0.99 ** total, 4),
            "steps": total,
            "max_steps": total,
            "stopped_early": "no",
            "train_seconds": 0,
            "peak_vram_gb": 0,
        },
        "adapter": True,
    }


def last_lines(out, count=20):
    return "\n".join((out.stdout or "").splitlines()[-count:])


def real_run(ctx, p, base, train_path, eval_path, adapter_dir, started, system, extra=None):
    """Runs the child on the GPU and returns its result. extra goes into the child's config (decide mode's mode and
    score_only)."""
    hf_home = os.path.join(base, "hf")
    os.makedirs(hf_home, exist_ok=True)
    python, venv_reused = ensure_venv(ctx, base)
    remove_stale_hf_locks(ctx, hf_home)
    cached = weights_cached(hf_home)
    ctx.log("venv " + ("reused" if venv_reused else "installed") + ", weights " + ("cached" if cached else "not cached yet"))
    result_path = os.path.join(ctx.work_dir, "glimmer-result.json")
    if os.path.exists(result_path):
        os.remove(result_path)
    # The child has until the job's deadline less the parent's own reserve, and is killed shortly after that.
    deadline = job_deadline(ctx, started) - PARENT_RESERVE_SECONDS
    left = deadline - time.time()
    if left < MIN_CHILD_SECONDS:
        raise RuntimeError(
            "Only " + minutes(left) + " are left for the model before the job's time limit, too few to load it, train and answer"
        )
    config = {
        "model": MODEL,
        "revision": MODEL_REVISION,
        "max_seq_length": MAX_SEQ_LENGTH,
        "max_steps": p["max_steps"],
        "learning_rate": p["learning_rate"],
        "lora_rank": p["lora_rank"],
        "train_path": train_path,
        "eval_path": eval_path,
        "system": system,
        "result_path": result_path,
        "adapter_dir": adapter_dir,
        "output_dir": os.path.join(ctx.work_dir, "outputs"),
        "deadline": deadline,
    }
    config.update(extra or {})
    family = ctx.params.get("baseFamily")
    if family:
        config["family"] = family
        config["quantized"] = str(ctx.params.get("baseQuantized")) == "1"
        if str(ctx.params.get("baseGated")) == "1":
            config["load_path"] = fetch_gated_base(ctx, hf_home)
    config_path = os.path.join(ctx.work_dir, "glimmer-config.json")
    with open(config_path, "w") as f:
        json.dump(config, f)
    env = {
        "HF_HOME": hf_home,
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TOKENIZERS_PARALLELISM": "false",
        # The venv is shared by every job in the region, so nothing writes bytecode into it.
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    cmd = shlex.quote(python) + " -u " + shlex.quote(os.path.abspath(__file__)) + " --child " + shlex.quote(config_path)
    seen = set()
    out = run_child(ctx, cmd, int(left) + CHILD_GRACE_SECONDS, env, seen)
    timed_out = bool(getattr(out, "timed_out", False))
    ended = "timed out" if timed_out else "exited with " + str(out.returncode)
    result = read_result(result_path)
    if result is None:
        # A venv another job built that is missing a module here is broken for every job, so the next one rebuilds it.
        missing = "ModuleNotFoundError" in (out.stdout or "")
        if venv_reused and out.returncode != 0 and not timed_out and "imported" not in seen and missing:
            mark_broken(ctx, os.path.dirname(os.path.dirname(python)))
        raise RuntimeError("The training child " + ended + " before the base model answered:\n" + last_lines(out))
    if out.returncode != 0:
        ctx.log("The training child " + ended + " after writing part of its result")
    result["ended"] = ended
    result["tail"] = last_lines(out)
    result["metrics"] = dict(result.get("metrics") or {})
    result["metrics"]["cached_weights"] = "yes" if cached else "no"
    result["metrics"]["cached_venv"] = "yes" if venv_reused else "no"
    return result


def finish(ctx, p, result, evals, train, adapter_dir, cache_used):
    """Sends the eval items, uploads the adapter, sends it to the Hugging Face Hub (publish_adapter) and returns the
    metrics.

    A result the child left unfinished fails the job with what it did get: with no adapter saved, at once; with the
    adapter saved but no tuned answers, after the adapter is uploaded, and with no eval items sent and nothing sent to
    the Hub (with no eval, nothing is judged or published).
    """
    base_answers = result.get("base") or []
    tuned_answers = result.get("tuned")
    ended = str(result.get("ended") or "exited with 0")
    tail = str(result.get("tail") or "")
    if len(base_answers) != len(evals):
        raise RuntimeError("The base model answered " + str(len(base_answers)) + " of " + str(len(evals)) + " eval prompts")
    metrics = dict(result.get("metrics") or {})
    metrics["cache_used"] = "yes" if cache_used else "no"
    metrics["train_examples"] = len(train)
    metrics["student_prompt"] = p.get("student_prompt", "full")
    metrics["student_system"] = p.get("student_system", "none")
    metrics["adapter_dir"] = adapter_dir
    # The base this adapter trained on, so the platform can tell a Muse Spark Open Derivative (lib/train/base.ts).
    metrics["base_model"] = MODEL
    metrics["base_revision"] = MODEL_REVISION
    if not result.get("adapter"):
        raise RuntimeError(
            "Training didn't finish (the child " + ended + "), so no adapter was saved. The base model had answered all "
            + str(len(evals)) + " eval prompts." + ("\n" + tail if tail else "")
        )
    if not isinstance(tuned_answers, list) or len(tuned_answers) != len(evals):
        reason = str(result.get("tuned_error") or "the child " + ended + " during them")[:300]
        metrics["eval_items"] = 0
        upload_adapter(ctx, adapter_dir, metrics)
        kept = "uploaded" if metrics.get("adapter_uploaded") == "yes" else "kept in " + adapter_dir
        ctx.log("Training finished: " + json.dumps(metrics, ensure_ascii=False, default=str)[:3000])
        raise RuntimeError(
            "The adapter was saved (" + kept + "), but the tuned model's answers failed (" + reason + "), so no eval items were sent"
        )
    ctx.progress(message="Sending " + str(len(evals)) + " eval items")
    sent = 0
    for i, item in enumerate(evals):
        if ctx.eval(i, item["prompt"], item["reference"], base_answers[i], tuned_answers[i]):
            sent += 1
    metrics["eval_items"] = sent
    upload_adapter(ctx, adapter_dir, metrics)
    publish_adapter(ctx, p, adapter_dir, metrics)
    loss = metrics.get("train_loss_final")
    steps = str(metrics.get("steps")) + " steps"
    if metrics.get("stopped_early") == "yes":
        steps = str(metrics.get("steps")) + " of " + str(metrics.get("max_steps")) + " steps (stopped early to finish within the time limit)"
    unfinished = [metrics.get("base_unfinished"), metrics.get("tuned_unfinished")]
    note = ""
    if any(isinstance(n, int) and n > 0 for n in unfinished):
        note = " (unfinished answers: base " + str(unfinished[0] or 0) + ", tuned " + str(unfinished[1] or 0) + ")"
    metrics["summary"] = (
        ("Dry run: " if p["dry_run"] else "")
        + "LoRA r=" + str(p["lora_rank"]) + " on Muse Glimmer 30B, " + steps
        + (", final loss " + str(round(loss, 4)) if isinstance(loss, (int, float)) else "")
        + ", " + str(sent) + " eval items" + note + "."
    )
    return metrics


def run(ctx):
    started = time.time()
    p = read_params(ctx.params)
    use_base(ctx.params)
    if p["mode"] == DECIDE_MODE:
        return decide_run(ctx, p, started)
    ctx.progress(message="Fetching the dataset")
    train = train_examples(ctx.dataset("train"))
    evals = eval_examples(ctx.dataset("eval"))
    if not train:
        raise RuntimeError("The dataset has no usable training conversations")
    own = shared_system(train)
    train, system = student_setup(p["student_prompt"], train, getattr(ctx, "dataset_title", None))
    own_size = " (" + str(len(own)) + " characters)" if own else ""
    if p["student_prompt"] == "short":
        p["student_system"] = system
        how = (
            "training and both models' answers use the system message " + json.dumps(system, ensure_ascii=False)
            + " in place of the dataset's task prompt" + own_size
        )
    elif own:
        p["student_system"] = "the dataset's own" + own_size
        how = "training keeps the dataset's task prompt" + own_size + ", and both models answer under it"
    else:
        p["student_system"] = "none"
        how = "training keeps the dataset's system messages, which differ, so both models answer with none"
    ctx.log(
        "dataset " + p["dataset_id"] + ": " + str(len(train)) + " training conversations, " + str(len(evals))
        + " eval prompts. Student prompt " + p["student_prompt"] + ": " + how
    )
    base, cache_used = base_dir(ctx)
    adapter_dir = os.path.join(base, "models", str(ctx.job_id or "job"))
    train_path = os.path.join(ctx.work_dir, "train.jsonl")
    eval_path = os.path.join(ctx.work_dir, "eval.jsonl")
    write_jsonl(train_path, train)
    write_jsonl(eval_path, evals)

    if p["dry_run"]:
        result = dry_run(ctx, p, evals, adapter_dir)
        result["metrics"].update({"cached_weights": "no", "cached_venv": "no", "dry_run": "yes"})
    else:
        result = real_run(ctx, p, base, train_path, eval_path, adapter_dir, started, system)
    return finish(ctx, p, result, evals, train, adapter_dir, cache_used)


# ---------------------------------------------------------------------------------------------------------------
# Decide mode in the parent (docs/DECISION_MODELS.md, "The GPU side"): the decision dataset's pages, a dry run, and the
# scores sent with ctx.decide instead of eval items.


def decide_items(raw, part):
    """A decision dataset's dev or test items (part=dev, or part=eval for test) as both models score them: {part, index,
    row, group, messages, letters}. The platform renders them and keeps which letter is which label, so they carry no
    answer. Raises on an item that isn't one, or an index twice, since the pages and the platform's layout would
    disagree then."""
    out, seen = [], set()
    for k, item in enumerate(raw):
        item = item if isinstance(item, dict) else {}
        index, messages, letters = item.get("index"), item.get("messages"), item.get("letters")
        ok = (
            isinstance(index, int) and not isinstance(index, bool) and index >= 0 and index not in seen
            and isinstance(messages, list) and len(messages) == 2
            and all(isinstance(m, dict) and isinstance(m.get("content"), str) for m in messages)
            and [m.get("role") for m in messages] == ["system", "user"]
            and isinstance(letters, list) and 2 <= len(letters) <= len(DECIDE_LETTERS)
            and tuple(letters) == DECIDE_LETTERS[:len(letters)]
        )
        if not ok:
            raise RuntimeError(
                "Item " + str(k) + " of the " + part + " part isn't a decision item: a new index, a system and a user"
                + " message, and its letters from A"
            )
        seen.add(index)
        out.append({
            "part": part, "index": index, "row": item.get("row"), "group": item.get("group"),
            "messages": [{"role": m["role"], "content": m["content"]} for m in messages], "letters": list(letters),
        })
    return out


def decide_steps(renderings):
    """Optimizer steps for this many training renderings: ceil(renderings / 32), at least 1, at most DECIDE_STEPS_MAX."""
    return int(min(DECIDE_STEPS_MAX, max(1, math.ceil(renderings / float(DECIDE_TRAIN_BATCH * DECIDE_GRAD_ACCUM)))))


def fake_logprobs(kind, item):
    """A dry run's stand-in scores for one item, deterministic: 60% to 99% of the probability on its letters, split by
    the item's hash, so they pass the platform's check (logprobsProblem in lib/decide/format.ts) as real ones would."""
    key = kind + ":" + item["part"] + ":" + str(item["index"]) + ":" + json.dumps(item["messages"], ensure_ascii=False)
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    mass = 0.6 + 0.39 * digest[0] / 255.0
    weights = [1 + digest[1 + j] for j in range(len(item["letters"]))]
    total = float(sum(weights))
    logprobs = [math.log(mass * w / total) for w in weights]
    return {"logprobs": logprobs, "mass": sum(math.exp(l) for l in logprobs), "top": True}


def decide_dry_run(ctx, p, items, train, adapter_dir):
    """Decide mode with no venv, model or GPU: progress ticks for the steps the renderings would take, stand-in scores
    (fake_logprobs) and, unless scoreOnly, a stand-in adapter folder."""
    total = 0 if p["score_only"] else decide_steps(len(train))
    every = max(PROGRESS_EVERY, PROGRESS_EVERY * math.ceil(total / 300.0))
    for step in range(every, total + 1, every):
        ctx.progress(step=step, total_steps=total, loss=round(2.0 * 0.99 ** step, 4))
    if total and total % every:
        ctx.progress(step=total, total_steps=total, loss=round(2.0 * 0.99 ** total, 4))
    metrics = {
        "renderings": len(train), "train_too_long": 0, "too_long": 0, "unusable_scores": 0, "steps": total,
        "max_steps": total, "stopped_early": "no", "train_seconds": 0, "peak_vram_gb": 0,
    }
    if not p["score_only"]:
        metrics["train_loss_final"] = round(2.0 * 0.99 ** total, 4)
        os.makedirs(adapter_dir, exist_ok=True)
        with open(os.path.join(adapter_dir, ADAPTER_CONFIG), "w") as f:
            json.dump({"dry_run": True, "base_model_name_or_path": MODEL, "revision": MODEL_REVISION, "r": p["lora_rank"], "lora_alpha": p["lora_rank"]}, f)
    return {
        "mode": DECIDE_MODE,
        "base": [fake_logprobs("base", item) for item in items],
        "tuned": None if p["score_only"] else [fake_logprobs("tuned", item) for item in items],
        "metrics": metrics,
        "adapter": not p["score_only"],
    }


def middle(values):
    """The median of a list of numbers, 0 for none."""
    s = sorted(values)
    if not s:
        return 0.0
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


def decide_health(metrics, prefix, scores):
    """Letter mass (median and minimum) and the share of prompts whose top token was a shown letter, over one model's
    scored items, into metrics under prefix."""
    masses = [s["mass"] for s in scores if s]
    tops = [s for s in scores if s and s.get("top")]
    metrics[prefix + "letter_mass_median"] = round(middle(masses), 4)
    metrics[prefix + "letter_mass_min"] = round(min(masses), 4) if masses else 0
    metrics[prefix + "top_letter_share"] = round(len(tops) / float(len(masses)), 4) if masses else 0


def write_decide_json(adapter_dir, contract):
    """decide.json next to the adapter: the format's contract as the dataset's pages carry it (decideJson in
    lib/decide/format.ts, with T = 1: T is fit after the run, from the dev scores), written aside and then renamed."""
    path = os.path.join(adapter_dir, DECIDE_JSON)
    part = path + ".part"
    with open(part, "w", encoding="utf-8") as f:
        f.write(json.dumps(contract, ensure_ascii=False, indent=2) + "\n")
    os.replace(part, path)
    return path


def decide_send(ctx, items, base, tuned):
    """Sends every item the base model scored, with the tuned model's scores when it has them, part by part
    (ctx.decide). An item with no base score (too long, or numbers that can't be log-probabilities) isn't sent, and the
    platform counts its row unscored. Returns how many the platform took."""
    parts = {"dev": [], "test": []}
    for i, item in enumerate(items):
        b, t = base[i], (tuned[i] if tuned is not None else None)
        if not b:
            continue
        parts[item["part"]].append({
            "index": item["index"], "base": b["logprobs"], "tuned": t["logprobs"] if t else None,
            "baseMass": b["mass"], "tunedMass": t["mass"] if t else None,
        })
    return sum(ctx.decide(part, scored) for part, scored in parts.items() if scored)


def decide_finish(ctx, p, result, items, train, adapter_dir, cache_used, contract):
    """Sends the scores, then writes decide.json next to the adapter, uploads the adapter and returns the metrics.

    Every score the GPU has goes to the platform first, so a run that fails later still reports what it measured: with
    no adapter saved, the base scores, and the job fails; with the adapter saved but no tuned scores, the base scores
    and the adapter (uploaded), and the job fails. scoreOnly trains nothing, so it has no adapter and no decide.json.
    publish is 0 in decide mode, so publish_adapter only records why nothing went to the Hub.
    """
    base = result.get("base") or []
    tuned = result.get("tuned")
    ended = str(result.get("ended") or "exited with 0")
    tail = str(result.get("tail") or "")
    if len(base) != len(items):
        raise RuntimeError("The base model scored " + str(len(base)) + " of " + str(len(items)) + " decision items")
    tuned_ok = isinstance(tuned, list) and len(tuned) == len(items)
    ctx.progress(message="Sending the scores of " + str(len(items)) + " decision items")
    sent = decide_send(ctx, items, base, tuned if tuned_ok else None)
    metrics = dict(result.get("metrics") or {})
    metrics.update({
        "mode": DECIDE_MODE,
        "epochs": p["epochs"],
        "score_only": "yes" if p["score_only"] else "no",
        "cache_used": "yes" if cache_used else "no",
        "train_renderings": len(train),
        "dev_items": sum(1 for item in items if item["part"] == "dev"),
        "test_items": sum(1 for item in items if item["part"] == "test"),
        "decide_items": sent,
        "base_model": MODEL,
        "base_revision": MODEL_REVISION,
    })
    decide_health(metrics, "base_", base)
    decide_health(metrics, "", tuned if tuned_ok else base)
    dry = "Dry run: " if p["dry_run"] else ""
    if p["score_only"]:
        metrics["summary"] = dry + "Score only: base Muse Glimmer 30B scored " + str(sent) + " decision items, and nothing trained."
        return metrics
    if not result.get("adapter"):
        raise RuntimeError(
            "Training didn't finish (the child " + ended + "), so no adapter was saved. The base model's scores for "
            + str(sent) + " decision items were sent." + ("\n" + tail if tail else "")
        )
    metrics["adapter_dir"] = adapter_dir
    if isinstance(contract, dict):
        write_decide_json(adapter_dir, contract)
        metrics["decide_json"] = "yes"
    if not tuned_ok:
        reason = str(result.get("tuned_error") or "the child " + ended + " during them")[:300]
        upload_adapter(ctx, adapter_dir, metrics)
        kept = "uploaded" if metrics.get("adapter_uploaded") == "yes" else "kept in " + adapter_dir
        ctx.log("Training finished: " + json.dumps(metrics, ensure_ascii=False, default=str)[:3000])
        raise RuntimeError(
            "The adapter was saved (" + kept + "), but the tuned model's scores failed (" + reason + "), so only the base"
            + " model's " + str(sent) + " were sent"
        )
    upload_adapter(ctx, adapter_dir, metrics)
    publish_adapter(ctx, p, adapter_dir, metrics)
    loss = metrics.get("train_loss_final")
    steps = str(metrics.get("steps")) + " steps"
    if metrics.get("stopped_early") == "yes":
        steps = str(metrics.get("steps")) + " of " + str(metrics.get("max_steps")) + " steps (stopped early to finish within the time limit)"
    metrics["summary"] = (
        dry + "Decide mode: LoRA r=" + str(p["lora_rank"]) + " on Muse Glimmer 30B, " + str(metrics.get("renderings", len(train)))
        + " renderings in " + steps + (", final loss " + str(round(loss, 4)) if isinstance(loss, (int, float)) else "")
        + ", " + str(sent) + " decision items scored before and after training."
    )
    return metrics


def decide_run(ctx, p, started):
    """Decide mode's run(ctx): the decision dataset's training renderings (none for scoreOnly) and its dev and test
    items, trained on and scored by the child on the GPU (or faked for a dry run), then the scores sent and the adapter
    kept (decide_finish). The renderings keep the dataset's own system message, so student_setup isn't used."""
    ctx.progress(message="Fetching the decision dataset")
    train = [] if p["score_only"] else train_examples(ctx.dataset("train"))
    items = decide_items(ctx.dataset("dev"), "dev") + decide_items(ctx.dataset("eval"), "test")
    kind = getattr(ctx, "dataset_kind", None)
    if kind != "decision":
        raise RuntimeError("Decide mode trains on a decision dataset, but the dataset's pages say its kind is " + json.dumps(kind))
    if not p["score_only"] and not train:
        raise RuntimeError("The decision dataset has no usable training renderings")
    if not items:
        raise RuntimeError("The decision dataset has no dev or test items to score")
    systems = {item["messages"][0]["content"] for item in items}
    systems.update(row["messages"][0]["content"] if row["messages"][0]["role"] == "system" else None for row in train)
    if len(systems) != 1 or None in systems:
        raise RuntimeError("The decision dataset's renderings don't share one system message, so they can't be scored the way they train")
    system = next(iter(systems))
    contract = getattr(ctx, "dataset_decide", None)
    if not p["score_only"]:
        good = isinstance(contract, dict) and contract.get("format") == DECIDE_FORMAT and contract.get("system") == system
        if not good:
            raise RuntimeError("The dataset's pages carry no " + DECIDE_JSON + " for its renderings, so the adapter would have no contract")
    dev = sum(1 for item in items if item["part"] == "dev")
    ctx.log(
        "decision dataset " + p["dataset_id"] + ": " + str(len(train)) + " training renderings (" + str(p["epochs"])
        + " epochs, with any balancing copies), " + str(dev) + " dev and " + str(len(items) - dev) + " test items to score"
        + (". Score only: base Glimmer is scored and nothing trains" if p["score_only"] else "")
    )
    base, cache_used = base_dir(ctx)
    adapter_dir = os.path.join(base, "models", str(ctx.job_id or "job"))
    train_path = os.path.join(ctx.work_dir, "train.jsonl")
    eval_path = os.path.join(ctx.work_dir, "decide-items.jsonl")
    write_jsonl(train_path, train)
    write_jsonl(eval_path, items)
    if p["dry_run"]:
        result = decide_dry_run(ctx, p, items, train, adapter_dir)
        result["metrics"].update({"cached_weights": "no", "cached_venv": "no", "dry_run": "yes"})
    else:
        extra = {"mode": DECIDE_MODE, "score_only": p["score_only"]}
        result = real_run(ctx, p, base, train_path, eval_path, adapter_dir, started, system, extra)
    return decide_finish(ctx, p, result, items, train, adapter_dir, cache_used, contract)


# ---------------------------------------------------------------------------------------------------------------
# The child process: runs inside the venv, with the GPU. Sends MUSE_EVENT lines that the parent turns into progress.


def event_fd():
    """The runner's event pipe (MUSE_EVENT_FD), or None, when events go to stdout instead."""
    try:
        fd = int(os.environ.get("MUSE_EVENT_FD", ""))
        os.fstat(fd)
        return fd
    except (ValueError, OSError):
        return None


def emit(kind, **fields):
    fields["kind"] = kind
    line = EVENT_PREFIX + json.dumps(fields) + "\n"
    fd = event_fd()
    if fd is not None:
        try:
            os.write(fd, line.encode("utf-8"))
            return
        except OSError:
            pass
    sys.stdout.write(line)
    sys.stdout.flush()


def train_stop_time(deadline, base_seconds):
    """When training must stop so the adapter is saved and the tuned answers are done by the child's deadline."""
    return deadline - TUNED_PASS_FACTOR * max(0.0, base_seconds) - SAVE_RESERVE_SECONDS


class StopClock:
    """Says when training should stop: from stop_at on, after any step but the last."""

    def __init__(self, stop_at, clock=time.time):
        self.stop_at = stop_at
        self.clock = clock
        self.stopped_at = None

    def check(self, step, max_steps):
        if self.stopped_at is None and step < max_steps and self.clock() >= self.stop_at:
            self.stopped_at = int(step)
        return self.stopped_at is not None


def free_training_memory(trainer, torch):
    """Drops the optimizer state training held, so the tuned answers get the GPU memory back."""
    import gc

    for name in ("optimizer", "lr_scheduler"):
        try:
            setattr(trainer, name, None)
        except Exception:
            pass
    accelerator = getattr(trainer, "accelerator", None)
    if accelerator is not None and hasattr(accelerator, "free_memory"):
        try:
            accelerator.free_memory()
        except Exception:
            pass
    gc.collect()
    torch.cuda.empty_cache()


def clip(text, size):
    """text, or its start and its end with " [...] " between them when it is longer than size."""
    if len(text) <= size:
        return text
    head = size // 4
    return text[:head] + " [...] " + text[len(text) - (size - head):]


def strip_control(raw):
    """raw with only the chat template's control tokens taken out (each leaves a line break; padding leaves nothing)."""
    text = raw.replace(PAD_TOKEN, "")
    for token in CONTROL_TOKENS:
        text = text.replace(token, "\n")
    return text.strip()


def final_answer(raw):
    """(answer, finished) from a model's raw output to an eval prompt.

    The eval prompt opens the final channel, so the output starts on it and the answer runs to the first <|eot|>,
    <|eom|> or <|end_of_text|>. An output that never closes it before the token budget runs out or another message
    starts, or that closes it empty, is unfinished: the answer is then UNFINISHED and the raw output with only the
    template's control tokens taken out, so the judge sees both what the model wrote and that it never finished.
    """
    cut, end = len(raw), None
    for token in FINAL_ENDS + (NEXT_MESSAGE,):
        at = raw.find(token)
        if 0 <= at < cut:
            cut, end = at, token
    text = raw[:cut].replace(PAD_TOKEN, "").strip()
    if end in FINAL_ENDS and text:
        return text, True
    rest = strip_control(raw)
    return UNFINISHED + ("\n\n" + rest if rest else ""), False


def render(tokenizer, messages, generation, bos):
    """The conversation through the model's chat template at REASONING, without the template's <|begin_of_text|>: the
    tokenizer adds the one the model expects."""
    text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=REASONING
    )
    return text.removeprefix(bos) if bos else text


def training_text(tokenizer, messages, bos):
    """A training conversation as the trainer sees it. Its answers carry no reasoning_content, so the template writes no
    to=self message and each answer sits on the final channel right after RESPONSE_PART, as each prompt does after
    INSTRUCTION_PART. Raises when the rendered text doesn't have them, since train_on_responses_only looks for both."""
    text = render(tokenizer, messages, False, bos)
    for m in messages:
        marker = {"user": INSTRUCTION_PART, "assistant": RESPONSE_PART}.get(m["role"])
        if marker and marker + (m["content"].strip() if TRIM_CONTENT else m["content"]) not in text:
            raise RuntimeError(
                "The chat template didn't render this " + m["role"] + " message right after " + marker
                + ", so train_on_responses_only can't find it. The rendered text: " + clip(text, 600)
            )
    return text


def eval_prompt(tokenizer, messages, bos):
    """A held-out prompt as both models answer it: the template's generation prompt with the final channel opened, so it
    ends exactly as a training text does before its answer and the model answers at once, with no reasoning, the way the
    tuned model was trained."""
    text = render(tokenizer, messages, True, bos)
    if not text.endswith(GENERATION_PROMPT):
        raise RuntimeError("The chat template's generation prompt doesn't end with " + GENERATION_PROMPT + ": " + clip(text, 300))
    return text + FINAL_CHANNEL


def first_answer(messages):
    return next(m["content"] for m in messages if m["role"] == "assistant")


def trained_spans(labels):
    """The [start, end) runs of trained tokens: the labels that aren't -100."""
    spans, start = [], None
    for k, label in enumerate(labels):
        if label != -100 and start is None:
            start = k
        elif label == -100 and start is not None:
            spans.append((start, k))
            start = None
    if start is not None:
        spans.append((start, len(labels)))
    return spans


def check_masking(rows, answers, decode):
    """Checks what train_on_responses_only left to train, and returns each example's trained-token count.

    Every example must train on some tokens, and its first trained span must start with its first answer: otherwise the
    markers never matched, or matched the wrong text, and the run would train on nothing or on the prompts. Raises a
    clear error on the first example that fails.
    """
    if len(rows) != len(answers):
        raise RuntimeError("The trainer holds " + str(len(rows)) + " training examples, not the " + str(len(answers)) + " written")
    counts = []
    for i, row in enumerate(rows):
        ids, labels = list(row.get("input_ids") or []), row.get("labels")
        if labels is None:
            raise RuntimeError("train_on_responses_only left no labels on training example " + str(i))
        spans = trained_spans(list(labels))
        if not spans:
            raise RuntimeError(
                "Training example " + str(i) + " has no trained tokens after train_on_responses_only: " + RESPONSE_PART
                + " wasn't found in its " + str(len(ids)) + " tokens (at most " + str(MAX_SEQ_LENGTH) + " are kept)"
            )
        got = decode(ids[spans[0][0]:spans[0][1]]).strip()
        want = answers[i].strip()[:ANSWER_HEAD]
        if not got or not (got.startswith(want) or (len(got) < len(want) and want.startswith(got))):
            raise RuntimeError(
                "Training example " + str(i) + " trains on the wrong text: its first trained span starts "
                + json.dumps(got[:80], ensure_ascii=False) + ", not with its answer " + json.dumps(want, ensure_ascii=False)
            )
        counts.append(sum(end - start for start, end in spans))
    return counts


def marked_text(ids, labels, decode):
    """The example's text with each trained span between TRAIN_OPEN and TRAIN_CLOSE."""
    out, last = [], 0
    for start, end in trained_spans(labels):
        out.append(decode(ids[last:start]) + TRAIN_OPEN + decode(ids[start:end]) + TRAIN_CLOSE)
        last = end
    out.append(decode(ids[last:]))
    return "".join(out)


def example_diagnosis(row, decode):
    """The job log's line on the first training example: its trained-token count and its text, the span marked."""
    ids, labels = list(row["input_ids"]), list(row["labels"])
    trained = sum(1 for label in labels if label != -100)
    return (
        "First training example: " + str(trained) + " trained tokens of " + str(len(ids)) + ", between " + TRAIN_OPEN
        + " and " + TRAIN_CLOSE + ":\n" + clip(marked_text(ids, labels, decode), DIAGNOSIS_CHARS)
    )


def child_main(config_path):
    with open(config_path) as f:
        cfg = json.load(f)
    use_family(cfg.get("family"))
    if cfg.get("mode") == DECIDE_MODE:
        return decide_child(cfg)
    # Unsloth patches transformers and trl, so it is imported first, as in the notebook.
    from unsloth import FastModel
    import torch
    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer
    from unsloth.chat_templates import train_on_responses_only

    # The parent marks a reused venv broken only when the child failed before this.
    emit("imported")
    train_rows = read_jsonl(cfg["train_path"])
    eval_rows = read_jsonl(cfg["eval_path"])
    total = int(cfg["max_steps"])
    rank = int(cfg["lora_rank"])
    deadline = float(cfg.get("deadline") or 0) or None
    result = {"base": None, "tuned": None, "metrics": None, "adapter": False}

    emit("phase", message="Loading " + cfg["model"])
    targets = (FAMILIES.get(cfg.get("family")) or {}).get("targets")
    if cfg.get("family"):
        # use_exact_model_name: Unsloth otherwise swaps a repo for its own mirror and drops the pinned revision.
        loaded = dict(
            model_name=cfg.get("load_path") or cfg["model"],
            revision=None if cfg.get("load_path") else cfg.get("revision"),
            max_seq_length=cfg["max_seq_length"],
            use_exact_model_name=True,
            # A repo that isn't already 4-bit is quantized as it loads.
            load_in_4bit=not cfg.get("quantized"),
        )
        if targets:
            from unsloth import FastLanguageModel

            FastModel = FastLanguageModel
        model, tokenizer = FastModel.from_pretrained(**loaded)
    else:
        model, tokenizer = FastModel.from_pretrained(
            model_name=cfg["model"], revision=cfg.get("revision"), max_seq_length=cfg["max_seq_length"]
        )
    if targets:
        model = FastModel.get_peft_model(
            model,
            target_modules=targets,
            r=rank,
            lora_alpha=rank,
            lora_dropout=0,
            bias="none",
            use_gradient_checkpointing="unsloth",
            random_state=3407,
        )
    else:
        model = FastModel.get_peft_model(
            model,
            finetune_vision_layers=False,
            finetune_language_layers=True,
            finetune_attention_modules=True,
            finetune_mlp_modules=True,
            r=rank,
            lora_alpha=rank,
            lora_dropout=0,
            bias="none",
            use_gradient_checkpointing="unsloth",
            random_state=3407,
        )
    # FastModel hands back a processor; plain strings go through its text tokenizer.
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""

    def decode(ids):
        return text_tokenizer.decode(ids, skip_special_tokens=False)

    # Rendered before any answer, so a template without the markers fails the job before it pays for the eval pass.
    texts = [training_text(tokenizer, row["messages"], bos) for row in train_rows]

    def answer_all(label):
        """(answers, unfinished) for the eval prompts, on the final channel as in training. Item 0's raw output goes to
        the job log."""
        if hasattr(FastModel, "for_inference"):
            FastModel.for_inference(model)
        text_tokenizer.padding_side = "left"
        if text_tokenizer.pad_token is None:
            text_tokenizer.pad_token = text_tokenizer.eos_token
        head = [{"role": "system", "content": cfg["system"]}] if cfg.get("system") else []
        prompts = [eval_prompt(tokenizer, head + [{"role": "user", "content": r["prompt"]}], bos) for r in eval_rows]
        answers, unfinished = [], 0
        for start in range(0, len(prompts), GEN_BATCH):
            enc = text_tokenizer(prompts[start:start + GEN_BATCH], return_tensors="pt", padding=True)
            input_ids = enc["input_ids"].to("cuda")
            attention_mask = enc["attention_mask"].to("cuda")
            with torch.no_grad():
                out = model.generate(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=MAX_NEW_TOKENS,
                    do_sample=False,
                    pad_token_id=text_tokenizer.pad_token_id,
                )
            width = input_ids.shape[1]
            for row in out:
                raw = decode(row[width:])
                if not answers:
                    emit("log", text=label + " model's raw output for eval item 0 (first " + str(RAW_CHARS) + " characters): " + raw.replace(PAD_TOKEN, "")[:RAW_CHARS])
                answer, finished = final_answer(raw)
                answers.append(answer)
                unfinished += 0 if finished else 1
            emit("phase", message=label + " answers: " + str(len(answers)) + " of " + str(len(prompts)))
        return answers, unfinished

    # A fresh LoRA adds zero (its B matrices start at zero), so these are the base model's answers. They are written
    # at once, so a run cut short later still reports what it got.
    began = time.time()
    result["base"], base_unfinished = answer_all("Base")
    base_seconds = time.time() - began
    write_result(cfg["result_path"], result)

    if hasattr(FastModel, "for_training"):
        FastModel.for_training(model)
    dataset = Dataset.from_list([{"text": text} for text in texts])

    class Progress(TrainerCallback):
        def __init__(self):
            self.loss = None
            self.sent = 0

        def on_log(self, args, state, control, logs=None, **kwargs):
            if logs and isinstance(logs.get("loss"), (int, float)):
                self.loss = float(logs["loss"])
            step = int(state.global_step or 0)
            if step and step != self.sent and (step % PROGRESS_EVERY == 0 or step >= state.max_steps):
                self.sent = step
                emit("progress", step=step, total=state.max_steps, loss=self.loss)

    # Training stops early when the clock says so, leaving time to save the adapter and answer with the tuned model.
    stop = StopClock(train_stop_time(deadline, base_seconds)) if deadline else None

    class Deadline(TrainerCallback):
        def on_step_end(self, args, state, control, **kwargs):
            if stop is not None and stop.check(int(state.global_step or 0), int(state.max_steps or total)):
                control.should_training_stop = True
            return control

    progress = Progress()
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        eval_dataset=None,
        args=SFTConfig(
            dataset_text_field="text",
            max_length=cfg["max_seq_length"],
            # Gradient accumulation invariant, as the notebook explains.
            loss_type="nll",
            per_device_train_batch_size=1,
            gradient_accumulation_steps=4,
            warmup_steps=5,
            max_steps=total,
            learning_rate=float(cfg["learning_rate"]),
            logging_steps=1,
            optim="adamw_8bit",
            weight_decay=0.001,
            lr_scheduler_type="linear",
            seed=3407,
            output_dir=cfg["output_dir"],
            save_strategy="no",
            report_to="none",
        ),
    )
    trainer = train_on_responses_only(trainer, instruction_part=INSTRUCTION_PART, response_part=RESPONSE_PART)
    # The masks as the trainer will use them: the first example goes to the job log before the check, so a failed
    # check shows what was trained.
    examples = [trainer.train_dataset[i] for i in range(len(trainer.train_dataset))]
    if examples and examples[0].get("labels") is not None:
        emit("log", text=example_diagnosis(examples[0], decode))
    trained = check_masking(examples, [first_answer(row["messages"]) for row in train_rows], decode)
    trainer.add_callback(progress)
    trainer.add_callback(Deadline())
    emit("phase", message="Training for " + str(total) + " steps")
    stats = trainer.train()
    steps = int(trainer.state.global_step or 0)
    stopped_early = stop is not None and stop.stopped_at is not None
    if stopped_early:
        if progress.sent != steps:
            emit("progress", step=steps, total=total, loss=progress.loss)
        emit("phase", message="Training stopped at step " + str(steps) + " of " + str(total) + " to finish within the time limit")

    loss = progress.loss if progress.loss is not None else getattr(stats, "training_loss", None)
    metrics = {
        "train_loss_final": round(float(loss), 4) if loss is not None else "unknown",
        "steps": steps,
        "max_steps": total,
        "stopped_early": "yes" if stopped_early else "no",
        "train_seconds": round(float(stats.metrics.get("train_runtime", 0)), 1),
        "base_answer_seconds": round(base_seconds, 1),
        "base_unfinished": base_unfinished,
        "trained_tokens_min": min(trained),
        "trained_tokens_mean": round(sum(trained) / len(trained), 1),
        "max_new_tokens": MAX_NEW_TOKENS,
        "peak_vram_gb": round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2),
        "gpu": torch.cuda.get_device_name(0),
    }
    # The adapter is saved before the tuned answers, so a failure there doesn't lose the training.
    os.makedirs(cfg["adapter_dir"], exist_ok=True)
    model.save_pretrained(cfg["adapter_dir"])
    tokenizer.save_pretrained(cfg["adapter_dir"])
    # PEFT leaves "revision" empty: the base model's pinned commit goes in, so the adapter loads from the Hugging Face Hub
    # onto the weights it was trained on. A failure is only logged, since the adapter itself is saved.
    try:
        fix_adapter_config(os.path.join(cfg["adapter_dir"], ADAPTER_CONFIG), cfg.get("revision"), cfg["model"])
    except (OSError, ValueError) as e:
        emit("log", text="The base model's revision couldn't be written into " + ADAPTER_CONFIG + ": " + type(e).__name__ + ": " + str(e)[:300])
    result["metrics"] = metrics
    result["adapter"] = True
    write_result(cfg["result_path"], result)
    emit("phase", message="Adapter saved")

    free_training_memory(trainer, torch)
    try:
        result["tuned"], metrics["tuned_unfinished"] = answer_all("Tuned")
    except Exception as e:
        result["tuned_error"] = type(e).__name__ + ": " + str(e)[:300]
        emit("phase", message="The tuned answers failed: " + result["tuned_error"])
    metrics["peak_vram_gb"] = round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2)
    write_result(cfg["result_path"], result)


# ---------------------------------------------------------------------------------------------------------------
# Decide mode in the child: every letter one token, the prompts scored from the first answer token, the renderings
# trained on their letters.


def letter_token_ids(tok):
    """{letter: its token ids}: the bare letter's token and the space-led one (one id when they are the same), so a
    letter's probability is both of theirs. Raises when either isn't a single token: the first answer token couldn't
    hold that letter then, and the job fails before it pays for anything."""
    out = {}
    for letter in DECIDE_LETTERS:
        ids = []
        for text in (letter, " " + letter):
            got = list(tok.encode(text, add_special_tokens=False))
            if len(got) != 1:
                raise RuntimeError(
                    "The tokenizer makes " + json.dumps(text) + " " + str(len(got)) + " tokens, not one, so its probability"
                    + " can't be read from the first answer token"
                )
            if got[0] not in ids:
                ids.append(got[0])
        out[letter] = ids
    return out


def log_sum_exp(values):
    """log(sum(exp(v))) of a few log-probabilities, -Infinity when they all are."""
    top = max(values)
    if top == -math.inf:
        return -math.inf
    return top + math.log(sum(math.exp(v - top) for v in values))


def letter_scores(row, ids, letters, letter_ids, top):
    """One prompt's scores from its first-token log-probabilities (row[k] is token ids[k]'s): each shown letter's
    log-probability, its tokens' summed and at least DECIDE_LOGPROB_FLOOR; the letter mass, their share of all the
    probability; and whether the top token was a shown letter. None when a number can't be a log-probability (NaN or
    +Infinity: a model that broke), so the item isn't sent."""
    if any(math.isnan(v) or v == math.inf for v in row):
        return None
    by_id = dict(zip(ids, row))
    logprobs, shown = [], set()
    for letter in letters:
        shown.update(letter_ids[letter])
        logprobs.append(max(DECIDE_LOGPROB_FLOOR, log_sum_exp([by_id[t] for t in letter_ids[letter]])))
    return {"logprobs": logprobs, "mass": sum(math.exp(l) for l in logprobs), "top": top in shown}


def forward_logits(model, torch, input_ids, attention_mask, positions, keep):
    """A forward pass's logits: the last position's only (logits_to_keep=1), or every position's from the first time
    the model refuses that argument on. keep holds which, across calls."""
    args = {"input_ids": input_ids, "attention_mask": attention_mask, "position_ids": positions, "use_cache": False}
    with torch.no_grad():
        if keep["last"]:
            try:
                return model(logits_to_keep=1, **args).logits
            except TypeError as e:
                if "logits_to_keep" not in str(e):
                    raise
                keep["last"] = False
                emit("log", text="The model doesn't take logits_to_keep (" + str(e)[:200] + "), so every position's logits are computed, one prompt a pass")
                # The caller sends this batch again one prompt at a time: 8 prompts of 2,048 tokens over the whole
                # vocabulary would be about 6.6 GB of logits next to the model.
                return None
        return model(**args).logits


def score_all(FastModel, model, tok, torch, prompts, items, letter_ids, label):
    """Each prompt's scores (letter_scores), None for one left out as too long. One forward pass a prompt,
    DECIDE_SCORE_BATCH at a time, left padded, with position ids counted from the attention mask so padding moves
    nothing; the logits at the last position go through log_softmax in float32 (bf16 can err by enough to look like
    more than all the probability) over the whole vocabulary, so there is no top-k limit. Unsloth's forward returns
    logits only when asked (UNSLOTH_RETURN_LOGITS, set for the pass and put back after, so training doesn't keep them)."""
    if hasattr(FastModel, "for_inference"):
        FastModel.for_inference(model)
    padding_side = getattr(tok, "padding_side", None)
    tok.padding_side = "left"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    flat = sorted({t for ids in letter_ids.values() for t in ids})
    todo = [i for i, prompt in enumerate(prompts) if prompt is not None]
    out = [None] * len(prompts)
    saved = os.environ.get("UNSLOTH_RETURN_LOGITS")
    os.environ["UNSLOTH_RETURN_LOGITS"] = "1"
    keep = {"last": True}
    try:
        every = DECIDE_PROGRESS_BATCHES * DECIDE_SCORE_BATCH
        start = 0
        while start < len(todo):
            # One prompt a pass once the model computes every position's logits (forward_logits).
            batch = todo[start:start + (DECIDE_SCORE_BATCH if keep["last"] else 1)]
            enc = tok([prompts[i] for i in batch], return_tensors="pt", padding=True)
            input_ids = enc["input_ids"].to("cuda")
            attention_mask = enc["attention_mask"].to("cuda")
            positions = (attention_mask.cumsum(-1) - 1).clamp(min=0)
            logits = forward_logits(model, torch, input_ids, attention_mask, positions, keep)
            if logits is None:
                continue
            shape = tuple(logits.shape)
            if len(shape) != 3 or shape[0] != len(batch) or shape[-1] <= flat[-1]:
                raise RuntimeError("The model's forward pass gave logits of shape " + str(shape) + ", not a row of the vocabulary for each prompt")
            logp = torch.log_softmax(logits[:, -1, :].float(), dim=-1)
            picked = logp[:, flat].tolist()
            tops = logp.argmax(dim=-1).tolist()
            for k, i in enumerate(batch):
                out[i] = letter_scores(picked[k], flat, items[i]["letters"], letter_ids, tops[k])
            done = start + len(batch)
            if done // every != start // every or done == len(todo):
                emit("phase", message=label + " scores: " + str(done) + " of " + str(len(todo)))
            start = done
    finally:
        # Put back as found: training pads its batches of 16 on the right, with no position ids from a mask.
        if padding_side is not None:
            tok.padding_side = padding_side
        if saved is None:
            os.environ.pop("UNSLOTH_RETURN_LOGITS", None)
        else:
            os.environ["UNSLOTH_RETURN_LOGITS"] = saved
    return out


def decide_prompts(tokenizer, text_tokenizer, items, bos):
    """(prompts, too_long): each item's prompt as both models score it (eval_prompt: the final channel open, so the next
    token is the answer), or None for one whose rendering would pass MAX_SEQ_LENGTH tokens (DECIDE_EXTRA_TOKENS)."""
    prompts, too_long = [], 0
    for item in items:
        text = eval_prompt(tokenizer, item["messages"], bos)
        if len(text_tokenizer.encode(text, add_special_tokens=False)) + DECIDE_EXTRA_TOKENS > MAX_SEQ_LENGTH:
            prompts.append(None)
            too_long += 1
        else:
            prompts.append(text)
    return prompts, too_long


def decide_training_texts(tokenizer, text_tokenizer, rows, bos):
    """(texts, rows, dropped): the training renderings as the trainer sees them (training_text) and the rows they came
    from, without the ones over MAX_SEQ_LENGTH tokens with the tokenizer's <|begin_of_text|>, which are counted."""
    texts, kept, dropped = [], [], 0
    for row in rows:
        text = training_text(tokenizer, row["messages"], bos)
        if len(text_tokenizer.encode(text, add_special_tokens=False)) + 1 > MAX_SEQ_LENGTH:
            dropped += 1
            continue
        texts.append(text)
        kept.append(row)
    return texts, kept, dropped


def decide_callbacks(TrainerCallback, stop, total):
    """(progress, deadline): the trainer's callbacks in decide mode, as child_main's are. progress sends a progress event
    every PROGRESS_EVERY steps and keeps the last loss; deadline stops training when stop (a StopClock, or None) says."""

    class Progress(TrainerCallback):
        def __init__(self):
            self.loss = None
            self.sent = 0

        def on_log(self, args, state, control, logs=None, **kwargs):
            if logs and isinstance(logs.get("loss"), (int, float)):
                self.loss = float(logs["loss"])
            step = int(state.global_step or 0)
            if step and step != self.sent and (step % PROGRESS_EVERY == 0 or step >= state.max_steps):
                self.sent = step
                emit("progress", step=step, total=state.max_steps, loss=self.loss)

    class Deadline(TrainerCallback):
        def on_step_end(self, args, state, control, **kwargs):
            if stop is not None and stop.check(int(state.global_step or 0), int(state.max_steps or total)):
                control.should_training_stop = True
            return control

    return Progress(), Deadline()


def decide_train_args(SFTConfig, cfg, total):
    """Decide training's SFTConfig and whether it groups by length. It is made before the base pass, so a config this
    Unsloth refuses fails before scoring is paid for. group_by_length only orders batches by length to pad less:
    Unsloth's patched config took it for the knowledge run's A100 runs, but transformers 5 dropped it, so a config that
    refuses it trains without it, logged."""
    args = {
        "dataset_text_field": "text",
        "max_length": cfg["max_seq_length"],
        "loss_type": "nll",
        "per_device_train_batch_size": DECIDE_TRAIN_BATCH,
        "gradient_accumulation_steps": DECIDE_GRAD_ACCUM,
        "warmup_steps": 5,
        "max_steps": total,
        "learning_rate": float(cfg["learning_rate"]),
        "logging_steps": 1,
        "optim": "adamw_8bit",
        "weight_decay": 0.001,
        "lr_scheduler_type": "linear",
        "seed": 3407,
        "output_dir": cfg["output_dir"],
        "save_strategy": "no",
        "report_to": "none",
    }
    try:
        return SFTConfig(group_by_length=True, **args), True
    except TypeError as e:
        if "group_by_length" not in str(e):
            raise
        emit("log", text="This SFTConfig doesn't take group_by_length (" + str(e)[:200] + "), so batches aren't grouped by length")
        return SFTConfig(**args), False


def decide_child(cfg):
    """The child in decide mode (docs/DECISION_MODELS.md, "The GPU side"). Loads the model and scores the dev and test
    items with the base (a fresh LoRA adds zero), writing those scores at once; then trains on the renderings, whose
    trained span is the answer's letter and <|eot|> (checked as for chat), 32 renderings a step; saves the adapter; and
    scores the same items with the tuned model. scoreOnly loads the base, scores and stops: no LoRA, no adapter."""
    from unsloth import FastModel
    import torch
    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer
    from unsloth.chat_templates import train_on_responses_only

    emit("imported")
    items = read_jsonl(cfg["eval_path"])
    train_rows = read_jsonl(cfg["train_path"])
    score_only = bool(cfg.get("score_only"))
    rank = int(cfg["lora_rank"])
    deadline = float(cfg.get("deadline") or 0) or None
    result = {"mode": DECIDE_MODE, "base": None, "tuned": None, "metrics": None, "adapter": False}

    emit("phase", message="Loading " + cfg["model"])
    model, tokenizer = FastModel.from_pretrained(
        model_name=cfg["model"], revision=cfg.get("revision"), max_seq_length=cfg["max_seq_length"]
    )
    if not score_only:
        model = FastModel.get_peft_model(
            model,
            finetune_vision_layers=False,
            finetune_language_layers=True,
            finetune_attention_modules=True,
            finetune_mlp_modules=True,
            r=rank,
            lora_alpha=rank,
            lora_dropout=0,
            bias="none",
            use_gradient_checkpointing="unsloth",
            random_state=3407,
        )
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""

    def decode(ids):
        return text_tokenizer.decode(ids, skip_special_tokens=False)

    # All checked before the base pass, so a tokenizer or a template that can't work fails before scoring is paid for.
    letter_ids = letter_token_ids(text_tokenizer)
    prompts, too_long = decide_prompts(tokenizer, text_tokenizer, items, bos)
    texts, kept, train_too_long = ([], [], 0) if score_only else decide_training_texts(tokenizer, text_tokenizer, train_rows, bos)
    if not score_only and not texts:
        raise RuntimeError("Every training rendering is over " + str(MAX_SEQ_LENGTH) + " tokens, so nothing can train")
    total = 0 if score_only else decide_steps(len(texts))
    metrics = {
        "renderings": len(texts), "train_too_long": train_too_long, "too_long": too_long, "steps": total,
        "max_steps": total, "gpu": torch.cuda.get_device_name(0),
    }
    train_args = None
    if not score_only:
        train_args, grouped = decide_train_args(SFTConfig, cfg, total)
        metrics["group_by_length"] = "yes" if grouped else "no"

    began = time.time()
    result["base"] = score_all(FastModel, model, text_tokenizer, torch, prompts, items, letter_ids, "Base")
    base_seconds = time.time() - began
    metrics["base_score_seconds"] = round(base_seconds, 1)
    metrics["unusable_scores"] = sum(1 for prompt, s in zip(prompts, result["base"]) if prompt is not None and s is None)
    metrics["peak_vram_gb"] = round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2)
    result["metrics"] = metrics
    write_result(cfg["result_path"], result)
    if score_only:
        emit("phase", message="Base scores written. Score only, so nothing trains")
        return

    if hasattr(FastModel, "for_training"):
        FastModel.for_training(model)
    # Batches of 16 pad on the right for training, whatever scoring left it as.
    text_tokenizer.padding_side = "right"
    dataset = Dataset.from_list([{"text": text} for text in texts])
    # Training stops early when the clock says so, leaving time to save the adapter and score with the tuned model.
    stop = StopClock(train_stop_time(deadline, base_seconds)) if deadline else None
    progress, deadline_stop = decide_callbacks(TrainerCallback, stop, total)
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        eval_dataset=None,
        args=train_args,
    )
    trainer = train_on_responses_only(trainer, instruction_part=INSTRUCTION_PART, response_part=RESPONSE_PART)
    examples = [trainer.train_dataset[i] for i in range(len(trainer.train_dataset))]
    if examples and examples[0].get("labels") is not None:
        emit("log", text=example_diagnosis(examples[0], decode))
    trained = check_masking(examples, [first_answer(row["messages"]) for row in kept], decode)
    trainer.add_callback(progress)
    trainer.add_callback(deadline_stop)
    emit("phase", message="Training on " + str(len(texts)) + " renderings for " + str(total) + " steps")
    stats = trainer.train()
    steps = int(trainer.state.global_step or 0)
    stopped_early = stop is not None and stop.stopped_at is not None
    if stopped_early:
        if progress.sent != steps:
            emit("progress", step=steps, total=total, loss=progress.loss)
        emit("phase", message="Training stopped at step " + str(steps) + " of " + str(total) + " to finish within the time limit")
    loss = progress.loss if progress.loss is not None else getattr(stats, "training_loss", None)
    metrics.update({
        "train_loss_final": round(float(loss), 4) if loss is not None else "unknown",
        "steps": steps,
        "stopped_early": "yes" if stopped_early else "no",
        "train_seconds": round(float(stats.metrics.get("train_runtime", 0)), 1),
        "trained_tokens_min": min(trained),
        "trained_tokens_mean": round(sum(trained) / len(trained), 1),
        "peak_vram_gb": round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2),
    })
    # The adapter is saved before the tuned pass, so a failure there doesn't lose the training.
    os.makedirs(cfg["adapter_dir"], exist_ok=True)
    model.save_pretrained(cfg["adapter_dir"])
    tokenizer.save_pretrained(cfg["adapter_dir"])
    try:
        fix_adapter_config(os.path.join(cfg["adapter_dir"], ADAPTER_CONFIG), cfg.get("revision"), cfg["model"])
    except (OSError, ValueError) as e:
        emit("log", text="The base model's revision couldn't be written into " + ADAPTER_CONFIG + ": " + type(e).__name__ + ": " + str(e)[:300])
    result["adapter"] = True
    write_result(cfg["result_path"], result)
    emit("phase", message="Adapter saved")

    free_training_memory(trainer, torch)
    try:
        began = time.time()
        result["tuned"] = score_all(FastModel, model, text_tokenizer, torch, prompts, items, letter_ids, "Tuned")
        metrics["tuned_score_seconds"] = round(time.time() - began, 1)
    except Exception as e:
        result["tuned_error"] = type(e).__name__ + ": " + str(e)[:300]
        emit("phase", message="The tuned scores failed: " + result["tuned_error"])
    metrics["peak_vram_gb"] = round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2)
    write_result(cfg["result_path"], result)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        child_main(sys.argv[2])
    else:
        sys.stderr.write("usage: recipe.py --child config.json\n")
        sys.exit(2)
`;
