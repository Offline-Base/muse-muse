"""Offline checks for B2's test wave (no GPU, no network, no model weights): measure_known.py's prompt and decoding flags,
compare_stage_b.py's swap gates, and job/test_wave_b2.sh.

  python3 scripts/knowledge/aws/test_b2_wave.py
  uv run --offline --no-project --python 3.12 --with transformers==5.15.0 --with jinja2 python -I scripts/knowledge/aws/test_b2_wave.py \
      --tokenizer .data/knowledge/runs/stage2-multi/out/adapter

With --tokenizer (a saved adapter folder: chat_template.jinja, tokenizer.json and tokenizer_config.json, no weights read) it
renders through Glimmer's real chat template and tokenizer and checks that every earlier caller's prompt is unchanged, byte for
byte and token for token, against the measure_known.py committed at HEAD and against a pinned hash, and what each A1 arm
renders. The compare_stage_b.py checks also run on the real compare-b answer files when they are on this Mac (counts only).
"""

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
JOB = os.path.join(HERE, "job")
sys.path[:0] = [HERE, JOB]
import compare_stage_b as C  # noqa: E402
import measure_known as M  # noqa: E402
from train_glimmer import FINAL_CHANNEL, GENERATION_PROMPT, REASONING, SYSTEM  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
COMPARE_B = os.path.join(ROOT, ".data", "knowledge", "runs", "compare-b")
WAVE = os.path.join(JOB, "test_wave_b2.sh")
# sha256 of the default prompt for the question "QUESTION", rendered through stage2-multi's saved tokenizer on Oct 31 (the
# prompt every score before the new flags used), and of its token ids.
GOLDEN_PROMPT = "44aab17a9fc5aecf2a399bae67b9801d1d587f108cce62b4a4cf37c519a7a188"
GOLDEN_IDS = "d2ecbf8177ea3fe8446b7cc88a77f094984f35654512a7b1da66873271b116e7"
QUESTIONS = ["QUESTION", "Who won the 2026 Tour de France?", "Qu'a annonce Meta le 3 juin 2026 ?", "  Leading spaces and a tab\tinside?",
             "A question with <angle> brackets & a newline\nin it?"]
CHECKS = []


def check(fn):
    CHECKS.append(fn)
    return fn


def expect_exit(fn, *args):
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            fn(*args)
    except SystemExit:
        return
    raise AssertionError(f"{fn.__name__}{args} should have exited")


def head_measure_known():
    """measure_known.py as committed at HEAD (before the new flags), loaded as a module, or None outside a git checkout."""
    try:
        text = subprocess.run(["git", "-C", ROOT, "show", "HEAD:scripts/knowledge/aws/job/measure_known.py"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    if "--no-system" in text:
        return None  # HEAD already has the new flags; the pinned hash still holds the line
    mod = types.ModuleType("measure_known_head")
    mod.__file__ = os.path.join(JOB, "measure_known_head.py")
    exec(compile(text, mod.__file__, "exec"), mod.__dict__)
    return mod


# ---- measure_known.py --------------------------------------------------------------------------------------------------

@check
def defaults_are_the_old_settings():
    """No flag means train_glimmer.py's prompt and greedy decoding, in the CLI, the class and score_honesty_bf16.py's parser."""
    a, s = M.parse(["--adapter", "x", "--questions", "q", "--out", "o"])
    assert s == M.SETTINGS_DEFAULTS, s
    assert M.answerer_kwargs(s) == {"system": SYSTEM, "strength": REASONING, "knowledge_cutoff": None, "current_date": None, "sampling": None}
    assert (M.Answerer.system, M.Answerer.strength, M.Answerer.knowledge_cutoff, M.Answerer.current_date, M.Answerer.sampling) == (SYSTEM, REASONING, None, None, None)
    ap = argparse.ArgumentParser()
    ap.add_argument("--strength", default=REASONING)  # score_honesty_bf16.py's own
    M.add_prompt_args(ap, strength=False)
    s2 = M.prompt_settings(ap.parse_args([]), ap)
    assert s2 == {k: v for k, v in M.SETTINGS_DEFAULTS.items() if k != "repeat"}, s2
    assert M.generate_kwargs(96, 7) == {"max_new_tokens": 96, "do_sample": False, "pad_token_id": 7}
    assert M.generate_kwargs(96, 7, M.answerer_kwargs(s)["sampling"]) == {"max_new_tokens": 96, "do_sample": False, "pad_token_id": 7}


@check
def flags_that_cannot_mean_what_they_say_are_refused():
    base = ["--adapter", "x", "--questions", "q", "--out", "o"]
    expect_exit(M.parse, base + ["--knowledge-cutoff", "2026-10-29"])  # the template ignores it beside a system message
    expect_exit(M.parse, base + ["--system", "Hi", "--current-date", "2026-11-01"])
    expect_exit(M.parse, base + ["--no-system", "--knowledge-cutoff", "Oct 29"])
    expect_exit(M.parse, base + ["--system", "a", "--no-system"])
    expect_exit(M.parse, base + ["--repeat", "3"])  # greedy repeats are the same reply
    expect_exit(M.parse, base + ["--top-k", "64"])
    expect_exit(M.parse, base + ["--seed", "1"])
    expect_exit(M.parse, base + ["--strength", "extreme"])
    expect_exit(M.parse, ["--questions", "q", "--out", "o"])  # answering needs an adapter (or none)
    _, s = M.parse(base + ["--no-system", "--knowledge-cutoff", "2026-10-29", "--current-date", "2026-11-01", "--strength", "default"])
    assert s["system"] is None and s["strength"] is None and s["knowledge_cutoff"] == "2026-10-29" and s["current_date"] == "2026-11-01"
    _, s = M.parse(base + ["--temperature", "1.0", "--top-p", "0.95", "--top-k", "64", "--seed", "1", "--repeat", "3"])
    assert (s["temperature"], s["top_p"], s["top_k"], s["seed"], s["repeat"]) == (1.0, 0.95, 64, 1, 3)
    kw = M.generate_kwargs(96, 7, M.answerer_kwargs(s)["sampling"])
    assert kw == {"max_new_tokens": 96, "do_sample": True, "pad_token_id": 7, "temperature": 1.0, "top_p": 0.95, "top_k": 64}, kw
    _, s = M.parse(base + ["--temperature", "0.6"])
    assert (s["top_p"], s["top_k"], s["seed"]) == (1.0, 0, 0), "sampling writes every knob out, so the generation config adds none"
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "system.txt")
        with open(path, "w") as f:
            f.write("Line one.\nLine two.\n")
        _, s = M.parse(base + ["--system-file", path])
        assert s["system"] == "Line one.\nLine two.", repr(s["system"])
    _, s = M.parse(["--adapter", "none", "--questions", "q", "--out", "o"])
    assert s == M.SETTINGS_DEFAULTS


@check
def repeats_resume_merge_and_seed():
    qs = [{"question": f"q{i}?", "answer": f"a{i}", "aliases": []} for i in range(7)]
    seeds = []

    def ask(questions):
        return [(f"It was a{q[1:-1]}.<|eot|>", 4) for q in questions]

    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "out.jsonl")
        meta = {"adapter_sha256": "a", "questions_sha256": "q", "model": "m", "revision": "r", "max_new_tokens": 96,
                **M.SETTINGS_DEFAULTS, "temperature": 1.0, "top_p": 0.95, "top_k": 64, "seed": 5, "repeat": 3}
        for shard in range(2):
            path = M.shard_path(out, shard, 2)
            M.check_meta(path + ".meta.json", meta | {"shard": shard})
            n = M.run_shard(qs, ask, path, shard, 2, 2, log=lambda m: None, repeat=3, reseed=seeds.append, seed=5)
            assert n == 3 * len(range(shard, 7, 2))
        assert seeds[0] == M.batch_seed(5, 0, 0) == 5 * 1000003 and M.batch_seed(5, 2, 4) == 7 * 1000003 + 4
        with contextlib.redirect_stdout(io.StringIO()):
            summary = M.merge(qs, out, 2)
        assert summary["answered"] == 21 and summary["missing"] == 0 and summary["repeat"] == 3 and summary["accuracy_by_repeat"] == [1.0] * 3
        rows = [json.loads(line) for line in open(out)]
        assert [(r["i"], r["r"]) for r in rows] == sorted((i, r) for i in range(7) for r in range(3))
        assert M.run_shard(qs, ask, M.shard_path(out, 1, 2), 1, 2, 2, log=lambda m: None, repeat=3) == 0, "resume does only what's left"
        # A shard restarted with another setting stops, so two runs' replies never mix.
        expect_exit(M.check_meta, M.shard_path(out, 0, 2) + ".meta.json", meta | {"seed": 6})
        expect_exit(M.check_meta, M.shard_path(out, 0, 2) + ".meta.json", meta | {"system": None})
        # Losing a repeat's rows shows as missing.
        path = M.shard_path(out, 0, 2)
        keep = [line for line in open(path) if json.loads(line).get("r") != 2]
        with open(path, "w") as f:
            f.writelines(keep)
        with contextlib.redirect_stdout(io.StringIO()):
            expect_exit(M.merge, qs, out, 2)
    # An old meta file has none of the new keys: it reads as the defaults, so old shards still carry on, and refuse a change.
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "m.json")
        old = {"adapter_sha256": "a", "questions_sha256": "q", "model": "m", "revision": "r", "max_new_tokens": 96, "batch": 32}
        with open(path, "w") as f:
            json.dump(old, f)
        M.check_meta(path, old | M.SETTINGS_DEFAULTS | {"no_system": False})
        with open(path, "w") as f:
            json.dump(old, f)
        expect_exit(M.check_meta, path, old | M.SETTINGS_DEFAULTS | {"strength": "high"})
    # Greedy rows look exactly as before: no r field.
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "s.jsonl")
        M.run_shard(qs, ask, path, 0, 1, 4, log=lambda m: None)
        rows = [json.loads(line) for line in open(path)]
        assert all(set(r) == {"i", "question", "answer", "aliases", "reply", "right", "ended"} for r in rows), rows[0]


def check_tokenizer(folder):
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(folder)
    bos = tok.bos_token or ""
    head = head_measure_known()

    def fake(module, **settings):
        a = object.__new__(module.Answerer)  # test_stage_b.py's stand-in: no model, only what prompt() reads
        a.tokenizer, a.bos = tok, bos
        for k, v in settings.items():
            setattr(a, k, v)
        return a

    for q in QUESTIONS:
        old = tok.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}], tokenize=False,
                                      add_generation_prompt=True, reasoning_strength=REASONING).removeprefix(bos) + FINAL_CHANNEL
        _, s = M.parse(["--adapter", "x", "--questions", "q", "--out", "o"])
        new = [M.render_prompt(tok, q, bos), fake(M).prompt(q), fake(M, **{k: v for k, v in M.answerer_kwargs(s).items() if k != "sampling"}).prompt(q),
               M.render_prompt(tok, q, bos, **{k: v for k, v in M.answerer_kwargs(s).items() if k != "sampling"})]
        if head is not None:
            new.append(fake(head).prompt(q))
        assert all(x == old for x in new), (q, [x == old for x in new])
        ids = tok(old, add_special_tokens=False)["input_ids"]
        assert all(tok(x, add_special_tokens=False)["input_ids"] == ids for x in new)
    p = M.render_prompt(tok, "QUESTION", bos)
    assert hashlib.sha256(p.encode()).hexdigest() == GOLDEN_PROMPT, "the default prompt changed"
    assert hashlib.sha256(str(tok(p, add_special_tokens=False)["input_ids"]).encode()).hexdigest() == GOLDEN_IDS, "the default token ids changed"
    print(f"ok tokenizer: the default prompt is unchanged on {len(QUESTIONS)} questions"
          + (" against HEAD's measure_known.py," if head else ",") + " the old inline call and the pinned hash, as text and as token ids")

    def block(**kw):
        text = M.render_prompt(tok, "QUESTION", bos, **kw)
        assert text.endswith(GENERATION_PROMPT + FINAL_CHANNEL)
        return M.system_block(text)

    p0 = block()
    assert "You are a helpful assistant.\n\nReasoning strength: low." in p0 and "Knowledge cutoff" not in p0 and "Current date" not in p0
    assert "Reasoning strength: high." in block(strength="high")
    p1 = block(system="You are a helpful assistant.\nKnowledge cutoff: 2026-10-29.\nCurrent date: 2026-11-01.")
    assert "You are a helpful assistant.\nKnowledge cutoff: 2026-10-29.\nCurrent date: 2026-11-01.\n\nReasoning strength: low." in p1, p1
    p2 = block(system=None, knowledge_cutoff="2026-10-29", current_date="2026-11-01")
    assert "You are a helpful AI assistant.\nKnowledge cutoff: 2026-10-29.\nCurrent date: 2026-11-01.\n\nReasoning strength: low." in p2, p2
    p3 = block(system=None, strength=None)
    assert "Knowledge cutoff: 2026-01-04." in p3 and "Reasoning strength: high." in p3 and "\nCurrent date: " in p3, p3
    # The arms as the wave passes them, through --render-only (no weights), in a child of this same interpreter.
    for flags, want in ((["--strength", "high"], "Reasoning strength: high."),
                        (["--no-system", "--knowledge-cutoff", "2026-10-29", "--current-date", "2026-11-01"], "Knowledge cutoff: 2026-10-29.\nCurrent date: 2026-11-01."),
                        (["--system", "You are a helpful assistant.\nKnowledge cutoff: 2026-10-29.\nCurrent date: 2026-11-01."], "Current date: 2026-11-01.\n\nReasoning strength: low.")):
        out = subprocess.run([sys.executable, "-I", os.path.join(JOB, "measure_known.py"), "--render-only", "--tokenizer", folder, *flags],
                             capture_output=True, text=True, check=True).stdout
        got = json.loads(out)
        assert want in got["rendered_system_block"], (flags, got["rendered_system_block"])
    print("ok tokenizer: A1's arms render the system blocks the plan names (P0h high; P1 the lines in the system text; "
          "P2 the template's block with 2026-10-29 and 2026-11-01; P3 2026-01-04 and high), and --render-only shows them")


@check
def ask_passes_the_decoding_through():
    """Answerer.ask with stand-ins for torch, the tokenizer and the model: greedy calls generate() with exactly the old
    arguments, sampling adds temperature, top_p and top_k, and the prompt comes from the instance's settings."""

    class Rows(list):
        shape = property(lambda self: (len(self), len(self[0])))

        def to(self, device):
            return self

    class Row(list):
        def __getitem__(self, i):
            return Row(list.__getitem__(self, i)) if isinstance(i, slice) else list.__getitem__(self, i)

        def __ne__(self, pad):
            return Row(x != pad for x in self)

        def sum(self):
            return sum(self)

    class Tok:
        pad_token_id = 0

        def __call__(self, prompts, return_tensors, padding):
            self.prompts = prompts
            return {"input_ids": Rows(Row([1, 2]) for _ in prompts), "attention_mask": Rows(Row([1, 1]) for _ in prompts)}

        def decode(self, row, skip_special_tokens):
            return "It was Ada.<|eot|>"

    class Model:
        def generate(self, input_ids, attention_mask, **kw):
            self.kw = kw
            return [Row([1, 2, 5, 6, 0]) for _ in input_ids]

    class Template:
        def apply_chat_template(self, messages, tokenize, add_generation_prompt, **kw):
            self.messages, self.kw = messages, kw
            return "<|begin_of_text|>SYS" + GENERATION_PROMPT

    torch = types.SimpleNamespace(no_grad=contextlib.nullcontext, cuda=types.SimpleNamespace(OutOfMemoryError=MemoryError))
    for settings, want in ((M.SETTINGS_DEFAULTS, {"max_new_tokens": 96, "do_sample": False, "pad_token_id": 0}),
                           (M.SETTINGS_DEFAULTS | {"temperature": 0.6, "top_p": 0.95, "top_k": 64, "seed": 1, "system": None, "strength": None,
                                                   "knowledge_cutoff": "2026-10-29", "current_date": "2026-11-01"},
                            {"max_new_tokens": 96, "do_sample": True, "pad_token_id": 0, "temperature": 0.6, "top_p": 0.95, "top_k": 64})):
        a = object.__new__(M.Answerer)
        for k, v in M.answerer_kwargs(settings).items():
            setattr(a, k, v)
        a.torch, a.device, a.text_tokenizer, a.tokenizer, a.bos, a.model = torch, "cpu", Tok(), Template(), "<|begin_of_text|>", Model()
        out = a.ask(["Who?", "Who else?"])
        assert out == [("It was Ada.<|eot|>", 2)] * 2 and a.model.kw == want, (out, a.model.kw)
        if settings["system"] is None:
            assert a.tokenizer.messages == [{"role": "user", "content": "Who else?"}]
            assert a.tokenizer.kw == {"knowledge_cutoff": "2026-10-29", "current_date": "2026-11-01"}, a.tokenizer.kw
        else:
            assert a.tokenizer.messages[0] == {"role": "system", "content": SYSTEM} and a.tokenizer.kw == {"reasoning_strength": REASONING}
        assert a.text_tokenizer.prompts == ["SYS" + GENERATION_PROMPT + FINAL_CHANNEL] * 2


# ---- compare_stage_b.py ------------------------------------------------------------------------------------------------

@check
def paired_counts_and_exact_p():
    p = C.paired([True] * 5 + [False] * 5, [False] * 5 + [False] * 5)
    assert (p["only_a"], p["only_b"]) == (5, 0) and abs(p["p_more"] - 1 / 32) < 1e-12 and p["p_less"] == 1.0 and abs(p["p_two"] - 1 / 16) < 1e-12
    p = C.paired([True, False], [True, False])
    assert p["p_two"] == 1.0 and p["diff"] == 0 and p["se"] == 0
    assert abs(C.tail(3, 4) - 5 / 16) < 1e-12 and C.tail(0, 9) == 1.0
    assert C.band_of(None) == "no training question" and C.band_of(0.39) == "0.2 to 0.4" and C.band_of(0.4) == "0.4 to 0.6" and C.band_of(0.9) == "0.6 and up"


def answers_file(path, probes, forget=None):
    with open(path, "w") as f:
        json.dump({"base": {"probes": probes, "forget": forget or []}, "tuned": {"probes": probes, "forget": forget or []}}, f)
    return path


def dev_file(path, made_up, honest, controls_right, controls_refused, cutoff_good, n_controls=300):
    rows = {"honesty": [], "controls": [], "cutoff": []}
    for i in range(120):
        reply = "It was founded in 1999 by Ada Blorp." if i < made_up else "I have no record of that; I can't confirm it."
        rows["honesty"].append({"id": f"uk-{i}", "kind": "unknowable", "topic": "news", "question": f"What happened {i}?", "bait": [], "note": "", "reply": reply})
    for i in range(n_controls):
        right = i < controls_right
        refused = not right and i < controls_right + controls_refused
        rows["controls"].append({"question": f"Control {i}?", "answer": "Zorbax", "aliases": [], "reply": "Zorbax." if right else "I don't know." if refused else "Quux."})
    for i in range(20):
        rows["cutoff"].append({"question": f"cutoff {i}", "reply": "My knowledge goes up to October 29, 2026." if i < cutoff_good else "I don't know."})
    with open(path, "w") as f:
        json.dump({"label": os.path.basename(path), "rows": rows}, f)
    return path


def run_gates(argv):
    ap_argv = ["compare_stage_b.py", *argv]
    real = sys.argv
    out = io.StringIO()
    try:
        sys.argv = ap_argv
        with contextlib.redirect_stdout(out):
            try:
                C.main()
                code = 0
            except SystemExit as e:
                code = e.code or 0
    finally:
        sys.argv = real
    return code, out.getvalue()


@check
def gates_on_fixtures():
    """H1, H3 to H6, H8 and H9 on small invented runs, and the verdict wording; nothing printed holds a reply."""
    with tempfile.TemporaryDirectory() as tmp:
        n = 200

        def probes(right, refuse):
            return [{"question": f"P{i}?", "answer": "Zorbax", "reply": "Zorbax." if i < right else "I don't know." if i < right + refuse else "Quux.",
                     "right": i < right} for i in range(n)]

        forget = [{"question": f"F{i}?", "answer": "x", "reply": "x", "right": i < 40} for i in range(40)]
        ref = answers_file(os.path.join(tmp, "s2.json"), probes(80, 0))
        base = answers_file(os.path.join(tmp, "r30b.json"), probes(60, 30), forget)
        good = answers_file(os.path.join(tmp, "good.json"), probes(75, 15), forget)
        bad = answers_file(os.path.join(tmp, "bad.json"), probes(40, 60), forget[:38] + [{"question": "F38?", "answer": "x", "reply": "y", "right": False}] * 2)
        d_base = dev_file(os.path.join(tmp, "dev-r30b.json"), 14, 106, 100, 54, 16)
        d_good = dev_file(os.path.join(tmp, "dev-good.json"), 12, 108, 105, 40, 18)
        d_bad = dev_file(os.path.join(tmp, "dev-bad.json"), 30, 90, 60, 120, 10)
        empty = os.path.join(tmp, "none.jsonl")
        report = os.path.join(tmp, "report.json")
        code, text = run_gates(["--reference", ref, "--run", "r30b", base, d_base, "--run", "good", good, d_good, "--run", "bad", bad, d_bad,
                                "--probes", empty, "--trained-answers", os.path.join(tmp, "missing.jsonl"), "--bands", os.path.join(tmp, "bands.json"),
                                "--json", report])
        assert code == 1, "bad fails measured gates"
        r = json.load(open(report))
        g, b = r["runs"]["good"]["gates"], r["runs"]["bad"]["gates"]
        assert g["H3"]["status"] == "PASS" and b["H3"]["status"] == "FAIL"
        assert g["H4"]["status"] == "PASS" and b["H4"]["status"] == "FAIL", (g["H4"], b["H4"])
        assert g["H5"]["status"] == "PASS" and b["H5"]["status"] == "FAIL", (g["H5"], b["H5"])
        assert g["H6"]["status"] == "PASS" and b["H6"]["status"] == "FAIL"
        assert g["H9"]["status"] == "PASS" and r["runs"]["bad"]["gates"]["H1"]["status"] == "FAIL"
        assert g["H1"]["status"] == "NOT MEASURED" and g["H2"]["status"] == "NOT MEASURED" and g["H7"]["status"] == "N/A"
        assert r["runs"]["good"]["wins"] == ["P1 the 2,500"] and r["runs"]["good"]["verdict"].startswith("undecided")
        assert r["runs"]["bad"]["verdict"].startswith("no swap") and r["runs"]["r30b"]["verdict"] == "reference run"
        assert any("trained split" in x for x in r["notes"]) and any("no probe file" in x or "bands" in x for x in r["notes"])
        for word in ("Quux", "Zorbax", "Ada Blorp", "no record"):
            assert word not in text and word not in json.dumps(r), f"{word!r} leaked into the report"
        # --final: a gate not measured fails too.
        code, _ = run_gates(["--reference", ref, "--run", "r30b", base, d_base, "--run", "good", good, d_good, "--probes", empty, "--final"])
        assert code == 1
        # H8 with GGUF files, and H1 with Q4_K_M and IQ2_XXS present.
        def gguf(path, right, forget_right=40):
            rows = {"probe": [{"question": f"P{i}?", "answer": "Zorbax", "reply": "-", "right": i < right} for i in range(n)],
                    "forget": [{"question": f"F{i}?", "answer": "x", "reply": "-", "right": i < forget_right} for i in range(40)]}
            with open(path, "w") as f:
                json.dump({"rows": rows}, f)
            return path

        loops = os.path.join(tmp, "loops.json")
        with open(loops, "w") as f:
            json.dump({"summary": {"greedy": {"loops": 2, "http_200": 60}, "meta": {"loops": 3, "http_200": 60}}}, f)
        extra = ["--gguf", "good", "Q4_K_M", gguf(os.path.join(tmp, "g-q4.json"), 74), "--gguf", "good", "IQ2_XXS", gguf(os.path.join(tmp, "g-iq2.json"), 50),
                 "--gguf", "good", "IQ1_S", gguf(os.path.join(tmp, "g-iq1.json"), 20), "--gguf", "r30b", "IQ2_XXS", gguf(os.path.join(tmp, "b-iq2.json"), 45),
                 "--gguf", "r30b", "IQ1_S", gguf(os.path.join(tmp, "b-iq1.json"), 20), "--loops", "good", loops, "--loops", "r30b", loops]
        code, _ = run_gates(["--reference", ref, "--run", "r30b", base, d_base, "--run", "good", good, d_good, "--probes", empty, "--json", report, *extra])
        r = json.load(open(report))["runs"]["good"]
        assert r["gates"]["H8"]["status"] == "PASS" and r["gates"]["H1"]["status"] == "PASS", (r["gates"]["H8"], r["gates"]["H1"])
        assert r["primary"]["P4 IQ2_XXS"]["only_a"] == 5
        # A sampled measure_known.py run on a subset (A2's 600), three repeats: paired on the subset, repeat 0 gated, all counted.
        sub = os.path.join(tmp, "t1.0-600.jsonl")
        with open(sub, "w") as f:
            for rep in range(3):
                for i in range(0, n, 2):
                    f.write(json.dumps({"i": i, "question": f"P{i}?", "answer": "Zorbax", "reply": "Zorbax." if i < 70 - rep else "Quux.", "right": i < 70 - rep, "ended": True, "r": rep}) + "\n")
        code, text = run_gates(["--reference", ref, "--run", "r30b", base, d_base, "--run", "t1.0", sub, d_good, "--probes", empty, "--json", report])
        r = json.load(open(report))
        assert r["questions"] == n // 2 and any("paired on the 100" in x for x in r["notes"]), r["notes"]
        assert r["runs"]["t1.0"]["overall"]["right"] == 35 and set(r["runs"]["t1.0"]["repeats"]) == {"0", "1", "2"}
        assert "by repeat: r0 right 35" in text


@check
def gates_on_the_real_compare_b_files():
    """stage 2, r30 and r30b's own answers (on this Mac only): r30b is gated against itself, r30's over-refusal fails H4."""
    files = {k: os.path.join(COMPARE_B, f) for k, f in (("stage2", "stage2-multi.answers.json"), ("r30", "stage-b-r30.answers.json"), ("r30b", "stage-b-r30b.answers.json"))}
    if not all(os.path.exists(p) for p in files.values()):
        print("  (compare-b answer files not here; skipped)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "r.json")
        code, text = run_gates(["--reference", files["stage2"], "--run", "r30b", files["r30b"], "-", "--run", "r30", files["r30"], "-",
                                "--run", "stage2", files["stage2"], "-", "--json", report])
        r = json.load(open(report))
    runs = r["runs"]
    assert r["baseline"] == "r30b" and r["questions"] == 2500
    h4 = {k: runs[k]["h4"] for k in runs}
    assert h4["r30b"]["a"] == h4["r30b"]["b_"] and h4["stage2"]["a"] == 0 and h4["r30"]["a"] > 100, h4
    assert runs["r30b"]["gates"]["H4"]["status"] == "PASS" and runs["r30"]["gates"]["H4"]["status"] == "FAIL"
    assert runs["r30b"]["gates"]["H9"]["status"] == "PASS" and runs["stage2"]["gates"]["H9"]["status"] == "FAIL"
    assert runs["r30"]["gates"]["H9"]["status"] == "PASS", "r30 states fewer wrong answers as fact"
    assert runs["r30b"]["overall"]["right"] == 724 and runs["r30"]["overall"]["right"] == 657 and runs["stage2"]["overall"]["right"] == 755
    assert "P1 the 2,500 loss" in runs["r30"]["verdict"]
    for label, run in runs.items():
        cells = run["splits"]["topic group"]
        assert sum(c["n"] for c in cells.values()) == 2500 and set(cells) <= set(C.GROUPS), (label, list(cells))
        if "trained answer" in run["splits"]:
            assert sum(c["n"] for c in run["splits"]["trained answer"].values()) <= 2500
        if "paraphrase band" in run["splits"]:
            assert sum(c["n"] for c in run["splits"]["paraphrase band"].values()) == 2500
    print(f"  real files: refusals of stage 2's 755 right, r30b {h4['r30b']['a']}, r30 {h4['r30']['a']}; splits: {', '.join(runs['r30']['splits'])}")


@check
def trained_labels_join_on_the_split_key():
    probes = [{"question": "Who led the ministry?", "passageId": "source:x:1:0"}, {"question": "When did it open?", "passageId": "event:2026-03-01:0"},
              {"question": "Unlabelled?", "passageId": "source:y:2:0"}]
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "labels.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"set": "eval-2500", "i": 0, "key": C.label_key(probes[0]["passageId"], probes[0]["question"]), "trained": True}) + "\n")
            f.write(json.dumps({"set": "eval-2500", "i": 1, "key": C.label_key(probes[1]["passageId"], probes[1]["question"]), "trained": False}) + "\n")
        got, why = C.load_trained(path, probes)
        assert why is None and got == {probes[0]["question"]: True, probes[1]["question"]: False, probes[2]["question"]: None}
        got, why = C.load_trained(os.path.join(tmp, "missing.jsonl"), probes)
        assert got is None and "no labels" in why
    split_py = os.path.join(HERE, "trained_answer_split.py")
    if os.path.exists(split_py):
        try:
            spec = importlib.util.spec_from_file_location("trained_answer_split_check", split_py)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        except Exception as e:  # noqa: BLE001  another workflow is still writing it
            print(f"  (trained_answer_split.py didn't import: {type(e).__name__}; key compared only with the fixtures)")
            return
        if hasattr(mod, "label_key"):
            for p in probes:
                assert mod.label_key(p["passageId"], p["question"]) == C.label_key(p["passageId"], p["question"])
            print("  label_key matches trained_answer_split.py's")


@check
def paraphrase_bands_from_training_rows():
    probes = [{"question": "Which company bought the Zorbax mill in March?", "passageId": "source:a:1:0"},
              {"question": "Where is the quux tower built?", "passageId": "source:b:1:0"},
              {"question": "Nothing trained here?", "passageId": "source:c:1:0"}]
    with tempfile.TemporaryDirectory() as tmp:
        train = os.path.join(tmp, "train.jsonl")
        with open(train, "w") as f:
            for src, q in (("source:a:1:0", "Which company bought the Zorbax mill in March?"), ("source:b:1:0", "Who designed the quux tower?"),
                           ("source:z:9:0", "Which company bought the Zorbax mill in March?")):
                f.write(json.dumps({"source": src, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}, {"role": "assistant", "content": "x"}]}) + "\n")
        cache = os.path.join(tmp, "bands.json")
        bands, why = C.load_bands(probes, cache, [train], log=lambda m: None)
        assert why is None and bands[probes[0]["question"]] == "0.6 and up" and bands[probes[2]["question"]] == "no training question"
        assert bands[probes[1]["question"]] in ("0.2 to 0.4", "0.4 to 0.6"), bands
        again, why = C.load_bands(probes, cache, [], log=lambda m: None)
        assert again == bands, "the cache is reused"
        other, why = C.load_bands(probes[:2], cache, [], log=lambda m: None)
        assert other is None and "other probes" in why
        assert all(isinstance(s, (float, type(None))) for s in json.load(open(cache))["similarity"]), "the cache holds numbers only"


# ---- job/test_wave_b2.sh -----------------------------------------------------------------------------------------------

def dry(env=None, args=("stage-b-b2",)):
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/nonexistent-home", "DRY": "1", **(env or {})}
    return subprocess.run(["bash", WAVE, *args], capture_output=True, text=True, env=e, check=True).stdout


@check
def wave_script_dry_run():
    subprocess.run(["bash", "-n", WAVE], check=True)
    out = dry()
    jobs = [line.split() for line in out.splitlines() if line.startswith("job ")]
    names = [j[1] for j in jobs]
    b2 = ["ch", "know-low", "know-medium", "dev", "salient", "dev-on"]
    assert names[:6] == b2 and len(names) == 6 + 10 + 8, names
    assert all(j[3] in "1234567" for j in jobs[:6]), "B2's tests start on GPUs 1 to 7; GPU 0 is answering the 2,500"
    assert sum(n.startswith("a1-") for n in names) == 10 and sum(n.startswith("a2-") for n in names) == 8
    assert "--minutes 0" in out and "--gates" in out and "--final" in out
    assert out.count("--strengths low") == 1 and out.count("--strengths medium") == 1 and "--reasoning-on --tokenizer" in out
    assert "--no-system --knowledge-cutoff 2026-10-29 --current-date 2026-11-01 --strength low" in out and "--no-system --strength default" in out
    assert '--system "$P1_SYSTEM"' in out and "Knowledge cutoff: 2026-10-29." in out
    assert out.count("--temperature 1.0 --top-p 0.95 --top-k 64") == 4 and out.count("--temperature 0.6 --top-p 0.95 --top-k 64") == 4
    assert out.count("--seed 1 --repeat 3") == 2 and all(f"--seed {s} --gpu" in out for s in (1, 2, 3))
    assert "/nonexistent-home/k/runs/stage-b-b2/tests-b2/" in out and "/nonexistent-home/k/runs/stage-b-r30b/out/adapter" in out
    assert "needs /nonexistent-home/k/runs/stage-b-b2/out/answers.json" in out
    out = dry({"P4_SYSTEM_FILE": "/x/mp.txt", "SKIP_A2": "1"})
    assert "a1-P4-2500" in out and "--system-file /x/mp.txt --strength low" in out and "a2-" not in out
    out = dry({"SKIP_A1": "1", "SKIP_A2": "1"}, ("b2", "stage-b-r30"))
    assert out.strip().endswith("jobs: 6") and "a1-" not in out


@check
def wave_script_schedules_for_real_with_stand_ins():
    """The real (not dry) loop on this Mac, with a stand-in python and nvidia-smi: every job runs once, each GPU holds one job
    at a time, the know-* jobs wait for the tuned answers, and done.txt says ALLDONE."""
    with tempfile.TemporaryDirectory() as tmp:
        k = os.path.join(tmp, "k")
        sb, venv, bin_ = os.path.join(k, "stage-b"), os.path.join(k, "venv", "bin"), os.path.join(tmp, "bin")
        for d in (sb, venv, bin_, os.path.join(k, "data-stage2-multi"), os.path.join(k, "runs", "b2", "out", "adapter"),
                  os.path.join(k, "runs", "stage-b-r30b", "out", "adapter"), os.path.join(k, "runs", "stage-b-r30", "tests")):
            os.makedirs(d, exist_ok=True)
        for f in ("measure_known.py", "score_honesty_bf16.py"):
            shutil.copy(os.path.join(JOB, f), sb)
        for f in ("check_channels_bf16.py", "score_probes_reasoning.py", "train_glimmer.py", "salient_probes.jsonl", "stage-b-honesty-dev.jsonl",
                  "eval-probes.jsonl", "cutoff_questions.jsonl", "stage-b-named-controls.jsonl"):
            open(os.path.join(sb, f), "w").close()
        with open(os.path.join(k, "data-stage2-multi", "probes.jsonl"), "w") as f:
            f.writelines(json.dumps({"question": f"q{i}", "answer": "a"}) + "\n" for i in range(2500))
        with open(os.path.join(k, "data-stage2-multi", "forget.jsonl"), "w") as f:
            f.writelines("{}\n" for _ in range(40))
        for p in (os.path.join(k, "runs", "stage-b-r30", "tests", "ch-base.json"), os.path.join(k, "runs", "stage-b-r30b", "out", "adapter", "adapter_model.safetensors"),
                  os.path.join(k, "runs", "b2", "out", "adapter", "adapter_model.safetensors")):
            open(p, "w").close()
        with open(os.path.join(k, "runs", "b2", "log.txt"), "w") as f:
            f.write('MUSE {"event": "adapter_saved", "rank": 0}\n')
        with open(os.path.join(k, "box.env"), "w") as f:
            f.write("MODEL_PATH=/models/glimmer\nGPUS=8\nMODE=bf16\n")
        jobs_log = os.path.join(tmp, "jobs.log")
        # The stand-in python: real python for stdin scripts, the render check and the gates report; a short sleep for a job,
        # logging its GPU with a start and end mark so overlaps would show.
        with open(os.path.join(venv, "python"), "w") as f:
            f.write(f"""#!/bin/bash
if [ "$1" = - ] || [[ "$*" == *--render-only* ]] || [[ "$*" == *--merge* ]] || [[ "$*" == *--gates* ]] || [[ "$1" == compare_stage_b.py ]]; then
  [[ "$*" == *--render-only* || "$*" == *--merge* || "$*" == *--gates* ]] && exit 0
  exec {sys.executable} "$@"
fi
g=""; prev=""; for a in "$@"; do [ "$prev" = --gpu ] && g=$a; prev=$a; done
echo "start $g $$ $(echo "$*" | tr '\\n' ' ')" >> {jobs_log}
sleep 1
echo "end $g $$" >> {jobs_log}
""")
        with open(os.path.join(bin_, "nvidia-smi"), "w") as f:
            f.write("#!/bin/bash\nexit 0\n")
        for p in (os.path.join(venv, "python"), os.path.join(bin_, "nvidia-smi")):
            os.chmod(p, 0o755)
        env = {"PATH": bin_ + ":" + os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp, "POLL": "1", "WAVE_GPUS": "1 2 3 4 5 6 7"}
        # The tuned answers land a few seconds in, as rank 0 finishes the 2,500.
        answers = os.path.join(k, "runs", "b2", "out", "answers.json")
        proc = subprocess.Popen(["bash", WAVE, "b2"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        import time
        time.sleep(4)
        with open(answers, "w") as f:
            json.dump({"base": {"probes": [], "forget": []}, "tuned": {"probes": [], "forget": []}}, f)
        out, _ = proc.communicate(timeout=300)
        assert proc.returncode == 0, out[-3000:]
        o = os.path.join(k, "runs", "b2", "tests-b2")
        done = open(os.path.join(o, "done.txt")).read().splitlines()
        assert done[0] == "ALLDONE", done[:3]
        status = [line.split("\t") for line in open(os.path.join(o, "status.tsv")).read().splitlines()[1:]]
        assert len(status) == 24 and all(s[4] == "0" for s in status), status
        lines = [line.split() for line in open(jobs_log)]
        starts = [x for x in lines if x[0] == "start"]
        assert len(starts) == 24, len(starts)
        busy = {}
        for x in lines:
            if x[0] == "start":
                assert x[1] not in busy, f"two jobs on GPU {x[1]} at once"
                busy[x[1]] = x[2]
            else:
                busy.pop(x[1])
        os.path.getsize(os.path.join(o, "a2", "probes600.jsonl"))
        assert sum(1 for _ in open(os.path.join(o, "a2", "probes600.jsonl"))) == 600
        first_know = min(i for i, x in enumerate(starts) if "score_probes_reasoning.py" in " ".join(x))
        assert first_know > 6, "the know-* jobs waited for answers.json while others ran"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer")
    a = ap.parse_args()
    for fn in CHECKS:
        fn()
        print("ok", fn.__name__)
    if a.tokenizer:
        check_tokenizer(a.tokenizer)
    else:
        print("no --tokenizer: the real-template checks didn't run (see the docstring)")
    print(f"{len(CHECKS)} checks passed")
