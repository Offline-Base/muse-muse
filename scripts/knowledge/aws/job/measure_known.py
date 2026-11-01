"""Stage B's measurement (docs/KNOWLEDGE_UPDATE.md, "Re-measure what the model now knows"): a model with a given adapter
answers questions it never trained on, the way train_glimmer.py answers its probes, so its "right" means the same thing
as the probe scores. One process per GPU, no DDP; run_measure_known.sh starts them all.

The model path, prompt and generation are train_glimmer.py's: Unsloth's from_pretrained and get_peft_model with its
settings, load_adapter(), the base chat template with its system line and reasoning strength, the final channel
appended, greedy, at most 96 new tokens, batches of 32, final_answer() and answered(). Constants and helpers are
imported, not copied. The base weights come from the same environment (KNOWLEDGE_MODEL, KNOWLEDGE_4BIT).

Each shard appends to OUT.shard-I-of-N.jsonl and syncs after every batch, so a stop loses at most one batch; a restart
with the same arguments carries on from what's there, and refuses if the adapter, the question file or a setting below
changed. --merge (no GPU) joins the shards into OUT, in question order, and exits 1 if a question is missing, unless
--allow-partial. A row holds the question's fields plus i (its line in the question file), reply, right, and ended
(false when the reply ran into the token limit); with --repeat above 1 also r, the repeat (0 first).

Serving-settings tests (the final plan's A1 and A2) change the prompt or the decoding. With none of these flags the prompt is
byte for byte the one every earlier score used (test_b2_wave.py checks it through the real template and tokenizer):
- --adapter none: the base model (the fresh LoRA, as train_glimmer.py answers "base").
- --system TEXT or --system-file FILE: this system message instead of "You are a helpful assistant.".
- --no-system: no system message, so the template writes its own block ("You are a helpful AI assistant.", a knowledge
  cutoff, the current date). --knowledge-cutoff YYYY-MM-DD and --current-date YYYY-MM-DD go to the template as kwargs; without
  them it writes 2026-01-04 and the machine's date. The template ignores both when there is a system message, so they are
  refused beside --system: put the lines in the system text instead.
- --strength low|medium|high|default: the reasoning strength the template writes (low, as in training); default sends none,
  which the template renders as high.
- --temperature T (0, greedy), --top-p, --top-k, --seed: sampling. Above 0, top-p defaults to 1.0, top-k to 0 (off) and the
  seed to 0, all written out so the model's generation config can't add its own. Before each batch the generator is seeded
  with (seed + r) * 1000003 + the batch's first question index, so a rerun with the same shards and batch size repeats it.
- --repeat N: every question N times (sampling only), rows told apart by r.
Every setting goes in OUT's .meta.json, with the system block the template actually rendered (rendered_system_block) and the
sha256 of the whole prompt for the placeholder question "QUESTION". --render-only prints that block for the given settings
from a tokenizer folder (--tokenizer, or the adapter folder) without loading any weights, to check an arm before it runs.

Usage: python measure_known.py --adapter DIR --questions Q.jsonl --out OUT.jsonl --gpu 3 --shard 3 --shards 8
       python measure_known.py --adapter none --no-system --knowledge-cutoff 2026-10-29 --current-date 2026-11-01 ...
       python measure_known.py --adapter DIR --temperature 1.0 --top-p 0.95 --top-k 64 --seed 1 --repeat 3 ...
       python measure_known.py --render-only --tokenizer DIR [prompt flags]
       python measure_known.py --merge --questions Q.jsonl --out OUT.jsonl --shards 8 [--allow-partial]
Speed: 40,000 questions took 31 minutes on eight A100 80GB (Oct 31, loading included).
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_glimmer import (FINAL_CHANNEL, FINAL_ENDS, GEN_BATCH, GENERATION_PROMPT, GRAD_CKPT, INSTRUCTION_PART,  # noqa: E402
                           LOAD_IN_4BIT, MAX_NEW_TOKENS, MAX_SEQ_LENGTH, MODEL, MODEL_REVISION, REASONING, STRENGTHS, SYSTEM,
                           answered, final_answer, load_adapter, read_jsonl)

KEEP = ("question", "answer", "aliases", "passageId", "date", "url")
# The prompt and decoding settings, at the values every run before them used. A meta file written before they existed has
# none of them, so a missing key reads as its default and an old shard still carries on.
SETTINGS_DEFAULTS = {"system": SYSTEM, "strength": REASONING, "knowledge_cutoff": None, "current_date": None,
                     "temperature": 0.0, "top_p": None, "top_k": None, "seed": None, "repeat": 1}
SAME = ("adapter_sha256", "questions_sha256", "model", "revision", "max_new_tokens", *SETTINGS_DEFAULTS)
DEFAULT_STRENGTH = "default"  # send no reasoning_strength: the template writes high
PLACEHOLDER = "QUESTION"
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def render_prompt(tokenizer, question, bos="", system=SYSTEM, strength=REASONING, knowledge_cutoff=None, current_date=None):
    """The answering prompt: the chat template with the generation prompt, then the final channel opened. The defaults are
    train_glimmer.py's and render exactly what every earlier score rendered. system=None sends no system message (the template
    then writes its own block, with knowledge_cutoff and current_date); strength=None leaves reasoning_strength out."""
    messages = ([] if system is None else [{"role": "system", "content": system}]) + [{"role": "user", "content": question}]
    kwargs = {} if strength is None else {"reasoning_strength": strength}
    if knowledge_cutoff:
        kwargs["knowledge_cutoff"] = knowledge_cutoff
    if current_date:
        kwargs["current_date"] = current_date
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, **kwargs)
    text = text.removeprefix(bos) if bos else text
    if not text.endswith(GENERATION_PROMPT):
        raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
    return text + FINAL_CHANNEL


def system_block(prompt):
    """The rendered system block of a prompt: everything before the user turn."""
    at = prompt.find(INSTRUCTION_PART)
    return prompt[:at] if at >= 0 else prompt


def generate_kwargs(max_new_tokens, pad_token_id, sampling=None):
    """generate()'s decoding arguments. Greedy (sampling None or temperature 0) passes exactly what it always passed."""
    kw = {"max_new_tokens": max_new_tokens, "do_sample": False, "pad_token_id": pad_token_id}
    if sampling and sampling.get("temperature"):
        top_p, top_k = sampling.get("top_p"), sampling.get("top_k")
        kw.update(do_sample=True, temperature=float(sampling["temperature"]), top_p=1.0 if top_p is None else float(top_p),
                  top_k=0 if top_k is None else int(top_k))
    return kw


def batch_seed(seed, r, first):
    return ((seed or 0) + r) * 1000003 + first


class Answerer:
    """The model as train_glimmer.py sets it up for answering. adapter=None keeps the fresh LoRA, whose output is the
    base model's, which is how train_glimmer.py answers "base"."""

    device = "cuda"
    # Class defaults, so a stand-in built without __init__ (test_stage_b.py's) prompts as before.
    system, strength, knowledge_cutoff, current_date, sampling = SYSTEM, REASONING, None, None, None

    def __init__(self, adapter, system=SYSTEM, strength=REASONING, knowledge_cutoff=None, current_date=None, sampling=None):
        import torch  # after the caller has set CUDA_VISIBLE_DEVICES
        from unsloth import FastModel  # Unsloth patches transformers, so it comes before them.
        self.torch = torch
        self.system, self.strength, self.knowledge_cutoff, self.current_date = system, strength, knowledge_cutoff, current_date
        self.sampling = sampling
        rank = 64
        if adapter:
            with open(os.path.join(adapter, "adapter_config.json")) as f:
                rank = int(json.load(f)["r"])
        model, tokenizer = FastModel.from_pretrained(
            model_name=MODEL, revision=MODEL_REVISION, max_seq_length=MAX_SEQ_LENGTH, load_in_4bit=LOAD_IN_4BIT,
        )
        model = FastModel.get_peft_model(
            model, finetune_vision_layers=False, finetune_language_layers=True, finetune_attention_modules=True,
            finetune_mlp_modules=True, r=rank, lora_alpha=rank, lora_dropout=0, bias="none",
            use_gradient_checkpointing=GRAD_CKPT, random_state=3407,
        )
        if adapter:
            load_adapter(model, adapter, rank)
        self.model, self.tokenizer = model, tokenizer
        self.text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
        self.bos = getattr(tokenizer, "bos_token", None) or getattr(self.text_tokenizer, "bos_token", None) or ""
        if hasattr(FastModel, "for_inference"):
            FastModel.for_inference(model)
        self.text_tokenizer.padding_side = "left"
        if self.text_tokenizer.pad_token is None:
            self.text_tokenizer.pad_token = self.text_tokenizer.eos_token

    def prompt(self, question):
        return render_prompt(self.tokenizer, question, self.bos, self.system, self.strength, self.knowledge_cutoff, self.current_date)

    def reseed(self, value):
        self.torch.manual_seed(value)
        if self.torch.cuda.is_available():
            self.torch.cuda.manual_seed_all(value)

    def ask(self, questions, max_new_tokens=MAX_NEW_TOKENS):
        """(raw decoded output, tokens generated) for each question, in order. Out of GPU memory, the batch is halved."""
        torch, tok = self.torch, self.text_tokenizer
        enc = tok([self.prompt(q) for q in questions], return_tensors="pt", padding=True)
        try:
            with torch.no_grad():
                out = self.model.generate(
                    input_ids=enc["input_ids"].to(self.device), attention_mask=enc["attention_mask"].to(self.device),
                    **generate_kwargs(max_new_tokens, tok.pad_token_id, self.sampling),
                )
        except torch.cuda.OutOfMemoryError:
            if len(questions) == 1:
                raise
            torch.cuda.empty_cache()
            half = len(questions) // 2
            print(f"MEASURE out of memory at batch {len(questions)}; halving", flush=True)
            return self.ask(questions[:half], max_new_tokens) + self.ask(questions[half:], max_new_tokens)
        width = enc["input_ids"].shape[1]
        return [(tok.decode(row[width:], skip_special_tokens=False), int((row[width:] != tok.pad_token_id).sum())) for row in out]


def add_prompt_args(ap, strength=True):
    """The prompt and decoding flags, shared with score_honesty_bf16.py (which has its own --strength)."""
    g = ap.add_argument_group("prompt; the defaults are train_glimmer.py's, the prompt of every earlier score")
    one = g.add_mutually_exclusive_group()
    one.add_argument("--system", help="system message text (default: train_glimmer.py's SYSTEM)")
    one.add_argument("--system-file", help="system message from a file (one trailing newline dropped)")
    one.add_argument("--no-system", action="store_true", help="no system message: the template writes its own block")
    g.add_argument("--knowledge-cutoff", help="YYYY-MM-DD, to the template as knowledge_cutoff (needs --no-system)")
    g.add_argument("--current-date", help="YYYY-MM-DD, to the template as current_date (needs --no-system)")
    if strength:
        g.add_argument("--strength", default=REASONING, choices=[*STRENGTHS, DEFAULT_STRENGTH],
                       help=f"reasoning strength ({REASONING}); '{DEFAULT_STRENGTH}' sends none (the template writes high)")
    d = ap.add_argument_group("decoding; the default is greedy")
    d.add_argument("--temperature", type=float, default=0.0)
    d.add_argument("--top-p", type=float)
    d.add_argument("--top-k", type=int)
    d.add_argument("--seed", type=int)


def prompt_settings(a, ap):
    """SETTINGS_DEFAULTS' keys, but repeat, from parsed arguments; ap.error on a combination that wouldn't do what it says."""
    if a.system_file:
        with open(a.system_file) as f:
            system = f.read().removesuffix("\n")
    else:
        system = None if a.no_system else SYSTEM if a.system is None else a.system
    for name in ("knowledge_cutoff", "current_date"):
        value = getattr(a, name)
        if value and not DAY.match(value):
            ap.error(f"--{name.replace('_', '-')} takes YYYY-MM-DD")
    if (a.knowledge_cutoff or a.current_date) and system is not None:
        ap.error("--knowledge-cutoff and --current-date need --no-system: the template writes those lines only without a system "
                 "message, so put them in the --system text instead")
    if a.temperature < 0:
        ap.error("--temperature can't be negative")
    sampling = a.temperature > 0
    if not sampling and (a.top_p is not None or a.top_k is not None or a.seed is not None):
        ap.error("--top-p, --top-k and --seed go with --temperature above 0 (the default is greedy)")
    return {"system": system, "strength": None if a.strength == DEFAULT_STRENGTH else a.strength,
            "knowledge_cutoff": a.knowledge_cutoff, "current_date": a.current_date, "temperature": a.temperature,
            "top_p": (1.0 if a.top_p is None else a.top_p) if sampling else None,
            "top_k": (0 if a.top_k is None else a.top_k) if sampling else None,
            "seed": (0 if a.seed is None else a.seed) if sampling else None}


def answerer_kwargs(settings):
    sampling = {k: settings[k] for k in ("temperature", "top_p", "top_k")} if settings["temperature"] > 0 else None
    return {"system": settings["system"], "strength": settings["strength"], "knowledge_cutoff": settings["knowledge_cutoff"],
            "current_date": settings["current_date"], "sampling": sampling}


def rendered(prompt_of):
    """What the meta file says about the prompt actually rendered, from a prompt(question) function."""
    text = prompt_of(PLACEHOLDER)
    return {"rendered_system_block": system_block(text), "prompt_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "prompt_question": PLACEHOLDER}


def ended(raw):
    """The output reached an end token before the limit; final_answer() cuts at the same tokens."""
    return any(t in raw for t in FINAL_ENDS + ("<|start|>",))


def result(i, item, raw):
    reply = final_answer(raw)
    return {"i": i, **{k: item.get(k) for k in KEEP if k in item}, "reply": reply, "right": answered(reply, item), "ended": ended(raw)}


def shard_path(out, shard, shards):
    return f"{out}.shard-{shard}-of-{shards}.jsonl"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def row_key(row):
    return row["i"], row.get("r", 0)


def load_done(path):
    """The finished (i, r) of a shard file. A half-written last line (a stop mid-write) is dropped from the file, so the
    next append starts on a clean line."""
    if not os.path.exists(path):
        return {}
    rows = {}
    good = []
    with open(path) as f:
        for line in f:
            try:
                rows[row_key(json.loads(line))] = True
                good.append(line)
            except (ValueError, KeyError):
                pass
    with open(path + ".tmp", "w") as f:
        f.writelines(line if line.endswith("\n") else line + "\n" for line in good)
    os.replace(path + ".tmp", path)
    return rows


def setting(meta, key):
    return meta.get(key, SETTINGS_DEFAULTS.get(key))


def check_meta(path, meta):
    """A shard restarted with another adapter, question file or setting would mix two runs' answers: stop instead."""
    if os.path.exists(path):
        with open(path) as f:
            old = json.load(f)
        changed = [k for k in SAME if setting(old, k) != setting(meta, k)]
        if changed:
            raise SystemExit(f"{path} was written with a different {', '.join(changed)}; use another --out")
    with open(path + ".tmp", "w") as f:
        json.dump(meta, f, indent=1)
    os.replace(path + ".tmp", path)


def run_shard(questions, ask, path, shard, shards, batch, log=print, repeat=1, reseed=None, seed=None):
    """Answers this shard's questions (each `repeat` times) that aren't in `path` yet. ask(list of questions) gives (raw, tokens)
    pairs; reseed(value), when given, runs before every batch."""
    done = load_done(path)
    mine = [(i, q) for i, q in enumerate(questions) if i % shards == shard]
    todo = [[(i, q) for i, q in mine if (i, r) not in done] for r in range(repeat)]
    total = sum(len(t) for t in todo)
    log(f"MEASURE shard {shard} of {shards}: {total} to do, {len(done)} already done" + (f", {repeat} repeats" if repeat > 1 else ""))
    began, right, finished, batches = time.time(), 0, 0, 0
    with open(path, "a") as f:
        for r, items in enumerate(todo):
            for start in range(0, len(items), batch):
                chunk = items[start:start + batch]
                if reseed is not None:
                    reseed(batch_seed(seed, r, chunk[0][0]))
                replies = ask([q["question"] for _, q in chunk])
                rows = [result(i, q, raw) | ({"r": r} if repeat > 1 else {}) for (i, q), (raw, _) in zip(chunk, replies)]
                right += sum(x["right"] for x in rows)
                f.writelines(json.dumps(x, ensure_ascii=False) + "\n" for x in rows)
                f.flush()
                os.fsync(f.fileno())
                finished += len(chunk)
                if batches % 10 == 0 or finished == total:
                    log(f"MEASURE shard {shard}: {finished} of {total}, {right} right, {finished / max(time.time() - began, 1e-9):.2f} questions/s")
                batches += 1
    return total


def merge(questions, out, shards, allow_partial=False):
    rows, metas = {}, []
    for s in range(shards):
        path = shard_path(out, s, shards)
        if os.path.exists(path):
            for line in open(path):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r["i"] % shards != s or r["i"] >= len(questions) or r["question"] != questions[r["i"]]["question"]:
                    raise SystemExit(f"{path}: row {r['i']} doesn't fit this question file and shard")
                rows[row_key(r)] = r
        if os.path.exists(path + ".meta.json"):
            with open(path + ".meta.json") as f:
                metas.append(json.load(f))
    if len({tuple(setting(m, k) for k in SAME) for m in metas}) > 1:
        raise SystemExit("the shards were written with different adapters, question files or settings")
    repeat = int(setting(metas[0], "repeat")) if metas else 1 + max((k[1] for k in rows), default=0)
    if any(k[1] >= repeat for k in rows):
        raise SystemExit(f"rows with a repeat beyond the {repeat} the meta file says")
    missing = len(questions) * repeat - len(rows)
    with open(out + ".tmp", "w") as f:
        f.writelines(json.dumps(rows[k], ensure_ascii=False) + "\n" for k in sorted(rows))
    os.replace(out + ".tmp", out)
    if metas:
        with open(out + ".meta.json", "w") as f:
            json.dump({k: v for k, v in metas[0].items() if k != "shard"}, f, indent=1)
    right = sum(r["right"] for r in rows.values())
    summary = {"questions": len(questions), "answered": len(rows), "missing": missing, "right": right,
               "accuracy": round(right / max(1, len(rows)), 4), "hit_token_limit": sum(not r["ended"] for r in rows.values())}
    if repeat > 1:
        per = [[r["right"] for k, r in rows.items() if k[1] == rep] for rep in range(repeat)]
        summary |= {"repeat": repeat, "accuracy_by_repeat": [round(sum(p) / max(1, len(p)), 4) for p in per]}
    print("MEASURE " + json.dumps(summary), flush=True)
    if missing and not allow_partial:
        raise SystemExit(f"{missing} questions have no answer yet; rerun the shards (they carry on) or pass --allow-partial")
    return summary


def render_only(a, settings):
    """The system block these settings render, from a tokenizer folder, with no weights loaded (the processor when one loads,
    since that is what Unsloth hands the Answerer)."""
    folder = a.tokenizer or (a.adapter if a.adapter and a.adapter != "none" else None)
    if not folder:
        raise SystemExit("--render-only needs --tokenizer DIR or an --adapter folder holding the tokenizer files")
    import transformers
    try:
        tok = transformers.AutoProcessor.from_pretrained(folder)
    except Exception:  # noqa: BLE001  a folder without the image processor's dependencies still renders text
        tok = transformers.AutoTokenizer.from_pretrained(folder)
    text_tok = getattr(tok, "tokenizer", tok)
    bos = getattr(tok, "bos_token", None) or getattr(text_tok, "bos_token", None) or ""
    info = rendered(lambda q: render_prompt(tok, q, bos, settings["system"], settings["strength"], settings["knowledge_cutoff"], settings["current_date"]))
    print(json.dumps({"rendered_by": type(tok).__name__, "settings": settings, **info}, ensure_ascii=False, indent=1))


def parse(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", help="an adapter folder, or none for the base model")
    ap.add_argument("--questions")
    ap.add_argument("--out")
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--shards", type=int, default=1)
    ap.add_argument("--batch", type=int, default=GEN_BATCH)
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--allow-partial", action="store_true")
    ap.add_argument("--repeat", type=int, default=1, help="answer every question this many times (sampling only)")
    ap.add_argument("--render-only", action="store_true", help="print the rendered system block for these settings and exit")
    ap.add_argument("--tokenizer", help="a folder with the tokenizer files, for --render-only")
    add_prompt_args(ap)
    a = ap.parse_args(argv)
    settings = prompt_settings(a, ap)
    if a.repeat < 1:
        ap.error("--repeat is at least 1")
    if a.repeat > 1 and not settings["temperature"]:
        ap.error("--repeat above 1 needs --temperature above 0: greedy gives the same reply every time")
    settings["repeat"] = a.repeat
    if not a.render_only and not (a.questions and a.out):
        ap.error("--questions and --out are needed")
    if not (a.merge or a.render_only) and (not a.adapter or not 0 <= a.shard < a.shards):
        ap.error("answering needs --adapter (a folder or none) and a --shard below --shards")
    return a, settings


def main():
    a, settings = parse()
    if a.render_only:
        render_only(a, settings)
        return
    questions = read_jsonl(a.questions)
    if a.merge:
        merge(questions, a.out, a.shards, a.allow_partial)
        return
    os.environ["CUDA_VISIBLE_DEVICES"] = str(a.gpu)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    path = shard_path(a.out, a.shard, a.shards)
    adapter = None if a.adapter == "none" else a.adapter
    meta = {
        "adapter": a.adapter, "adapter_sha256": sha256_file(os.path.join(adapter, "adapter_model.safetensors")) if adapter else "none",
        "questions": a.questions, "questions_sha256": sha256_file(a.questions), "model": MODEL, "revision": MODEL_REVISION,
        "load_in_4bit": LOAD_IN_4BIT, "max_new_tokens": MAX_NEW_TOKENS, "batch": a.batch, "shard": a.shard, "shards": a.shards,
        **settings, "no_system": settings["system"] is None,
        "seeding": "per batch: (seed + r) * 1000003 + first question index" if settings["temperature"] else None,
    }
    check_meta(path + ".meta.json", meta)
    answerer = Answerer(adapter, **answerer_kwargs(settings))
    check_meta(path + ".meta.json", meta | rendered(answerer.prompt))
    print(f"MEASURE shard {a.shard} on GPU {a.gpu}: model and adapter loaded", flush=True)
    sampled = bool(settings["temperature"])
    run_shard(questions, answerer.ask, path, a.shard, a.shards, a.batch, log=lambda m: print(m, flush=True), repeat=a.repeat,
              reseed=answerer.reseed if sampled else None, seed=settings["seed"])
    print(f"MEASURE shard {a.shard} done", flush=True)


if __name__ == "__main__":
    main()
