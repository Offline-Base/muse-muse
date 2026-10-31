"""Offline checks for train_glimmer.py's per-row labels, check_channels_bf16.py and score_probes_reasoning.py, on this Mac, with
the real tokenizer, template and Unsloth masking and a tiny random Muse Glimmer on CPU. No weights, no GPU, one process (plain
asserts). Reads the adapter folder's tokenizer and the first rows of train-stage2.jsonl; prints counts only.

  uv run --no-project --python 3.12 --with transformers==5.15.0 --with torch==2.11.0 --with torchvision==0.26.0 --with pillow \\
    --with peft==0.21.2 --with datasets==4.8.5 --with accelerate==1.15.0 --with trl==0.22.2 --with unsloth_zoo==2026.10.9 \\
    python -I scripts/knowledge/aws/job/test_glimmer_labels.py [--old-commit 8e90f0f]

1. Labels: the decoded trained span of each row kind at low, medium and high (final only, reasoning, several turns, tool calls)
   through Unsloth's real masking, the collator's padding, and that broken labels are caught.
2. Real rows: stage 2's first rows keep Unsloth's labels exactly, and the first gives the run's logged 37 of 100.
3. train_glimmer.main() run whole on the tiny model (Unsloth's model wrapper stubbed, TRL's real trainer and Unsloth's real masking),
   at --old-commit and now, on a file with no reasoning rows: same token ids, labels, losses and MUSE lines. Then on a mixed file
   under DDP-free CPU, where the reasoning rows train whole.
4. score_reasoning.py: rows rebuilt by reply_row from every stored reply match what the run stored, and --table matches the old
   script's apart from its new lines.
5. greedy_tokens() in chunks with finished rows dropped gives what plain generate() gives, batched and alone, also under PEFT.
6. check_channels_bf16.py's main run on the tiny model, then --table and --gates on its output.
7. score_probes_reasoning.py in both modes, GGUF against a stub llama-server, with hand-counted grades.
"""

import argparse
import contextlib
import copy
import importlib.util
import io
import json
import os
import random
import shutil
import stat
import subprocess
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
ADAPTER = os.path.join(ROOT, ".data/knowledge/runs/stage2-multi/out/adapter")
STAGE2 = os.path.join(ROOT, ".data/knowledge/dataset/train-stage2.jsonl")
TINY_FROM = os.path.join(ROOT, ".data/knowledge/littlebit-dev/runs/s2-0.55-b4/model/config.json")
MODELS = os.path.join(ROOT, ".data/knowledge/models")
SYS = "You are a helpful assistant."
done = []


def ok(name, detail=""):
    done.append(name)
    print(f"ok {len(done)}: {name}{' (' + str(detail) + ')' if detail != '' else ''}", flush=True)


def rows_for_tests():
    """(row, the exact text it must train), written by hand, so nothing here comes from the code under test."""
    user = {"role": "user", "content": "What is 2 + 2?"}
    system = {"role": "system", "content": SYS}
    out = {"final only": ({"messages": [system, user, {"role": "assistant", "content": "It is 4."}]}, "It is 4.<|eot|>")}
    for strength in ("low", "medium", "high"):
        out[f"reasoning {strength}"] = ({"reasoning_strength": strength, "messages": [system, user, {"role": "assistant", "content": "It is 4.", "reasoning_content": f"Add them ({strength})."}]},
                                        f" to=self<|message|>Add them ({strength}).<|eom|><|start|>assistant to=user<|message|>It is 4.<|eot|>")
    out["reasoning on the last turn only"] = ({"messages": [system, user, {"role": "assistant", "content": "Four."}, {"role": "user", "content": "Times 3?"},
                                                            {"role": "assistant", "content": "Twelve.", "reasoning_content": "4 x 3."}]},
                                              "Four.<|eot|> to=self<|message|>4 x 3.<|eom|><|start|>assistant to=user<|message|>Twelve.<|eot|>")
    out["reasoning on both turns"] = ({"messages": [system, user, {"role": "assistant", "content": "Four.", "reasoning_content": "Sum."}, {"role": "user", "content": "Times 3?"},
                                                    {"role": "assistant", "content": "Twelve.", "reasoning_content": "4 x 3."}]},
                                      " to=self<|message|>Sum.<|eom|><|start|>assistant to=user<|message|>Four.<|eot|> to=self<|message|>4 x 3.<|eom|><|start|>assistant to=user<|message|>Twelve.<|eot|>")
    tool = {"type": "function", "function": {"name": "calc.add", "description": "Adds.", "parameters": {"type": "object", "properties": {"a": {"type": "integer"}}}}}
    call = {"id": "c1", "type": "function", "function": {"name": "calc.add", "arguments": {"a": 2}}}
    atem = '<atem:function_calls>\n<atem:invoke name="calc.add">\n<atem:parameter name="a">2</atem:parameter>\n</atem:invoke>\n</atem:function_calls>'
    out["tool call, tool result, final"] = (
        {"reasoning_strength": "medium", "tools": [tool], "messages": [
            system, user, {"role": "assistant", "content": None, "reasoning_content": "Use the tool.", "tool_calls": [call]},
            {"role": "tool", "name": "calc.add", "content": "4"}, {"role": "assistant", "content": "It is 4.", "reasoning_content": "The tool said 4."}]},
        f" to=self<|message|>Use the tool.<|eom|><|start|>assistant to=calc.add<|message|>{atem}<|eot|>"
        " to=self<|message|>The tool said 4.<|eom|><|start|>assistant to=user<|message|>It is 4.<|eot|>")
    return out


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def glimmer_renderer(tg, processor):
    bos = processor.tokenizer.bos_token

    def render(messages, generation, strength=tg.REASONING, tools=None):
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=strength, **({"tools": tools} if tools else {}))
        return text.removeprefix(bos)
    return render


class ZooTrainer:
    """What train_on_responses_only reads from a trainer, with TRL's real collator for this processor."""

    def __init__(self, texts, processor):
        from datasets import Dataset
        from trl.trainer.sft_trainer import DataCollatorForVisionLanguageModeling
        self.train_dataset = Dataset.from_list([{"text": t} for t in texts])
        self.eval_dataset = None
        self.args = types.SimpleNamespace(max_length=2048, dataset_text_field="text", packing=False, remove_unused_columns=True)
        self.processing_class = processor
        self.data_collator = DataCollatorForVisionLanguageModeling(processor)
        self.model = None


def check_label_kinds(tg, processor, zoo_mask):
    tok = processor.tokenizer
    render = glimmer_renderer(tg, processor)
    cases = rows_for_tests()
    rows = [r for r, _ in cases.values()]
    texts = [tg.training_text(r, render) for r in rows]
    for strength in ("low", "medium", "high"):
        assert f"Reasoning strength: {strength}." in texts[list(cases).index(f"reasoning {strength}")]
    trainer = zoo_mask(ZooTrainer(texts, processor), instruction_part=tg.INSTRUCTION_PART, response_part=tg.RESPONSE_PART)
    assert len(trainer.train_dataset) == len(rows), "Unsloth dropped a row"
    final_only_before = {name: tok.decode([t for t in ex["labels"] if t != -100], skip_special_tokens=False) for name, ex in zip(cases, trainer.train_dataset)}
    marks = tg.channel_marks(tok)
    assert marks["prompt"] == [200022, 140680] and marks["header"][2:4] == tok(" to=self", add_special_tokens=False)["input_ids"]
    mapped = trainer.train_dataset.map(lambda b: {"labels": [tg.whole_turn_labels(i, x, marks) for i, x in zip(b["input_ids"], b["labels"])]}, batched=True)
    for (name, (row, want)), ex, text in zip(cases.items(), mapped, texts):
        ids, labels = list(ex["input_ids"]), list(ex["labels"])
        got = tok.decode([t for t, label in zip(ids, labels) if label != -100], skip_special_tokens=False)
        assert got == want, (name, got, want)
        assert all(label in (-100, t) for t, label in zip(ids, labels))
        # The model is given everything up to and including the generation prompt: the first trained token is " to".
        if tg.has_reasoning(row):
            k = next(j for j, m in enumerate(row["messages"]) if m.get("reasoning_content"))
            n = len(tok(render(row["messages"][:k], True, row.get("reasoning_strength", tg.REASONING), row.get("tools")))["input_ids"])
            assert labels[n - 1] == -100 and labels[n] == tok(" to", add_special_tokens=False)["input_ids"][0], name
        else:
            assert labels == list(trainer.train_dataset[list(cases).index(name)]["labels"]), "a row without reasoning changed"
    assert final_only_before["final only"] == "It is 4.<|eot|>"
    assert final_only_before["reasoning low"] == "It is 4.<|eot|>"
    ok("trained spans decode to the hand-written text", f"{len(cases)} row kinds, low, medium, high, tool call")

    report = tg.check_whole_turns(mapped, texts, rows, render, tok)
    assert report["reasoning_rows"] == report["checked"] == len(rows) - 1 and not report["dropped"] and not report["cut_at_max_length"], report
    ok("check_whole_turns passes the right labels", report)

    # A tool result, the prompt and the headers of final-only turns must stay masked: the tool case's text proves it, and
    # labels left at Unsloth's are caught.
    try:
        tg.check_whole_turns(trainer.train_dataset, texts, rows, render, tok)
        raise AssertionError("final-only labels on reasoning rows weren't caught")
    except RuntimeError as e:
        assert "whole-turn labels failed" in str(e)
    broken = [dict(x) for x in mapped]
    broken[1]["labels"] = [t if i > 3 else -100 for i, t in enumerate(broken[1]["input_ids"])]
    try:
        tg.check_whole_turns(broken, texts, rows, render, tok)
        raise AssertionError("over-wide labels weren't caught")
    except RuntimeError:
        pass
    # A literal control token inside reasoning cuts the span short: stop, don't train it quietly.
    bad_row = {"messages": [{"role": "system", "content": SYS}, {"role": "user", "content": "Q?"}, {"role": "assistant", "content": "A.", "reasoning_content": "before <|start|>user<|message|> after"}]}
    bad_text = tg.training_text(bad_row, render)
    t2 = zoo_mask(ZooTrainer([bad_text, texts[0]], processor), instruction_part=tg.INSTRUCTION_PART, response_part=tg.RESPONSE_PART)
    m2 = t2.train_dataset.map(lambda b: {"labels": [tg.whole_turn_labels(i, x, marks) for i, x in zip(b["input_ids"], b["labels"])]}, batched=True)
    try:
        tg.check_whole_turns(m2, [bad_text, texts[0]], [bad_row, rows[0]], render, tok)
        raise AssertionError("a control token inside reasoning wasn't caught")
    except RuntimeError:
        pass
    ok("broken labels stop the run", "final-only on a reasoning row, too wide, control token inside reasoning")

    # What Unsloth does to the collator, then one padded batch: labels pad with -100 and line up with the ids.
    tok.padding_side = "right"
    batch = trainer.data_collator([dict(x) for x in mapped.select([0, 1, len(rows) - 1])])
    assert batch["labels"].shape == batch["input_ids"].shape
    lengths = batch["attention_mask"].sum(1).tolist()
    assert len(set(lengths)) > 1
    for row_i in range(3):
        pad = batch["attention_mask"][row_i] == 0
        assert bool((batch["labels"][row_i][pad] == -100).all())
    tok.padding_side = "left"
    batch = trainer.data_collator([dict(x) for x in mapped.select([0, 1, len(rows) - 1])])
    for row_i in range(3):
        pad = batch["attention_mask"][row_i] == 0
        assert bool((batch["labels"][row_i][pad] == -100).all())
        keep = batch["labels"][row_i] != -100
        assert bool((batch["labels"][row_i][keep] == batch["input_ids"][row_i][keep]).all())
    tok.padding_side = "right"
    ok("collator pads ids and labels alike, either side", type(trainer.data_collator).__name__)
    return marks


def check_real_rows(tg, processor, zoo_mask, marks):
    tok = processor.tokenizer
    render = glimmer_renderer(tg, processor)
    rows = []
    with open(STAGE2) as f:
        for line in f:
            rows.append(json.loads(line))
            if len(rows) >= 3000:
                break
    assert not any(tg.has_reasoning(r) for r in rows)
    texts = [tg.training_text(r, render) for r in rows]
    trainer = zoo_mask(ZooTrainer(texts, processor), instruction_part=tg.INSTRUCTION_PART, response_part=tg.RESPONSE_PART)
    first = trainer.train_dataset[0]
    trained = sum(label != -100 for label in first["labels"])
    assert (trained, len(first["input_ids"])) == (37, 100), (trained, len(first["input_ids"]))
    ok("stage 2's first row gives the run's logged masking", "37 of 100")
    assert first["input_ids"][-1] == tok.convert_tokens_to_ids("<|eot|>"), "the trainer would have added an end token"
    same = sum(tg.whole_turn_labels(list(ex["input_ids"]), ex["labels"], marks) is ex["labels"] for ex in trainer.train_dataset)
    assert same == len(rows)
    for ex, r in zip(trainer.train_dataset, rows):
        got = tok.decode([t for t in ex["labels"] if t != -100], skip_special_tokens=False)
        assert got == "".join(m["content"] + "<|eot|>" for m in r["messages"] if m["role"] == "assistant")
    ok("real rows keep Unsloth's labels, which are the answers and <|eot|>", f"{same} rows")
    return rows


def tiny_config():
    from transformers.models.muse_glimmer.configuration_muse_glimmer import MuseGlimmerConfig
    with open(TINY_FROM) as f:
        c = json.load(f)
    c["text_config"].update(hidden_size=32, intermediate_size=64, num_attention_heads=2, num_key_value_heads=1, head_dim=16, num_hidden_layers=2,
                            layer_types=["sliding_attention", "sliding_attention"], sliding_window=64, layer_rope_theta=[500000.0, 500000.0], qk_scale_factor=1.0)
    c["vision_config"].update(hidden_size=16, intermediate_size=32, num_attention_heads=2, num_hidden_layers=1, layer_types=["window_attention"])
    c["out_hidden_size"], c["projector_hidden_size"] = 32, 16
    return MuseGlimmerConfig(**{k: v for k, v in c.items() if k not in ("architectures", "transformers_version")})


def tiny_model(seed=11):
    import torch
    from transformers.models.muse_glimmer.modeling_muse_glimmer import MuseGlimmerForConditionalGeneration
    torch.manual_seed(seed)
    model = MuseGlimmerForConditionalGeneration(tiny_config()).float().eval()
    return model


def run_main(path, name, folder, rows, processor, stream):
    """train_glimmer.main() whole on the tiny model. Stubbed: Unsloth's FastModel (returns the tiny model and the real processor),
    torch.cuda's device calls, and the three SFT settings only Unsloth or a GPU accepts. Real: TRL's SFTTrainer and Unsloth's masking."""
    import torch
    import trl
    from unsloth_zoo.dataset_utils import train_on_responses_only as zoo
    env = {"KNOWLEDGE_DATA": os.path.join(folder, "data"), "KNOWLEDGE_OUT": os.path.join(folder, "out"), "KNOWLEDGE_CKPT": os.path.join(folder, "ckpt"), "KNOWLEDGE_HYPER": os.path.join(folder, "hyper.json")}
    for d in ("data", "ckpt"):
        os.makedirs(os.path.join(folder, d), exist_ok=True)
    os.environ.update(env)
    probe = {"question": "Q?", "answer": "A"}
    for fname, value in (("train.jsonl", rows), ("probes.jsonl", [probe]), ("forget.jsonl", [probe])):
        with open(os.path.join(env["KNOWLEDGE_DATA"], fname), "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in value)
    with open(env["KNOWLEDGE_HYPER"], "w") as f:
        json.dump({"epochs": 1, "batch_size": 2, "grad_accum": 1, "save_steps": 1000, "tuned_eval": 0, "eval_probes": 1}, f)
    with open(os.path.join(env["KNOWLEDGE_CKPT"], "base.json"), "w") as f:
        json.dump({"probes": [{"right": False}], "forget": [{"right": True}]}, f)

    model = tiny_model()
    model.train()
    captured = {}

    class FastModel:
        @staticmethod
        def from_pretrained(**kw):
            return model, processor

        @staticmethod
        def get_peft_model(m, **kw):
            return m

        @staticmethod
        def for_training(m):
            m.train()

    unsloth = types.ModuleType("unsloth")
    unsloth.FastModel = FastModel
    chat = types.ModuleType("unsloth.chat_templates")
    chat.train_on_responses_only = zoo
    real_config, real_trainer = trl.SFTConfig, trl.SFTTrainer

    def config(**kw):
        kw.pop("loss_type")
        kw.pop("warmup_ratio")
        kw.pop("group_by_length")  # Unsloth's patched config takes these; transformers 5 dropped group_by_length
        kw.update(optim="adamw_torch", use_cpu=True, dataloader_pin_memory=False, disable_tqdm=True)
        return real_config(**kw)

    class Trainer(real_trainer):
        def __init__(self, **kw):
            kw["processing_class"] = kw.pop("tokenizer")
            super().__init__(**kw)

        def create_model_card(self, *a, **kw):
            pass  # reads a template through the real trl package, which this stub stands in front of

        def train(self, **kw):
            captured["input_ids"] = [list(x) for x in self.train_dataset["input_ids"]]
            captured["labels"] = [list(x) for x in self.train_dataset["labels"]]
            captured["collator"] = type(self.data_collator).__name__
            stats = super().train(**kw)
            captured["loss"] = stats.training_loss
            return stats

    fake_trl = types.ModuleType("trl")
    fake_trl.SFTConfig, fake_trl.SFTTrainer = config, Trainer
    saved = {k: sys.modules.get(k) for k in ("unsloth", "unsloth.chat_templates", "trl")}
    sys.modules.update({"unsloth": unsloth, "unsloth.chat_templates": chat, "trl": fake_trl})
    cuda = {k: getattr(torch.cuda, k) for k in ("current_device", "max_memory_reserved", "get_device_name")}
    torch.cuda.current_device, torch.cuda.max_memory_reserved, torch.cuda.get_device_name = (lambda: 0), (lambda: 0), (lambda i=0: "cpu")
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            module = load_module(path, name)
            module.main()
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
        for k, v in cuda.items():
            setattr(torch.cuda, k, v)
    captured["lines"] = [line for line in buf.getvalue().splitlines() if line.startswith("MUSE ")]
    return captured, module


def muse_lines(lines):
    """MUSE lines without clocks and paths."""
    out = []
    for line in lines:
        d = json.loads(line[5:])
        if d["event"] == "progress":
            continue
        for k in ("seconds", "examples_per_second", "examples_per_second_steady", "peak_vram_gb", "peak_vram_gb_per_gpu", "path"):
            d.pop(k, None)
        out.append(d)
    return out


def check_main(old_commit, processor, real_rows):
    now = os.path.join(HERE, "train_glimmer.py")
    with tempfile.TemporaryDirectory(prefix="glimmer-main-") as d:
        old_path = os.path.join(d, "train_glimmer_old.py")
        with open(old_path, "w") as f:
            f.write(subprocess.run(["git", "-C", ROOT, "show", f"{old_commit}:scripts/knowledge/aws/job/train_glimmer.py"], capture_output=True, text=True, check=True).stdout)
        rows = real_rows[:12]
        a, _ = run_main(old_path, "tg_old", os.path.join(d, "old"), rows, processor, None)
        b, module = run_main(now, "tg_new", os.path.join(d, "new"), rows, processor, None)
        for key in ("input_ids", "labels", "collator", "loss"):
            assert a[key] == b[key], key
        assert muse_lines(a["lines"]) == muse_lines(b["lines"]), (muse_lines(a["lines"]), muse_lines(b["lines"]))
        assert not any('"whole_turns"' in line for line in b["lines"])
        ok("no reasoning rows: main() at the old commit and now agree", f"token ids, labels, loss {b['loss']:.6f}, {len(b['lines'])} MUSE lines")

        cases = rows_for_tests()
        mixed = rows[:6] + [copy.deepcopy(r) for r, _ in cases.values()]
        c, _ = run_main(now, "tg_mixed", os.path.join(d, "mixed"), mixed, processor, None)
        report = next(json.loads(line[5:]) for line in c["lines"] if '"whole_turns"' in line)
        assert report["rows"] == report["kept"] == len(mixed) and report["checked"] == report["reasoning_rows"] == len(cases) - 1 and not report["dropped"], report
        tok = processor.tokenizer
        trained = [tok.decode([t for t in labels if t != -100], skip_special_tokens=False) for labels in c["labels"]]
        for want in [w for _, w in cases.values()]:
            assert want in trained, want
        for r, got in zip(rows[:6], trained[:6]):
            assert got == r["messages"][-1]["content"] + "<|eot|>"
        assert c["loss"] > 0
        ok("mixed file: main() trains the reasoning rows whole and the others final only", f"{len(mixed)} rows, real TRL steps on CPU, collator {c['collator']}, whole_turns {report}")
    return module


def check_score_reasoning(tok):
    import score_reasoning as sr
    with open(os.path.join(HERE, "reasoning_probes.jsonl")) as f:
        probes = {x["id"]: x for x in map(json.loads, filter(str.strip, f))}
    fields = ("id", "part", "kind", "subkind", "steps", "mode", "question", "answer", "prompt_tokens", "tokens", "stop", "hit_limit", "looped", "channels", "has_reasoning", "reached_final",
              "reasoning_tokens", "final_tokens", "reasoning", "final", "raw", "got", "had_format", "shape", "header_first", "final_lenient", "reasoning_words", "parsed", "fenced_ok")
    checked, differ, stage1_chat, older = 0, [], None, 0
    for model, name in (("base", "Q4_K_M-medium"), ("base", "Q4_K_M-low"), ("stage1", "Q4_K_M-medium"), ("stage1", "Q4_K_M-low"), ("stage1", "IQ1_S-medium")):
        with open(os.path.join(MODELS, model, "reasoning", name + ".json")) as f:
            d = json.load(f)
        if (model, name) == ("stage1", "Q4_K_M-medium"):
            stage1_chat = sr.chat_counts(d["rows"])
        for stored in d["rows"]:
            toks = tok(stored["raw"], add_special_tokens=False)["input_ids"]
            if len(toks) != stored["tokens"]:
                continue  # decoding then encoding isn't exact for this reply; nothing to compare it on
            it = probes[stored["id"]]
            row = sr.reply_row(it, stored["mode"], [0] * stored["prompt_tokens"], toks, toks, stored["stop"], tok, False)
            checked += 1
            bad = [k for k in fields if k in stored and row.get(k) != stored[k]]
            if it["kind"] != "python" and row["right"] != stored["right"]:
                bad.append("right")
            if "self" not in stored["channels"] and stored["has_reasoning"] and set(bad) == {"has_reasoning", "reasoning_tokens", "reasoning"}:
                # 6 rows of stage 1's medium file: written by an earlier split_channels, which took " to to=self" for a header.
                # Today's strict parse, unchanged by moving it, calls that misspelled, and its channels already say so.
                older += 1
                bad = []
            if bad:
                differ.append((stored["id"], bad))
    assert not differ, differ[:5]
    assert checked > 1000, checked
    assert older == 6, older
    ok("reply_row rebuilds the stored rows", f"{checked} rows from 5 runs, every field, {older} written by an earlier parse")
    assert (stage1_chat["multistep_right"], stage1_chat["multistep_n"]) == (20, 150), stage1_chat
    ok("chat-endpoint count reproduces stage 1's multi-step number", f"{stage1_chat['multistep_right']}/{stage1_chat['multistep_n']}")
    return probes


def check_table_against_old(old_commit):
    with tempfile.TemporaryDirectory(prefix="sr-old-") as d:
        old = os.path.join(d, "score_reasoning_old.py")
        before = subprocess.run(["git", "-C", ROOT, "show", f"{old_commit}:scripts/knowledge/aws/job/score_reasoning.py"], capture_output=True, text=True)
        source = before.stdout if before.returncode == 0 else None
        if source is None:
            # Not in git at this commit: the copy taken before the edit, when given.
            saved = os.environ.get("SCORE_REASONING_BEFORE")
            if not saved:
                print("skip: no old score_reasoning.py to compare the table with (set SCORE_REASONING_BEFORE)", flush=True)
                return
            with open(saved) as f:
                source = f.read()
        with open(old, "w") as f:
            f.write(source)
        files = [os.path.join(MODELS, "base/reasoning/Q4_K_M-medium.json"), os.path.join(MODELS, "stage1/reasoning/Q4_K_M-medium.json")]
        probes = os.path.join(HERE, "reasoning_probes.jsonl")
        a = subprocess.run([sys.executable, "-I", old, "--table", *files, "--probes", probes], capture_output=True, text=True, check=True).stdout.splitlines()
        b = subprocess.run([sys.executable, "-I", os.path.join(HERE, "score_reasoning.py"), "--table", *files, "--probes", probes], capture_output=True, text=True, check=True).stdout.splitlines()
        new = [x for x in b if "chat endpoint would accept" in x]
        assert len(new) == 2 and [x for x in b if x not in new] == a, "the table changed"
        ok("--table matches the old script apart from the 2 new lines", new[1])


def check_engine(tok):
    import torch
    import check_channels_bf16 as cc
    model = tiny_model()
    rng = random.Random(3)
    prompts = [[200000] + [rng.randrange(1000, 150000) for _ in range(rng.randrange(4, 30))] for _ in range(9)]
    pad = cc.pad_id(tok)

    def plain(ps, n, stops):
        with torch.no_grad():
            ids, mask = cc.left_padded(torch, ps, pad, "cpu")
            out = model.generate(input_ids=ids, attention_mask=mask, max_new_tokens=n, do_sample=False, pad_token_id=pad, eos_token_id=stops)[:, ids.shape[1]:].tolist()
        res = []
        for row in out:
            end = next((k for k, t in enumerate(row) if t in stops), None)
            res.append((row, "limit") if end is None else (row[:end + 1], "eos"))
        return res

    # Random weights never say <|eot|>, so take tokens they do say as the end tokens, for rows ending at different times.
    sample = plain(prompts, 90, [199999])
    counts = {}
    for row, _ in sample:
        for t in row[10:]:
            counts[t] = counts.get(t, 0) + 1
    stops = sorted(counts, key=counts.get, reverse=True)[:2]
    real_stops = cc.stop_ids
    cc.stop_ids = lambda _tok: stops
    try:
        want = [plain([p], 90, stops)[0] for p in prompts]
        together = plain(prompts, 90, stops)
        for chunk in (3, 7, 32):
            for batch in (1, 4, 9):
                got = cc.greedy_tokens(model, torch, tok, prompts, 90, batch, chunk=chunk, device="cpu")
                # Each batch of this size, in one plain generate(), and alone when the size is 1.
                groups = [plain(prompts[i:i + batch], 90, stops) for i in range(0, len(prompts), batch)]
                assert got == [r for g in groups for r in g], (chunk, batch)
                if batch == 1:
                    assert got == want, (chunk, batch)
        lengths = sorted(len(g[0]) for g in together)
        assert lengths[0] < lengths[-1], lengths
        check = cc.batch_check(model, torch, tok, prompts, device="cpu", new_tokens=16)
        ok("chunks with finished rows dropped give plain generate()'s tokens", f"chunks 3, 7, 32, batches 1, 4, 9; replies {lengths[0]} to {lengths[-1]} tokens; padded vs alone {check['same']}/{check['n']}")

        from peft import LoraConfig, get_peft_model
        lora = get_peft_model(tiny_model(), LoraConfig(r=4, lora_alpha=4, target_modules=["q_proj", "o_proj"], lora_dropout=0.0)).eval()
        # Untouched LoRA: the same as the bare model, through PEFT's own generate and forward.
        got = cc.greedy_tokens(lora, torch, tok, prompts, 60, 9, chunk=7, device="cpu")
        bare = cc.greedy_tokens(tiny_model(), torch, tok, prompts, 60, 9, chunk=60, device="cpu")
        assert got == bare
        ok("the same under PEFT", "fresh LoRA")
    finally:
        cc.stop_ids = real_stops


class TinyAnswerer:
    device = "cpu"

    def __init__(self, adapter):
        import torch
        self.torch, self.model = torch, tiny_model()


def check_channels_run(tok_path, tok, folder):
    import check_channels_bf16 as cc
    import measure_known
    real = measure_known.Answerer
    measure_known.Answerer = TinyAnswerer
    out = os.path.join(folder, "tiny.json")
    a = argparse.Namespace(adapter="none", label="tiny", out=out, tokenizer=tok_path, probes=os.path.join(HERE, "reasoning_probes.jsonl"), strength="medium", gpu=0, batch=4, minutes=0, limit=14,
                           max_new_tokens=12, allow_code_exec=False)
    keep_env = {k: os.environ.get(k) for k in ("CUDA_VISIBLE_DEVICES", "UNSLOTH_RETURN_LOGITS")}
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            cc.main_run(a)
    finally:
        measure_known.Answerer = real
        for k, v in keep_env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
    with open(out) as f:
        d = json.load(f)
    c = d["channel"]
    assert d["complete"] and d["n_skipped"] == 0 and d["gguf"] is None
    for key in ("p_to", "p_self", "p_user_first"):
        assert 0 <= c[key] <= 1, key
    assert c["n_header"] > 5 and "free_run" in c
    # Random weights rarely close a reply inside 12 tokens, so the walk may have nothing; run it directly too.
    import torch
    items = [{"question": "What is 2 + 2?"}, {"question": "Name a color, please."}]
    w = cc.walk_probs(tiny_model(), torch, tok, items, ["Add two and two.", "Pick blue."], "medium", 2, "cpu")
    assert {"p_eom", "p_eot", "p_start", "p_assistant", "p_to_second", "p_user", "p_message"} == set(w) and all(len(v) == 2 and 0 <= min(v) <= max(v) <= 1 for v in w.values())
    ok("check_channels main run and the probability walk, on the tiny model", f"{d['n_requests']} replies, P(=self) {c['p_self']:.6f}")
    table = subprocess.run([sys.executable, "-I", os.path.join(HERE, "score_reasoning.py"), "--table", os.path.join(MODELS, "base/reasoning/Q4_K_M-medium.json"), out], capture_output=True, text=True, check=True).stdout
    assert 'P("=self") after " to"' in table and "| complete run |" in table and "not measured" in table
    ok("score_reasoning.py --table reads its JSON beside a GGUF run")

    # Gates: base against itself passes what it can answer; stage 1 fails them.
    base = os.path.join(MODELS, "base/reasoning/Q4_K_M-medium.json")
    run = lambda *x: subprocess.run([sys.executable, "-I", os.path.join(HERE, "check_channels_bf16.py"), "--gates", *x], capture_output=True, text=True)
    good = run(base, "--base", base, "--header", os.path.join(MODELS, "base/reasoning/Q4_K_M-header.json"), "--vision", os.path.join(MODELS, "base/reasoning/Q4_K_M-vision2.json"))
    assert good.returncode == 0 and "FAIL" not in good.stdout, good.stdout + good.stderr
    bad = run(os.path.join(MODELS, "stage1/reasoning/Q4_K_M-medium.json"), "--base", base, "--header", os.path.join(MODELS, "stage1/reasoning/Q4_K_M-header.json"),
              "--vision", os.path.join(MODELS, "stage1/reasoning/Q4_K_M-vision2.json"))
    assert bad.returncode == 1 and bad.stdout.count("FAIL") == 4, bad.stdout
    off_line = next(x for x in bad.stdout.splitlines() if "reasoning off" in x)
    assert off_line.startswith("PASS"), off_line
    ok("--gates: base passes, stage 1 fails P, well formed, multi-step and vision, as measured", off_line.strip())


STUB = r'''
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
with open(%r) as f:
    replies = json.load(f)
count = [0]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        self._send({"status": "ok"})
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        r = replies[count[0] %% len(replies)]; count[0] += 1
        self._send({"tokens": r, "stop_type": "eos"})
HTTPServer(("127.0.0.1", port), H).serve_forever()
'''


def check_probes_script(tok_path, tok, folder):
    import score_probes_reasoning as spr
    probes = [{"question": f"Which city is number {i}?", "answer": "Paris"} for i in range(8)]
    pfile, ffile = os.path.join(folder, "p.jsonl"), os.path.join(folder, "f.jsonl")
    with open(pfile, "w") as f:
        f.writelines(json.dumps(p) + "\n" for p in probes)
    with open(ffile, "w") as f:
        f.write(json.dumps({"question": "Which old city?", "answer": "Paris"}) + "\n")
    enc = lambda s: tok(s, add_special_tokens=False)["input_ids"]
    replies = [enc(" to=self<|message|>Think.<|eom|><|start|>assistant to=user<|message|>Paris.<|eot|>"),  # right
               enc(" to=self<|message|>Maybe Paris.<|eom|><|start|>assistant to=user<|message|>I'm not sure.<|eot|>"),  # in reasoning only
               enc(" toself<|message|>Think.<|eom|><|start|>assistant to=user<|message|>Paris.<|eot|>"),  # first header wrong, final right
               enc(" to=self<|message|>Think.<|eom|><|start|>assistant touser<|message|>Paris.<|eot|>")]  # final header misspelled
    rfile = os.path.join(folder, "replies.json")
    with open(rfile, "w") as f:
        json.dump(replies, f)
    stub = os.path.join(folder, "stub.py")
    with open(stub, "w") as f:
        f.write(STUB % rfile)
    wrapper = os.path.join(folder, "llama-server")
    with open(wrapper, "w") as f:
        f.write(f'#!/bin/sh\nexec {sys.executable} -I {stub} "$@"\n')
    os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IEXEC)
    # Prefilled: right on the first 4 of the set as chosen.
    chosen = spr.choose(pfile, ffile, 3, 5)
    assert [x["set"] for x in chosen] == ["fixed"] * 3 + ["new"] * 3 + ["old"]
    fixed_q = [json.loads(x)["question"] for x in open(pfile)][:5]
    shuffled = fixed_q[:]
    random.Random(7).shuffle(shuffled)
    assert [x["question"] for x in chosen[:3]] == shuffled[:3]
    prefilled = os.path.join(folder, "prefilled.json")
    with open(prefilled, "w") as f:
        json.dump({"rows": {"probe": [{"question": x["question"], "right": True} for x in chosen[:6]], "forget": [{"question": chosen[6]["question"], "right": True}]}}, f)
    out = os.path.join(folder, "probes-gguf.json")
    cmd = [sys.executable, "-I", os.path.join(HERE, "score_probes_reasoning.py"), "--gguf", os.path.join(folder, "x.gguf"), "--tokenizer", tok_path, "--label", "stub", "--out", out, "--probes", pfile, "--forget", ffile,
           "--n", "3", "--fixed-n", "5", "--strengths", "medium", "--server", wrapper, "--parallel", "1", "--port", "8097", "--prefilled", prefilled, "--slot-ctx", "1400"]
    run = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "PYTHONPATH": os.pathsep.join(p for p in sys.path if "site-packages" in p)})
    assert run.returncode == 0, run.stdout[-500:] + run.stderr[-1500:]
    with open(out) as f:
        d = json.load(f)
    r = d["runs"]["medium"]
    assert r["complete"], r
    rows = r["rows"]
    fx = r["summary"]["fixed"]
    # Fixed gets replies 1 to 3, in order: right; only in reasoning; first header wrong but final channel right.
    assert fx["final_channel"]["right"] == 2 and fx["any_header"]["right"] == 2 and fx["in_reasoning_not_final"] == 1, fx
    assert fx["well_formed"] == 2 and fx["prefilled_same_questions"]["right"] == 3 and fx["paired_final_vs_prefilled"]["only_a"] == 1, fx
    nw = r["summary"]["new"]
    # New gets replies 4, 1, 2: misspelled final header (wrong strictly, right any header); right; only in reasoning.
    assert nw["final_channel"]["right"] == 1 and nw["any_header"]["right"] == 2 and nw["reached_final"] == 2, nw
    assert r["summary"]["old"]["final_channel"]["n"] == 1
    assert all(q["set"] for q in rows) and sum(x["hit_limit"] for x in rows) == 0
    table = subprocess.run([sys.executable, "-I", os.path.join(HERE, "score_probes_reasoning.py"), "--table", out], capture_output=True, text=True, env={**os.environ, "PYTHONPATH": os.pathsep.join(p for p in sys.path if "site-packages" in p)})
    assert table.returncode == 0 and "2/3" in table.stdout, table.stderr[-500:]
    ok("score_probes_reasoning.py, GGUF mode against a stub server: hand-counted grades", "strict 2/3 and 1/3, any header 2/3 and 2/3")

    import measure_known
    real = measure_known.Answerer
    measure_known.Answerer = TinyAnswerer
    out2 = os.path.join(folder, "probes-adapter.json")
    argv = sys.argv
    sys.argv = ["x", "--adapter", "none", "--tokenizer", tok_path, "--label", "tiny", "--out", out2, "--probes", pfile, "--forget", ffile, "--n", "3", "--fixed-n", "5", "--strengths", "medium,low", "--max-new-tokens", "8", "--batch", "3"]
    keep = os.environ.get("CUDA_VISIBLE_DEVICES")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            spr.main()
    finally:
        sys.argv = argv
        measure_known.Answerer = real
        os.environ.pop("CUDA_VISIBLE_DEVICES", None)
        if keep is not None:
            os.environ["CUDA_VISIBLE_DEVICES"] = keep
    with open(out2) as f:
        d2 = json.load(f)
    assert set(d2["runs"]) == {"medium", "low"} and all(x["complete"] and len(x["rows"]) == 7 for x in d2["runs"].values())
    ok("score_probes_reasoning.py, adapter mode on the tiny model", "both strengths, all 7 rows")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-commit", default="8e90f0f")
    a = ap.parse_args()
    from transformers import AutoProcessor, AutoTokenizer
    from unsloth_zoo.dataset_utils import train_on_responses_only as zoo
    import train_glimmer as tg
    processor = AutoProcessor.from_pretrained(ADAPTER)
    tok = AutoTokenizer.from_pretrained(ADAPTER)
    marks = check_label_kinds(tg, processor, zoo)
    real_rows = check_real_rows(tg, processor, zoo, marks)
    check_main(a.old_commit, processor, real_rows)
    check_score_reasoning(tok)
    check_table_against_old(a.old_commit)
    check_engine(tok)
    folder = tempfile.mkdtemp(prefix="glimmer-tests-")
    try:
        check_channels_run(ADAPTER, tok, folder)
        check_probes_script(ADAPTER, tok, folder)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    print(f"all {len(done)} checks passed", flush=True)


if __name__ == "__main__":
    main()
