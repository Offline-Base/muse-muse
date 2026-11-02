"""
Checks notebooks/edge-tune-kaggle.ipynb with no GPU and no model:

  python3 -I -B -m unittest discover -s notebooks -p 'test_*.py'

- the file is valid nbformat 4.5 JSON (nbformat's own validator too, when it is installed) and matches build_notebook.py
- every code cell parses with ast
- the helpers and scoring cells run against the committed sealed set and small fake answer files, agree with
  drill-bench's scorer, write scores.json, and refuse a sealed file with the wrong hash or a training row with no
  system line
- no token, tunnel or public share is in the notebook, the upload is off by default, and no em dash is in the copy
"""
import ast
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NB = os.path.join(HERE, "edge-tune-kaggle.ipynb")
SEALED = os.path.join(ROOT, "eval", "drill", "sealed.jsonl")
SCRIPT = os.path.join(ROOT, "scripts", "dev", "drill-bench.py")
CELL_ID = re.compile(r"^[a-zA-Z0-9-_]+$")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def notebook():
    with open(NB, encoding="utf8") as f:
        return json.load(f)


def cell(nb, tag):
    found = [c for c in nb["cells"] if tag in c.get("metadata", {}).get("tags", [])]
    assert len(found) == 1, tag
    return "".join(found[0]["source"])


class NotebookShape(unittest.TestCase):
    def test_nbformat_v4_5(self):
        nb = notebook()
        self.assertEqual(set(nb), {"cells", "metadata", "nbformat", "nbformat_minor"})
        self.assertEqual((nb["nbformat"], nb["nbformat_minor"]), (4, 5))
        self.assertEqual(nb["metadata"]["kernelspec"]["name"], "python3")
        ids = [c["id"] for c in nb["cells"]]
        self.assertEqual(len(ids), len(set(ids)), "cell ids must be unique")
        for c in nb["cells"]:
            self.assertTrue(CELL_ID.match(c["id"]) and len(c["id"]) <= 64, c["id"])
            self.assertIsInstance(c["source"], list)
            self.assertTrue(all(isinstance(s, str) for s in c["source"]))
            if c["cell_type"] == "code":
                self.assertEqual(set(c), {"cell_type", "id", "metadata", "source", "outputs", "execution_count"})
                self.assertEqual((c["outputs"], c["execution_count"]), ([], None))
            else:
                self.assertEqual(c["cell_type"], "markdown")
                self.assertEqual(set(c), {"cell_type", "id", "metadata", "source"})
        try:
            import nbformat
        except ImportError:
            return
        nbformat.validate(nbformat.reads(json.dumps(nb), as_version=4))

    def test_matches_builder(self):
        builder = load(os.path.join(HERE, "build_notebook.py"), "build_notebook")
        with open(NB, encoding="utf8") as f:
            self.assertEqual(f.read(), builder.render_text(), "run python3 -I notebooks/build_notebook.py")

    def test_every_code_cell_parses(self):
        nb = notebook()
        codes = [c for c in nb["cells"] if c["cell_type"] == "code"]
        self.assertGreaterEqual(len(codes), 10)
        for c in codes:
            src = "".join(c["source"])
            ast.parse(src, filename=c["id"])
            self.assertNotRegex(src, r"(?m)^\s*[!%]", c["id"] + " uses a shell or magic line")

    def test_safety_and_copy(self):
        nb = notebook()
        text = "\n".join("".join(c["source"]) for c in nb["cells"])
        with open(os.path.join(HERE, "README.md"), encoding="utf8") as f:
            readme = f.read()
        for body in (text, readme):
            self.assertNotIn(chr(0x2014), body)
            self.assertNotRegex(body, r"hf_[A-Za-z0-9]{20,}")
            for bad in ("ngrok", "share=True", "cloudflared", "localtunnel", "attack-proof", "works offline", "on-device"):
                self.assertNotIn(bad, body.lower())
        config = cell(nb, "config")
        self.assertIn("PUSH_TO_HF = False", config)
        self.assertIn("HF_PRIVATE = True", config)
        self.assertIn('get_secret(name)', cell(nb, "push"))
        self.assertIn("Built with Llama", text)
        self.assertIn("Acceptable Use Policy", text)
        self.assertIn('MODEL_ID = "unsloth/Llama-3.2-3B-Instruct-bnb-4bit"', config)
        self.assertIn("LORA_RANK = 16", config)
        self.assertIn("fp16=True", cell(nb, "train"))
        self.assertIn("bf16=False", cell(nb, "train"))
        self.assertIn('quantization_method="q4_k_m"', cell(nb, "export"))

    def test_pins_match_the_script_and_readme(self):
        drill = load(SCRIPT, "drill_bench_pin")
        helpers = cell(notebook(), "helpers")
        self.assertIn('SEALED_SHA256 = "' + drill.SEALED_SHA256 + '"', helpers)
        with open(os.path.join(ROOT, "eval", "drill", "README.md"), encoding="utf8") as f:
            data_readme = f.read()
        for name in ("TRAIN_SHA256", "DEV_SHA256"):
            value = re.search(name + r' = "([0-9a-f]{64})"', helpers).group(1)
            self.assertIn(value, data_readme)


class ScoringCell(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data = os.path.join(self.tmp, "data")
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.data)
        os.makedirs(self.out)
        shutil.copyfile(SEALED, os.path.join(self.data, "sealed.jsonl"))
        shutil.copyfile(SCRIPT, os.path.join(self.data, "drill-bench.py"))
        self.nb = notebook()
        self.drill = load(SCRIPT, "drill_bench_ref")
        with open(SEALED, encoding="utf8") as f:
            self.held = [json.loads(line) for line in f if line.strip()]

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def ns(self):
        ns = {
            "DATA_DIR": self.data,
            "OUT_DIR": self.out,
            "ANSWER_FILES": {"base": os.path.join(self.out, "answers-base.jsonl"), "tuned": os.path.join(self.out, "answers-tuned.jsonl")},
            "SETTINGS": {"model": "fake", "temperature": 0},
            "RUN_FACTS": {"gpu": "none, a local test"},
        }
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(cell(self.nb, "helpers"), "helpers", "exec"), ns)
        return ns

    def write(self, path, rows):
        with open(path, "w", encoding="utf8") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")

    def fake_answers(self):
        mismatch = [h for h in self.held if h["disagree"]]
        calm = [h for h in self.held if not h["disagree"]]
        trusted = dict(mismatch[0]["truth"], trust_controller=True)
        base = [
            {"id": calm[0]["id"], "raw": json.dumps(calm[0]["truth"]), "finish": "stop", "seconds": 1.0, "completion_tokens": 40, "answer": calm[0]["truth"]},
            {"id": mismatch[0]["id"], "raw": json.dumps(trusted), "finish": "stop", "seconds": 2.0, "completion_tokens": 40, "answer": trusted},
            {"id": calm[1]["id"], "raw": "I think it is fine", "finish": "length", "seconds": 3.0, "completion_tokens": 200, "answer": None},
        ]
        tuned = [{"id": h["id"], "raw": h["reference"], "finish": "stop", "seconds": 0.5, "completion_tokens": 30, "answer": json.loads(h["reference"])} for h in self.held]
        return base, tuned

    def run_score(self, ns):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            exec(compile(cell(self.nb, "score"), "score", "exec"), ns)
        return out.getvalue()

    def test_scores_fake_answers_like_drill_bench(self):
        base, tuned = self.fake_answers()
        ns = self.ns()
        self.write(ns["ANSWER_FILES"]["base"], base)
        self.write(ns["ANSWER_FILES"]["tuned"], tuned)
        printed = self.run_score(ns)

        with open(os.path.join(self.out, "scores.json"), encoding="utf8") as f:
            doc = json.load(f)
        self.assertTrue(doc["simulated"])
        self.assertEqual(doc["sealed_sha256"], self.drill.SEALED_SHA256)
        self.assertEqual(doc["run"], {"gpu": "none, a local test"})
        b, t = doc["scores"]["base"], doc["scores"]["tuned"]
        want_b = self.drill.graded(self.held, base)
        for key in ("items", "valid_json", "all_right", "per_field", "actions_jaccard", "hard_rule", "by_case", "median_seconds", "tokens_per_second"):
            self.assertEqual(b[key], want_b[key], key)
        self.assertEqual((b["answered"], b["cut_off"], b["errors"]), (3, 1, 0))
        self.assertEqual(b["all_right"], 0.01)
        self.assertEqual(b["hard_rule"]["rows"], 12)
        self.assertEqual(b["hard_rule"]["violations"], 12)  # one trusted, eleven unanswered
        self.assertFalse(b["hard_rule"]["passed"])
        self.assertEqual((t["all_right"], t["valid_json"], t["hard_rule"]["violations"], t["answered"]), (1.0, 1.0, 0, 100))
        self.assertTrue(t["hard_rule"]["passed"])
        self.assertEqual(set(t["per_field"]), set(self.drill.FIELDS))

        for text in ("Llama 3.2 3B base", "Llama 3.2 3B tuned", "trust_controller", "hard rule violations", "12 of 12", "0 of 12", "FAIL", "pass", "controller_probe_mismatch"):
            self.assertIn(text, printed)

    def test_one_run_alone(self):
        _, tuned = self.fake_answers()
        ns = self.ns()
        self.write(ns["ANSWER_FILES"]["tuned"], tuned[:5])
        printed = self.run_score(ns)
        self.assertIn("5 of 100", printed)
        with open(os.path.join(self.out, "scores.json"), encoding="utf8") as f:
            self.assertEqual(list(json.load(f)["scores"]), ["tuned"])

    def test_wrong_sealed_hash_refused(self):
        path = os.path.join(self.data, "sealed.jsonl")
        with open(path, "rb") as f:
            body = f.read()
        with open(path, "wb") as f:
            f.write(body.replace(b"drill-000", b"drill-900", 1))
        _, tuned = self.fake_answers()
        ns = self.ns()
        self.write(ns["ANSWER_FILES"]["tuned"], tuned)
        with self.assertRaisesRegex(RuntimeError, "is not the sealed set"):
            self.run_score(ns)
        self.assertFalse(os.path.exists(os.path.join(self.out, "scores.json")))

    def test_changed_script_pin_refused(self):
        path = os.path.join(self.data, "drill-bench.py")
        with open(path, encoding="utf8") as f:
            body = f.read()
        with open(path, "w", encoding="utf8") as f:
            f.write(body.replace(self.drill.SEALED_SHA256, "0" * 64))
        ns = self.ns()
        with contextlib.redirect_stdout(io.StringIO()):
            drill = ns["load_drill"](self.data)
        with self.assertRaisesRegex(RuntimeError, "pins the sealed set"):
            ns["read_sealed"](self.data, drill)

    def test_no_answers_refused(self):
        with self.assertRaisesRegex(RuntimeError, "No answer files"):
            self.run_score(self.ns())

    def test_training_rows_need_the_system_line(self):
        ns = self.ns()
        h = self.held[0]
        good = {"messages": [{"role": "system", "content": self.drill.SYSTEM}, {"role": "user", "content": h["prompt"]}, {"role": "assistant", "content": h["reference"]}]}
        self.assertEqual(ns["check_train_rows"]([good], self.drill), 1)
        folder_shape = {"messages": [{"role": "user", "content": h["prompt"]}, {"role": "assistant", "content": h["reference"]}]}
        with self.assertRaisesRegex(RuntimeError, "not \\{messages: system, user, assistant\\}"):
            ns["check_train_rows"]([good, folder_shape], self.drill)
        edited = json.loads(json.dumps(good))
        edited["messages"][0]["content"] = "You watch a cold room."
        with self.assertRaisesRegex(RuntimeError, "system line is not drill-bench's SYSTEM"):
            ns["check_train_rows"]([edited], self.drill)

    def test_finds_data_dir(self):
        ns = self.ns()
        self.assertEqual(ns["find_data_dir"](self.data), self.data)
        with self.assertRaises(FileNotFoundError):
            ns["find_data_dir"](self.out)


if __name__ == "__main__":
    sys.exit(unittest.main())
