"""Pure-function tests for tunelib.py (no torch, numpy or board):

  python3 -I -m unittest discover scripts/edge/sam3/tune/tests
"""
import json
import os
import random
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import tunelib as T  # noqa: E402

REPO = HERE.parents[4]
NOV3 = REPO / "docs/log/bench/2026-11-03/distract"


def far_box(k):
    # boxes well away from any test box (the test photos are at most 640 px wide)
    return [2000 + 60 * k, 2000, 40, 40]


class Iou(unittest.TestCase):
    def test_values(self):
        self.assertAlmostEqual(T.iou_xywh([0, 0, 10, 10], [0, 0, 10, 10]), 1.0)
        self.assertAlmostEqual(T.iou_xywh([0, 0, 10, 10], [5, 0, 10, 10]), 50 / 150)
        self.assertEqual(T.iou_xywh([0, 0, 10, 10], [20, 20, 5, 5]), 0.0)
        self.assertEqual(T.iou_xywh([0, 0, 0, 0], [0, 0, 0, 0]), 0.0)
        self.assertEqual(T.xyxy_to_xywh([10, 20, 30, 60]), [10, 20, 20, 40])

    def test_b_image_rules(self):
        x = [100, 100, 50, 50]
        r = T.score_b_image([{"box": x, "score": 0.9}], x)
        self.assertEqual((r["found"], r["top"], r["only"], r["other"]), (1, 1, 1, 0))
        # a bear scored above the object: found, not top, not only, one other box
        r = T.score_b_image([{"box": x, "score": 0.7}, {"box": [0, 0, 30, 30], "score": 0.95}], x)
        self.assertEqual((r["found"], r["top"], r["only"], r["other"]), (1, 0, 0, 1))
        self.assertEqual((r["best_x"], r["best_other"]), (0.7, 0.95))
        # a second box on the object counts as another box, as score.py counted on Nov 3
        r = T.score_b_image([{"box": x, "score": 0.9}, {"box": [102, 101, 50, 50], "score": 0.8}], x)
        self.assertEqual((r["found"], r["only"], r["other"]), (1, 0, 1))
        # under 0.5 nothing counts, but the best scores still see it (for the medians)
        r = T.score_b_image([{"box": x, "score": 0.3}], x)
        self.assertEqual((r["found"], r["top"], r["other"], r["best_x"], r["best_other"]), (0, 0, 0, 0.3, 0.0))
        self.assertEqual(T.score_a_image([{"box": x, "score": 0.5}, {"box": x, "score": 0.49}]), {"fired": 1, "boxes": 1})
        self.assertEqual(T.score_h_image([{"box": x, "score": 0.6}], [[0, 0, 5, 5], x]), {"found": 1})


class Nov3Counts(unittest.TestCase):
    """The counts rebuilt from per_image.json come out as scores.json has them, for all four Nov 3 prompts."""

    def test_against_per_image_json(self):
        per = json.loads((NOV3 / "per_image.json").read_text())["images"]
        scores = json.loads((NOV3 / "scores.json").read_text())["results"]
        for key in ("meta:muse", "meta:plush toy", "meta:toy", "tuned:muse"):
            b_rows, a_rows = [], []
            for img in per:
                found, other, a_boxes = img[key]
                x = img["muse_box"]
                dets = ([{"box": x, "score": 0.95}] if found else []) + \
                       [{"box": far_box(k), "score": 0.8} for k in range(other)]
                b_rows.append(T.score_b_image(dets, x))
                a_rows.append(T.score_a_image([{"box": far_box(k), "score": 0.8} for k in range(a_boxes)]))
            col = T.summarize(b_rows, a_rows)
            want = scores[key]
            self.assertEqual(col["B"]["n"], 30)
            self.assertEqual(col["B"]["found"], want["B"]["muse_found@0.5"], key)
            self.assertEqual(col["B"]["otherBoxes"], want["B"]["boxes_not_muse@0.5"], key)
            self.assertEqual(col["A"]["boxes"], want["A"]["boxes@0.5"], key)
            self.assertEqual(col["A"]["firedPhotos"], want["A"]["images_with_a_box@0.5"], key)
        # the headline: the tune still fires on 22 of 30 photos with no Muse
        self.assertEqual(sum(1 for i in per if i["tuned:muse"][2] > 0), 22)

    def test_summary_shape_and_medians(self):
        x = [0, 0, 10, 10]
        rows = [T.score_b_image([{"box": x, "score": s}], x) for s in (0.9, 0.7, 0.8)]
        col = T.summarize(rows, [], [{"found": 1}, {"found": 0}], {"B": (0.51234, 0.6), "H": -1.0})
        self.assertEqual(set(col), {"B", "A", "H", "medianScore", "medianBestOther"})
        self.assertEqual(set(col["B"]), {"n", "found", "top", "only", "otherBoxes", "ap", "ap50"})
        self.assertEqual(col["medianScore"], 0.8)
        self.assertEqual(col["medianBestOther"], 0.0)
        self.assertEqual(col["B"]["ap"], 0.512)
        self.assertEqual(col["H"], {"n": 2, "found": 1, "ap": 0.0})  # pycocotools' -1 (no boxes) reads as 0
        self.assertNotIn("H", T.summarize(rows, []))
        self.assertIsNone(T.summarize([], [])["medianScore"])


class Seeds(unittest.TestCase):
    def test_split_by_seed(self):
        ids = [f"p{i}" for i in range(20)]
        tr, held = T.split_by_seed(ids, 7, 5)
        self.assertEqual(len(held), 5)
        self.assertEqual(sorted(tr + held), sorted(ids))
        self.assertFalse(set(tr) & set(held))
        self.assertEqual((tr, held), T.split_by_seed(ids, 7, 5))
        self.assertNotEqual(held, T.split_by_seed(ids, 8, 5)[1])
        self.assertEqual(T.seeded_order(["a", "b", "c"], 1), T.seeded_order(["c", "a", "b"], 1))

    def test_paste_rule(self):
        bears = [[10, 10, 100, 120], [300, 50, 80, 100]]
        for seed in range(20):
            rng = random.Random(seed)
            h = T.paste_height([b[3] for b in bears], 480)
            self.assertEqual(h, 110)
            box, _ = T.place_box(rng, 640, 480, 50, 100, bears, h)
            self.assertIsNotNone(box)
            x, y, w, hh = box
            self.assertTrue(0 <= x and x + w <= 640 and 0 <= y and y + hh <= 480)
            self.assertFalse(T.overlaps(box, bears))
            self.assertEqual(box, T.place_box(random.Random(seed), 640, 480, 50, 100, bears, h)[0])
        self.assertEqual(T.paste_height([10], 480), 0.12 * 480)
        self.assertEqual(T.paste_height([400], 480), 0.45 * 480)
        # no room anywhere: None, never an overlapping box
        self.assertIsNone(T.place_box(random.Random(1), 100, 100, 50, 50, [[0, 0, 100, 100]], 50, tries=20)[0])


class Pictures(unittest.TestCase):
    def test_license_filter(self):
        self.assertTrue(T.showable({"license": "Attribution License"}))
        self.assertTrue(T.showable({"license": "Attribution-ShareAlike License"}))
        self.assertTrue(T.showable({"license": None}))
        # A COCO photo whose license is missing is never shown, though the person's own photo (no license) is.
        self.assertFalse(T.showable({"source": "coco", "license": None}))
        self.assertTrue(T.showable({"source": "coco", "license": "Attribution-ShareAlike License"}))
        self.assertEqual(T.short_license("Attribution License"), "CC BY 2.0")
        self.assertIsNone(T.short_license(None))
        for lic in ("Attribution-NonCommercial License", "Attribution-NoDerivs License",
                    "No known copyright restrictions", "United States Government Work"):
            self.assertFalse(T.showable({"license": lic}), lic)
        c = T.credit_for({"license": "Attribution License", "coco_id": 20553, "flickr_url": "http://f/x", "word": "muse"},
                         pasted=True)
        self.assertEqual(c, "COCO val2017 20553 (CC BY 2.0, http://f/x), Muse pasted in.")
        self.assertIsNone(T.credit_for({"license": None}, pasted=True))
        self.assertNotIn("\u2014", c)

    def test_pick_rule(self):
        def b(found, top, only, other, bx=0.9, bo=0.5):
            return {"found": found, "top": top, "only": only, "other": other, "best_x": bx, "best_other": bo}
        items_b = {"b1": {"license": "Attribution License"}, "b2": {"license": "Attribution License"},
                   "b3": {"license": "Attribution-NonCommercial License"}, "b4": {"license": None}}
        items_a = {"a1": {"license": "Attribution License"}, "a2": {"license": "No known copyright restrictions"}}
        tuned = {"b1": b(1, 1, 0, 2), "b2": b(1, 1, 0, 1), "b3": b(1, 1, 1, 0), "b4": b(1, 0, 0, 1)}
        generic = {"b1": b(1, 0, 0, 5), "b2": b(1, 1, 0, 3), "b3": b(1, 0, 0, 4), "b4": b(1, 1, 0, 2, 0.95, 0.4)}
        a = {"a1": {"fired": 1, "boxes": 2}, "a2": {"fired": 1, "boxes": 9}}
        picks = T.pick_images(tuned, generic, a, items_b, items_a)
        # b3 would win tuned_top (the tune boxed it alone) but is NC, so never shown; b1 has the busiest generic answer
        self.assertEqual(picks[0], ("tuned_top", "B", "b1"))
        # generic_top prefers a photo where the tune doesn't rank first: b4 (the person's own, no license)
        self.assertEqual(picks[1], ("generic_top", "B", "b4"))
        # a2 fired more but isn't showable
        self.assertEqual(picks[2], ("tuned_false_fire", "A", "a1"))
        self.assertEqual(T.pick_images({}, {}, {}, {}, {}), [])


class Guards(unittest.TestCase):
    def test_refuses(self):
        self.assertIsNone(T.guard_problem(6000, 500, False))
        self.assertIn("memory", T.guard_problem(5000, 500, False))
        self.assertIn("disk", T.guard_problem(6000, 299, False))
        self.assertIn("glimmer", T.guard_problem(8000, 9000, True))
        self.assertEqual(T.mem_available_mb("MemTotal: 7800000 kB\nMemAvailable:    6291456 kB\n"), 6144)
        self.assertEqual(T.mem_available_mb("nothing"), 0)
        self.assertTrue(T.glimmer_in(["python\0/opt/glimmer-train/train.py\0", "bash\0"]))
        self.assertFalse(T.glimmer_in(["python\0/opt/sam3train/x.py\0"]))

    def test_words(self):
        self.assertIsNone(T.word_problem("muse"))
        for bad in ("Muse", "m", "mu se", "muse1", "a" * 25, None):
            self.assertIsNotNone(T.word_problem(bad), bad)
        self.assertIsNone(T.generic_problem("plush toy"))
        for bad in ("plush  toy", "plush toy ", " toy", "toy!", "x"):
            self.assertIsNotNone(T.generic_problem(bad), bad)

    def test_deltas_kept(self):
        ds = [("/d/a.pt", 1), ("/d/b.pt", 3), ("/d/c.pt", 2), ("/m/muse31.pt", 0)]
        self.assertEqual(T.deltas_to_delete(ds, keep=2, protect=("/m/muse31.pt",)), ["/d/a.pt"])
        self.assertEqual(T.deltas_to_delete(ds[:2], keep=2), [])

    def test_hosts(self):
        mm = "https://www.musemuse.dev"
        ok = ["https://www.musemuse.dev/api/x.jpg", "https://abc123.public.blob.vercel-storage.com/samtune/1/p.jpg"]
        bad = ["http://www.musemuse.dev/x.jpg", "https://evil.dev/x.jpg", "https://www.musemuse.dev.evil.dev/x",
               "https://public.blob.vercel-storage.com/x", "http://abc.public.blob.vercel-storage.com/x",
               "https://u:p@abc.public.blob.vercel-storage.com/x", "https://abc.public.blob.vercel-storage.com:8443/x",
               "file:///etc/passwd", "not a url"]
        for u in ok:
            self.assertTrue(T.url_allowed(u, mm), u)
        for u in bad:
            self.assertFalse(T.url_allowed(u, mm), u)
        self.assertTrue(T.url_allowed("http://127.0.0.1:9/x", "http://127.0.0.1:9"))
        self.assertFalse(T.url_allowed("http://127.0.0.1:10/x", "http://127.0.0.1:9"))

    def test_train_step(self):
        self.assertEqual(T.train_step("Train Epoch: [2][ 40/200] loss 4.1", 4), (440, 800))
        self.assertIsNone(T.train_step("musefreeze31: trainable 30.4M params", 4))


if __name__ == "__main__":
    unittest.main()
