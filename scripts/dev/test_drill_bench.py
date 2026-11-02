#!/usr/bin/env python3
"""python3 -I scripts/dev/test_drill_bench.py (or pytest on this file) checks the drill bench with no model and no network:
the rules, the hard rule, reproducibility, the sealed hash, the split and `ask` against a fake server on 127.0.0.1."""
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("drill_bench", os.path.join(HERE, "drill-bench.py"))
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)
SEALED = os.path.join(HERE, "..", "..", "eval", "drill", "sealed.jsonl")


def make_into(seed=db.SEED):
    out = tempfile.mkdtemp(prefix="drill-")
    db.make(out, seed)
    return out


class Rules(unittest.TestCase):
    def row(self, **over):
        base = {"t": 0, "setpoint": -18.0, "controller": -18.0, "probe": -18.2, "door": "shut", "defrost": "off", "power": "on", "cloud": "up"}
        return {**base, **over}

    def window(self, n=12, **over):
        return [self.row(t=i * 5, **over) for i in range(n)]

    def test_normal(self):
        truth, _ = db.truth_of(self.window())
        self.assertEqual(truth, {"status": "normal", "trust_controller": True, "likely_cause": "none", "actions": ["keep_watching"], "escalate": False})

    def test_disagreement_beyond_threshold_never_trusts_the_controller(self):
        rows = self.window()
        rows[-1] = self.row(t=55, controller=-18.0, probe=-14.9)
        truth, f = db.truth_of(rows)
        self.assertTrue(f["disagree"])
        self.assertIs(truth["trust_controller"], False)
        self.assertEqual(truth["likely_cause"], "controller_probe_mismatch")
        self.assertTrue(truth["escalate"])

    def test_disagreement_at_the_threshold_is_not_a_mismatch(self):
        rows = self.window()
        rows[-1] = self.row(t=55, controller=-18.0, probe=-15.0)
        self.assertEqual(db.truth_of(rows)[0]["likely_cause"], "none")

    def test_mismatch_wins_over_every_other_rule(self):
        rows = self.window(defrost="on", door="open", cloud="down")
        rows[0]["setpoint"] = 50.0
        rows[-1]["probe"] = 9.0
        truth, _ = db.truth_of(rows)
        self.assertEqual(truth["likely_cause"], "controller_probe_mismatch")
        self.assertIn("keep_local_log", truth["actions"])

    def test_setpoint_pushed_is_not_trusted(self):
        rows = self.window()
        for r in rows[6:]:
            r["setpoint"] = 50.0
        truth, _ = db.truth_of(rows)
        self.assertEqual((truth["likely_cause"], truth["trust_controller"], truth["status"]), ("setpoint_changed", False, "alert"))

    def test_defrost_door_dropout_gap_cloud(self):
        rows = self.window()
        for r in rows[4:]:
            r["defrost"] = "on"
        self.assertEqual(db.truth_of(rows)[0]["likely_cause"], "defrost_stuck")
        rows = self.window()
        for r in rows[2:5]:
            r["door"] = "open"
        self.assertEqual(db.truth_of(rows)[0]["likely_cause"], "door_open")
        rows = self.window()
        for r in rows[9:]:
            r["probe"] = None
        truth, _ = db.truth_of(rows)
        self.assertEqual((truth["likely_cause"], truth["trust_controller"]), ("probe_dropout", False))
        rows = self.window()
        rows[5]["power"] = "lost"
        for r in rows[6:]:
            r["t"] += 15
        rows[6]["power"] = "restored"
        self.assertEqual(db.truth_of(rows)[0]["likely_cause"], "power_gap")
        rows = self.window()
        rows[-1]["cloud"] = "down"
        self.assertEqual(db.truth_of(rows)[0], {"status": "normal", "trust_controller": True, "likely_cause": "cloud_down", "actions": ["keep_local_log", "keep_watching"], "escalate": False})

    def test_actions_are_known_and_defer_to_the_site(self):
        for cause, (_, _, _, actions) in db.VERDICT.items():
            self.assertTrue(set(actions) <= set(db.ACTIONS), cause)
        text = " ".join(db.ACTIONS.values()).lower()
        for banned in ("\u2014", " c ", "degrees", "discard", "throw", "safe to", "unsafe", "on-device", "private", "works offline"):
            self.assertNotIn(banned, text)
        self.assertNotIn("\u2014", db.SYSTEM)


class Data(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = make_into()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, ignore_errors=True)

    def read(self, name):
        return db.read_jsonl(os.path.join(self.out, name))

    def test_counts_and_even_split(self):
        train, dev, sealed = self.read("train.jsonl"), self.read("dev.jsonl"), self.read("sealed.jsonl")
        self.assertEqual((len(train), len(dev), len(sealed)), (900, 50, 100))
        counts = {}
        for s in sealed:
            counts[s["case"]] = counts.get(s["case"], 0) + 1
        self.assertEqual(set(counts), set(db.CAUSES))
        self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)

    def test_rows_are_in_the_training_formats_and_simulated(self):
        for r in self.read("train.jsonl"):
            roles = [m["role"] for m in r["messages"]]
            self.assertEqual(roles, ["system", "user", "assistant"])
            self.assertTrue(r["messages"][1]["content"].startswith("Simulated cold-room log"))
            self.assertLessEqual(len(r["messages"][1]["content"]), 1500)
            answer = json.loads(r["messages"][2]["content"])
            self.assertEqual(list(answer), list(db.FIELDS))
            self.assertTrue(set(answer["actions"]) <= set(db.ACTIONS))
        for r in self.read("dev.jsonl"):
            self.assertEqual(set(r), {"prompt", "reference"})
        for s in self.read("sealed.jsonl"):
            self.assertTrue(s["simulated"])
            self.assertEqual(json.loads(s["reference"]), s["truth"])
            self.assertLessEqual(len(s["prompt"]), 1500)

    def test_no_sealed_prompt_in_training(self):
        train = {r["messages"][1]["content"] for r in self.read("train.jsonl")} | {r["prompt"] for r in self.read("dev.jsonl")}
        self.assertEqual(sum(1 for s in self.read("sealed.jsonl") if s["prompt"] in train), 0)
        layouts = {s["layout"] for s in self.read("sealed.jsonl")}
        self.assertEqual(layouts, {f.__name__ for f in db.SEALED_LAYOUTS})

    def test_no_near_duplicates_the_dataset_split_would_drop(self):
        # lib/train/logic.ts promptKey and isNearDuplicate (word-set Jaccard 0.7), checked over every training and
        # kept-aside prompt, and every sealed prompt against them.
        words, near = db.prompt_words, db.near_duplicate
        train = [words(r["messages"][1]["content"]) for r in self.read("train.jsonl")] + [words(r["prompt"]) for r in self.read("dev.jsonl")]
        sealed = [words(s["prompt"]) for s in self.read("sealed.jsonl")]
        within = sum(1 for i in range(len(train)) for j in range(i + 1, len(train)) if near(train[i], train[j]))
        across = sum(1 for s in sealed if any(near(s, t) for t in train))
        self.assertTrue(near(words("How do I reset my password?"), words("how can i reset my password")))
        self.assertEqual((within, across), (0, 0))

    def test_same_seed_same_bytes_and_the_committed_seal(self):
        again = make_into()
        try:
            for name in ("train.jsonl", "dev.jsonl", "sealed.jsonl", "demo-calm-cloud-down.csv", "demo-spoofed-controller.csv"):
                self.assertEqual(db.sha256(os.path.join(self.out, name)), db.sha256(os.path.join(again, name)), name)
        finally:
            shutil.rmtree(again, ignore_errors=True)
        self.assertEqual(db.sha256(os.path.join(self.out, "sealed.jsonl")), db.SEALED_SHA256)
        if os.path.exists(SEALED):
            self.assertEqual(db.sha256(SEALED), db.SEALED_SHA256)

    def test_demo_csvs(self):
        import csv

        with open(os.path.join(self.out, "demo-spoofed-controller.csv"), encoding="utf8") as f:
            spoof = list(csv.DictReader(f))
        self.assertTrue(all(r["source"] == "Simulated" for r in spoof))
        self.assertEqual(spoof[-1]["controller_c"], "-18.1")
        self.assertEqual(spoof[-1]["probe_c"], "9.4")
        rows = [{"record": int(r["record"]), "t": i, "setpoint": float(r["setpoint_c"]), "controller": float(r["controller_c"]), "probe": float(r["probe_c"]), "door": r["door"], "defrost": r["defrost"], "power": r["power"], "cloud": r["cloud"]} for i, r in enumerate(spoof)]
        self.assertEqual(db.truth_of(rows)[0]["likely_cause"], "controller_probe_mismatch")
        self.assertIs(db.truth_of(rows)[0]["trust_controller"], False)
        calm = db.demo_windows()["demo-calm-cloud-down.csv"]
        self.assertEqual(db.truth_of(calm)[0]["likely_cause"], "cloud_down")


class Scoring(unittest.TestCase):
    def held(self):
        return db.read_jsonl(SEALED if os.path.exists(SEALED) else os.path.join(make_into(), "sealed.jsonl"))

    def test_reference_scores_perfect(self):
        held = self.held()
        report = db.graded(held, [{"id": h["id"], "answer": h["truth"]} for h in held])
        self.assertEqual(report["all_right"], 1.0)
        self.assertTrue(report["hard_rule"]["passed"])
        self.assertGreater(report["hard_rule"]["rows"], 0)

    def test_trusting_a_disagreeing_controller_is_a_violation_even_if_else_right(self):
        held = self.held()
        answers = []
        for h in held:
            a = dict(h["truth"])
            if h["disagree"]:
                a["trust_controller"] = True
            answers.append({"id": h["id"], "answer": a})
        report = db.graded(held, answers)
        self.assertEqual(report["hard_rule"]["violations"], report["hard_rule"]["rows"])
        self.assertFalse(report["hard_rule"]["passed"])
        self.assertEqual(report["by_case"]["controller_probe_mismatch"]["all_right"], 0)

    def test_missing_and_bad_answers(self):
        held = self.held()[:16]
        report = db.graded(held, [])
        self.assertEqual((report["valid_json"], report["all_right"]), (0.0, 0.0))
        self.assertEqual(report["hard_rule"]["violations"], report["hard_rule"]["rows"])
        bad = [{"id": h["id"], "answer": {**h["truth"], "trust_controller": "false", "actions": list(reversed(h["truth"]["actions"]))}} for h in held]
        report = db.graded(held, bad)
        self.assertEqual(report["per_field"]["trust_controller"], 0.0)  # a string is not a boolean
        self.assertEqual(report["per_field"]["actions"], 1.0)  # order doesn't matter

    def test_parse_answer(self):
        self.assertEqual(db.parse_answer('<think>{"x":1}</think>```json\n{"status":"normal"}\n```'), {"status": "normal"})
        self.assertIsNone(db.parse_answer("no json here"))


class Fake(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        Fake.seen.append({"path": self.path, "body": body, "auth": self.headers.get("authorization"), "node": self.headers.get("x-jcp-node")})
        prompt = body["messages"][1]["content"]
        if "Simulated Room K" in prompt:
            self.send_response(500)
            self.end_headers()
            return
        content = 'Here you go: {"status":"normal","trust_controller":true,"likely_cause":"none","actions":["keep_watching"],"escalate":false}'
        raw = json.dumps({"choices": [{"message": {"content": content}, "finish_reason": "stop"}], "usage": {"completion_tokens": 30}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class Ask(unittest.TestCase):
    def test_ask_against_a_local_fake(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        tmp = tempfile.mkdtemp(prefix="drill-ask-")
        try:
            out = os.path.join(tmp, "answers.jsonl")
            os.environ["DRILL_TEST_KEY"] = "fake-key-for-the-local-fake"
            args = ["ask", "--heldout", SEALED, "--url", f"http://127.0.0.1:{server.server_port}/v1/", "--model", "fake-model", "--out", out, "--limit", "8", "--key-env", "DRILL_TEST_KEY", "--header", "X-JCP-Node: nd_fake", "--schema"]
            self.assertEqual(db.main(args), 0)
            rows = db.read_jsonl(out)
            self.assertEqual(len(rows), 8)
            sent = Fake.seen[0]
            self.assertEqual(sent["path"], "/v1/chat/completions")
            self.assertEqual(sent["body"]["temperature"], 0)
            self.assertEqual(sent["body"]["messages"][0]["content"], db.SYSTEM)
            self.assertEqual(sent["body"]["response_format"]["json_schema"]["schema"], db.ANSWER_SCHEMA)
            self.assertEqual((sent["auth"], sent["node"]), ("Bearer fake-key-for-the-local-fake", "nd_fake"))
            errors = [r for r in rows if str(r["finish"]).startswith("error")]
            for r in rows:
                if r in errors:
                    self.assertIsNone(r["answer"])
                else:
                    self.assertEqual(r["answer"]["likely_cause"], "none")
            report = db.graded(db.read_jsonl(SEALED)[:8], rows)
            self.assertEqual(report["items"], 8)
        finally:
            os.environ.pop("DRILL_TEST_KEY", None)
            server.shutdown()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
