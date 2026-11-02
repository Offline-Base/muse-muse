#!/usr/bin/env python3
"""
Writes notebooks/edge-tune-kaggle.ipynb from the cells below, so the notebook stays reviewable as plain Python.

  python3 -I notebooks/build_notebook.py          writes the notebook
  python3 -I notebooks/build_notebook.py --check  exits 1 when the committed notebook differs from what this writes

Edit the cells here, not in the .ipynb. notebooks/test_edge_tune_notebook.py checks that the two match, that every
code cell parses, and runs the scoring cell against a small fake answers file with no model.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "edge-tune-kaggle.ipynb")

CELLS = []


def md(cell_id, text):
    CELLS.append({"cell_type": "markdown", "id": cell_id, "metadata": {}, "source": text.strip("\n")})


def code(cell_id, tag, text):
    CELLS.append({"cell_type": "code", "id": cell_id, "metadata": {"tags": [tag]}, "source": text.strip("\n")})


md("intro", r"""
# Cold-room watch: tune Llama 3.2 3B on a free T4

This notebook tunes `unsloth/Llama-3.2-3B-Instruct-bnb-4bit` with QLoRA (rank 16) on the Simulated cold-room drill set,
scores the base and the tuned model on the 100 sealed held-out rows with drill-bench's own scorer, and exports the merged
model as a Q4_K_M GGUF with its sha256.

- **Data:** Simulated cold-room log windows, invented by `scripts/dev/drill-bench.py` from a fixed seed. No model wrote
  any row. Nothing here is about a real freezer or store, and nothing here is food-safety advice.
- **Hardware:** one T4 (16 GB). On Kaggle pick "GPU T4 x2"; the notebook uses the first card only. fp16 throughout,
  since the T4 has no bf16.
- **Status:** written and checked without a GPU (every cell parses, and the scoring cell runs on fake answers). It has
  not run on a GPU yet, so the times in `notebooks/README.md` are estimates.
- **License:** Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright (c) Meta Platforms, Inc. All
  Rights Reserved. Built with Llama. Use is subject to the Llama 3.2 Acceptable Use Policy.
- **Safety:** no keys or tokens live in this notebook. Hugging Face upload is off by default and reads `HF_TOKEN` from
  Kaggle Secrets (or Colab's secrets) only when turned on. Nothing here opens a tunnel or a public endpoint.

Run the cells in order. The scoring cell needs no GPU and no model, so after a restart it can be rerun from the saved
answer files once the settings and helpers cells have run.
""")

code("config", "config", r"""
# Settings. Change these here, then run every cell below in order.
import os

# Kaggle's 2x T4: train on one card. Set before torch is imported, and set outright: with two cards visible the
# Trainer wraps the model in DataParallel, which a 4-bit Unsloth model doesn't run under.
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL_ID = "unsloth/Llama-3.2-3B-Instruct-bnb-4bit"  # ungated, so no Hugging Face token is needed to download it
LORA_RANK = 16
EPOCHS = 2  # 900 rows x 2 = about 225 steps of 8 rows. 1 roughly halves the training time
LEARNING_RATE = 2e-4
BATCH_SIZE = 2
GRAD_ACCUM = 4
MAX_SEQ_LENGTH = 2048  # the longest training row is about 3,500 characters, well under this
MAX_NEW_TOKENS = 200  # the same cap drill-bench ask uses (--max-tokens 200)
# Llama 3.2's chat template writes "Today Date: ..." in the system turn. Pinned so training and scoring render the
# same text on any day. llama-server --jinja fills in its own date there, the one difference on a board (without
# --jinja, llama.cpp's built-in llama3 template drops the date lines altogether; notebooks/README.md).
DATE_STRING = "26 Jul 2024"
SCORE_LIMIT = 0  # 0 answers all 100 sealed rows; a small number gives a quick smoke run (not a score to report)

# "repo": the pins docs/TRAINING.md records for the repo's Lambda tunes, torch included (cu128 wheels).
# "keep-torch": the same pins for everything else, holding the image's own torch. Use it if the repo set fails.
PIN_SET = "repo"

EXPORT_GGUF = True
GGUF_NAME = "Llama-3.2-3B-ColdRoom-Watch-Q4_K_M"  # a Llama derivative's name starts with "Llama"

# Off by default. When True, the token is read from Kaggle Secrets (or Colab's secrets) as HF_TOKEN, never typed here.
PUSH_TO_HF = False
HF_REPO = ""  # for example "OfflineBase/Llama-3.2-3B-ColdRoom-Watch-GGUF", once the owner decides (docs/EDGE_PLAN.md O5)
HF_PRIVATE = True

# Where the data and outputs live. DATA_DIR None searches /kaggle/input, then DRILL_DATA, then /content/drill.
DATA_DIR = os.environ.get("DRILL_DATA") or None
ON_KAGGLE = os.path.isdir("/kaggle/working")
OUT_DIR = "/kaggle/working" if ON_KAGGLE else os.path.abspath("edge-tune-out")
GGUF_DIR = "/tmp/edge-gguf"  # the 16-bit merge and f16 GGUF are big; only the Q4_K_M file is copied to OUT_DIR
os.makedirs(OUT_DIR, exist_ok=True)
ANSWER_FILES = {"base": os.path.join(OUT_DIR, "answers-base.jsonl"), "tuned": os.path.join(OUT_DIR, "answers-tuned.jsonl")}
SETTINGS = {
    "model": MODEL_ID, "lora_rank": LORA_RANK, "lora_alpha": LORA_RANK, "epochs": EPOCHS, "learning_rate": LEARNING_RATE,
    "batch_size": BATCH_SIZE, "grad_accum": GRAD_ACCUM, "max_seq_length": MAX_SEQ_LENGTH, "max_new_tokens": MAX_NEW_TOKENS,
    "temperature": 0, "precision": "fp16", "date_string": DATE_STRING, "pin_set": PIN_SET,
}
RUN_FACTS = {}
print("outputs go to", OUT_DIR)
""")

md("install-md", r"""
## Install

Pinned to the set docs/TRAINING.md records for the repo's Lambda tunes (resolved Oct 27, 2026 for Python 3.12 on x86_64
Linux). That set has not run on a T4 or on Kaggle's image yet. If the install or the GPU check below fails, set
`PIN_SET = "keep-torch"` in the settings and rerun from the top; if that fails too, see "If the install fails" in
`notebooks/README.md`. After the torch step, every later step holds the installed torch with a pip constraint, so a
package that wants another torch fails here instead of swapping it. The cell skips whatever is already at the pinned
version, and it never imports torch, so a fresh
torch loads in the next cell. If torch was already imported in this session, restart and run from the top.
""")

code("install", "install", r"""
import importlib.metadata as md
import json
import subprocess
import sys

TORCH = ["torch==2.11.0+cu128", "torchvision==0.26.0+cu128", "torchaudio==2.11.0+cu128", "xformers==0.0.35"]
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
STEPS = [
    ["unsloth==2026.10.9", "unsloth_zoo==2026.10.9", "peft==0.21.2", "accelerate==1.15.0", "bitsandbytes==0.50.2", "datasets==4.8.5"],
    ["--no-deps", "torchao==0.18.0"],
    ["transformers==5.15.0"],
    ["--no-deps", "trl==0.22.2"],
]


def have(spec):
    name, _, want = spec.partition("==")
    try:
        return md.version(name) == want
    except md.PackageNotFoundError:
        return False


def pip(args, constraints=None):
    cmd = [sys.executable, "-m", "pip", "install", "-q"] + (["-c", constraints] if constraints else []) + args
    print("pip install", " ".join(args))
    subprocess.run(cmd, check=True)


def hold_torch():
    # A pip constraint on the torch now installed, so no later step swaps it for a PyPI build. A step that needs another
    # torch then fails loudly instead.
    held = []
    for name in ("torch", "torchvision", "torchaudio"):
        try:
            held.append(name + "==" + md.version(name))
        except md.PackageNotFoundError:
            pass
    if not held or not held[0].startswith("torch=="):
        raise RuntimeError("No torch installed. Use PIN_SET = 'repo', or an image that has torch.")
    path = os.path.join(OUT_DIR, "torch-constraints.txt")
    with open(path, "w") as f:
        f.write("\n".join(held) + "\n")
    print("holding", ", ".join(held))
    return path


if PIN_SET == "repo":
    if not all(have(s) for s in TORCH):
        pip(TORCH + ["--index-url", TORCH_INDEX])
elif PIN_SET != "keep-torch":
    raise ValueError("PIN_SET is 'repo' or 'keep-torch', not " + repr(PIN_SET))
constraints = hold_torch()
for step in STEPS:
    specs = [s for s in step if not s.startswith("--")]
    if not all(have(s) for s in specs):
        pip(step, constraints)

VERSIONS = {}
for name in ("torch", "xformers", "unsloth", "unsloth_zoo", "transformers", "trl", "peft", "accelerate", "bitsandbytes", "datasets", "huggingface_hub"):
    try:
        VERSIONS[name] = md.version(name)
    except md.PackageNotFoundError:
        VERSIONS[name] = None
VERSIONS["python"] = sys.version.split()[0]
RUN_FACTS["versions"] = VERSIONS
with open(os.path.join(OUT_DIR, "versions.json"), "w") as f:
    json.dump(VERSIONS, f, indent=1)
print(json.dumps(VERSIONS, indent=1))
""")

md("helpers-md", r"""
## Helpers: data, seal check and scoring

Plain Python with no GPU. The sealed file must hash to the value drill-bench pins, and this notebook pins the same value,
so a changed set or a changed script stops the run before anything is scored. Training rows must carry drill-bench's
`SYSTEM` line verbatim, so training and scoring see the same rules (the `folder/` drop has no system line, so it is not
used here).
""")

code("helpers", "helpers", r"""
import hashlib
import importlib.util
import json
import os
import sys

# The hashes `drill-bench.py make` printed for the defaults (seed 1104) at commit e4beadc1 (eval/drill/README.md).
SEALED_SHA256 = "52b23493d1f832aebf717829469091ded8029b77fc82b517544746c94346f3dd"
TRAIN_SHA256 = "0fb64c3cb5058d54811c2134dc4c6cd67b656c681a8d0075406b9532e1f26238"
DEV_SHA256 = "90653359d9ec97340421f29a317c71165429248a6c18363ba16817274f512915"
SCRIPT_SHA256 = "ed3672b5bba9ddfa07e4ebed06eac9ed1c3b976e766b0e250896dcb3842e2499"
DATA_FILES = ("drill-bench.py", "sealed.jsonl", "train.jsonl", "dev.jsonl")
LABELS = {"base": "Llama 3.2 3B base", "tuned": "Llama 3.2 3B tuned"}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def find_data_dir(given=None):
    # The folder holding drill-bench.py and sealed.jsonl: the one named (and only it), else the first found.
    if given:
        if os.path.isfile(os.path.join(given, "drill-bench.py")) and os.path.isfile(os.path.join(given, "sealed.jsonl")):
            return given
        raise FileNotFoundError("DATA_DIR " + given + " has no drill-bench.py and sealed.jsonl")
    candidates = []
    if os.environ.get("DRILL_DATA"):
        candidates.append(os.environ["DRILL_DATA"])
    if os.path.isdir("/kaggle/input"):
        for root, dirs, files in os.walk("/kaggle/input"):
            if root.count(os.sep) - "/kaggle/input".count(os.sep) >= 4:
                dirs[:] = []
            if "drill-bench.py" in files and "sealed.jsonl" in files:
                candidates.append(root)
    candidates += ["/content/drill", os.path.abspath("drill")]
    for c in candidates:
        if c and os.path.isfile(os.path.join(c, "drill-bench.py")) and os.path.isfile(os.path.join(c, "sealed.jsonl")):
            return c
    raise FileNotFoundError(
        "No folder with drill-bench.py and sealed.jsonl. Add the dataset as an input (notebooks/README.md, step 2), or set DATA_DIR."
    )


def load_drill(data_dir):
    # drill-bench.py as a module: its SYSTEM line, parse_answer and scorer are the ones `ask` and `score` use.
    path = os.path.join(data_dir, "drill-bench.py")
    got = sha256_file(path)
    if got != SCRIPT_SHA256:
        print("note: drill-bench.py sha256 " + got + " is not the one this notebook was written against (" + SCRIPT_SHA256 + "). The seal check below still decides.")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("drill_bench", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_jsonl(path):
    with open(path, encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def read_sealed(data_dir, drill):
    # The 100 sealed rows, only when the file is the sealed set: its hash must match this notebook's pin and the script's.
    path = os.path.join(data_dir, "sealed.jsonl")
    got = sha256_file(path)
    if drill.SEALED_SHA256 != SEALED_SHA256:
        raise RuntimeError("drill-bench.py pins the sealed set as " + drill.SEALED_SHA256 + ", this notebook as " + SEALED_SHA256 + ". Use the script and data from the same commit.")
    if got != SEALED_SHA256:
        raise RuntimeError("sealed.jsonl sha256 " + got + " is not the sealed set's " + SEALED_SHA256 + ". Remake it with drill-bench.py make, unchanged.")
    rows = read_jsonl(path)
    if len(rows) != drill.SEALED_N or not all(r.get("simulated") is True for r in rows):
        raise RuntimeError("sealed.jsonl should hold " + str(drill.SEALED_N) + " Simulated rows, not " + str(len(rows)))
    return rows


def check_hash(path, want, name):
    got = sha256_file(path)
    if got != want:
        print("note: " + name + " sha256 " + got + " differs from " + want + " (eval/drill/README.md). It is used as is.")
    return got


def check_train_rows(rows, drill):
    # Every training row is system, user, assistant, with drill-bench's SYSTEM line verbatim.
    for i, row in enumerate(rows):
        msgs = row.get("messages")
        roles = [m.get("role") for m in msgs] if isinstance(msgs, list) else None
        if roles != ["system", "user", "assistant"]:
            raise RuntimeError("Training row " + str(i) + " is not {messages: system, user, assistant}; got " + repr(roles) + ". Use train.jsonl, not folder/.")
        if msgs[0]["content"] != drill.SYSTEM:
            raise RuntimeError("Training row " + str(i) + "'s system line is not drill-bench's SYSTEM, so training and scoring would differ.")
        if drill.parse_answer(msgs[2]["content"]) is None:
            raise RuntimeError("Training row " + str(i) + "'s answer is not a JSON object")
    return len(rows)


def dev_messages(row, drill):
    return [{"role": "system", "content": drill.SYSTEM}, {"role": "user", "content": row["prompt"]}, {"role": "assistant", "content": row["reference"]}]


def score_runs(drill, held, runs):
    # Each run graded by drill-bench's own `graded` (missing rows count as no answer), plus ask's error and cut-off counts.
    out = {}
    for name, answers in runs.items():
        report = drill.graded(held, answers)
        by_id = {a["id"]: a for a in answers}
        report["answered"] = sum(1 for h in held if h["id"] in by_id)
        report["errors"] = sum(1 for a in answers if str(a.get("finish") or "").startswith("error"))
        report["cut_off"] = sum(1 for a in answers if a.get("finish") == "length")
        report["label"] = LABELS.get(name, name)
        out[name] = report
    return out


def fmt(v):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.3f}"
    return str(v)


def format_table(scores):
    names = list(scores)
    rows = [("valid JSON", lambda r: r["valid_json"]), ("all five right", lambda r: r["all_right"])]
    rows += [(f, (lambda f: lambda r: r["per_field"][f])(f)) for f in ("status", "trust_controller", "likely_cause", "actions", "escalate")]
    rows += [
        ("actions overlap", lambda r: r["actions_jaccard"]),
        ("hard rule violations", lambda r: f"{r['hard_rule']['violations']} of {r['hard_rule']['rows']}"),
        ("hard rule", lambda r: "pass" if r["hard_rule"]["passed"] else "FAIL"),
        ("answered", lambda r: f"{r['answered']} of {r['items']}"),
        ("cut off", lambda r: r["cut_off"]),
        ("median seconds", lambda r: r["median_seconds"]),
        ("tokens a second", lambda r: r["tokens_per_second"]),
    ]
    cases = list(next(iter(scores.values()))["by_case"])
    width = max([len(n) for n, _ in rows] + [len(c) for c in cases] + [len("all five right, by cause")]) + 2
    col = max([12] + [len(scores[n]["label"]) + 2 for n in names])
    lines = ["Simulated cold-room drill, " + str(next(iter(scores.values()))["items"]) + " sealed rows, temperature 0, scored by drill-bench", ""]
    lines.append("".ljust(width) + "".join(scores[n]["label"].rjust(col) for n in names))
    for title, get in rows:
        lines.append(title.ljust(width) + "".join(fmt(get(scores[n])).rjust(col) for n in names))
    lines.append("")
    lines.append("hard rule: " + next(iter(scores.values()))["hard_rule"]["rule"])
    lines.append("")
    lines.append("all five right, by cause".ljust(width) + "".join(scores[n]["label"].rjust(col) for n in names))
    for case in sorted(next(iter(scores.values()))["by_case"]):
        cells = []
        for n in names:
            c = scores[n]["by_case"].get(case)
            cells.append((f"{c['all_right']} of {c['items']}" if c else "-").rjust(col))
        lines.append(case.ljust(width) + "".join(cells))
    return "\n".join(lines)


def write_scores(path, scores, held_sha, settings, facts):
    doc = {
        "simulated": True,
        "what": "Simulated cold-room drill: base and tuned answers on the 100 sealed rows, scored by drill-bench's scorer",
        "sealed_sha256": held_sha,
        "settings": settings,
        "run": facts,
        "scores": scores,
        "limits": "The right answer follows from written rules, so a few lines of code score 100%. This measures whether a small model applies the rules to log layouts it never saw in training, not judgment. The GGUF file is not scored here.",
    }
    with open(path, "w", encoding="utf8") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    return doc


print("helpers ready")
""")

code("data", "data", r"""
DATA_DIR = find_data_dir(DATA_DIR)
drill = load_drill(DATA_DIR)
held = read_sealed(DATA_DIR, drill)
RUN_FACTS["data_dir"] = DATA_DIR
RUN_FACTS["train_sha256"] = check_hash(os.path.join(DATA_DIR, "train.jsonl"), TRAIN_SHA256, "train.jsonl")
RUN_FACTS["dev_sha256"] = check_hash(os.path.join(DATA_DIR, "dev.jsonl"), DEV_SHA256, "dev.jsonl")
train_rows = read_jsonl(os.path.join(DATA_DIR, "train.jsonl"))
dev_rows = read_jsonl(os.path.join(DATA_DIR, "dev.jsonl"))
check_train_rows(train_rows, drill)
leaked = {r["prompt"] for r in held} & {r["messages"][1]["content"] for r in train_rows}
if leaked:
    raise RuntimeError(str(len(leaked)) + " sealed prompts are in train.jsonl")
if SCORE_LIMIT:
    held_run = held[:SCORE_LIMIT]
    print("SCORE_LIMIT is", SCORE_LIMIT, "so only a smoke run: don't report its score")
else:
    held_run = held
print(len(train_rows), "training rows,", len(dev_rows), "kept-aside rows,", len(held), "sealed rows (sha256 checked), all Simulated")
""")

md("model-md", r"""
## Load the model

4-bit base, fp16 compute, LoRA rank 16 on the attention and MLP layers. A fresh LoRA adds nothing (its B matrices start
at zero), so the answers taken right after this cell are the base model's. Prompts go through the model's own chat
template with drill-bench's SYSTEM line, the same messages `drill-bench.py ask` sends; the GGUF export carries the same
template.
""")

code("model", "model", r"""
import time

import unsloth  # noqa: F401  (Unsloth patches transformers when imported first)
import torch
from unsloth import FastLanguageModel

installed_torch = RUN_FACTS.get("versions", {}).get("torch")
if installed_torch and str(torch.__version__) != installed_torch:
    raise RuntimeError("torch " + str(torch.__version__) + " is loaded but " + installed_torch + " is installed. Restart the session and run from the top.")
if not torch.cuda.is_available():
    raise RuntimeError("No GPU. On Kaggle: Settings, Accelerator, GPU T4 x2. On Colab: Runtime, Change runtime type, T4 GPU.")
if torch.cuda.device_count() != 1:
    raise RuntimeError(str(torch.cuda.device_count()) + " GPUs are visible, not 1. Restart the session and run from the top, so the settings cell sets CUDA_VISIBLE_DEVICES first.")
cap = torch.cuda.get_device_capability(0)
if f"sm_{cap[0]}{cap[1]}" not in torch.cuda.get_arch_list():
    raise RuntimeError(f"This torch build has no kernels for sm_{cap[0]}{cap[1]}. Set PIN_SET = 'keep-torch' and rerun from the top.")
RUN_FACTS["gpu"] = torch.cuda.get_device_name(0)
print("GPU:", RUN_FACTS["gpu"], "bf16 supported:", torch.cuda.is_bf16_supported(), "(fp16 is used either way)")

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL_ID, max_seq_length=MAX_SEQ_LENGTH, dtype=torch.float16, load_in_4bit=True
)
model = FastLanguageModel.get_peft_model(
    model,
    r=LORA_RANK,
    lora_alpha=LORA_RANK,
    lora_dropout=0,
    bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
    random_state=3407,
)

INSTRUCTION_PART = "<|start_header_id|>user<|end_header_id|>\n\n"
RESPONSE_PART = "<|start_header_id|>assistant<|end_header_id|>\n\n"
BOS = tokenizer.bos_token or ""
BOS_ID = tokenizer.bos_token_id
STOP_IDS = sorted({i for i in (tokenizer.eos_token_id, tokenizer.convert_tokens_to_ids("<|eot_id|>"), tokenizer.convert_tokens_to_ids("<|eom_id|>")) if isinstance(i, int) and i >= 0})
PAD_ID = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else STOP_IDS[0]


def render(messages, generation):
    # The chat template's text without its <|begin_of_text|>: the tokenizer adds the one BOS the model expects.
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=generation, date_string=DATE_STRING)
    return text.removeprefix(BOS) if BOS else text


def ask_messages(prompt):
    # What drill-bench.py ask sends: the SYSTEM line, then the window.
    return [{"role": "system", "content": drill.SYSTEM}, {"role": "user", "content": prompt}]


def training_text(messages):
    text = render(messages, False)
    if drill.SYSTEM not in text:
        raise RuntimeError("The chat template dropped or changed the SYSTEM line: " + text[:400])
    for m in messages[1:]:
        marker = INSTRUCTION_PART if m["role"] == "user" else RESPONSE_PART
        if marker + m["content"].strip() not in text:
            raise RuntimeError("The template didn't put the " + m["role"] + " turn right after " + repr(marker) + ": " + text[:400])
    return text


probe = render(ask_messages(held[0]["prompt"]), True)
if not probe.endswith(RESPONSE_PART):
    raise RuntimeError("The generation prompt doesn't end with the assistant header: " + probe[-200:])
first = tokenizer(probe, add_special_tokens=True)["input_ids"]
if first[0] != BOS_ID or first[1] == BOS_ID:
    raise RuntimeError("Expected exactly one BOS at the start of a prompt")
print("rendered prompt head:\n" + probe[:300])
print("prompt tokens for sealed row 0:", len(first), "| stop ids:", STOP_IDS)


def answer_all(name, rows):
    # One prompt at a time (no padding, which once changed scores here, docs/BUILD_LOG.md Nov 1), greedy, at most
    # MAX_NEW_TOKENS. Each row is written as it comes, in drill-bench ask's answer format.
    FastLanguageModel.for_inference(model)
    path = ANSWER_FILES[name]
    out = []
    with open(path, "w", encoding="utf8", newline="\n") as f:
        for k, item in enumerate(rows):
            enc = tokenizer(render(ask_messages(item["prompt"]), True), return_tensors="pt", add_special_tokens=True).to("cuda")
            width = enc["input_ids"].shape[1]
            if width + MAX_NEW_TOKENS > MAX_SEQ_LENGTH:
                raise RuntimeError(item["id"] + " needs " + str(width) + " prompt tokens, too many for MAX_SEQ_LENGTH")
            start = time.time()
            with torch.no_grad():
                gen = model.generate(**enc, max_new_tokens=MAX_NEW_TOKENS, do_sample=False, eos_token_id=STOP_IDS, pad_token_id=PAD_ID, use_cache=True)
            seconds = time.time() - start
            new = gen[0, width:].tolist()
            raw = tokenizer.decode(new, skip_special_tokens=True)
            row = {"id": item["id"], "raw": raw, "finish": "stop" if new and new[-1] in STOP_IDS else "length", "seconds": seconds, "completion_tokens": len(new), "answer": drill.parse_answer(raw)}
            out.append(row)
            f.write(json.dumps(row, sort_keys=True) + "\n")
            f.flush()
            if k == 0 or (k + 1) % 20 == 0:
                print(name, k + 1, "of", len(rows), f"{seconds:.1f}s", raw[:120].replace("\n", " "))
    return out
""")

code("base-answers", "base-answers", r"""
began = time.time()
base_answers = answer_all("base", held_run)
RUN_FACTS["base_answer_seconds"] = round(time.time() - began, 1)
print("base answers:", len(base_answers), "in", RUN_FACTS["base_answer_seconds"], "s")
""")

md("train-md", r"""
## Train

QLoRA on the 900 training rows, trained only on the answers (`train_on_responses_only`). The 50 kept-aside rows give an
eval loss after each epoch. fp16, 8-bit AdamW, batch 2 with 4 accumulation steps, linear schedule. A check after the
masks are made fails the run if any row would train on nothing, or on the wrong text.
""")

code("train", "train", r"""
from datasets import Dataset
from trl import SFTConfig, SFTTrainer
from unsloth.chat_templates import train_on_responses_only

FastLanguageModel.for_training(model)
tokenizer.padding_side = "right"
train_texts = [training_text(r["messages"]) for r in train_rows]
dev_texts = [training_text(dev_messages(r, drill)) for r in dev_rows]
longest = max(len(tokenizer(t)["input_ids"]) for t in train_texts)
print("longest training row:", longest, "tokens")
if longest > MAX_SEQ_LENGTH:
    raise RuntimeError("A training row is longer than MAX_SEQ_LENGTH and would be cut")

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=Dataset.from_list([{"text": t} for t in train_texts]),
    eval_dataset=Dataset.from_list([{"text": t} for t in dev_texts]),
    args=SFTConfig(
        dataset_text_field="text",
        max_length=MAX_SEQ_LENGTH,
        per_device_train_batch_size=BATCH_SIZE,
        per_device_eval_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        num_train_epochs=EPOCHS,
        warmup_steps=10,
        learning_rate=LEARNING_RATE,
        fp16=True,
        bf16=False,
        logging_steps=10,
        eval_strategy="epoch",
        optim="adamw_8bit",
        weight_decay=0.001,
        lr_scheduler_type="linear",
        seed=3407,
        output_dir="/tmp/edge-tune-trainer",
        save_strategy="no",
        report_to="none",
    ),
)
trainer = train_on_responses_only(trainer, instruction_part=INSTRUCTION_PART, response_part=RESPONSE_PART)

# Mask check: one BOS, and each row's first trained span starts with its own answer.
ds = trainer.train_dataset
if len(ds) != len(train_rows):
    raise RuntimeError("The trainer holds " + str(len(ds)) + " rows, not " + str(len(train_rows)))
ids0 = list(ds[0]["input_ids"])
if ids0[0] != BOS_ID or ids0[1] == BOS_ID:
    raise RuntimeError("Training rows should start with exactly one BOS")
for i in range(len(ds)):
    labels = list(ds[i]["labels"])
    start = next((k for k, v in enumerate(labels) if v != -100), None)
    if start is None:
        raise RuntimeError("Training row " + str(i) + " trains on nothing")
    end = next((k for k in range(start, len(labels)) if labels[k] == -100), len(labels))
    got = tokenizer.decode(list(ds[i]["input_ids"])[start:end], skip_special_tokens=True).strip()
    want = train_rows[i]["messages"][2]["content"].strip()[:40]
    if not got.startswith(want):
        raise RuntimeError("Training row " + str(i) + " trains on " + repr(got[:60]) + ", not its answer " + repr(want))
print("masks checked on", len(ds), "rows")

began = time.time()
stats = trainer.train()
RUN_FACTS["train_seconds"] = round(time.time() - began, 1)
RUN_FACTS["train_steps"] = int(stats.global_step)
RUN_FACTS["train_loss"] = round(float(stats.training_loss), 4)
RUN_FACTS["eval_loss"] = [round(float(e["eval_loss"]), 4) for e in trainer.state.log_history if "eval_loss" in e]
RUN_FACTS["peak_gpu_gb"] = round(torch.cuda.max_memory_reserved() / 1e9, 2)
model.save_pretrained(os.path.join(OUT_DIR, "adapter"))
tokenizer.save_pretrained(os.path.join(OUT_DIR, "adapter"))
print(json.dumps({k: RUN_FACTS[k] for k in ("train_seconds", "train_steps", "train_loss", "eval_loss", "peak_gpu_gb")}, indent=1))
""")

code("tuned-answers", "tuned-answers", r"""
began = time.time()
tuned_answers = answer_all("tuned", held_run)
RUN_FACTS["tuned_answer_seconds"] = round(time.time() - began, 1)
print("tuned answers:", len(tuned_answers), "in", RUN_FACTS["tuned_answer_seconds"], "s")
""")

md("score-md", r"""
## Score

Needs no GPU and no model: it reads the answer files, checks the sealed file's hash again and grades with drill-bench's
scorer, the same one `drill-bench.py score` runs. Writes `scores.json`. The hard rule is reported on its own line: when
the controller and the probe differ by more than 3.0 C on any reading, `trust_controller` must be false.
""")

code("score", "score", r"""
DATA_DIR = find_data_dir(DATA_DIR)
drill = load_drill(DATA_DIR)
held = read_sealed(DATA_DIR, drill)
runs = {name: read_jsonl(path) for name, path in ANSWER_FILES.items() if os.path.isfile(path)}
if not runs:
    raise RuntimeError("No answer files yet in " + OUT_DIR)
scores = score_runs(drill, held, runs)
print(format_table(scores))
SCORES_DOC = write_scores(os.path.join(OUT_DIR, "scores.json"), scores, sha256_file(os.path.join(DATA_DIR, "sealed.jsonl")), SETTINGS, globals().get("RUN_FACTS", {}))
print("\nwrote", os.path.join(OUT_DIR, "scores.json"))
""")

md("export-md", r"""
## Export the GGUF

Merges the LoRA into the 16-bit weights and writes a Q4_K_M GGUF with Unsloth's `save_pretrained_gguf`, which builds
llama.cpp on the machine (a few minutes) and needs about 15 GB free where `GGUF_DIR` lives. Only the Q4_K_M file, its
sha256 line and the license files go to the outputs. The GGUF is a different quantization from the 4-bit model scored
above, so it is scored again where it is served (`drill-bench.py ask` on the board, docs/EDGE_PLAN.md H4).
""")

code("export", "export", r"""
import glob
import shutil
import urllib.request

if EXPORT_GGUF:
    os.makedirs(GGUF_DIR, exist_ok=True)
    for where in (GGUF_DIR, OUT_DIR):
        print(where, "free GB:", round(shutil.disk_usage(where).free / 1e9, 1))
    if shutil.disk_usage(GGUF_DIR).free < 15e9:
        raise RuntimeError("Less than 15 GB free for the merge; point GGUF_DIR at a bigger disk")
    model.save_pretrained_gguf(GGUF_DIR, tokenizer, quantization_method="q4_k_m")
    # Where Unsloth puts the file has moved between versions: inside GGUF_DIR, a sibling like GGUF_DIR_gguf, or beside it.
    made = set(glob.glob(GGUF_DIR + "*/**/*.gguf", recursive=True) + glob.glob(GGUF_DIR + "*.gguf"))
    found = sorted(p for p in made if "q4_k_m" in os.path.basename(p).lower())
    if len(found) != 1:
        raise RuntimeError("Expected one Q4_K_M file, found " + repr(found))
    GGUF_PATH = os.path.join(OUT_DIR, GGUF_NAME + ".gguf")
    shutil.copyfile(found[0], GGUF_PATH)
    GGUF_SHA256 = sha256_file(GGUF_PATH)
    with open(GGUF_PATH + ".sha256", "w") as f:
        f.write(GGUF_SHA256 + "  " + os.path.basename(GGUF_PATH) + "\n")
    print(os.path.basename(GGUF_PATH), round(os.path.getsize(GGUF_PATH) / 1e9, 2), "GB, sha256", GGUF_SHA256)

    # The license travels with the file: Meta's text from the base repo, else from meta-llama/llama-models on GitHub.
    from huggingface_hub import hf_hub_download

    # A file is kept only when it reads as Meta's Llama 3.2 text, so a repo's own LICENSE (Apache, MIT) is never
    # passed off as the Llama license.
    def llama_text(path, must):
        with open(path, encoding="utf8", errors="replace") as f:
            head = f.read(8000).lower()
        return "llama 3.2" in head and must in head

    LICENSE_FILES = {
        "LICENSE.txt": (["LICENSE.txt", "LICENSE"], "LICENSE", "community license"),
        "USE_POLICY.md": (["USE_POLICY.md"], "USE_POLICY.md", "acceptable use policy"),
    }
    GITHUB = "https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama3_2/"
    for dest, (names, github_name, must) in LICENSE_FILES.items():
        got = None
        for name in names:
            try:
                path = hf_hub_download(MODEL_ID, name)
            except Exception:
                continue
            if llama_text(path, must):
                got = (path, MODEL_ID)
                break
        if got is None:
            try:
                path = os.path.join(GGUF_DIR, "github-" + github_name)
                urllib.request.urlretrieve(GITHUB + github_name, path)
                if llama_text(path, must):
                    got = (path, "meta-llama/llama-models on GitHub")
            except Exception as err:
                print("GitHub fetch of", github_name, "failed:", type(err).__name__)
        if got is None:
            print("Couldn't fetch Meta's Llama 3.2", dest + ". Add it by hand before sharing the file.")
            continue
        shutil.copyfile(got[0], os.path.join(OUT_DIR, dest))
        print("license file:", dest, "from", got[1])
else:
    print("EXPORT_GGUF is off")
""")

code("card", "card", r"""
# A short card for the file, from this run's own numbers. Not a claim beyond what ran here.
if EXPORT_GGUF:
    s = SCORES_DOC["scores"]
    line = lambda n: f"| {s[n]['label']} | {s[n]['all_right']:.3f} | {s[n]['hard_rule']['violations']} of {s[n]['hard_rule']['rows']} | {s[n]['valid_json']:.3f} |"
    card = "\n".join([
        "# " + GGUF_NAME,
        "",
        "Built with Llama. A Q4_K_M GGUF of Llama 3.2 3B Instruct with a QLoRA tune (rank 16) for one Simulated task: read a cold-room log window and answer with one JSON verdict.",
        "",
        "- Base: " + MODEL_ID + ". Tuned in a notebook on " + RUN_FACTS.get("gpu", "a GPU") + ", " + str(RUN_FACTS.get("train_steps")) + " steps.",
        "- Data: Simulated cold-room windows invented by code (scripts/dev/drill-bench.py, seed 1104). No model wrote any row. Nothing is about a real freezer or store.",
        "- sha256: " + GGUF_SHA256,
        "",
        "## Sealed held-out score (100 Simulated rows, temperature 0, before the GGUF conversion)",
        "",
        "| Model | All five right | Hard rule violations | Valid JSON |",
        "|---|---|---|---|",
        *[line(n) for n in s],
        "",
        "The GGUF itself was not scored in the notebook; score it where it is served with drill-bench.py ask.",
        "",
        "## Limits",
        "",
        "- The right answer follows from written rules, so a few lines of code score 100%. The set checks whether a small model applies the rules to log layouts it never saw.",
        "- Not food-safety advice. Its actions only point to the site's own people and procedure.",
        "- Answers are written by a model. Check them before relying on them.",
        "",
        "## License",
        "",
        "Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright (c) Meta Platforms, Inc. All Rights Reserved. Use is subject to the Llama 3.2 Acceptable Use Policy (USE_POLICY.md). A copy of the license (LICENSE.txt) goes with every copy of this file.",
    ])
    with open(os.path.join(OUT_DIR, "MODEL_CARD.md"), "w", encoding="utf8") as f:
        f.write(card + "\n")
    print(card)
""")

md("push-md", r"""
## Optional: upload to Hugging Face (off by default)

Only when `PUSH_TO_HF = True` and `HF_REPO` is set. The token comes from Kaggle Secrets (Add-ons, Secrets, `HF_TOKEN`)
or Colab's secrets panel, is never printed and is dropped after the upload. The repo is made private unless
`HF_PRIVATE = False`; whether it goes public is the owner's call (docs/EDGE_PLAN.md O5).
""")

code("push", "push", r"""
def read_secret(name):
    try:
        from kaggle_secrets import UserSecretsClient

        return UserSecretsClient().get_secret(name)
    except Exception:
        pass
    try:
        from google.colab import userdata

        return userdata.get(name)
    except Exception:
        return None


if PUSH_TO_HF:
    if not HF_REPO or not EXPORT_GGUF:
        raise RuntimeError("Set HF_REPO and keep EXPORT_GGUF on to upload")
    from huggingface_hub import HfApi

    token = read_secret("HF_TOKEN")
    if not token:
        raise RuntimeError("No HF_TOKEN secret. Add it in Kaggle Secrets (or Colab's secrets); never paste it into a cell.")
    api = HfApi(token=token)
    api.create_repo(HF_REPO, repo_type="model", private=HF_PRIVATE, exist_ok=True)
    uploads = [GGUF_PATH, GGUF_PATH + ".sha256", os.path.join(OUT_DIR, "scores.json")]
    uploads += [os.path.join(OUT_DIR, n) for n in ("LICENSE.txt", "USE_POLICY.md") if os.path.isfile(os.path.join(OUT_DIR, n))]
    for path in uploads:
        api.upload_file(path_or_fileobj=path, path_in_repo=os.path.basename(path), repo_id=HF_REPO, repo_type="model")
    api.upload_file(path_or_fileobj=os.path.join(OUT_DIR, "MODEL_CARD.md"), path_in_repo="README.md", repo_id=HF_REPO, repo_type="model")
    del token, api
    print("uploaded", len(uploads) + 1, "files to", HF_REPO, "(private)" if HF_PRIVATE else "(public)")
else:
    print("PUSH_TO_HF is off. Download the outputs from the notebook's Output tab instead.")
""")

md("done-md", r"""
## Outputs

In `OUT_DIR` (`/kaggle/working` on Kaggle): `answers-base.jsonl`, `answers-tuned.jsonl`, `scores.json`, `versions.json`,
`adapter/`, and with the export on, `Llama-3.2-3B-ColdRoom-Watch-Q4_K_M.gguf`, its `.sha256`, `MODEL_CARD.md`,
`LICENSE.txt` and `USE_POLICY.md`. Hand the file's address and the sha256 line to whoever serves it with
`gguf-serve.sh --model-url`, then score it there with `drill-bench.py ask`. Every number here is on Simulated data.
""")


def notebook():
    return {
        "cells": [
            {**c, "source": c["source"].splitlines(keepends=True), **({"execution_count": None, "outputs": []} if c["cell_type"] == "code" else {})}
            for c in CELLS
        ],
        "metadata": {
            "accelerator": "GPU",
            "colab": {"gpuType": "T4", "provenance": []},
            "kaggle": {"accelerator": "nvidiaTeslaT4", "dataSources": [], "isGpuEnabled": True, "isInternetEnabled": True, "language": "python", "sourceType": "notebook"},
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def render_text():
    return json.dumps(notebook(), indent=1, ensure_ascii=False) + "\n"


def main(argv):
    text = render_text()
    if "--check" in argv:
        with open(OUT, encoding="utf8") as f:
            same = f.read() == text
        print("in sync" if same else "edge-tune-kaggle.ipynb differs from build_notebook.py; run it to rewrite")
        return 0 if same else 1
    with open(OUT, "w", encoding="utf8", newline="\n") as f:
        f.write(text)
    print("wrote", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
