"""Tests for ui.py, ask.py and compare.py against a fake SAM service and a fake control plane (no board, no network).

  python3 -m unittest scripts/edge/sam3/test_sam_page.py
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import compare  # noqa: E402
import ui  # noqa: E402

PIXEL = base64.b64encode(b"\xff\xd8\xff" + b"x" * 40).decode()


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


class FakeSam(BaseHTTPRequestHandler):
    """The Nov 3 server.py's answers. ignore_tuned plays the Nov 2 one, which had no tuned detectors."""
    seen = []
    ignore_tuned = False

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._send(200, {"ok": True, "gpu_mb": 3525, "tuned": [] if self.ignore_tuned else ["muse"]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeSam.seen.append(body)
        tuned = "base" if self.ignore_tuned else body.get("tuned", "base")
        if tuned not in ("base", "muse"):
            return self._send(400, {"error": f"no tuned detector named {tuned!r}"})
        found = body["prompt"] == "plush toy" or (body["prompt"] == "muse" and tuned == "muse")
        res = {"prompt": body["prompt"], "count": int(found), "ms": 1420, "image_size": [640, 480],
               "objects": [{"box": [1, 2, 3, 4], "score": 0.99, "area_px": 9}] if found else [],
               "overlay_jpeg_b64": PIXEL}
        if tuned != "base":
            res["weights"] = tuned
        self._send(200, res)

    def log_message(self, *a):
        pass


class FakeFleet(BaseHTTPRequestHandler):
    """The control plane's jobs API. Each exec job runs right away in a local bash, as the agent runs it with bash -lc."""
    jobs = {}
    commands = []

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        assert self.path == "/admin/api/jobs" and self.headers["Authorization"] == "Bearer jpt_test"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        cmd = body["params"]["command"]
        assert len(cmd) <= 16384, "over the control plane's command limit"
        FakeFleet.commands.append(cmd)
        p = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=60)
        jid = f"jb_{len(FakeFleet.jobs)}"
        FakeFleet.jobs[jid] = {"status": "succeeded" if p.returncode == 0 else "failed",
                               "tasks": [{"output": f"$ {cmd}\n" + p.stdout + p.stderr}]}
        self._send(200, {"job_id": jid})

    def do_GET(self):
        self._send(200, FakeFleet.jobs[self.path.rsplit("/", 1)[-1]])

    def log_message(self, *a):
        pass


class SamPageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sam, cls.sam_url = serve(FakeSam)
        cls.fleet, cls.fleet_url = serve(FakeFleet)

    @classmethod
    def tearDownClass(cls):
        cls.sam.shutdown()
        cls.fleet.shutdown()

    def setUp(self):
        FakeSam.seen.clear()
        FakeSam.ignore_tuned = False

    def direct(self):
        return ui.Config({"SAM_URL": self.sam_url})

    def test_fleet_url_has_no_default(self):
        self.assertIn("no default", ui.Config({}).problem())
        self.assertIn("/admin", ui.Config({"FLEET_URL": "http://cp.local:8080", "FLEET_TOKEN": "jpt_x"}).problem())
        self.assertIn("jpt_", ui.Config({"FLEET_URL": "http://cp.local:8080/admin"}).problem())
        self.assertIsNone(ui.Config({"FLEET_URL": "http://cp.local:8080/admin", "FLEET_TOKEN": "jpt_x"}).problem())
        self.assertIsNone(self.direct().problem())
        self.assertIn("no path", ui.Config({"SAM_URL": "http://10.0.0.2:8790/segment"}).problem())
        self.assertEqual(ui.Config({"SAM_URL": "http://a:1", "FLEET_URL": "http://b/admin"}).mode, "direct")

    def test_direct_base_and_tuned(self):
        before = ui.look(PIXEL, "muse", 0.5, "base", self.direct())
        after = ui.look(PIXEL, "muse", 0.5, "muse", self.direct())
        self.assertEqual((before["count"], before["weights"], before["via"]), (0, "base", "direct"))
        self.assertEqual((after["count"], after["weights"]), (1, "muse"))
        self.assertNotIn("tuned", FakeSam.seen[0])
        self.assertEqual(FakeSam.seen[1]["tuned"], "muse")

    def test_never_shows_meta_answer_as_the_tunes(self):
        FakeSam.ignore_tuned = True
        with self.assertRaisesRegex(RuntimeError, "asked for 'muse'"):
            ui.look(PIXEL, "muse", 0.5, "muse", self.direct())

    def test_service_errors_and_bad_input(self):
        with self.assertRaisesRegex(RuntimeError, "no tuned detector"):
            ui.look(PIXEL, "muse", 0.5, "other", self.direct())
        for args in [("not base64!", "muse", 0.5, "base"), (PIXEL, "  ", 0.5, "base"), (PIXEL, "muse", 2, "base"),
                     (PIXEL, "muse", 0.5, "Muse; rm")]:
            with self.assertRaises(ValueError):
                ui.look(*args, cfg=self.direct())

    def test_health_lists_tuned(self):
        self.assertEqual(ui.health(self.direct())["sam"]["tuned"], ["muse"])

    def test_fleet_end_to_end_with_inline_ask(self):
        cfg = ui.Config({"FLEET_URL": self.fleet_url + "/admin", "FLEET_TOKEN": "jpt_test", "SAM_BOARD_URL": self.sam_url})
        b64 = base64.b64encode(b"\xff\xd8\xff" + os.urandom(30000)).decode()  # 3 pieces
        FakeFleet.commands.clear()
        res = ui.look(b64, "plush toy", 0.4, "muse", cfg)
        self.assertEqual((res["count"], res["weights"], res["via"], res["parts"]), (1, "muse", "fleet", 3))
        self.assertEqual(FakeSam.seen[-1]["image_b64"], b64)
        self.assertEqual(FakeSam.seen[-1]["tuned"], "muse")
        self.assertEqual(FakeSam.seen[-1]["threshold"], 0.4)
        self.assertNotIn("python3 /opt/sam3/ask.py", FakeFleet.commands[-1])  # the repo's ask.py goes inline
        rid = re.search(r"python3 - ([0-9a-f]{12}) ", FakeFleet.commands[-1]).group(1)
        self.assertFalse(Path(f"/tmp/sam-ui/{rid}").exists(), "the pieces are removed after the look")
        before = ui.look(PIXEL, "muse", 0.5, "base", cfg)
        self.assertEqual((before["count"], before["weights"]), (0, "base"))
        self.assertNotIn("tuned", FakeSam.seen[-1])

    def test_ask_keeps_the_hosted_three_argument_form(self):
        rid = "a1b2c3d4e5f6"
        d = Path(f"/tmp/sam-ui/{rid}")
        d.mkdir(parents=True, exist_ok=True)
        (d / "000").write_text(PIXEL)
        p = subprocess.run([sys.executable, str(HERE / "ask.py"), rid, "plush toy", "0.500"], capture_output=True, text=True,
                           env={**os.environ, "SAM_URL": self.sam_url}, timeout=30)
        res = json.loads(p.stdout.split("SAMRESULT ", 1)[1])
        self.assertEqual(res["count"], 1)
        self.assertNotIn("tuned", FakeSam.seen[-1])
        self.assertFalse(d.exists())
        p = subprocess.run([sys.executable, str(HERE / "ask.py"), rid, "x", "0.5", "Bad Name"], capture_output=True, text=True,
                           env={**os.environ, "SAM_URL": self.sam_url}, timeout=30)
        self.assertIn("bad tuned name", p.stdout)

    def test_compare_writes_page_and_json(self):
        with tempfile.TemporaryDirectory() as t:
            photo = Path(t) / "muse.jpg"
            photo.write_bytes(base64.b64decode(PIXEL))
            old, old_photo = ui.CFG, compare.photo_b64
            ui.CFG = self.direct()
            compare.photo_b64 = lambda path, max_side=1024: PIXEL  # the fake JPEG isn't a real picture
            try:
                code = compare.main([str(photo), "--out", str(Path(t) / "c.html")])
            finally:
                ui.CFG, compare.photo_b64 = old, old_photo
            self.assertEqual(code, 0)
            rows = json.loads((Path(t) / "c.json").read_text())["rows"]
            self.assertEqual([(r["prompt"], r["base"]["count"], r["tuned"]["count"]) for r in rows],
                             [("muse", 0, 1), ("plush toy", 1, 1)])
            page = (Path(t) / "c.html").read_text()
            self.assertIn("Tuned on a Jetson: muse", page)
            self.assertNotIn("\u2014", page)


if __name__ == "__main__":
    unittest.main()
