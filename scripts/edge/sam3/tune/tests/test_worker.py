"""worker.py against a stub of the site's worker API (no board, no torch, no network beyond 127.0.0.1):
claim, progress, Stop, the guards, uploads and the report it posts.

  python3 -I -m unittest discover scripts/edge/sam3/tune/tests
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
TUNE = HERE.parent
sys.path.insert(0, str(TUNE))
import worker as W  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64
RUN_ID = "7d4f8a52-3c1e-4b7a-9f00-0123456789ab"


class Site:
    """A stub of /api/train/sam/worker/*: records every request, answers from `self.answers`."""

    def __init__(self):
        self.requests, self.claim, self.stop_at = [], None, None
        site = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n)
                path = self.path
                rec = {"path": path, "auth": self.headers.get("Authorization"), "token": self.headers.get("X-Job-Token"),
                       "ctype": self.headers.get("Content-Type"), "raw": raw}
                try:
                    rec["body"] = json.loads(raw) if rec["ctype"] == "application/json" and raw else None
                except ValueError:
                    rec["body"] = None
                site.requests.append(rec)
                if rec["auth"] != "Bearer s3cret":
                    return self.send(401, {"error": "unauthorized"})
                if path.endswith("/next"):
                    if not site.claim:
                        self.send_response(204); self.end_headers(); return
                    c, site.claim = site.claim, None
                    return self.send(200, {"run": c})
                if path.endswith("/progress"):
                    stage = rec["body"]["stage"]
                    return self.send(200, {"stop": stage == site.stop_at})
                if "/upload?" in path:
                    if rec["token"] != "tok-1":
                        return self.send(401, {"error": "unauthorized"})
                    name = path.split("name=")[1]
                    return self.send(200, {"url": f"https://x.public.blob.vercel-storage.com/samtune/{RUN_ID}/report/{name}"})
                return self.send(200, {"status": "ok"})

            def send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                b = JPEG
                self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers()
                self.wfile.write(b)

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def paths(self):
        return [r["path"].split("/api/train/sam/worker/")[1] for r in self.requests]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def setting(found):
    return {"B": {"n": 30, "found": found, "top": 10, "only": 2, "otherBoxes": 40, "ap": 0.5, "ap50": 0.5},
            "A": {"n": 30, "firedPhotos": 20, "boxes": 50}, "medianScore": 0.9, "medianBestOther": 0.8}


class FakeBoard:
    """Stands in for systemd-run: writes what each step would write, and calls tick like the real runner."""

    def __init__(self, ticks=None):
        self.calls, self.ticks = [], ticks or {}

    def __call__(self, unit, argv, env, cwd, log_path, tick):
        self.calls.append((unit, argv, env))
        name = unit.rsplit("-", 1)[1]
        for lines in self.ticks.get(name, []):
            tick(lines)
        arg = lambda k: argv[argv.index(k) + 1]  # noqa: E731
        if name == "build":
            item = {"license": "Attribution License", "coco_id": 1, "flickr_url": "http://f/1", "word": "muse",
                    "w": 640, "h": 480}
            sets = {"word": "muse", "generic": "plush toy", "source": "nov3",
                    "sets": {"A": [{"id": "A-1", "file": "/x", **item}], "B": [{"id": "B-1", "file": "/y", "x": [1, 2, 3, 4], **item}]},
                    "counts": {"train_images": 200}}
            W.write_json(sets, f"{cwd}/sets.json")
            os.makedirs(f"{cwd}/data/samtune/train", exist_ok=True)
            Path(f"{cwd}/data/samtune/train/photo.jpg").write_bytes(JPEG)
        elif name in ("meta", "tune"):
            ids = ("meta_word", "meta_generic", "meta_toy") if name == "meta" else ("prior_word", "tuned_word", "tuned_generic")
            row_b = {"found": 1, "top": 1, "only": 0, "other": 1, "best_x": 0.9, "best_other": 0.6}
            out = {"settings": {i: setting(n) for n, i in enumerate(ids)},
                   "rows": {i: {"B-1": row_b, "A-1": {"fired": 1, "boxes": 2}} for i in ids},
                   "truck": {"meta" if name == "meta" else "tuned": {"truck": 1, "wheel": 4}}}
            if name == "tune":
                out["deltaSha256"] = "ab" * 32
            W.write_json(out, arg("--out"))
            W.write_json({}, arg("--masks"))
        elif name == "train":
            Path(env["SAM_TUNE_DELTA"]).write_bytes(b"delta")
        elif name == "draw":
            d = arg("--out-dir")
            os.makedirs(d, exist_ok=True)
            Path(f"{d}/sbs1.jpg").write_bytes(JPEG)
            W.write_json([{"file": "sbs1.jpg", "rule": "tuned_top", "image": "B-1", "credit": "COCO val2017 1 (CC BY 2.0, "
                        "http://f/1), Muse pasted in.", "license": "Attribution License"}], f"{d}/picks.json")
        return 0


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.site = Site()
        self.tmp = tempfile.mkdtemp()
        sam3 = Path(self.tmp, "sam3/sam3/train/configs/muse")
        sam3.mkdir(parents=True)
        (sam3 / "muse31.yaml").write_text("# @package _global_\n")
        lib = Path(self.tmp, "lib")
        (lib / "configs").mkdir(parents=True)
        shutil.copy(TUNE / "configs/sam_tune.yaml.tmpl", lib / "configs/sam_tune.yaml.tmpl")
        prior = Path(self.tmp, "muse31.pt")
        prior.write_bytes(b"prior")
        self.cfg = W.env_config({"MM_URL": self.site.url, "WORKER_ID": "jetson-03", "SAM_WORKER_TOKEN": "s3cret",
                                 "SAM_TUNE_HOME": f"{self.tmp}/home", "SAM_TUNE_LIB": str(lib),
                                 "SAM3_ROOT": f"{self.tmp}/sam3", "SAM_TUNE_PY": "python3",
                                 "SAM_TUNE_PRIOR": str(prior)})
        self.claim = {"id": RUN_ID, "word": "muse", "generic": "plush toy", "data": "builtin-muse", "photos": [],
                      "distractors": [], "seed": 20261103, "epochs": 4, "jobToken": "tok-1"}

    def tearDown(self):
        self.site.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def worker(self, board=None, mem=6500, disk=900, glimmer=False):
        return W.Worker(self.cfg, runner=board or FakeBoard(), probe=lambda home: (mem, disk, glimmer))

    def test_guards_refuse_without_asking(self):
        for kw in ({"mem": 5000}, {"disk": 200}, {"glimmer": True}):
            self.site.claim = dict(self.claim)
            self.assertIsNone(self.worker(**kw).poll_once())
        self.assertEqual(self.site.requests, [])

    def test_nothing_queued(self):
        self.assertIsNone(self.worker().poll_once())
        r = self.site.requests[0]
        self.assertEqual(r["body"], {"workerId": "jetson-03", "freeMemMb": 6500, "freeDiskMb": 900})
        self.assertEqual(r["auth"], "Bearer s3cret")

    def test_full_run_posts_numbers_only(self):
        self.site.claim = dict(self.claim)
        board = FakeBoard(ticks={"train": [["Train Epoch: [1][ 50/200] loss 5.0"]],
                                 "meta": [["STAGE loading_meta", "loaded in 50s"], ["STAGE scoring_meta", "LOOK 5 180"]]})
        self.assertEqual(self.worker(board).poll_once(), "done")
        paths = self.site.paths()
        self.assertEqual(paths[0], "next")
        stages = [r["body"]["stage"] for r in self.site.requests if r["path"].endswith("/progress")]
        self.assertEqual(stages, ["claimed", "building_sets", "loading_meta", "scoring_meta", "training", "loading_tune", "drawing",
                                  "uploading", "done"])
        uploads = [r for r in self.site.requests if "/upload?" in r["path"]]
        self.assertEqual([u["path"].split("name=")[1] for u in uploads], ["sbs1.jpg", "scores.json", "per_image.json"])
        self.assertTrue(all(u["token"] == "tok-1" for u in uploads))
        self.assertEqual(uploads[0]["ctype"], "image/jpeg")
        done = [r for r in self.site.requests if r["path"].endswith("/done")][0]["body"]
        self.assertEqual(done["jobToken"], "tok-1")
        rep = done["report"]
        self.assertEqual(set(rep), {"version", "word", "generic", "seed", "setsSource", "settings", "truck", "images",
                                    "files", "deltaSha256", "workerId", "apFrom", "timings"})
        self.assertEqual(rep["version"], 1)
        self.assertNotIn("verdict", rep)
        self.assertEqual(set(rep["settings"]), {"meta_word", "meta_generic", "meta_toy", "prior_word", "tuned_word",
                                                "tuned_generic"})
        self.assertEqual(rep["truck"], {"meta": {"truck": 1, "wheel": 4}, "tuned": {"truck": 1, "wheel": 4}})
        self.assertEqual(rep["images"][0]["rule"], "tuned_top")
        self.assertEqual(rep["images"][0]["caption"], "")
        self.assertTrue(rep["files"]["perImage"].endswith("per_image.json"))
        self.assertEqual((rep["setsSource"], rep["apFrom"], rep["workerId"]), ("nov3", 0.05, "jetson-03"))
        self.assertLess(len(json.dumps(rep)), 65_536)
        # heavy steps ran as capped units named for the run; the trainer got the run's own delta path
        units = [c[0] for c in board.calls]
        self.assertEqual(units, [f"sam-tune-{RUN_ID}-{n}" for n in ("build", "meta", "train", "tune", "draw")])
        train_env = board.calls[2][2]
        self.assertTrue(train_env["SAM_TUNE_DELTA"].endswith(f"deltas/{RUN_ID}.pt"))
        self.assertNotIn("SAM_WORKER_TOKEN", json.dumps([c[2] for c in board.calls]))
        self.assertIn("--prior", board.calls[3][1])
        # photos and the run's config are gone; the delta and results stay
        rd = Path(self.cfg["home"], "runs", RUN_ID)
        self.assertFalse((rd / "data").exists())
        self.assertTrue((rd / "tune.json").exists())
        self.assertFalse(list(Path(self.tmp, "sam3/sam3/train/configs/samtune").glob("*.yaml")))
        self.assertFalse(Path(self.cfg["home"], "current.json").exists())

    def test_stop_between_stages(self):
        self.site.claim = dict(self.claim)
        self.site.stop_at = "building_sets"
        board = FakeBoard()
        self.assertEqual(self.worker(board).poll_once(), "stopped")
        self.assertEqual(board.calls, [])
        fail = [r for r in self.site.requests if r["path"].endswith("/fail")]
        self.assertEqual(fail[0]["body"], {"jobToken": "tok-1", "reason": "Stopped by an admin."})
        self.assertFalse(any(r["path"].endswith("/done") for r in self.site.requests))

    def test_stop_during_training(self):
        self.site.claim = dict(self.claim)
        self.site.stop_at = "training"
        self.assertEqual(self.worker().poll_once(), "stopped")
        self.assertTrue(any(r["path"].endswith("/fail") for r in self.site.requests))

    def test_bad_word_refused_on_the_board(self):
        self.site.claim = {**self.claim, "word": "Muse; rm"}
        board = FakeBoard()
        self.assertEqual(self.worker(board).poll_once(), "failed")
        self.assertEqual(board.calls, [])
        fail = [r for r in self.site.requests if r["path"].endswith("/fail")][0]["body"]
        self.assertIn("refused the words", fail["reason"])

    def test_photos_only_from_allowed_hosts(self):
        w = self.worker()
        w.rid, w.tok = RUN_ID, "tok-1"
        rd = Path(self.tmp, "rd")
        claim = {**self.claim, "data": "uploads",
                 "photos": [{"url": f"{self.site.url}/p.jpg", "split": "train", "box": [1, 2, 3, 4], "skipped": False}]}
        got = w.download(claim, str(rd))
        self.assertTrue(got["photos"][0]["path"].endswith(".jpg"))
        claim["photos"].append({"url": "https://evil.dev/p.jpg", "split": "held", "box": [1, 2, 3, 4], "skipped": False})
        with self.assertRaises(ValueError):
            w.download(claim, str(rd))

    def test_restart_mid_run_tells_the_site(self):
        w = self.worker()
        w.save_state({"id": RUN_ID, "jobToken": "tok-1"})
        self.assertEqual(oct(os.stat(w.state_path()).st_mode & 0o777), "0o600")
        W.subprocess.run = lambda *a, **k: None  # no systemctl on the laptop
        w.recover()
        fail = [r for r in self.site.requests if r["path"].endswith("/fail")][0]["body"]
        self.assertEqual(fail["reason"], "The board restarted during the run.")
        self.assertFalse(os.path.exists(w.state_path()))

    def test_config_template_fills(self):
        tmpl = (TUNE / "configs/sam_tune.yaml.tmpl").read_text()
        out = W.fill_config(tmpl, "/r/data", "/r/train", 4, 7, False)
        self.assertTrue(out.startswith("# @package _global_\n"))
        self.assertIn("roboflow_vl_100_root: /r/data", out)
        self.assertIn("max_epochs: 4", out)
        self.assertIn("seed_value: 7", out)
        self.assertIn("_target_: musefreeze31.build", out)
        self.assertNotIn("include_negatives: true\n          _partial_: true\n        img_folder: ${paths.roboflow_vl_100_root}/"
                         "${roboflow_train.supercategory}/train/", out)
        neg = W.fill_config(tmpl, "/r/data", "/r/train", 4, 7, True)
        self.assertIn("include_negatives: true\n          _partial_: true\n        img_folder: ${paths.roboflow_vl_100_root}/"
                      "${roboflow_train.supercategory}/train/", neg)
        self.assertNotIn("@@", neg)
        self.assertEqual(W.image_ext(JPEG), "jpg")
        self.assertIsNone(W.image_ext(b"<html>"))


if __name__ == "__main__":
    unittest.main()
