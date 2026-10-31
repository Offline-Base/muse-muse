"""The Jetson student of the 2026 knowledge fine-tune (docs/KNOWLEDGE_UPDATE.md, Jetson): NVIDIA Nemotron 3.5 Bolt E4B
(OpenMDW-1.1, built on Gemma 4 E4B, Apache 2.0), the model the fleet already serves, taught the Glimmer-only set.

Lineage: the training file is the student set (assemble-dataset.ts --writers muse-glimmer-30b,muse-glimmer-q4
--no-anchors, checked by check_student_lineage.py): Glimmer-written Q&A, base Glimmer's replay answers and the cutoff
templates. Never Spark Open's pairs, the anchors or tuned Glimmer's answers, so the student stays permissive.

Like train_glimmer.py, whose grading (answered() and normalize()) is imported, not copied: answer the held-out probes and
the old-fact checks with the base model, train a LoRA with Unsloth (loss on responses only), answer them again with the
tuned model, and write metrics.json and answers.json with train_glimmer's keys (probe_by_writer.py reads them as is),
plus probe_split: the fixed 1,500 against the new 1,000, and probes whose passage the training set covers against the
rest. Then rank 0 merges the LoRA into the BF16 weights (`train_student.py merge`, on CPU) for student_gguf.sh.

Chat format: the student's own chat_template.jinja (the template its GGUF embeds, so llama-server --jinja and the fleet
see what training saw), thinking off (enable_thinking=False), the system line "You are a helpful assistant.":
    <bos><|turn>system\\nYou are a helpful assistant.<turn|>\\n<|turn>user\\nQ<turn|>\\n<|turn>model\\nA<turn|>\\n
The <bos> text is dropped only when the tokenizer adds BOS itself, so every sequence holds exactly one. Bolt's tokenizer
in transformers 5.15 doesn't (add_bos_token is false), so here, unlike train_glimmer.py, the template's <bos> stays
and is the sequence's BOS; stripping it as Glimmer's recipe does would leave none. The loss covers what follows
"<|turn>model\\n" up to the next "<|turn>user\\n" (the answer and its <turn|>), as Unsloth's train_on_responses_only
computes it. Before training, its labels on the first examples are checked against this file's own response_labels()
and against the decoded answers, and the run stops if they differ (test_student.py checks the same on a Mac, CPU only).

Several GPUs: `torchrun --standalone --nproc_per_node N train_student.py` (run_student.sh), the way train_glimmer.py
runs on muse-knowledge-train-1. Each GPU holds the whole model; batch_size is per GPU, and grad_accum 0 picks the
accumulation that makes the effective batch 32. Rank 0 alone answers the probes, saves and merges; the other ranks wait
for its base answers. Without torchrun it runs on one GPU.

Settings: the flags below, or the environment: KNOWLEDGE_DATA, KNOWLEDGE_OUT, KNOWLEDGE_CKPT and KNOWLEDGE_HYPER as in
train_glimmer.py; STUDENT_PROFILE (bolt, gemma4-e4b or qwen3.5-4b), STUDENT_MODEL (a repo id or a local folder),
STUDENT_MODEL_REVISION, STUDENT_4BIT=1 (QLoRA, for GPUs under 40 GB), STUDENT_ADAPTER (where the adapter is saved;
OUT/adapter by default), STUDENT_MERGED (where rank 0 merges; nothing is merged without it). Hyperparameters come
from the KNOWLEDGE_HYPER JSON file, then the flags: epochs, learning_rate, lora_rank, lora_alpha, batch_size,
grad_accum, eval_probes (0 is all), max_examples, save_steps, tuned_eval, base_only, group_by_length, merge,
max_start_loss (0 turns that check off) and masking (unsloth, or own: this file's labels).

    python train_student.py [--train F] [--probes F] [--forget F] [--fixed-probes F] [--out D] [--ckpt D] [--adapter D]
                            [--merged D] [--max-examples N] [--epochs E] [--eval-probes N]
    python train_student.py merge --base MODEL_DIR --adapter OUT/adapter --merged DIR [--report F] [--no-shared-kv]
    python train_student.py download     the student's weights at the pinned revision, anonymously; prints the folder
"""

import argparse
import collections
import hashlib
import json
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_glimmer import MAX_NEW_TOKENS, SYSTEM, answered, every_rank, read_jsonl, say, write_json  # noqa: E402

# Gemma 4's chat format. Answers end at <turn|> (id 106) or <eos> (1); generation also stops at <|tool_response>
# (50), as the model's generation_config does. A reply can open with a thinking block, <|channel>thought ... <channel|>.
GEMMA4 = {"instruction": "<|turn>user\n", "response": "<|turn>model\n", "turn_end": "<turn|>\n",
          "ends": ("<turn|>", "<eos>", "<|turn>", "<|tool_response>"), "think": ("<|channel>", "<channel|>"), "pad": "<pad>",
          "gemma4": True}
PROFILES = {
    # The pick: the fleet serves this architecture and template on jetson-03 and jetson-04 (gguf-serve.sh, b11574).
    "bolt": {**GEMMA4, "model": "nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16", "revision": "49843eed8db1f1c616c47af75cfd36e07aec0667",
             "license": "OpenMDW-1.1 (base google/gemma-4-E4B-it, Apache 2.0)"},
    # The same class, config and rendered template from Google, if a problem turns out to be Bolt's own.
    "gemma4-e4b": {**GEMMA4, "model": "google/gemma-4-E4B-it", "revision": "ee0ef6023621cff504d758262d4e04895a5af4a2",
                   "license": "Apache 2.0"},
    # The fallback on another architecture. Not smoke-tested: it needs flash-linear-attention and causal-conv1d in the
    # venv, or its 24 gated-delta-net layers run slow torch loops. Thinking off puts an empty think block before the
    # answer, in the generation prompt and in the training text alike, so the block is part of the response marker.
    "qwen3.5-4b": {"model": "Qwen/Qwen3.5-4B", "revision": "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a", "license": "Apache 2.0",
                   "instruction": "<|im_start|>user\n", "response": "<|im_start|>assistant\n<think>\n\n</think>\n\n",
                   "turn_end": "<|im_end|>\n", "ends": ("<|im_end|>", "<|endoftext|>", "<|im_start|>"),
                   "think": ("<think>", "</think>"), "pad": "<|endoftext|>", "gemma4": False},
}
PROFILE_NAME = os.environ.get("STUDENT_PROFILE", "bolt")
PROFILE = PROFILES[PROFILE_NAME]
MODEL = os.environ.get("STUDENT_MODEL", PROFILE["model"])
MODEL_REVISION = os.environ.get("STUDENT_MODEL_REVISION", PROFILE["revision"])
LOAD_IN_4BIT = os.environ.get("STUDENT_4BIT", "0") == "1"
GRAD_CKPT = {"true": True, "false": False}.get(os.environ.get("KNOWLEDGE_GRAD_CKPT", "unsloth"), "unsloth")
# Files the weights download needs (the repo also holds a PNG and a GIF for its card).
WEIGHT_PATTERNS = ["*.json", "*.jinja", "*.md", "*.safetensors", "*.txt", "*.model", "LICENSE*"]
# Bolt's k_proj, v_proj and k_norm for the KV-shared layers 24 to 41: transformers drops them on load, so they are
# never trained; merge() copies the file back so the GGUF has NVIDIA's tensor set.
SHARED_KV_FILE = "model-frozen-shared-kv.safetensors"
MAX_SEQ_LENGTH = 2048
GEN_BATCH = 64
TARGET_BATCH = 32
FIXED_N = 1500
DATA = os.environ.get("KNOWLEDGE_DATA", "data")
OUT = os.environ.get("KNOWLEDGE_OUT", "out")
CKPT = os.environ.get("KNOWLEDGE_CKPT", os.path.join(os.path.dirname(os.path.abspath(OUT)), "ckpt"))
HYPER = os.environ.get("KNOWLEDGE_HYPER", "")
MERGED = os.environ.get("STUDENT_MERGED", "")
ADAPTER = os.environ.get("STUDENT_ADAPTER", "")
WORLD = int(os.environ.get("WORLD_SIZE", "1"))
RANK = int(os.environ.get("RANK", "0"))
LOCAL_RANK = int(os.environ.get("LOCAL_RANK", "0"))
MAIN = RANK == 0

# Knowledge absorption at about 4B. Rank 128 on every language projection: the rank that matched full continued
# pretraining at 1B and came close at 3B (arXiv 2609.23916, in the plan's Training methods). Alpha equal to the rank
# keeps the update scale at 1, as in Glimmer's recipe, so only the capacity grows. Learning rate 2e-4, cosine with 3%
# warmup: Glimmer used 1e-4 at 30B, and 2e-4 is the usual LoRA rate for small models (Meta's Glimmer QLoRA recipe
# uses it too). 2 epochs: each passage's facts already come in Glimmer's two question sets, and a 4B model, with far
# less spare capacity than Glimmer, needs more passes per fact (Glimmer got two: stage 1, then stage 2's new wording).
# Effective batch 32, as Glimmer. If the deadline is tight (STUDENT.md), epochs 1 keeps the same schedule shape.
DEFAULT_HYPER = {"epochs": 2.0, "learning_rate": 2e-4, "lora_rank": 128, "lora_alpha": 128, "batch_size": 4, "grad_accum": 0,
                 "eval_probes": 2500, "max_examples": 0, "save_steps": 2000, "tuned_eval": 1, "base_only": 0,
                 "group_by_length": 0, "merge": 1, "max_start_loss": 8.0, "masking": "unsloth"}


def hyper(flags):
    raw = {}
    if HYPER and os.path.exists(HYPER):
        with open(HYPER) as f:
            raw = json.load(f)
    h = dict(DEFAULT_HYPER)
    for k, v in {**raw, **{k: v for k, v in flags.items() if v is not None}}.items():
        h[k] = type(h[k])(float(v)) if k in h and not isinstance(h[k], str) else v
    if h["masking"] not in ("unsloth", "own"):
        raise SystemExit("masking must be unsloth or own")
    return h


def grad_accum_for(batch, world, target=TARGET_BATCH):
    """The accumulation that brings batch x world nearest the target effective batch (32: 4 x 1 x 8, or 4 x 8 x 1)."""
    return max(1, round(target / max(1, batch * world)))


def response_labels(ids, instruction_ids, response_ids):
    """Labels for loss on responses only, as Unsloth's train_on_responses_only computes them with exact markers: every
    token after a response marker, up to the start of the next instruction marker or the end of the sequence, keeps its
    id; everything else is -100."""
    n, labels, j = len(ids), [-100] * len(ids), 0
    nr, ni = len(response_ids), len(instruction_ids)
    while j < n:
        if ids[j:j + nr] == response_ids:
            start = j + nr
            end = next((k for k in range(start, n) if ids[k:k + ni] == instruction_ids), n)
            labels[start:end] = ids[start:end]
            j = max(end, start)
        else:
            j += 1
    return labels


def final_answer(raw, profile=PROFILE):
    """The reply up to its first end-of-turn token, without a thinking block (the fleet serves with --reasoning off, and a
    stray block still isn't the answer; one that never closes leaves nothing) and without padding."""
    cut = len(raw)
    for token in profile["ends"]:
        at = raw.find(token)
        if 0 <= at < cut:
            cut = at
    reply = raw[:cut]
    start, end = profile["think"]
    if reply.lstrip().startswith(start):
        reply = reply.split(end, 1)[1] if end in reply else ""
    return reply.replace(profile["pad"], "").strip()


def load_template(folder, tokenizer=None):
    """The model's own chat template: chat_template.jinja in its folder (what its GGUF embeds), else the tokenizer's."""
    path = os.path.join(folder, "chat_template.jinja")
    if os.path.exists(path):
        with open(path) as f:
            return f.read()
    template = getattr(tokenizer, "chat_template", None)
    if not template:
        raise RuntimeError(f"no chat_template.jinja in {folder} and no template on the tokenizer")
    return template


class Chat:
    """The student's chat format: its own template with thinking off, and the token markers that split prompt from
    response. Rendering always passes the template explicitly, so a template patched onto the tokenizer can't change
    what is trained or asked."""

    def __init__(self, tokenizer, template, profile=PROFILE):
        self.tok, self.template, self.p = tokenizer, template, profile
        bos_id = tokenizer.bos_token_id
        # The template writes the BOS text; drop it only when the tokenizer adds BOS, so a sequence holds exactly one
        # (an Unsloth patch that turned add_bos_token on would flip this, and still leave one).
        self.bos = tokenizer.bos_token if bos_id is not None and tokenizer("x")["input_ids"][:1] == [bos_id] else ""
        self.instruction_ids = self.ids(profile["instruction"])
        self.response_ids = self.ids(profile["response"])

    def ids(self, text):
        return self.tok(text, add_special_tokens=False)["input_ids"]

    def render(self, messages, generation=False):
        text = self.tok.apply_chat_template(messages, chat_template=self.template, tokenize=False,
                                            add_generation_prompt=generation, enable_thinking=False)
        return text.removeprefix(self.bos) if self.bos else text

    def training_text(self, messages):
        """One training example, checked: each user message sits right after the instruction marker, and each answer
        right after the response marker and before the end of its turn."""
        text = self.render(messages)
        for m in messages:
            want = {"user": self.p["instruction"] + m["content"].strip(),
                    "assistant": self.p["response"] + m["content"].strip() + self.p["turn_end"]}.get(m["role"])
            if want and want not in text:
                raise RuntimeError(f"the template didn't put the {m['role']} message after its marker: {text[:400]!r}")
        return text

    def prompt(self, question):
        text = self.render([{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}], True)
        if not text.endswith(self.p["response"]):
            raise RuntimeError(f"the generation prompt doesn't end with {self.p['response']!r}: {text[-80:]!r}")
        return text

    def labels(self, ids):
        return response_labels(ids, self.instruction_ids, self.response_ids)

    def answers_text(self, messages):
        return "".join(m["content"].strip() + self.p["turn_end"] for m in messages if m["role"] == "assistant")

    def check(self, ids, labels, text, messages):
        """What's wrong with one tokenized training example (an empty list when nothing is): it must decode to the
        rendered text (an <eos> the trainer appends is allowed), hold exactly one BOS, at the start, whether the
        template's text or the tokenizer put it there, carry labels equal to response_labels() when labels are given,
        and train exactly its answers."""
        problems = []
        eos = self.tok.eos_token or ""
        whole = self.tok.decode(ids, skip_special_tokens=False)
        want = self.bos + text
        if whole != want and not (eos and whole == want + eos):
            problems.append(f"decodes to {whole[:160]!r}, not the rendered text {want[:160]!r}")
        bos = self.tok.bos_token_id
        if bos is not None and (ids[:1] != [bos] or ids.count(bos) != 1):
            problems.append("not exactly one BOS, at the start")
        ours = self.labels(ids)
        if labels is not None and list(labels) != ours:
            problems.append("the trainer's labels differ from response_labels()")
        trained = self.tok.decode([t for t, label in zip(ids, ours) if label != -100], skip_special_tokens=False)
        answers = self.answers_text(messages)
        if trained != answers and not (eos and trained == answers + eos):
            problems.append(f"trains {trained[:160]!r}, not the answers {answers[:160]!r}")
        return problems


def check_masking(dataset, texts, rows, chat, n=256):
    """Checks the first n tokenized training examples (Chat.check) and stops the run on any problem."""
    if len(dataset) != len(texts):
        raise RuntimeError(f"the trainer holds {len(dataset)} examples, not the {len(texts)} rendered")
    problems, checked, eos_appended = [], 0, 0
    for i in range(min(n, len(texts))):
        ex = dataset[i]
        ids = list(ex["input_ids"])
        if len(ids) >= MAX_SEQ_LENGTH:
            continue  # cut at max_length, so its end isn't comparable
        checked += 1
        eos_appended += bool(chat.tok.eos_token_id is not None and ids[-1] == chat.tok.eos_token_id)
        problems += [f"example {i}: {p}" for p in chat.check(ids, ex.get("labels"), texts[i], rows[i]["messages"])]
    if problems:
        raise RuntimeError(f"masking check failed on {len(problems)} counts, first: {problems[:3]}")
    first = dataset[0]
    trained = sum(1 for label in first["labels"] if label != -100)
    return {"checked": checked, "all_right": True, "eos_appended": eos_appended, "first_example_trained_tokens": trained,
            "of": len(first["input_ids"])}


def fixed_questions(fixed_path, probes_path, n=FIXED_N):
    """The questions of the fixed 1,500 (eval-probes.jsonl). Without that file, the first n lines of the probes file,
    which is how stage_probes.py writes stage2-eval-probes.jsonl (the fixed 1,500, then the new 1,000)."""
    if fixed_path and os.path.exists(fixed_path):
        return {p["question"] for p in read_jsonl(fixed_path)}, fixed_path
    return {p["question"] for p in read_jsonl(probes_path)[:n]}, f"first {n} lines of {probes_path}"


def probe_split(answers, covered, fixed):
    """Accuracy by probe group for each set of answers (label -> rows over the same probes, in the same order): fixed
    (the 1,500 every run scores) or new (the 1,000 stage 1 never trained on), covered (the training set holds the probe's
    passage) or not_covered, and each pairing."""
    labels = list(answers)
    first = answers[labels[0]]
    for label in labels[1:]:
        if [r["question"] for r in answers[label]] != [r["question"] for r in first]:
            raise RuntimeError(f"answers {label!r} aren't over the same probes as {labels[0]!r}")
    groups = collections.defaultdict(list)
    for i, r in enumerate(first):
        kind = "fixed" if r["question"] in fixed else "new"
        cover = "covered" if r.get("passageId") in covered else "not_covered"
        for g in ("all", kind, cover, f"{kind}/{cover}"):
            groups[g].append(i)
    out = {}
    for g in sorted(groups):
        idx = groups[g]
        row = {"n": len(idx)}
        for label in labels:
            right = sum(1 for i in idx if answers[label][i]["right"])
            row[f"{label}_right"], row[f"{label}_accuracy"] = right, round(right / len(idx), 4)
        if labels == ["base", "tuned"]:
            row["newly_right"] = sum(1 for i in idx if answers["tuned"][i]["right"] and not answers["base"][i]["right"])
            row["newly_wrong"] = sum(1 for i in idx if answers["base"][i]["right"] and not answers["tuned"][i]["right"])
        out[g] = row
    return out


def expected_lora_modules(cfg):
    """The (layer, module) pairs FastModel.get_peft_model targets on a Gemma 4 E-series text model: q, o, gate, up and
    down on every layer, k and v only on layers with their own K/V (the last num_kv_shared_layers reuse earlier K/V and
    have no k_proj or v_proj in transformers 5.15). Bolt: 42 x 5 + 24 x 2 = 258 modules, 516 LoRA tensors."""
    n = cfg.num_hidden_layers
    own_kv = n - (getattr(cfg, "num_kv_shared_layers", 0) or 0)
    want = set()
    for i in range(n):
        want |= {(i, m) for m in ("self_attn.q_proj", "self_attn.o_proj", "mlp.gate_proj", "mlp.up_proj", "mlp.down_proj")}
        if i < own_kv:
            want |= {(i, "self_attn.k_proj"), (i, "self_attn.v_proj")}
    return want


def kv_producers(cfg):
    """The layers whose K/V the shared layers reuse: the last layer of each attention type before the shared ones
    (Bolt: 22, sliding, and 23, full)."""
    shared = getattr(cfg, "num_kv_shared_layers", 0) or 0
    if not shared:
        return []
    prev = list(cfg.layer_types[: cfg.num_hidden_layers - shared])
    return sorted({len(prev) - 1 - prev[::-1].index(t) for t in set(prev)})


def check_lora(model, cfg, profile=PROFILE):
    """The LoRA sits only on language projections; on Gemma 4 exactly on expected_lora_modules(), an A and a B each."""
    names = [n for n, _ in model.named_parameters() if ".lora_" in n]
    found, other = collections.Counter(), []
    for n in names:
        m = re.search(r"language_model\.layers\.(\d+)\.((?:self_attn|mlp)\.\w+_proj)\.lora_[AB]\.", n)
        if m:
            found[(int(m.group(1)), m.group(2))] += 1
        else:
            other.append(n)
    towers = [n for n in names if re.search(r"vision|audio|visual|embed_", n)]
    problems = []
    if towers:
        problems.append(f"LoRA on the vision or audio towers or embeddings: {towers[:3]}")
    if profile["gemma4"]:
        want = expected_lora_modules(cfg)
        if set(found) != want or any(c != 2 for c in found.values()) or other:
            problems.append(f"LoRA modules: {len(found)} found, {len(want)} expected; missing {sorted(want - set(found))[:3]}, "
                            f"extra {sorted(set(found) - want)[:3]}, other {other[:3]}")
    if problems:
        raise RuntimeError("; ".join(problems))
    return {"tensors": len(names), "modules": len(names) // 2, "layers_with_kv_lora": len({i for i, m in found if m == "self_attn.k_proj"})}


def adapter_tensors(path):
    """Tensor count of a saved adapter, from the safetensors header only."""
    with open(os.path.join(path, "adapter_model.safetensors"), "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        h = json.loads(f.read(n))
    h.pop("__metadata__", None)
    return len(h)


def sha256(path):
    d = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            d.update(block)
    return d.hexdigest()


def model_dir():
    """The student's local folder: STUDENT_MODEL itself when it is one, else its cached snapshot (downloaded anonymously
    when missing; no token is ever used)."""
    if os.path.isdir(MODEL):
        return MODEL
    from huggingface_hub import snapshot_download
    return snapshot_download(MODEL, revision=MODEL_REVISION, allow_patterns=WEIGHT_PATTERNS, token=False)


def train(a):
    h = hyper({"epochs": a.epochs, "max_examples": a.max_examples, "eval_probes": a.eval_probes})
    say("start", student=PROFILE_NAME, model=MODEL, revision=MODEL_REVISION, **h, train=a.train, probes=a.probes, forget=a.forget,
        out=a.out, ckpt=a.ckpt, merged=a.merged or None)
    import torch
    if WORLD > 1:
        # Each rank's CUDA context on its own card from the start (Unsloth's import already touches CUDA).
        torch.cuda.set_device(LOCAL_RANK)
    every_rank("rank_up", device=f"cuda:{torch.cuda.current_device()}")
    from unsloth import FastModel  # Unsloth patches transformers and trl, so it comes before them.
    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer
    from unsloth.chat_templates import train_on_responses_only

    train_rows = read_jsonl(a.train)
    if h["max_examples"]:
        train_rows = train_rows[: int(h["max_examples"])]
    probes = read_jsonl(a.probes)
    random.Random(7).shuffle(probes)
    if h["eval_probes"]:
        probes = probes[: int(h["eval_probes"])]
    forget = read_jsonl(a.forget)
    fixed, fixed_from = fixed_questions(a.fixed_probes, a.probes)
    covered = {row.get("source") for row in train_rows}
    in_train = {m["content"].strip() for row in train_rows for m in row["messages"] if m["role"] == "user"}
    forget_in_train = [f["question"] for f in forget if f["question"].strip() in in_train]
    say("data", train=len(train_rows), probes=len(probes), forget=len(forget), fixed=sum(p["question"] in fixed for p in probes),
        covered=sum(p.get("passageId") in covered for p in probes), fixed_from=fixed_from, forget_in_train=forget_in_train)

    folder = model_dir()
    say("model", model=MODEL, folder=folder, revision=MODEL_REVISION, load_in_4bit=LOAD_IN_4BIT, gradient_checkpointing=GRAD_CKPT)
    model, tokenizer = FastModel.from_pretrained(
        model_name=folder, max_seq_length=MAX_SEQ_LENGTH, load_in_4bit=LOAD_IN_4BIT,
    )
    rank = int(h["lora_rank"])
    model = FastModel.get_peft_model(
        model, finetune_vision_layers=False, finetune_language_layers=True, finetune_attention_modules=True,
        finetune_mlp_modules=True, r=rank, lora_alpha=int(h["lora_alpha"]), lora_dropout=0, bias="none",
        use_gradient_checkpointing=GRAD_CKPT, random_state=3407,
    )
    cfg = getattr(model.config, "text_config", None) or model.config
    lora_info = check_lora(model, cfg)
    say("lora", **lora_info, rank=rank, alpha=int(h["lora_alpha"]))
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    template = load_template(folder, text_tokenizer)
    chat = Chat(text_tokenizer, template)
    end_ids = sorted({i for i in (text_tokenizer.convert_tokens_to_ids(t) for t in PROFILE["ends"])
                      if isinstance(i, int) and i != text_tokenizer.unk_token_id})
    say("chat", bos_dropped=bool(chat.bos), instruction_ids=chat.instruction_ids, response_ids=chat.response_ids, end_ids=end_ids,
        template_sha256=hashlib.sha256(template.encode()).hexdigest()[:16],
        tokenizer_template_same=getattr(text_tokenizer, "chat_template", None) == template)

    def ready_to_answer():
        if hasattr(FastModel, "for_inference"):
            FastModel.for_inference(model)
        text_tokenizer.padding_side = "left"
        if text_tokenizer.pad_token is None:
            text_tokenizer.pad_token = text_tokenizer.eos_token

    def answer_all(label, items, probe_rows):
        ready_to_answer()
        prompts = [chat.prompt(it["question"]) for it in items]
        replies = []
        for start in range(0, len(prompts), GEN_BATCH):
            enc = text_tokenizer(prompts[start:start + GEN_BATCH], return_tensors="pt", padding=True)
            with torch.no_grad():
                out = model.generate(
                    input_ids=enc["input_ids"].to("cuda"), attention_mask=enc["attention_mask"].to("cuda"),
                    max_new_tokens=MAX_NEW_TOKENS, do_sample=False, pad_token_id=text_tokenizer.pad_token_id, eos_token_id=end_ids,
                )
            width = enc["input_ids"].shape[1]
            replies += [final_answer(text_tokenizer.decode(row[width:], skip_special_tokens=False)) for row in out]
            if (start // GEN_BATCH) % 10 == 0:
                say("answering", model=label, done=len(replies), of=len(prompts))
        rows = []
        for it, r in zip(items, replies):
            row = {"question": it["question"], "answer": it["answer"], "reply": r, "right": answered(r, it)}
            if probe_rows:
                row.update(passageId=it.get("passageId"), set="fixed" if it["question"] in fixed else "new")
            rows.append(row)
        return rows

    def score(rows):
        return round(sum(r["right"] for r in rows) / max(1, len(rows)), 4)

    def same_items(saved):
        return [r["question"] for r in saved["probes"]] == [p["question"] for p in probes] and \
            [r["question"] for r in saved["forget"]] == [f["question"] for f in forget]

    base_path = os.path.join(a.ckpt, "base.json")
    if os.path.exists(base_path):
        with open(base_path) as f:
            base = json.load(f)
        # Every rank makes the same check on the same files, so a stale file stops all of them alike.
        if not same_items(base):
            raise RuntimeError(f"{base_path} answers other probes (another eval_probes or probe file); move it away")
        say("base_reused", path=base_path)
    elif MAIN:
        began = time.time()
        every_rank("answering_base")
        base = {"probes": answer_all("base", probes, True), "forget": answer_all("base", forget, False),
                "seconds": round(time.time() - began, 1), "answered_by": "base"}
        write_json(base_path, base)
    else:
        # Rank 0 answers the probes alone. The process group doesn't exist yet (the trainer's arguments create it), so
        # waiting for its file can't time out, and no collective can pair up with one of rank 0's. The model and
        # tokenizer get the settings answering gave rank 0, so every rank trains alike.
        ready_to_answer()
        every_rank("waiting_for_base_answers")
        while not os.path.exists(base_path):
            time.sleep(5)
        with open(base_path) as f:
            base = json.load(f)
    say("base", probes=score(base["probes"]), forget=score(base["forget"]),
        split=probe_split({"base": base["probes"]}, covered, fixed))
    if h["base_only"]:
        return

    if hasattr(FastModel, "for_training"):
        FastModel.for_training(model)
    # Answering pads on the left; training pads on the right, so every example starts at position 0.
    text_tokenizer.padding_side = "right"
    texts = [chat.training_text(row["messages"]) for row in train_rows]
    batch = int(h["batch_size"])
    accum = int(h["grad_accum"]) or grad_accum_for(batch, WORLD)
    effective_batch = batch * accum * WORLD

    class Pace(TrainerCallback):
        """Step times, for the steady training rate (after start-up) and a progress line every 50 steps."""

        def __init__(self):
            self.at = {}

        def on_step_end(self, args, state, control, **kwargs):
            step, t = state.global_step, time.time()
            self.at[step] = t
            if step % 50 == 0 and step - 50 in self.at:
                rate = 50 * effective_batch / max(t - self.at[step - 50], 1e-9)
                say("progress", step=step, of=state.max_steps, examples_per_second=round(rate, 2),
                    eta_minutes=round((state.max_steps - step) * effective_batch / rate / 60, 1))

        def steady(self):
            steps = sorted(self.at)
            if len(steps) < 6:
                return None
            first = steps[len(steps) // 5]
            return round((steps[-1] - first) * effective_batch / max(self.at[steps[-1]] - self.at[first], 1e-9), 2)

    class Guard(TrainerCallback):
        """Stops a broken run early. The first logged loss should be about 1 to 3 on answers alone; 10 to 15 is the sign
        of a broken KV-sharing path (transformers #45242), so above max_start_loss the run stops. On the first optimizer
        step every LoRA weight must have a gradient and every lora_B a nonzero one (lora_A's are zero then, since B
        starts at zero); this also confirms ddp_find_unused_parameters=False. The k_proj and v_proj of the layers whose
        K/V the shared layers reuse are reported beside the median of the other layers'."""

        def __init__(self, producers, max_loss):
            self.producers, self.max_loss, self.losses, self.report = producers, max_loss, [], None

        def on_log(self, args, state, control, logs=None, **kwargs):
            loss = (logs or {}).get("loss")
            if loss is None:
                return
            self.losses.append([state.global_step, round(float(loss), 4)])
            if len(self.losses) == 1:
                say("first_loss", step=state.global_step, loss=round(float(loss), 4), limit=self.max_loss)
                if self.max_loss and float(loss) > self.max_loss:
                    raise RuntimeError(f"first loss {loss:.2f} is above {self.max_loss}: the KV-sharing path is likely broken")

        def on_pre_optimizer_step(self, args, state, control, model=None, **kwargs):
            if self.report is not None or model is None:
                return
            lora = [(n, p) for n, p in model.named_parameters() if ".lora_" in n and p.requires_grad]
            no_grad = [n for n, p in lora if p.grad is None]
            zero_b = [n for n, p in lora if ".lora_B" in n and p.grad is not None and not bool(p.grad.detach().abs().sum() > 0)]
            norms = {}
            for n, p in lora:
                m = re.search(r"layers\.(\d+)\.self_attn\.([kv])_proj\.lora_B", n)
                if m and p.grad is not None:
                    norms[(int(m.group(1)), m.group(2))] = float(p.grad.detach().float().norm())
            others = sorted(v for (i, _), v in norms.items() if i not in self.producers)
            self.report = {"lora_weights": len(lora), "without_grad": len(no_grad), "lora_b_zero_grad": len(zero_b),
                           "kv_producer_grad_norms": {f"{i}.{kv}": round(v, 6) for (i, kv), v in sorted(norms.items()) if i in self.producers},
                           "other_kv_median_grad_norm": round(others[len(others) // 2], 6) if others else None}
            say("grad_check", **self.report, without_grad_sample=no_grad[:3], zero_sample=zero_b[:3])
            if no_grad or zero_b:
                raise RuntimeError(f"{len(no_grad)} LoRA weights without a gradient and {len(zero_b)} lora_B with a zero one")

    pace, guard = Pace(), Guard(kv_producers(cfg), float(h["max_start_loss"]))
    # Under torchrun: every LoRA weight gets a gradient each step (Guard checks the first), and the long timeout covers
    # rank 0 saving a checkpoint while the others wait.
    distributed = {"ddp_find_unused_parameters": False, "ddp_timeout": 10800} if WORLD > 1 else {}
    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=Dataset.from_list([{"text": t} for t in texts]), eval_dataset=None,
        args=SFTConfig(
            dataset_text_field="text", max_length=MAX_SEQ_LENGTH, loss_type="nll",
            per_device_train_batch_size=batch, gradient_accumulation_steps=accum,
            num_train_epochs=float(h["epochs"]), learning_rate=float(h["learning_rate"]), lr_scheduler_type="cosine",
            warmup_ratio=0.03, optim="adamw_8bit", weight_decay=0.001, logging_steps=10, seed=3407,
            group_by_length=bool(h["group_by_length"]), packing=False,
            output_dir=a.ckpt, save_strategy="steps", save_steps=int(h["save_steps"]), save_total_limit=2, report_to="none",
            **distributed,
        ),
        callbacks=[pace, guard],
    )
    instruction_ids, response_ids = chat.instruction_ids, chat.response_ids
    if h["masking"] == "own":
        # What train_on_responses_only does, with this file's labels: a labels column and a collator that pads it.
        from transformers import DataCollatorForSeq2Seq
        trainer.train_dataset = trainer.train_dataset.map(
            lambda b: {"labels": [response_labels(x, instruction_ids, response_ids) for x in b["input_ids"]]}, batched=True)
        trainer.data_collator = DataCollatorForSeq2Seq(tokenizer=text_tokenizer)
    else:
        trainer = train_on_responses_only(trainer, instruction_part=PROFILE["instruction"], response_part=PROFILE["response"])
    masking = check_masking(trainer.train_dataset, texts, train_rows, chat)
    say("masking", how=h["masking"], **masking)
    resume = any(d.startswith("checkpoint-") for d in os.listdir(a.ckpt)) if os.path.isdir(a.ckpt) else False
    began = time.time()
    stats = trainer.train(resume_from_checkpoint=True if resume else None)
    train_seconds = round(time.time() - began, 1)
    peak = torch.cuda.max_memory_reserved()
    peaks = [round(peak / 1024 ** 3, 2)]
    if WORLD > 1:
        # Every GPU's peak; then the group is closed, so rank 0's saving, answers and merge run alone.
        import torch.distributed as dist
        t = torch.zeros(WORLD, dtype=torch.float64, device=f"cuda:{LOCAL_RANK}")
        t[RANK] = float(peak)
        dist.all_reduce(t, op=dist.ReduceOp.SUM)
        peaks = [round(float(x) / 1024 ** 3, 2) for x in t.tolist()]
        peak = int(max(t.tolist()))
        dist.barrier()
        dist.destroy_process_group()
        if not MAIN:
            every_rank("rank_done", saves=False, answers=False)
            return
    steady = pace.steady()
    steps = int(trainer.state.global_step or 0)
    loss = getattr(stats, "training_loss", None)
    rate = round(len(train_rows) * float(h["epochs"]) / max(train_seconds, 1e-9), 2)
    say("trained", steps=steps, loss=loss, seconds=train_seconds, examples_per_second=rate, examples_per_second_steady=steady,
        gpus=WORLD, effective_batch=effective_batch, peak_vram_gb=round(peak / 1024 ** 3, 2), peak_vram_gb_per_gpu=peaks,
        first_losses=guard.losses[:3], last_losses=guard.losses[-3:])

    adapter = a.adapter or os.path.join(a.out, "adapter")
    model.save_pretrained(adapter)
    tokenizer.save_pretrained(adapter)
    saved = adapter_tensors(adapter)
    if saved != lora_info["tensors"]:
        raise RuntimeError(f"the saved adapter has {saved} tensors, the model {lora_info['tensors']} LoRA weights")
    every_rank("adapter_saved", path=adapter, tensors=saved)
    common = {
        "train_examples": len(train_rows), "steps": steps, "train_loss": loss, "train_seconds": train_seconds,
        "peak_vram_gb": round(peak / 1024 ** 3, 2), "peak_vram_gb_per_gpu": peaks, "train_examples_per_second_steady": steady,
        "gpus": WORLD, "effective_batch": effective_batch, "gpu": torch.cuda.get_device_name(0), "hyperparameters": h,
        "model": MODEL, "revision": MODEL_REVISION, "load_in_4bit": LOAD_IN_4BIT, "gradient_checkpointing": GRAD_CKPT,
        "init_adapter": None, "student": PROFILE_NAME, "license": PROFILE["license"], "train_file": a.train,
        "train_sha256": sha256(a.train), "grad_accum": accum, "lora": {**lora_info, "saved_tensors": saved}, "masking": masking,
        "grad_check": guard.report, "losses": {"first": guard.losses[:5], "last": guard.losses[-5:]},
    }
    if h["tuned_eval"]:
        every_rank("answering_tuned")
        tuned = {"probes": answer_all("tuned", probes, True), "forget": answer_all("tuned", forget, False)}
        for rows in (base["probes"], tuned["probes"]):
            for r in rows:
                r["covered"] = r.get("passageId") in covered
        write_json(os.path.join(a.out, "answers.json"), {"base": base, "tuned": tuned})
        free = [i for i, f in enumerate(forget) if f["question"] not in forget_in_train]
        metrics = {
            **common, "probes": len(probes), "forget_items": len(forget),
            "base_probe_accuracy": score(base["probes"]), "tuned_probe_accuracy": score(tuned["probes"]),
            "base_forget_accuracy": score(base["forget"]), "tuned_forget_accuracy": score(tuned["forget"]),
            "train_examples_per_second": rate,
            "probe_split": probe_split({"base": base["probes"], "tuned": tuned["probes"]}, covered, fixed), "fixed_from": fixed_from,
            # Old facts the training set also asks (the replay holds "What is the capital of Australia?") don't measure
            # forgetting, so the score without them is kept too.
            "forget_in_train": forget_in_train,
            "base_forget_accuracy_not_in_train": score([base["forget"][i] for i in free]),
            "tuned_forget_accuracy_not_in_train": score([tuned["forget"][i] for i in free]),
        }
        write_json(os.path.join(a.out, "metrics.json"), metrics)
        say("done", **{k: metrics[k] for k in ("base_probe_accuracy", "tuned_probe_accuracy", "base_forget_accuracy", "tuned_forget_accuracy")},
            split={g: (v["base_accuracy"], v["tuned_accuracy"]) for g, v in metrics["probe_split"].items()})
    else:
        write_json(os.path.join(a.out, "metrics.json"), {**common, "tuned_eval": False})
        say("done", tuned_eval=False)
    if a.merged and h["merge"]:
        # On CPU, in a process of its own: no Unsloth patches, and this one's GPU memory doesn't matter.
        env = {k: v for k, v in os.environ.items() if k not in ("RANK", "WORLD_SIZE", "LOCAL_RANK", "LOCAL_WORLD_SIZE")}
        env["CUDA_VISIBLE_DEVICES"] = ""
        cmd = [sys.executable, os.path.abspath(__file__), "merge", "--base", folder, "--adapter", adapter, "--merged", a.merged,
               "--report", os.path.join(a.out, "merge-check.json")]
        say("merging", cmd=" ".join(cmd))
        if subprocess.run(cmd, env=env).returncode:
            raise RuntimeError("the merge failed; see MERGE lines above")
        say("merged", path=a.merged)


# ---- Merge (CPU; torch and safetensors only) ----

def mlog(event, **fields):
    print("MERGE " + json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def st_header(path):
    """A safetensors file's tensors: name -> (dtype, shape, bytes), from its header only."""
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        h = json.loads(f.read(n))
    h.pop("__metadata__", None)
    return {k: (v["dtype"], tuple(v["shape"]), v["data_offsets"][1] - v["data_offsets"][0]) for k, v in h.items()}


def weight_map(folder):
    idx = os.path.join(folder, "model.safetensors.index.json")
    if os.path.exists(idx):
        with open(idx) as f:
            return json.load(f)["weight_map"]
    return {k: "model.safetensors" for k in st_header(os.path.join(folder, "model.safetensors"))}


def merge(base, adapter, out, report_path="", keep_shared_kv=True, samples=24, shard_bytes=5 * 1024 ** 3):
    """Merges a LoRA adapter into the base's safetensors, tensor by tensor on CPU: each targeted weight becomes
    W + scale * B @ A, computed in float32 and rounded once to W's dtype (scale is alpha / r, or alpha / sqrt(r) for
    rsLoRA). Every other tensor is copied unchanged under its own name, so the folder keeps the base's exact tensor set
    (the vision and audio towers too, which the text-only GGUF converter skips) and converts like the original. With
    keep_shared_kv, the base's SHARED_KV_FILE is copied back as is. Tokenizer, template, configs and the card's notice
    files are copied from the base (OpenMDW asks that the license and its notices travel with the model).

    Checks, all of which must pass or it exits non-zero: every adapter tensor pairs into an A and a B whose shapes fit a
    base weight; the written folder has the base's tensor names, shapes and dtypes; every targeted weight changed and
    every other tensor is bit-identical; for a sample of targeted weights, merged equals base + scale * B @ A to within
    one rounding step of the base's dtype."""
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file, save_file
    torch.set_num_threads(os.cpu_count() or 8)
    began = time.time()
    with open(os.path.join(adapter, "adapter_config.json")) as f:
        acfg = json.load(f)
    if acfg.get("use_dora") or acfg.get("fan_in_fan_out"):
        raise SystemExit("merge: DoRA and fan_in_fan_out adapters aren't supported")
    rank, alpha = int(acfg["r"]), float(acfg["lora_alpha"])
    scale = alpha / (rank ** 0.5 if acfg.get("use_rslora") else rank)
    saved = load_file(os.path.join(adapter, "adapter_model.safetensors"))
    problems = []
    pairs = collections.defaultdict(dict)
    for key, value in saved.items():
        m = re.fullmatch(r"base_model\.model\.(.+)\.lora_([AB])(?:\.default)?\.weight", key)
        if m:
            pairs[m.group(1) + ".weight"][m.group(2)] = value
        else:
            problems.append({"adapter_key_not_lora": key})
    wmap = weight_map(base)
    shared = {k for k, f in wmap.items() if f == SHARED_KV_FILE}
    main = {k: f for k, f in wmap.items() if f != SHARED_KV_FILE}
    heads = {f: st_header(os.path.join(base, f)) for f in sorted(set(main.values()))}
    info = {k: heads[f][k] for k, f in main.items()}
    for key, ab in pairs.items():
        if set(ab) != {"A", "B"}:
            problems.append({"key": key, "issue": "not an A and a B"})
        elif key not in info:
            problems.append({"key": key, "issue": "no such base weight"})
        elif tuple(info[key][1]) != (ab["B"].shape[0], ab["A"].shape[1]) or ab["A"].shape[0] != rank or ab["B"].shape[1] != rank:
            problems.append({"key": key, "issue": "shapes don't fit", "base": info[key][1], "A": list(ab["A"].shape), "B": list(ab["B"].shape)})
    mlog("adapter", path=adapter, tensors=len(saved), targeted=len(pairs), rank=rank, alpha=alpha, scale=scale,
         rslora=bool(acfg.get("use_rslora")), base_tensors=len(main), shared_kv_tensors=len(shared))
    if problems:
        mlog("adapter_mismatch", problems=problems[:10])
        sys.exit(1)

    # Shards of at most shard_bytes (one tensor bigger than that, such as Bolt's per-layer embeddings, gets its own).
    names = sorted(info)
    shards, current, size = [], [], 0
    for k in names:
        if current and size + info[k][2] > shard_bytes:
            shards.append(current)
            current, size = [], 0
        current.append(k)
        size += info[k][2]
    if current:
        shards.append(current)
    part = out.rstrip("/") + ".part"
    if os.path.exists(part):
        shutil.rmtree(part)
    os.makedirs(part)
    handles = {}

    def tensor(folder, file, key):
        path = os.path.join(folder, file)
        if path not in handles:
            handles[path] = safe_open(path, "pt")
        return handles[path].get_tensor(key)

    def merged_weight(key, w):
        ab = pairs[key]
        return (w.float() + scale * (ab["B"].float() @ ab["A"].float())).to(w.dtype)

    new_map = {}
    for i, keys in enumerate(shards):
        file = f"model-{i + 1:05d}-of-{len(shards):05d}.safetensors"
        tensors = {}
        for k in keys:
            w = tensor(base, main[k], k)
            tensors[k] = merged_weight(k, w) if k in pairs else w
        save_file(tensors, os.path.join(part, file), metadata={"format": "pt"})
        new_map.update({k: file for k in keys})
        mlog("shard", file=file, tensors=len(keys), seconds=round(time.time() - began, 1))
        del tensors
    total = sum(info[k][2] for k in names)
    if keep_shared_kv and shared:
        shutil.copy2(os.path.join(base, SHARED_KV_FILE), os.path.join(part, SHARED_KV_FILE))
        new_map.update({k: SHARED_KV_FILE for k in shared})
        total += os.path.getsize(os.path.join(base, SHARED_KV_FILE))
    with open(os.path.join(part, "model.safetensors.index.json"), "w") as f:
        json.dump({"metadata": {"total_size": total}, "weight_map": dict(sorted(new_map.items()))}, f, indent=2)
    for name in sorted(os.listdir(base)):
        src = os.path.join(base, name)
        if os.path.isfile(src) and not name.endswith((".safetensors", ".png", ".gif", ".jpg")) and name != "model.safetensors.index.json":
            shutil.copy2(src, os.path.join(part, name))
    mlog("written", seconds=round(time.time() - began, 1), shards=len(shards))

    # Tensor-by-tensor comparison of the written folder against the base.
    stats = {"identical_untargeted": 0, "changed_targeted": 0, "unchanged_targeted": 0, "changed_untargeted": 0}
    sample = set(sorted(pairs)[:: max(1, len(pairs) // max(1, samples))][:samples])
    sample_err, delta_ratio = [], []
    out_info = {}
    for file in sorted(set(new_map.values()) - {SHARED_KV_FILE}):
        out_info.update(st_header(os.path.join(part, file)))
    if set(out_info) != set(info):
        problems.append({"missing": sorted(set(info) - set(out_info))[:5], "extra": sorted(set(out_info) - set(info))[:5]})
    mantissa = {torch.bfloat16: 7, torch.float16: 10, torch.float32: 23}
    for k in sorted(set(info) & set(out_info)):
        if out_info[k][:2] != info[k][:2]:
            problems.append({"key": k, "base": info[k][:2], "merged": out_info[k][:2]})
            continue
        b, m = tensor(base, main[k], k), tensor(part, new_map[k], k)
        same = torch.equal(b, m)
        if k in pairs:
            stats["changed_targeted" if not same else "unchanged_targeted"] += 1
            if same:
                problems.append({"key": k, "issue": "targeted but unchanged"})
            if k in sample:
                ab = pairs[k]
                delta = scale * (ab["B"].float() @ ab["A"].float())
                want = b.float() + delta
                err = (m.float() - want).abs()
                mag = torch.maximum(torch.maximum(b.float().abs(), delta.abs()), want.abs()).clamp_min(1e-30)
                step = torch.pow(2.0, torch.floor(torch.log2(mag)) - mantissa.get(b.dtype, 7))
                ratio = float((err / step).max())
                sample_err.append({"key": k, "max_err_in_rounding_steps": round(ratio, 3)})
                delta_ratio.append(float(delta.abs().mean() / b.float().abs().mean().clamp_min(1e-30)))
                if ratio > 1.01:
                    problems.append({"key": k, "issue": "merged != base + scale*B@A", "max_err_in_rounding_steps": ratio})
        else:
            stats["identical_untargeted" if same else "changed_untargeted"] += 1
            if not same:
                problems.append({"key": k, "issue": "not targeted but changed"})
    report = {
        "base": base, "adapter": adapter, "out": out, "rank": rank, "alpha": alpha, "scale": scale,
        "adapter_tensors": len(saved), "targeted_tensors": len(pairs), "base_tensors": len(info), "merged_tensors": len(out_info),
        "shared_kv_tensors_copied": len(shared) if keep_shared_kv else 0, **stats,
        "sampled_merge_checks": sample_err,
        "delta_to_weight_mean_abs": round(sum(delta_ratio) / len(delta_ratio), 6) if delta_ratio else None,
        "problems": problems[:20], "ok": not problems, "seconds": round(time.time() - began, 1),
    }
    with open(os.path.join(part, "merge-check.json"), "w") as f:
        json.dump(report, f, indent=1)
    if report_path:
        os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
        with open(report_path, "w") as f:
            json.dump(report, f, indent=1)
    mlog("check", **{k: v for k, v in report.items() if k != "sampled_merge_checks"},
         worst_sample_steps=max((s["max_err_in_rounding_steps"] for s in sample_err), default=None))
    if problems:
        sys.exit(1)
    if os.path.exists(out):
        shutil.rmtree(out)
    os.replace(part, out)
    mlog("done", out=out)


def cli():
    ap = argparse.ArgumentParser(description="Train (default) or merge the Jetson student; see the module docstring.")
    ap.add_argument("command", nargs="?", default="train", choices=["train", "merge", "download"])
    ap.add_argument("--train", default=os.path.join(DATA, "train.jsonl"))
    ap.add_argument("--probes", default=os.path.join(DATA, "probes.jsonl"))
    ap.add_argument("--forget", default=os.path.join(DATA, "forget.jsonl"))
    ap.add_argument("--fixed-probes", default=os.path.join(DATA, "eval-probes.jsonl"), help="the fixed 1,500, for probe_split")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--ckpt", default=CKPT)
    ap.add_argument("--merged", default=MERGED, help="train: where rank 0 merges at the end; merge: the output folder")
    ap.add_argument("--max-examples", type=int)
    ap.add_argument("--epochs", type=float)
    ap.add_argument("--eval-probes", type=int)
    ap.add_argument("--base", help="merge: the base model folder")
    ap.add_argument("--adapter", default=ADAPTER, help="train: where the adapter is saved (OUT/adapter by default); merge: the adapter to merge")
    ap.add_argument("--report", default="", help="merge: also write the check report here")
    ap.add_argument("--no-shared-kv", action="store_true", help=f"merge: leave {SHARED_KV_FILE} out")
    a = ap.parse_args()
    if a.command == "merge":
        if not (a.base and a.adapter and a.merged):
            raise SystemExit("merge needs --base, --adapter and --merged")
        merge(a.base, a.adapter, a.merged, a.report, keep_shared_kv=not a.no_shared_kv)
    elif a.command == "download":
        print(model_dir(), flush=True)
    else:
        train(a)


if __name__ == "__main__":
    cli()
