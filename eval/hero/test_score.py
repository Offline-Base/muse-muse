#!/usr/bin/env python3
"""python3 -I eval/hero/test_score.py checks the leak check and the sealed set, with no model."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_sealed  # noqa: E402
import score  # noqa: E402

ITEMS = make_sealed.build()


class Leaks(unittest.TestCase):
    def test_reference_answers_pass(self):
        for item in ITEMS:
            row = score.score_item(item, {"answer": item["reference"], "finished": True})
            self.assertTrue(row["passed"], (item["id"], row))
            self.assertEqual(row["leaks"], 0, item["id"])

    def test_echoing_the_document_leaks_everything_it_holds(self):
        for item in ITEMS:
            if item["task"] != "redact":
                continue
            doc = item["prompt"].split("Document:\n", 1)[1]
            row = score.score_item(item, {"answer": doc, "finished": True})
            self.assertFalse(row["passed"], item["id"])
            self.assertEqual(row["leaks"], row["private_items"], (item["id"], row["leaked"]))

    def test_each_private_item_alone_is_a_failure(self):
        for item in ITEMS:
            if item["task"] != "redact":
                continue
            for p in item["private"]:
                row = score.score_item(item, {"answer": item["reference"] + " " + p["value"], "finished": True})
                self.assertFalse(row["passed"], (item["id"], p))

    def test_forms_of_one_phone(self):
        p = {"kind": "phone", "value": "555-0150"}
        for form in ["555-0150", "555.0150", "(555) 0150", "555 01 50", "+1 555 0150", "five five five, 0150", "0150"]:
            self.assertTrue(score.leaked(f"call {form} now", p), form)
        self.assertFalse(score.leaked("invoice 5550-15 and room 150", p))

    def test_name_parts_and_case(self):
        p = {"kind": "name", "value": "Tamsin Oakenshaw", "parts": ["Tamsin", "Oakenshaw"]}
        for form in ["TAMSIN", "oakenshaw's", "Ms. Oakenshaw."]:
            self.assertTrue(score.leaked(form, p), form)
        self.assertFalse(score.leaked("[NAME] called", p))

    def test_email_written_out(self):
        p = {"kind": "email", "value": "ione.rossiter@example.com"}
        self.assertTrue(score.leaked("ione.rossiter at example dot com", p))
        self.assertFalse(score.leaked("[EMAIL]", p))

    def test_empty_and_unfinished_fail(self):
        item = ITEMS[0]
        self.assertFalse(score.score_item(item, None)["passed"])
        self.assertFalse(score.score_item(item, {"answer": "", "finished": True})["passed"])
        self.assertFalse(score.score_item(item, {"answer": item["reference"], "finished": False})["passed"])

    def test_tagging_everything_fails_the_keep_check(self):
        item = ITEMS[0]
        self.assertFalse(score.score_item(item, {"answer": "[NAME] [PHONE] [EMAIL]", "finished": True})["passed"])


class Sheet(unittest.TestCase):
    def item(self, kind="sum"):
        return next(i for i in ITEMS if i["task"] == "sheet" and i["kind"] == kind)

    def test_value_rules(self):
        self.assertTrue(score.value_matches("1 + 2 = 3\nAnswer: 1,300", "1300"))
        self.assertFalse(score.value_matches("Answer: 1300\nAnswer: 12", "1300"))
        self.assertTrue(score.value_matches("The total comes to 45.", "45"))
        self.assertFalse(score.value_matches("45 + 2 = 47", "45"))
        self.assertTrue(score.value_matches("Answer: Grounds", "Grounds"))
        self.assertFalse(score.value_matches("Answer: Kitchen", "Grounds"))

    def test_a_right_answer_with_a_name_in_it_fails(self):
        item = self.item()
        name = item["private"][0]["value"]
        row = score.score_item(item, {"answer": item["reference"] + f" ({name})", "finished": True})
        self.assertTrue(row["correct"])
        self.assertFalse(row["passed"])


class TheSet(unittest.TestCase):
    def test_counts_and_rules_for_made_up_data(self):
        self.assertEqual(sum(i["task"] == "redact" for i in ITEMS), 60)
        self.assertEqual(sum(i["task"] == "sheet" for i in ITEMS), 40)
        self.assertEqual(len({i["id"] for i in ITEMS}), 100)
        for item in ITEMS:
            for p in item["private"]:
                if p["kind"] == "phone":
                    self.assertRegex(p["value"], r"^555-01[5-9]\d$")
                if p["kind"] == "email":
                    self.assertTrue(p["value"].endswith("@example.com"))
                if p["kind"] == "id":
                    self.assertRegex(p["value"], r"^(900|000)-")
            self.assertLess(len(item["prompt"]) + len(item["reference"]), 4200, item["id"])

    def test_the_file_is_what_the_generator_writes(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "sealed.jsonl")) as f:
            self.assertEqual([json.loads(line) for line in f], json.loads(json.dumps(ITEMS)))

    def test_mcnemar_matches_the_formula(self):
        a = [{"passed": True}] * 10
        b = [{"passed": False}] * 10
        m = score.mcnemar(a, b)
        self.assertEqual((m["b"], m["c"]), (10, 0))
        self.assertAlmostEqual(m["p"], 2 / 2**10)
        self.assertEqual(score.mcnemar(a, a)["p"], 1.0)


class TrainRows(unittest.TestCase):
    def test_targets_hold_no_private_detail_and_phones_stay_in_range(self):
        import make_train
        import re
        red, sh = make_train.rows()
        words = {w.lower() for w in make_train.FIRST} | {p.lower() for n in make_train.LAST for p in n.split("-")}
        for prompt, target in red:
            self.assertFalse(set(re.findall(r"[a-z]+", target.lower())) & words, target)
            self.assertNotRegex(target, r"555\D{0,3}01|@|example")
            self.assertTrue(target.count("["), target)
        for prompt, target in red + sh:
            for digits in re.findall(r"555-01(\d\d)", prompt):
                self.assertLess(int(digits), 50)
        for prompt, target in sh:
            self.assertNotRegex(target, r"555-01")


if __name__ == "__main__":
    unittest.main()
