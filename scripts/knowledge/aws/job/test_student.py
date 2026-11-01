"""CPU-only checks for train_student.py's prompt rendering and response-only masking, plain asserts so it runs without
pytest or a GPU, and without model weights:

    uv run --no-project --python 3.12 --with transformers==5.15.0 --with tokenizers==0.22.2 --with jinja2 \\
      python -I scripts/knowledge/aws/job/test_student.py [--tokenizer DIR] [--rows N]

Without transformers only the stdlib part runs (response_labels on made-up ids, final_answer, probe_split,
grad_accum_for, the LoRA layout and KV producers from Bolt's config, the safetensors header reader). With it, the real
tokenizer part runs too, on Bolt's own tokenizer and chat_template.jinja at the pinned revision (the tokenizer files
only, about 32 MB: read from the Hugging Face cache, or downloaded when missing): the rendered training text and the
generation prompt byte for byte, thinking off by default and when asked, the marker and end token ids, and on real
rows of train-student.jsonl (the first N plus every replay, cutoff and after-cutoff kind found), tokenized as the
trainer does, that the labels train exactly the answers and their <turn|>, with one BOS. The check is also shown to
catch broken labels.
"""

import argparse
import json
import os
import struct
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import train_student as ts  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
DATASET = os.path.join(ROOT, ".data", "knowledge", "dataset")
FORGET = os.path.join(ROOT, "scripts", "knowledge", "aws", "forget.jsonl")
BOLT = ts.PROFILES["bolt"]
TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "config.json", "generation_config.json",
                   "special_tokens_map.json", "vocab.json", "merges.txt"]

passed = []


def ok(name):
    passed.append(name)


def rows(path, limit=None):
    out = []
    with open(path) as f:
        for line in f:
            if line.strip():
                out.append(json.loads(line))
                if limit and len(out) >= limit:
                    break
    return out


# ---- stdlib only ----

def check_response_labels():
    I, R = [105, 2364, 107], [105, 4368, 107]
    sys_turn = [2, 105, 9731, 107, 10, 11, 106, 107]
    one = sys_turn + I + [20, 21, 106, 107] + R + [30, 31, 106, 107]
    got = ts.response_labels(one, I, R)
    assert got == [-100] * (len(one) - 4) + [30, 31, 106, 107], got
    # Two turns: both answers train, with their end of turn; the user turn between them doesn't.
    two = sys_turn + I + [20, 106, 107] + R + [30, 106, 107] + I + [40, 106, 107] + R + [50, 51, 106, 107]
    got = ts.response_labels(two, I, R)
    trained = [t for t, label in zip(two, got) if label != -100]
    assert trained == [30, 106, 107, 50, 51, 106, 107], trained
    assert ts.response_labels(sys_turn + I + [20, 106, 107], I, R) == [-100] * 14
    # A response marker at the very end trains nothing; one cut mid-answer trains to the end.
    assert set(ts.response_labels(sys_turn + I + [20] + R, I, R)) == {-100}
    cut = sys_turn + I + [20] + R + [30, 31]
    assert ts.response_labels(cut, I, R)[-2:] == [30, 31]
    ok("response_labels on made-up ids")


def check_final_answer():
    cases = [("Canberra<turn|>\n", "Canberra"), ("Canberra<turn|><pad><pad>", "Canberra"), ("Mars<eos>", "Mars"),
             ("<|channel>thought\nThe Red Planet.<channel|>Mars<turn|>", "Mars"), ("<|channel>thought\nnever closes", ""),
             ("  Paris  <|turn>user\nmore", "Paris"), ("call<|tool_response>", "call"), ("no end at all", "no end at all")]
    for raw, want in cases:
        assert ts.final_answer(raw, BOLT) == want, (raw, ts.final_answer(raw, BOLT))
    ok(f"final_answer on {len(cases) + 1} replies")


def check_probe_split():
    base = [{"question": "a", "passageId": "p1", "right": False}, {"question": "b", "passageId": "p2", "right": True},
            {"question": "c", "passageId": "p3", "right": False}, {"question": "d", "passageId": "p9", "right": True}]
    tuned = [dict(r, right=r["question"] in ("a", "c")) for r in base]
    s = ts.probe_split({"base": base, "tuned": tuned}, covered={"p1", "p2", "p3"}, fixed={"a", "b"})
    assert s["all"] == {"n": 4, "base_right": 2, "base_accuracy": 0.5, "tuned_right": 2, "tuned_accuracy": 0.5, "newly_right": 2, "newly_wrong": 2}, s["all"]
    assert s["fixed"]["n"] == 2 and s["new"]["n"] == 2 and s["covered"]["n"] == 3 and s["not_covered"]["n"] == 1
    assert s["new/covered"]["tuned_right"] == 1 and s["new/not_covered"]["base_right"] == 1 and "fixed/not_covered" not in s
    one = ts.probe_split({"gguf": tuned}, set(), {"a"})
    assert one["not_covered"]["n"] == 4 and "newly_right" not in one["all"]
    try:
        ts.probe_split({"base": base, "tuned": tuned[::-1]}, set(), set())
        raise AssertionError("answers in another order weren't refused")
    except RuntimeError:
        pass
    ok("probe_split groups and counts")


def check_settings():
    assert [ts.grad_accum_for(b, w) for b, w in ((4, 8), (4, 1), (8, 1), (16, 8), (4, 2))] == [1, 8, 4, 1, 4]
    h = ts.hyper({"epochs": 1.0, "max_examples": None, "eval_probes": 200})
    assert (h["epochs"], h["eval_probes"], h["lora_rank"], h["lora_alpha"], h["learning_rate"], h["masking"]) == (1.0, 200, 128, 128, 2e-4, "unsloth"), h
    ok("hyperparameter defaults and grad_accum_for")


def check_layout(config_path):
    with open(config_path) as f:
        text = json.load(f)["text_config"]
    cfg = types.SimpleNamespace(**text)
    want = ts.expected_lora_modules(cfg)
    assert len(want) == 258 and 2 * len(want) == 516, len(want)
    assert (23, "self_attn.k_proj") in want and (24, "self_attn.k_proj") not in want and (41, "self_attn.q_proj") in want
    assert ts.kv_producers(cfg) == [22, 23], ts.kv_producers(cfg)
    ok("Bolt LoRA layout (258 modules, 516 tensors) and KV producers 22, 23")


def check_headers():
    with tempfile.TemporaryDirectory() as d:
        head = json.dumps({"__metadata__": {"format": "pt"}, "x.lora_A.weight": {"dtype": "BF16", "shape": [2, 3], "data_offsets": [0, 12]},
                           "x.lora_B.weight": {"dtype": "F32", "shape": [3, 2], "data_offsets": [12, 36]}}).encode()
        with open(os.path.join(d, "adapter_model.safetensors"), "wb") as f:
            f.write(struct.pack("<Q", len(head)) + head + bytes(36))
        assert ts.adapter_tensors(d) == 2
        assert ts.st_header(os.path.join(d, "adapter_model.safetensors"))["x.lora_B.weight"] == ("F32", (3, 2), 24)
    ok("safetensors header reader")


def check_fixed():
    stage2, fixed_file = os.path.join(DATASET, "stage2-eval-probes.jsonl"), os.path.join(DATASET, "eval-probes.jsonl")
    if not (os.path.exists(stage2) and os.path.exists(fixed_file)):
        print("skip: the probe files aren't here")
        return
    a, _ = ts.fixed_questions(fixed_file, stage2)
    b, how = ts.fixed_questions("", stage2)
    assert len(a) == 1500 and a == b, (len(a), len(b), how)
    ok("the fixed 1,500 are the first 1,500 lines of stage2-eval-probes.jsonl")


def cached(profile, name):
    """A file of the profile's pinned snapshot in the Hugging Face cache, or None."""
    hub = os.environ.get("HF_HUB_CACHE") or os.path.join(os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface"), "hub")
    path = os.path.join(hub, "models--" + profile["model"].replace("/", "--"), "snapshots", profile["revision"], name)
    return path if os.path.exists(path) else None


def check_merge():
    """merge() on a made-up two-shard model with a shared-K/V file, in BF16, against the LoRA formula."""
    import contextlib
    import io
    import torch
    from safetensors.torch import load_file, save_file
    g = torch.Generator().manual_seed(5)
    with tempfile.TemporaryDirectory() as d:
        base, adapter, out = os.path.join(d, "base"), os.path.join(d, "adapter"), os.path.join(d, "merged")
        os.makedirs(base)
        os.makedirs(adapter)
        weights = {"model.language_model.layers.0.self_attn.q_proj.weight": torch.randn(8, 6, generator=g).bfloat16(),
                   "model.language_model.layers.0.mlp.down_proj.weight": torch.randn(6, 10, generator=g).bfloat16(),
                   "model.language_model.norm.weight": torch.randn(6, generator=g).bfloat16(),
                   "model.vision_tower.patch.weight": torch.randn(4, 4, generator=g)}
        shared = {"model.language_model.layers.1.self_attn.k_proj.weight": torch.randn(4, 6, generator=g).bfloat16()}
        save_file(dict(list(weights.items())[:2]), os.path.join(base, "model-00001-of-00002.safetensors"))
        save_file(dict(list(weights.items())[2:]), os.path.join(base, "model-00002-of-00002.safetensors"))
        save_file(shared, os.path.join(base, ts.SHARED_KV_FILE))
        wmap = {k: f"model-0000{1 + i // 2}-of-00002.safetensors" for i, k in enumerate(weights)}
        wmap.update({k: ts.SHARED_KV_FILE for k in shared})
        with open(os.path.join(base, "model.safetensors.index.json"), "w") as f:
            json.dump({"metadata": {}, "weight_map": wmap}, f)
        for name in ("config.json", "chat_template.jinja", "README.md"):
            with open(os.path.join(base, name), "w") as f:
                f.write("{}" if name.endswith(".json") else name)
        r, alpha = 4, 8
        lora = {}
        for k in list(weights)[:2]:
            stem = "base_model.model." + k[: -len(".weight")]
            o, i = weights[k].shape
            lora[stem + ".lora_A.weight"] = torch.randn(r, i, generator=g).bfloat16()
            lora[stem + ".lora_B.weight"] = torch.randn(o, r, generator=g).bfloat16()
        save_file(lora, os.path.join(adapter, "adapter_model.safetensors"))
        with open(os.path.join(adapter, "adapter_config.json"), "w") as f:
            json.dump({"r": r, "lora_alpha": alpha, "use_rslora": False, "use_dora": False}, f)
        with contextlib.redirect_stdout(io.StringIO()):
            ts.merge(base, adapter, out, os.path.join(d, "report.json"))
        with open(os.path.join(d, "report.json")) as f:
            report = json.load(f)
        assert report["ok"] and report["changed_targeted"] == 2 and report["identical_untargeted"] == 2, report
        merged = {}
        for f in sorted(os.listdir(out)):
            if f.endswith(".safetensors"):
                merged.update(load_file(os.path.join(out, f)))
        for k in list(weights)[:2]:
            stem = "base_model.model." + k[: -len(".weight")]
            want = (weights[k].float() + alpha / r * (lora[stem + ".lora_B.weight"].float() @ lora[stem + ".lora_A.weight"].float())).bfloat16()
            assert torch.equal(merged[k], want), k
        for k in list(weights)[2:]:
            assert torch.equal(merged[k], weights[k]) and merged[k].dtype == weights[k].dtype, k
        assert torch.equal(merged[list(shared)[0]], list(shared.values())[0])
        with open(os.path.join(out, "model.safetensors.index.json")) as f:
            index = json.load(f)["weight_map"]
        assert set(index) == set(wmap) and index[list(shared)[0]] == ts.SHARED_KV_FILE
        assert all(os.path.exists(os.path.join(out, n)) for n in ("config.json", "chat_template.jinja", "README.md", "merge-check.json"))
        assert not os.path.exists(out + ".part")
        # An adapter for a weight the base doesn't have stops the merge.
        lora["base_model.model.model.language_model.layers.9.mlp.up_proj.lora_A.weight"] = torch.zeros(r, 6).bfloat16()
        lora["base_model.model.model.language_model.layers.9.mlp.up_proj.lora_B.weight"] = torch.zeros(6, r).bfloat16()
        save_file(lora, os.path.join(adapter, "adapter_model.safetensors"))
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                ts.merge(base, adapter, os.path.join(d, "merged2"))
            raise AssertionError("an adapter for a missing weight was merged")
        except SystemExit:
            pass
    ok("merge: W + (alpha / r) * B @ A on the targets, every other tensor and the shared-K/V file bit-identical")


# ---- with the real tokenizer ----

def tokenizer_dir(profile, given, fetch):
    if given:
        return given
    from huggingface_hub import snapshot_download
    try:
        return snapshot_download(profile["model"], revision=profile["revision"], allow_patterns=TOKENIZER_FILES, local_files_only=True)
    except Exception:
        if not fetch:
            return None
    return snapshot_download(profile["model"], revision=profile["revision"], allow_patterns=TOKENIZER_FILES, token=False)


def sample_rows(n):
    path = os.path.join(DATASET, "train-student.jsonl")
    if not os.path.exists(path):
        return []
    picked, kinds = [], {}
    with open(path) as f:
        for i, line in enumerate(f):
            row = json.loads(line)
            kind = row["source"].split(":")[0]
            if i < n or (kind in ("replay", "cutoff", "after-cutoff") and kinds.get(kind, 0) < 20):
                picked.append(row)
                kinds[kind] = kinds.get(kind, 0) + 1
            if i >= n and all(kinds.get(k, 0) >= 20 for k in ("replay", "cutoff", "after-cutoff")):
                break
            if i > 200000:
                break
    return picked


def check_tokenizer(folder, profile, train_rows, name):
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(folder)
    template = ts.load_template(folder, tok)
    chat = ts.Chat(tok, template, profile)
    bos_id = tok.bos_token_id
    q, a = "Who won the 2026 race?", "Jane Doe won it."
    msgs = [{"role": "system", "content": ts.SYSTEM}, {"role": "user", "content": q}, {"role": "assistant", "content": a}]
    text = chat.training_text(msgs)
    prompt = chat.prompt(q)
    if profile is BOLT:
        # The sequence's text, BOS included, whichever of the template or the tokenizer supplies the BOS (transformers
        # 5.15's Gemma tokenizer doesn't add one, so here the template's <bos> stays in the text).
        print(f"note {name}: tokenizer adds BOS: {bool(chat.bos)} (add_bos_token {getattr(tok, 'add_bos_token', None)})")
        assert chat.bos + text == f"<bos><|turn>system\n{ts.SYSTEM}<turn|>\n<|turn>user\n{q}<turn|>\n<|turn>model\n{a}<turn|>\n", repr(text)
        assert chat.bos + prompt == f"<bos><|turn>system\n{ts.SYSTEM}<turn|>\n<|turn>user\n{q}<turn|>\n<|turn>model\n", repr(prompt)
        assert chat.instruction_ids == [105, 2364, 107] and chat.response_ids == [105, 4368, 107], (chat.instruction_ids, chat.response_ids)
        ends = [tok.convert_tokens_to_ids(t) for t in profile["ends"]]
        assert ends == [106, 1, 105, 50], ends
        with open(os.path.join(folder, "generation_config.json")) as f:
            assert set(json.load(f)["eos_token_id"]) <= set(ends)
        think = tok.apply_chat_template(msgs[:2], chat_template=template, tokenize=False, add_generation_prompt=True, enable_thinking=True)
        assert "<|think|>" in think and "<|think|>" not in prompt and "<|channel>" not in prompt + text
        default = tok.apply_chat_template(msgs[:2], chat_template=template, tokenize=False, add_generation_prompt=True)
        assert default.removeprefix(chat.bos) == prompt, "the template's default should be thinking off"
    else:
        assert text.endswith(profile["response"] + a + profile["turn_end"]), repr(text)
        assert prompt.endswith(profile["response"]) and "<think>\n\n</think>\n\n" in prompt, repr(prompt)
    assert text.startswith(prompt), "the generation prompt should be the training text up to the answer"
    assert getattr(tok, "chat_template", None) in (None, template), "the tokenizer's template should be the file's"
    ok(f"{name}: training text and generation prompt render byte for byte, thinking off")

    def tokenized(t):
        ids = tok(t)["input_ids"]
        return list(ids)

    ids = tokenized(text)
    if bos_id is not None:
        assert ids[0] == bos_id and ids.count(bos_id) == 1, ids[:4]
        assert tokenized(prompt)[:1] == [bos_id], "a probe prompt must start with BOS too"
    labels = chat.labels(ids)
    assert tok.decode([t for t, label in zip(ids, labels) if label != -100], skip_special_tokens=False) == a + profile["turn_end"]
    assert chat.check(ids, labels, text, msgs) == []
    eos = tok.eos_token_id
    if eos is not None and eos not in ids[-1:]:
        appended = ids + [eos]
        assert chat.check(appended, chat.labels(appended), text, msgs) == [], "an <eos> the trainer appends should pass"
    # The check bites: labels shifted by one token, a doubled BOS, and an example whose answer isn't the row's.
    shifted = [-100] + labels[:-1]
    assert any("differ" in p for p in chat.check(ids, shifted, text, msgs))
    if bos_id is not None:
        assert any("BOS" in p for p in chat.check([bos_id] + ids, None, text, msgs)), "a doubled BOS should be caught"
        assert any("BOS" in p for p in chat.check(ids[1:], None, text, msgs)), "a missing BOS should be caught"
    other = msgs[:2] + [{"role": "assistant", "content": "Someone else."}]
    assert any("not the answers" in p for p in chat.check(ids, labels, text, other))
    ok(f"{name}: labels train exactly the answer and its end of turn; broken labels are caught")

    checked, longest, kinds = 0, 0, {}
    texts, dataset = [], []
    for row in train_rows:
        t = chat.training_text(row["messages"])
        x = tokenized(t)
        problems = chat.check(x, chat.labels(x), t, row["messages"])
        assert not problems, (row["source"], problems)
        checked += 1
        longest = max(longest, len(x))
        kinds[row["source"].split(":")[0]] = kinds.get(row["source"].split(":")[0], 0) + 1
        texts.append(t)
        dataset.append({"input_ids": x, "labels": chat.labels(x)})
    if train_rows:
        assert longest < ts.MAX_SEQ_LENGTH
        stats = ts.check_masking(dataset, texts, train_rows, chat)
        assert stats["checked"] == min(256, len(train_rows)) and stats["first_example_trained_tokens"] > 0, stats
        broken = [dict(d) for d in dataset]
        broken[3]["labels"] = [-100] * len(broken[3]["labels"])
        try:
            ts.check_masking(broken, texts, train_rows, chat)
            raise AssertionError("check_masking let fully masked labels through")
        except RuntimeError:
            pass
        ok(f"{name}: {checked} real training rows ({', '.join(f'{k} {v}' for k, v in sorted(kinds.items()))}) mask right, "
           f"longest {longest} tokens; check_masking stops on a masked-out example")

    probes_file = os.path.join(DATASET, "stage2-eval-probes.jsonl")
    if os.path.exists(probes_file):
        qs = [p["question"] for p in rows(probes_file)] + [p["question"] for p in rows(FORGET)]
        lengths = [len(tok(chat.prompt(x))["input_ids"]) for x in qs]
        assert max(lengths) + ts.MAX_NEW_TOKENS <= 1024, max(lengths)
        ok(f"{name}: {len(qs)} probe and old-fact prompts render; longest {max(lengths)} tokens, inside a 1,024-token slot")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", default=os.environ.get("STUDENT_TOKENIZER", ""), help="Bolt's tokenizer folder")
    ap.add_argument("--rows", type=int, default=400, help="leading rows of train-student.jsonl to check")
    a = ap.parse_args()

    check_response_labels()
    check_final_answer()
    check_probe_split()
    check_settings()
    check_headers()
    check_fixed()
    config = cached(BOLT, "config.json") or (os.path.join(a.tokenizer, "config.json") if a.tokenizer else None)
    if config:
        check_layout(config)
    else:
        print("skip: Bolt's config.json isn't cached, so the LoRA layout check didn't run")
    try:
        import safetensors  # noqa: F401
        import torch  # noqa: F401
        check_merge()
    except ImportError:
        print("skip: no torch and safetensors here, so the merge check didn't run (add --with torch --with safetensors)")
    try:
        import transformers  # noqa: F401
    except ImportError:
        print("skip: no transformers here, so the tokenizer part didn't run (see the command in this file's docstring)")
        transformers = None
    if transformers is not None:
        folder = tokenizer_dir(BOLT, a.tokenizer, fetch=True)
        if not config:
            check_layout(os.path.join(folder, "config.json"))
        train_rows = sample_rows(a.rows)
        check_tokenizer(folder, BOLT, train_rows, "bolt")
    for name in passed:
        print("ok   " + name)
    print(f"ok: {len(passed)} checks pass")


if __name__ == "__main__":
    main()
