"""Unit tests for the compare lab's machine side (common.py, lab.py, lab_remote.py, s3_put_remote.py).

    python3 -m unittest scripts/knowledge/compare/test_lab.py

No network beyond 127.0.0.1 fakes, no Lambda, no AWS, no lab. Fixtures are synthetic.
"""

import contextlib
import datetime as dt
import hashlib
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402
import lab  # noqa: E402
import lab_remote  # noqa: E402

UTC = dt.timezone.utc
T0 = dt.datetime(2026, 11, 1, 1, 0, tzinfo=UTC)
RD = "/home/ubuntu/compare"

# The real lab files only lab.py commands write (not the watch's watch.log and state.json, nor last_use), read before
# any test runs. tearDownModule fails the suite if a test changed one of them.
REAL_LAB_FILES = [os.path.join(C.LAB_DIR, n) for n in ("lab.log", "memory.json", "uploads.json", "known_hosts", "stopped")]


def file_mark(path):
    try:
        st = os.stat(path)
        return (st.st_size, st.st_mtime_ns)
    except OSError:
        return None


REAL_MARKS = {p: file_mark(p) for p in REAL_LAB_FILES}
_MODULE_LAB = None


def iso(t):
    return t.isoformat()


@contextlib.contextmanager
def temp_lab():
    """Points every state path of common and lab at a temp folder."""
    d = tempfile.mkdtemp(prefix="lab-test-")
    saved_c = {k: getattr(C, k) for k in ("LAB_DIR", "STATE", "LAST_USE", "STOPPED", "WATCH_PID", "TUNNEL_PID", "KNOWN_HOSTS")}
    saved_l = {k: getattr(lab, k) for k in ("LOG", "WATCH_LOG", "WATCH_LOCK", "STATE_LOCK", "MEMORY", "UPLOADS")}
    try:
        C.LAB_DIR = d
        for k in saved_c:
            if k != "LAB_DIR":
                setattr(C, k, os.path.join(d, os.path.basename(saved_c[k])))
        for k in saved_l:
            setattr(lab, k, os.path.join(d, os.path.basename(saved_l[k])))
        yield d
    finally:
        for k, v in saved_c.items():
            setattr(C, k, v)
        for k, v in saved_l.items():
            setattr(lab, k, v)
        shutil.rmtree(d, ignore_errors=True)


def setUpModule():
    """Every test runs with the state paths in a temp folder, also those that don't ask for temp_lab()."""
    global _MODULE_LAB
    _MODULE_LAB = temp_lab()
    _MODULE_LAB.__enter__()


def tearDownModule():
    if _MODULE_LAB is not None:
        _MODULE_LAB.__exit__(None, None, None)
    changed = [p for p in REAL_LAB_FILES if file_mark(p) != REAL_MARKS[p]]
    if changed:
        raise AssertionError("the tests changed real lab files (or a lab.py command ran meanwhile): " + ", ".join(changed))


def temp_config(mutate=None, d=None):
    with open(C.CONFIG) as f:
        raw = json.load(f)
    if mutate:
        mutate(raw)
    d = d or tempfile.mkdtemp(prefix="cfg-test-")
    path = os.path.join(d, "models.json")
    with open(path, "w") as f:
        json.dump(raw, f)
    return path


def reset_final(raw):
    """glimmer-final as it was before `lab.py add` (disabled, no sha256 or bytes)."""
    for m in raw["models"]:
        if m.get("name") == "glimmer-final":
            m["enabled"] = False
            m.pop("sha256", None)
            m.pop("bytes", None)


def pristine_config():
    """The live models.json with glimmer-final reset, so these tests don't depend on whether the final model was added."""
    return C.load_config(temp_config(reset_final))


def machine(**kw):
    m = {"provider": "lambda", "id": "i-1", "type": "gpu_1x_gh200", "usd_per_hour": 2.29, "launched": iso(T0),
         "deadline": iso(T0 + dt.timedelta(hours=4)), "ended": None, "ip": "10.0.0.9", "status": "active", "ready": True,
         "ready_at": iso(T0 + dt.timedelta(minutes=20)), "keep_until": None, "missing_lists": 0, "idle_minutes": 30}
    m.update(kw)
    return m


# ---- config ----

class TestConfig(unittest.TestCase):
    def test_live_final_entry(self):
        # After `lab.py add glimmer-final` the live entry carries the uploaded file's sha256 and size.
        f = C.model("glimmer-final", C.load_config())
        if f.get("sha256") is not None:
            self.assertRegex(f["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(int(f["bytes"]), 10**9)


    def test_real_config_and_like_run(self):
        cfg = pristine_config()
        f = C.model("glimmer-final", cfg)
        self.assertEqual(f["file"], "glimmer-stage-b-r30b-Q4_K_M.gguf")
        self.assertEqual(f["source"]["s3_key"], "knowledge/models/stage-b-r30b/glimmer-stage-b-r30b-Q4_K_M.gguf")
        self.assertEqual(f["source"]["writer1_path"], "/home/ubuntu/q/stage-b-r30b/glimmer-stage-b-r30b-Q4_K_M.gguf")
        self.assertIsNone(f["bytes"])
        self.assertIsNone(f["sha256"])
        self.assertEqual(f["port"], 8206)
        self.assertFalse(f["enabled"])
        self.assertEqual(f["replaces"], "glimmer-stage2")
        self.assertEqual(f["serve"], C.model("glimmer-stage2", cfg)["serve"])
        self.assertEqual(f["request"], C.model("glimmer-stage2", cfg)["request"])
        self.assertEqual(C.base_model(cfg)["name"], "glimmer-base")
        self.assertEqual(C.local_port(f, cfg), 18206)
        self.assertEqual(C.base_url(C.model("glimmer-base", cfg), cfg), "http://127.0.0.1:18202")
        self.assertEqual([m["name"] for m in C.models(cfg)], ["glimmer-stage2", "glimmer-base", "qwen3.8-27b", "gemma-4-31b", "granite-4.2-30b"])
        self.assertAlmostEqual(C.bpw(C.model("qwen3.8-27b", cfg)), 5.64, places=2)
        self.assertAlmostEqual(C.bpw(C.model("gemma-4-31b", cfg)), 4.60, places=2)
        self.assertEqual(C.bpw(f), 0.0)

    def test_replaces(self):
        cfg = pristine_config()
        self.assertNotIn("glimmer-final", [m["name"] for m in C.load_plan(cfg)])

        def enable(raw):
            reset_final(raw)
            raw["models"][-1]["enabled"] = True
        cfg2 = C.load_config(temp_config(enable))
        names = [m["name"] for m in C.load_plan(cfg2)]
        self.assertIn("glimmer-final", names)
        self.assertNotIn("glimmer-stage2", names)
        self.assertEqual(len(names), 5)
        names = [m["name"] for m in C.load_plan(cfg2, ["glimmer-stage2", "glimmer-final"])]
        self.assertEqual(names, ["glimmer-stage2", "glimmer-final"])
        with self.assertRaises(C.ConfigError):
            C.load_plan(cfg2, ["nope"])

    def test_rejects(self):
        cases = {
            "repeat name": lambda r: r["models"][1].update(name="glimmer-stage2"),
            "repeat port": lambda r: r["models"][1].update(port=8201),
            "port 5037": lambda r: r["models"][1].update(port=5037),
            "chat_port 5037": lambda r: r["lab"].update(chat_port=5037),
            "no off": lambda r: r["models"][2]["request"].pop("off"),
            "two bases": lambda r: r["models"][0].update(role="base"),
            "no base": lambda r: r["models"][1].update(role="other"),
            "missing like": lambda r: r["models"][-1].update(like="nobody"),
            "verbose flag": lambda r: r["models"][2]["serve"].append("-v"),
            "slots flag": lambda r: r["lab"]["server_flags"].append("--slots"),
            "prompt log": lambda r: r["lab"]["server_flags"].extend(["--log-prompts-dir", "/tmp/x"]),
            "outside range": lambda r: r["models"][1].update(port=9300),
        }
        for label, fn in cases.items():
            with self.subTest(label), self.assertRaises(C.ConfigError):
                C.load_config(temp_config(fn))

    def test_gpu_warning_only(self):
        def big(raw):
            for m in raw["models"]:
                if "gpu_gb" in m:
                    m["gpu_gb"] = 30
        cfg = C.load_config(temp_config(big))
        self.assertTrue(cfg["_warnings"])

    def test_fit_count(self):
        cfg = C.load_config()
        plan = C.load_plan(cfg)
        self.assertEqual(C.fit_count(plan, 97871), 5)
        self.assertEqual(C.fit_count(plan, 81559), 4)
        self.assertEqual(C.fit_count(plan, 40960), 2)
        self.assertEqual(C.fit_count(plan, 2 * 81559, 2), 5)
        self.assertEqual(C.fit_count(plan, None), 0)


# ---- requests and finals ----

class TestRequests(unittest.TestCase):
    def setUp(self):
        self.cfg = C.load_config()
        self.msgs = [{"role": "system", "content": C.SYSTEM}, {"role": "user", "content": "hi"}]

    def test_neutral_and_merge(self):
        g = C.model("glimmer-stage2", self.cfg)
        b = C.request_body(g, self.msgs, "off", max_tokens=96)
        for k, v in C.NEUTRAL.items():
            self.assertEqual(b[k], v)
        self.assertEqual(b["samplers"][-1], "temperature")
        self.assertEqual(b["stop"], ["<|eot|>"])
        self.assertEqual(b["chat_template_kwargs"], {"reasoning_strength": "low"})
        self.assertEqual((b["temperature"], b["top_k"], b["top_p"], b["seed"], b["cache_prompt"]), (0.0, 1, 1.0, 7, False))
        self.assertNotIn("stream_options", b)
        on = C.request_body(g, self.msgs, "on", max_tokens=2048, stream=True)
        self.assertEqual(on["reasoning_format"], "auto")
        self.assertEqual(on["chat_template_kwargs"], {"reasoning_strength": "low", "allow_reasoning": True})
        self.assertEqual(on["stream_options"], {"include_usage": True})
        q = C.request_body(C.model("qwen3.8-27b", self.cfg), self.msgs, "on", max_tokens=10)
        self.assertEqual(q["chat_template_kwargs"], {"enable_thinking": True, "reasoning_effort": "low"})
        self.assertNotIn("stop", q)

    def test_errors(self):
        g = C.model("glimmer-base", self.cfg)
        with self.assertRaises(ValueError):
            C.request_body({"name": "x", "request": {"off": {}}}, self.msgs, "on", max_tokens=8)
        with self.assertRaises(ValueError):
            C.request_body(g, [{"role": "user", "content": "hi"}], "off", max_tokens=8)
        with self.assertRaises(ValueError):
            C.request_body(g, [{"role": "system", "content": " "}, {"role": "user", "content": "hi"}], "off", max_tokens=8)
        with self.assertRaises(TypeError):
            C.request_body(g, self.msgs, "off")  # max_tokens is required

    def test_final_text(self):
        g = {"final": "glimmer"}
        self.assertEqual(C.final_text(g, " Paris.<|eot|>"), "Paris.")
        self.assertEqual(C.final_text(g, "x<|start|>assistant to=user<|message|>Lyon<|eot|>"), "Lyon")
        t = {"final": "think"}
        self.assertEqual(C.final_text(t, "<think>aaa</think>\n\n42"), "42")
        self.assertEqual(C.final_text(t, "<think>aaa"), "")
        self.assertEqual(C.final_text(t, "plain 42"), "plain 42")
        e = {"final": "gemma4"}
        self.assertEqual(C.final_text(e, "<|channel>thought\nbbb<channel|>42<turn|>"), "42")
        self.assertEqual(C.final_text(e, "42 <|channel>thought cut"), "42")
        self.assertEqual(C.final_text({"final": "plain"}, "  a  "), "a")
        self.assertEqual(C.final_text(g, None), "")


# ---- the watch ----

class TestWatchRules(unittest.TestCase):
    def setUp(self):
        self.cfg = C.load_config()

    def state(self, **kw):
        return {"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": machine(**kw)}}

    def reason(self, now, last_use=None, stopped=False, **kw):
        s = self.state(**kw)
        return lab.stop_reason(s["machines"]["muse-compare-lab-1"], s, self.cfg, now, last_use, stopped)

    def test_quiet_when_in_use(self):
        now = T0 + dt.timedelta(minutes=40)
        self.assertIsNone(self.reason(now, last_use=now - dt.timedelta(minutes=2)))

    def test_cap(self):
        s = self.state()
        s["ledger"]["spent_before_usd"] = 29.0
        now = T0 + dt.timedelta(minutes=25)
        why = lab.stop_reason(s["machines"]["muse-compare-lab-1"], s, self.cfg, now, now)
        self.assertIn("cap", why)

    def test_deadlines(self):
        self.assertIn("machine deadline", self.reason(T0 + dt.timedelta(hours=4, minutes=1), last_use=T0 + dt.timedelta(hours=4)))
        late = dt.datetime(2026, 11, 5, 3, 1, tzinfo=UTC)
        why = self.reason(late, last_use=late, deadline=iso(late + dt.timedelta(hours=1)), launched=iso(late - dt.timedelta(minutes=30)),
                          ready_at=iso(late - dt.timedelta(minutes=5)))
        self.assertEqual(why, "lab deadline_utc")

    def test_setup_limit(self):
        self.assertIsNone(self.reason(T0 + dt.timedelta(minutes=44), ready=False, ready_at=None))
        self.assertIn("not ready", self.reason(T0 + dt.timedelta(minutes=45), ready=False, ready_at=None))

    def test_idle(self):
        now = T0 + dt.timedelta(minutes=50)  # ready at +20, nothing since: 30 idle
        self.assertIn("idle", self.reason(now))
        self.assertIsNone(self.reason(now, last_activity=iso(now - dt.timedelta(minutes=1))))
        self.assertIsNone(self.reason(now, last_use=now - dt.timedelta(minutes=29)))
        self.assertIsNone(self.reason(now, keep_until=iso(now + dt.timedelta(minutes=10))))
        self.assertIn("idle", self.reason(now + dt.timedelta(minutes=41), keep_until=iso(now + dt.timedelta(minutes=10))))
        self.assertIn("idle", self.reason(T0 + dt.timedelta(minutes=35), idle_minutes=15))

    def test_stop_file(self):
        self.assertEqual(self.reason(T0 + dt.timedelta(minutes=30), last_use=T0 + dt.timedelta(minutes=29), stopped=True), "stop file")

    def test_activity(self):
        prev = {"18201": {"requests_processing": 0, "requests_deferred": 0, "tokens_predicted_total": 10, "prompt_tokens_total": 5}}
        same = {"18201": dict(prev["18201"])}
        self.assertFalse(lab.saw_activity(prev, same))
        busy = {"18201": dict(prev["18201"], requests_processing=1)}
        self.assertTrue(lab.saw_activity(prev, busy))  # a long request with unchanged counters still counts
        waiting = {"18201": dict(prev["18201"], requests_deferred=2)}
        self.assertTrue(lab.saw_activity(prev, waiting))
        grew = {"18201": dict(prev["18201"], tokens_predicted_total=11)}
        self.assertTrue(lab.saw_activity(prev, grew))
        self.assertFalse(lab.saw_activity(prev, {"18201": None}))
        self.assertFalse(lab.saw_activity(None, None))
        text = "# HELP x\nllamacpp:requests_processing 2\nllamacpp:tokens_predicted_total 1.5e3\nllamacpp:prompt_tokens_total 7\n"
        self.assertEqual(lab.metrics_text_values(text), {"requests_processing": 2.0, "tokens_predicted_total": 1500.0, "prompt_tokens_total": 7.0})

    def test_spend_by_started_minute(self):
        m = machine(ended=iso(T0 + dt.timedelta(minutes=10, seconds=1)))
        self.assertAlmostEqual(C.machine_hours(m), 11 / 60)
        self.assertEqual(C.machine_usd(dict(m, no_cost=True)), 0.0)
        s = {"ledger": {"spent_before_usd": 1.0}, "machines": {"a": m, "b": machine(launched=None)}}
        self.assertAlmostEqual(C.spent_usd(s), round(1.0 + 2.29 * 11 / 60, 2))
        self.assertEqual(C.burn_rate(s), 0.0)


class TestReconcile(unittest.TestCase):
    P = "muse-compare-lab-"

    def test_failed_list_changes_nothing(self):
        s = {"machines": {"muse-compare-lab-1": machine()}}
        before = json.dumps(s, sort_keys=True)
        strays, _ = lab.reconcile(s, None, T0, self.P)
        self.assertEqual(strays, [])
        self.assertEqual(json.dumps(s, sort_keys=True), before)

    def test_three_missing_lists_to_end(self):
        s = {"machines": {"muse-compare-lab-1": machine()}}
        for k in (1, 2):
            lab.reconcile(s, [], T0, self.P)
            self.assertIsNone(s["machines"]["muse-compare-lab-1"]["ended"])
            self.assertEqual(s["machines"]["muse-compare-lab-1"]["missing_lists"], k)
        lab.reconcile(s, [{"id": "i-1", "name": "muse-compare-lab-1", "status": "active", "ip": "1.2.3.4"}], T0, self.P)
        self.assertEqual(s["machines"]["muse-compare-lab-1"]["missing_lists"], 0)
        for _ in range(3):
            lab.reconcile(s, [], T0, self.P)
        self.assertTrue(s["machines"]["muse-compare-lab-1"]["ended"])

    def test_adopt_launching(self):
        s = {"machines": {"muse-compare-lab-2": machine(id=None, launched=iso(T0), launch_posted=iso(T0), status="launching", ready=False)}}
        listing = [{"id": "i-9", "name": "muse-compare-lab-2", "status": "booting", "ip": None}]
        strays, lines = lab.reconcile(s, listing, T0 + dt.timedelta(seconds=30), self.P)
        self.assertEqual(strays, [])
        self.assertEqual(s["machines"]["muse-compare-lab-2"]["id"], "i-9")
        self.assertTrue(s["machines"]["muse-compare-lab-2"]["adopted"])

    def test_lost_launch_ends_without_cost(self):
        s = {"machines": {"muse-compare-lab-2": machine(id=None, launched=iso(T0), launch_posted=iso(T0), ready=False)}}
        lab.reconcile(s, [], T0 + dt.timedelta(seconds=30), self.P)  # inside the grace: not counted
        self.assertEqual(s["machines"]["muse-compare-lab-2"]["missing_lists"], 0)
        for k in range(3):
            lab.reconcile(s, [], T0 + dt.timedelta(minutes=3 + k), self.P)
        m = s["machines"]["muse-compare-lab-2"]
        self.assertTrue(m["ended"])
        self.assertTrue(m["no_cost"])

    def test_stray_and_others(self):
        s = {"machines": {"muse-compare-lab-1": machine()}}
        listing = [{"id": "i-1", "name": "muse-compare-lab-1", "status": "active"},
                   {"id": "i-7", "name": "muse-compare-lab-7", "status": "active"},
                   {"id": "i-8", "name": "muse-compare-lab-8", "status": "terminating"},
                   {"id": "t-1", "name": "muse-knowledge-train-1", "status": "active"}]
        strays, _ = lab.reconcile(s, listing, T0, self.P)
        self.assertEqual([x["id"] for x in strays], ["i-7"])

    def test_reopen_ended_but_listed(self):
        s = {"machines": {"muse-compare-lab-1": machine(ended=iso(T0))}}
        lab.reconcile(s, [{"id": "i-1", "name": "muse-compare-lab-1", "status": "active"}], T0, self.P)
        self.assertIsNone(s["machines"]["muse-compare-lab-1"]["ended"])


class TestWatchOnce(unittest.TestCase):
    def setUp(self):
        self.cfg = C.load_config()

    def run_once(self, state, listing, now, confirm=True, metrics=None, stopped=False, last_use=None):
        calls = []

        def term(iid, lst):
            calls.append(iid)
            return confirm
        lab.save_state(state)
        done = lab.watch_once(self.cfg, now=now, list_fn=lambda: listing, terminate_fn=term, metrics_fn=lambda: metrics or {},
                              notify_fn=lambda *a: True, last_use=last_use or T0, stopped=stopped, say=lambda m: None)
        return done, calls, C.lab_state()

    def test_idle_terminates_and_exit(self):
        with temp_lab():
            now = T0 + dt.timedelta(minutes=55)
            st = {"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": machine()}}
            listing = [{"id": "i-1", "name": "muse-compare-lab-1", "status": "active"}]
            done, calls, after = self.run_once(st, listing, now)
            self.assertEqual(calls, ["i-1"])
            self.assertTrue(after["machines"]["muse-compare-lab-1"]["ended"])
            self.assertIn("idle", after["machines"]["muse-compare-lab-1"]["end_reason"])
            done, calls, _ = self.run_once(after, [], now + dt.timedelta(minutes=1))
            self.assertTrue(done)
            self.assertEqual(calls, [])

    def test_busy_request_keeps_it(self):
        with temp_lab():
            now = T0 + dt.timedelta(minutes=55)
            st = {"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": machine()}}
            listing = [{"id": "i-1", "name": "muse-compare-lab-1", "status": "active"}]
            busy = {"18201": {"requests_processing": 1, "requests_deferred": 0, "tokens_predicted_total": 5, "prompt_tokens_total": 5}}
            done, calls, after = self.run_once(st, listing, now, metrics=busy)
            self.assertEqual(calls, [])
            self.assertFalse(done)
            self.assertEqual(after["machines"]["muse-compare-lab-1"]["last_activity"], iso(now).replace("+00:00", "+00:00"))

    def test_unconfirmed_terminate_retries(self):
        with temp_lab():
            now = T0 + dt.timedelta(minutes=55)
            st = {"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": machine()}}
            listing = [{"id": "i-1", "name": "muse-compare-lab-1", "status": "active"}]
            done, calls, after = self.run_once(st, listing, now, confirm=False)
            self.assertEqual(calls, ["i-1"])
            self.assertIsNone(after["machines"]["muse-compare-lab-1"]["ended"])
            self.assertFalse(done)

    def test_failed_list_terminates_nothing(self):
        with temp_lab():
            now = T0 + dt.timedelta(hours=5)
            st = {"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": machine()}}
            done, calls, after = self.run_once(st, None, now)
            self.assertEqual(calls, [])
            self.assertFalse(done)
            self.assertIsNone(after["machines"]["muse-compare-lab-1"]["ended"])

    def test_stray_terminated(self):
        with temp_lab():
            st = {"ledger": {"spent_before_usd": 0.0}, "machines": {}}
            listing = [{"id": "i-5", "name": "muse-compare-lab-5", "status": "active"},
                       {"id": "t-1", "name": "muse-knowledge-train-1", "status": "active"}]
            done, calls, _ = self.run_once(st, listing, T0)
            self.assertEqual(calls, ["i-5"])
            self.assertFalse(done)

    def test_failing_stray_terminate_does_not_skip_ours(self):
        with temp_lab():
            now = T0 + dt.timedelta(minutes=55)  # our machine is idle past its limit
            st = {"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": machine()}}
            listing = [{"id": "i-5", "name": "muse-compare-lab-5", "status": "active"},
                       {"id": "i-1", "name": "muse-compare-lab-1", "status": "active"}]
            calls, notes, said = [], [], []

            def term(iid, lst):
                calls.append(iid)
                if iid == "i-5":
                    raise urllib.error.URLError("network down")
                return True
            lab.save_state(st)
            lab.watch_once(self.cfg, now=now, list_fn=lambda: listing, terminate_fn=term, metrics_fn=lambda: {},
                           notify_fn=lambda t, b: notes.append(b) or True, last_use=T0, stopped=False, say=said.append)
            self.assertEqual(calls, ["i-1", "i-5"])  # our own machine first
            self.assertTrue(C.lab_state()["machines"]["muse-compare-lab-1"]["ended"])
            self.assertFalse([n for n in notes if "stray" in n])  # no claim of a terminate that failed
            self.assertTrue([s for s in said if "stray" in s and "failed (URLError)" in s])
            # An unconfirmed stray terminate is not announced either; a confirmed one is.
            for confirm, want in ((False, 0), (True, 1)):
                notes.clear()
                lab.save_state({"ledger": {"spent_before_usd": 0.0}, "machines": {}})
                lab.watch_once(self.cfg, now=now, list_fn=lambda: listing[:1], terminate_fn=lambda iid, lst: confirm,
                               metrics_fn=lambda: {}, notify_fn=lambda t, b: notes.append(b) or True, last_use=T0,
                               stopped=False, say=lambda m: None)
                self.assertEqual(len([n for n in notes if "stray" in n]), want)

    def test_terminate_only_prefix(self):
        listing = [{"id": "t-1", "name": "muse-knowledge-train-1"}]
        saved = lab.LAM
        sent = []
        lab.LAM = lambda method, path, body=None: sent.append((method, path, body)) or {"data": {"terminated_instances": [{"id": "t-1"}]}}
        try:
            self.assertFalse(lab.terminate_instance("t-1", listing, "muse-compare-lab-"))
            self.assertEqual(sent, [])
            listing = [{"id": "c-1", "name": "muse-compare-lab-1"}]
            lab.LAM = lambda method, path, body=None: sent.append((method, path, body)) or {"data": {"terminated_instances": [{"id": "c-1"}]}}
            self.assertTrue(lab.terminate_instance("c-1", listing, "muse-compare-lab-"))
            self.assertEqual(sent, [("POST", "instance-operations/terminate", {"instance_ids": ["c-1"]})])
        finally:
            lab.LAM = saved


class TestWrapper(unittest.TestCase):
    def test_exit_zero_ends_loop_and_failure_restarts(self):
        d = tempfile.mkdtemp()
        try:
            count = os.path.join(d, "n")
            script = os.path.join(d, "fake.sh")
            with open(script, "w") as f:
                f.write(f'n=$(cat {count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {count}; [ "$1" = watch ] || exit 9; '
                        f'[ $n -ge 3 ] && exit 0; exit 1\n')
            wrapper = lab.watch_wrapper("/bin/sh", script, pause=0)
            r = subprocess.run(["bash", "-c", wrapper], timeout=20)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(open(count).read().strip(), "3")  # two failures restarted, the clean exit stopped it
            os.remove(count)
            with open(script, "w") as f:
                f.write(f"echo 1 >> {count}; exit 0\n")
            subprocess.run(["bash", "-c", wrapper], timeout=20)
            self.assertEqual(len(open(count).read().split()), 1)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_single_instance_lock(self):
        with temp_lab():
            import fcntl
            holder = open(lab.WATCH_LOCK, "a")
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(lab.watch(interval=0), 0)  # returns at once without a cycle
            finally:
                holder.close()


# ---- the presigned multipart protocol ----

class FakeS3(http.server.BaseHTTPRequestHandler):
    parts = {}
    puts = []
    always_403 = set()

    def log_message(self, *a):
        pass

    def do_PUT(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        n = int(q["partNumber"][0])
        data = self.rfile.read(int(self.headers["Content-Length"]))
        FakeS3.puts.append((n, q["X-Amz-Signature"][0]))
        if q["X-Amz-Signature"][0] == "bad" or n in FakeS3.always_403:
            self.send_response(403)
            self.end_headers()
            return
        FakeS3.parts[n] = data
        self.send_response(200)
        self.send_header("ETag", '"' + hashlib.md5(data).hexdigest() + '"')
        self.send_header("Content-Length", "0")
        self.end_headers()


class StubS3:
    def __init__(self, port, spoil=()):
        self.port, self.spoil, self.calls = port, set(spoil), []

    def create_multipart_upload(self, Bucket, Key):
        self.calls.append(("create", Key))
        return {"UploadId": "U-ours"}

    def generate_presigned_url(self, op, Params, ExpiresIn, HttpMethod=None):
        n = Params["PartNumber"]
        self.calls.append(("presign", n, ExpiresIn))
        sig = "bad" if n in self.spoil else "good"
        self.spoil.discard(n)
        return f"http://127.0.0.1:{self.port}/{Params['Key']}?partNumber={n}&uploadId={Params['UploadId']}&X-Amz-Signature={sig}"

    def head_object(self, Bucket, Key):
        if ("complete",) not in [c[:1] for c in self.calls]:
            raise KeyError("NoSuchKey")
        return {"ContentLength": sum(len(v) for v in FakeS3.parts.values())}

    def get_object(self, Bucket, Key):
        raise KeyError("NoSuchKey")

    def complete_multipart_upload(self, Bucket, Key, UploadId, MultipartUpload):
        self.calls.append(("complete", UploadId, [p["PartNumber"] for p in MultipartUpload["Parts"]]))

    def put_object(self, Bucket, Key, Body):
        self.calls.append(("put", Key, Body))

    def abort_multipart_upload(self, Bucket, Key, UploadId):
        self.calls.append(("abort", UploadId))


class TestPresign(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeS3)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        FakeS3.parts, FakeS3.puts, FakeS3.always_403 = {}, [], set()
        self.d = tempfile.mkdtemp()
        self.file = os.path.join(self.d, "glimmer-test-Q4_K_M.gguf")
        self.data = os.urandom(5 * 65536 + 1234)
        with open(self.file, "wb") as f:
            f.write(self.data)

        def mutate(raw):
            raw["models"][0]["bytes"] = None
            raw["models"][0]["sha256"] = None  # the real models.json gets one once s3-put has run
            raw["models"][0]["source"]["writer1_path"] = self.file
        self.cfg_path = temp_config(mutate, self.d)
        self.cfg = C.load_config(self.cfg_path)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def put(self, stub, **kw):
        argv = [sys.executable, "-I", "-c", lab.BOOTSTRAP]
        out = io.StringIO()
        with temp_lab(), contextlib.redirect_stdout(out):
            res = lab.s3_put("glimmer-stage2", self.cfg, client_factory=lambda: stub, argv=argv, size_fn=os.path.getsize,
                             config_path=self.cfg_path, part_bytes=65536, batch=2, **kw)
        return res, out.getvalue(), argv

    def test_batches_repress_and_complete(self):
        stub = StubS3(self.port, spoil={3})
        (sha, size), printed, argv = self.put(stub)
        self.assertEqual(sha, hashlib.sha256(self.data).hexdigest())
        self.assertEqual(size, len(self.data))
        self.assertEqual(b"".join(FakeS3.parts[n] for n in sorted(FakeS3.parts)), self.data)
        presigned = [c[1] for c in stub.calls if c[0] == "presign"]
        self.assertEqual(sorted(set(presigned)), [1, 2, 3, 4, 5, 6])
        self.assertEqual(presigned.count(3), 2)  # spoiled once, presigned again
        self.assertTrue(all(c[2] == 900 for c in stub.calls if c[0] == "presign"))
        self.assertIn(("complete", "U-ours", [1, 2, 3, 4, 5, 6]), stub.calls)
        self.assertFalse([c for c in stub.calls if c[0] == "abort"])
        sha_put = [c for c in stub.calls if c[0] == "put"][0]
        self.assertTrue(sha_put[1].endswith(".sha256"))
        m = C.model("glimmer-stage2", C.load_config(self.cfg_path))
        self.assertEqual((m["sha256"], m["bytes"]), (sha, len(self.data)))
        self.assertNotIn("http", printed)
        self.assertNotIn("Signature", printed)
        self.assertFalse(any("http" in a for a in argv))
        self.assertFalse(any("http" in a for a in lab.uploader_argv(self.cfg)))

    def test_gives_up_and_aborts_only_ours(self):
        FakeS3.always_403 = {2}
        stub = StubS3(self.port)
        with self.assertRaises(lab.LabError) as ctx:
            self.put(stub)
        self.assertNotIn("http", str(ctx.exception))
        self.assertEqual([c for c in stub.calls if c[0] == "abort"], [("abort", "U-ours")])
        self.assertEqual(FakeS3.puts.count((2, "good")), 5)
        m = C.model("glimmer-stage2", C.load_config(self.cfg_path))
        self.assertIsNone(m["sha256"])

    def test_wrong_size_refused(self):
        def mutate(raw):
            raw["models"][0]["source"]["writer1_path"] = self.file
            raw["models"][0]["bytes"] = 7
        cfg = C.load_config(temp_config(mutate, self.d))
        with temp_lab(), self.assertRaises(lab.LabError):
            lab.s3_put("glimmer-stage2", cfg, client_factory=lambda: StubS3(self.port), size_fn=os.path.getsize)

    def test_writer1_path_guard(self):
        for bad in ("/etc/passwd", "/home/ubuntu/q/../x.gguf", "/home/ubuntu/mp-gpu/a.gguf", "/home/ubuntu/q/gpu.lock"):
            with self.subTest(bad), self.assertRaises(lab.LabError):
                lab.check_writer1_path(bad)
        lab.check_writer1_path("/home/ubuntu/q/stage-b-r30/glimmer-stage-b-r30-Q4_K_M.gguf")

    def test_scrub(self):
        s = lab.scrub("err https://b.s3.amazonaws.com/k?X-Amz-Signature=abc&x=1 then X-Amz-Credential=AKIA/x")
        self.assertNotIn("amazonaws", s)
        self.assertNotIn("AKIA", s)


class TestCredentials(unittest.TestCase):
    class Expired:
        def get_credentials(self):
            raise RuntimeError("Token has expired and refresh failed")

    class NoCreds:
        def get_credentials(self):
            return None

    def test_message(self):
        cfg = C.load_config()
        for s in (self.Expired(), self.NoCreds()):
            with self.assertRaises(SystemExit) as ctx:
                lab.check_aws(cfg, s)
            self.assertEqual(str(ctx.exception), "AWS login expired: run `aws login --profile offlinebase`, then retry")
        with self.assertRaises(SystemExit) as ctx:
            lab.fresh_s3(self.Expired(), cfg)
        self.assertIn("aws login --profile offlinebase", str(ctx.exception))


# ---- command lines ----

class TestCommandLines(unittest.TestCase):
    def setUp(self):
        self.cfg = C.load_config()

    def test_server_argv(self):
        g = C.model("glimmer-stage2", self.cfg)
        argv = lab.server_argv(g, self.cfg, 8192)
        self.assertEqual(argv[0], "/home/ubuntu/compare/llama.cpp-b11970/build/bin/llama-server")
        self.assertEqual(argv[argv.index("--host") + 1], "127.0.0.1")
        self.assertEqual(argv[argv.index("-c") + 1], "16384")
        self.assertEqual(argv[argv.index("-np") + 1], "2")
        self.assertEqual(argv[argv.index("--alias") + 1], "glimmer-stage2")
        self.assertEqual(argv[argv.index("--chat-template-file") + 1], "/home/ubuntu/compare/templates/tuned-reasoning-off.jinja")
        for flag in ("--no-slots", "--metrics", "--no-webui", "--jinja"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("-ctk") + 1], "q8_0")
        self.assertEqual(argv[argv.index("-ctv") + 1], "q8_0")
        for bad in ("-v", "--verbose", "--log-prompts-dir", "--slot-save-path", "--slots"):
            self.assertNotIn(bad, argv)
        self.assertIn("--device", lab.server_argv(g, self.cfg, 4096, 1))
        self.assertEqual(lab_remote.check_argv("glimmer-stage2", argv, "b11970", RD), argv[0])
        with self.assertRaises(ValueError):
            lab_remote.check_argv("glimmer-stage2", argv + ["-v"], "b11970", RD)
        with self.assertRaises(ValueError):
            bad = list(argv)
            bad[bad.index("--host") + 1] = "0.0.0.0"
            lab_remote.check_argv("glimmer-stage2", bad, "b11970", RD)
        sh = lab.server_shell(argv, self.cfg, "glimmer-stage2")
        self.assertTrue(sh.startswith("LD_LIBRARY_PATH=/home/ubuntu/compare/llama.cpp-b11970/build/bin setsid nohup "))
        self.assertTrue(sh.endswith("> /home/ubuntu/compare/logs/glimmer-stage2.log 2>&1 < /dev/null &"))

    def test_tunnel(self):
        argv = lab.tunnel_argv(self.cfg, "10.1.2.3")
        fwd = [argv[i + 1] for i, a in enumerate(argv) if a == "-L"]
        self.assertEqual(len(fwd), 9)
        self.assertTrue(all(f.startswith("127.0.0.1:182") and f.endswith(f":127.0.0.1:{int(f.split(':')[1]) - 10000}") for f in fwd))
        self.assertNotIn("5037", " ".join(argv))
        self.assertIn("ExitOnForwardFailure=yes", argv)
        self.assertEqual(argv[-1], "ubuntu@10.1.2.3")

    def test_devices(self):
        plan = C.load_plan(self.cfg)
        self.assertEqual(set(lab.devices_for(plan, 1).values()), {None})
        d2 = lab.devices_for(plan, 2)
        self.assertEqual(set(d2.values()), {0, 1})

    def test_keep_capped(self):
        m = machine()
        until = lab.keep_until(m, 600, self.cfg, now=T0 + dt.timedelta(hours=3))
        self.assertEqual(until, C.parse_time(m["deadline"]))


# ---- a fake llama-server for the warm-up, the smoke check and /metrics ----

class FakeLlama(http.server.BaseHTTPRequestHandler):
    bodies = []

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, text=None):
        data = text.encode() if text is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"status": "ok"})
        if self.path == "/metrics":
            return self._send(200, text="llamacpp:requests_processing 0\nllamacpp:requests_deferred 0\n"
                                        "llamacpp:tokens_predicted_total 12\nllamacpp:prompt_tokens_total 30\n")
        self._send(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeLlama.bodies.append(body)
        if body["messages"][0]["role"] != "system":
            return self._send(400, {"error": {"message": "no system"}})
        on = (body.get("chat_template_kwargs") or {}).get("allow_reasoning")
        self._send(200, {"choices": [{"message": {"content": "17 + 25 = 42<|eot|>", "reasoning_content": "r" * 30 if on else None},
                                      "finish_reason": "stop"}],
                         "usage": {"prompt_tokens": 20, "completion_tokens": 9}, "timings": {"predicted_per_second": 55.5}})


class TestFakeServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeLlama)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

        def mutate(raw):
            raw["lab"]["local_port_offset"] = cls.port - 8201
        cls.cfg = C.load_config(temp_config(mutate))

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_health_smoke_warmup_metrics(self):
        g = C.model("glimmer-stage2", self.cfg)
        self.assertEqual(C.health(g, cfg=self.cfg), "ok")
        self.assertEqual(C.health(C.model("glimmer-base", self.cfg), cfg=self.cfg), "down")
        FakeLlama.bodies = []
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            res = lab.smoke(self.cfg, [g])
        self.assertEqual(res["glimmer-stage2/off"]["final_chars"], len("17 + 25 = 42"))
        self.assertTrue(res["glimmer-stage2/on"]["has_42"])
        self.assertEqual(res["glimmer-stage2/on"]["reasoning_chars"], 30)
        self.assertNotIn("rrrr", out.getvalue())
        self.assertTrue(all(b["samplers"] == C.NEUTRAL["samplers"] for b in FakeLlama.bodies))
        FakeLlama.bodies = []
        w = lab.warmup([g], self.cfg, 2)
        self.assertEqual(w, {"glimmer-stage2": [200, 200]})
        self.assertEqual({b["max_tokens"] for b in FakeLlama.bodies}, {8})
        self.assertGreater(len(FakeLlama.bodies[0]["messages"][1]["content"]), 2000)
        m = lab.read_metrics(self.cfg, timeout=1)
        self.assertEqual(m[str(self.port)]["tokens_predicted_total"], 12.0)
        self.assertIsNone(m[str(self.port + 1)])


# ---- the memory ladder, on a simulated GPU ----

class TestLadder(unittest.TestCase):
    """lab.ladder with the lab replaced by a GPU model: each server takes gpu_gb (at ctx 8192) or 1 GB less (at 4096),
    and the warm-up grows each server's pool by `pool` MiB."""

    def run_ladder(self, total_mib, pool=600, broken=(), breaks=None):
        """broken: models that never start. breaks: {model: n}, a model that fails to start from attempt n on (1 is the
        first attempt), for any reason but memory."""
        cfg = pristine_config()
        plan = C.load_plan(cfg)
        running = {}
        attempts = [0]
        breaks = breaks or {}

        def use(m, ctx):
            return int(float(m["gpu_gb"]) * 1000 / 1.048576) - (0 if ctx >= 8192 else 950)

        def free():
            return total_mib - sum(running.values())

        def fake_remote(cfg_, ip, args, data=None, timeout=180):
            if args == "stop-all":
                running.clear()
                attempts[0] += 1
                return {"stopped_all": True}
            if args == "gpu":
                return {"free_mib": free(), "servers": {n: {"gpu_mib": v} for n, v in running.items()}}
            if args == "ps":
                return {"servers": {n: {"alive": True} for n in running}}
            raise AssertionError(args)

        def fake_start(cfg_, ip, m, ctx, device):
            need = use(m, ctx)
            if m["name"] not in broken and attempts[0] < breaks.get(m["name"], 10 ** 6) and need <= free():
                running[m["name"]] = need
            return lab.server_argv(m, cfg, ctx, device)

        def fake_warmup(models_, cfg_, slots):
            for m in models_:
                if m["name"] in running:
                    running[m["name"]] += pool
            for n in list(running):  # a server that runs out in the warm-up dies
                if free() < 0:
                    running.pop(n)
            return {m["name"]: [200] * slots for m in models_}

        saved = (lab.remote, lab.start_server, lab.wait_health, lab.warmup, C.health, lab.log)
        lab.remote, lab.start_server, lab.warmup = fake_remote, fake_start, fake_warmup
        lab.wait_health = lambda cfg_, ip, m, minutes=10: m["name"] in running
        C.health = lambda m, timeout=3, cfg=None: "ok" if m["name"] in running else "down"
        lab.log = lambda *a, **k: None
        try:
            with temp_lab():
                lab.save_state({"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": machine(ready=False)}})
                ctx, loaded, servers, ok = lab.ladder(cfg, "muse-compare-lab-1", "10.0.0.9", plan, 1)
                steps = C.lab_state()["machines"]["muse-compare-lab-1"]["ladder"]
                mem = json.load(open(lab.MEMORY))
        finally:
            lab.remote, lab.start_server, lab.wait_health, lab.warmup, C.health, lab.log = saved
        self.assertEqual(mem["steps"], steps)
        return ctx, [m["name"] for m in loaded], {k: v["state"] for k, v in servers.items()}, ok, [s["step"] for s in steps]

    def test_fits_at_full_context(self):
        ctx, loaded, states, ok, steps = self.run_ladder(97871)
        self.assertEqual((ctx, ok, len(loaded), steps), (8192, True, 5, ["1 uniform"]))

    def test_context_fallback(self):
        ctx, loaded, states, ok, steps = self.run_ladder(93500)
        self.assertEqual((ctx, ok, len(loaded)), (4096, True, 5))
        self.assertEqual(steps, ["1 uniform", "3 ctx fallback"])

    def test_swap_last_other(self):
        ctx, loaded, states, ok, steps = self.run_ladder(81559)
        self.assertTrue(ok)
        self.assertEqual(ctx, 4096)
        self.assertEqual(states["granite-4.2-30b"], "not loaded (memory)")
        self.assertEqual(sum(1 for s in states.values() if s == "up"), 4)

    def test_broken_model_is_left_out_not_swapped(self):
        ctx, loaded, states, ok, steps = self.run_ladder(97871, broken={"gemma-4-31b"})
        self.assertTrue(ok)
        self.assertEqual(states["gemma-4-31b"], "failed")
        self.assertEqual(states["granite-4.2-30b"], "up")
        self.assertEqual(len(loaded), 4)

    def test_failure_after_swap_drops_no_healthy_model(self):
        # Steps 1 and 3 run short of memory, so granite is left out; then qwen fails with memory to spare. The
        # next try leaves out only qwen: gemma, which is healthy and fits, stays loaded.
        ctx, loaded, states, ok, steps = self.run_ladder(81559, breaks={"qwen3.8-27b": 3})
        self.assertTrue(ok)
        self.assertEqual(steps, ["1 uniform", "3 ctx fallback", "4 without granite-4.2-30b", "4 without failed: qwen3.8-27b"])
        self.assertEqual(states["qwen3.8-27b"], "failed")
        self.assertEqual(states["gemma-4-31b"], "up")
        self.assertEqual(states["granite-4.2-30b"], "not loaded (memory)")
        self.assertEqual(sorted(loaded), ["gemma-4-31b", "glimmer-base", "glimmer-stage2"])


# ---- lab_remote ----

class FakeRange(http.server.BaseHTTPRequestHandler):
    data = b""
    deny = set()
    hits = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        tok = q.get("t", [""])[0]
        FakeRange.hits.append(tok)
        if tok in FakeRange.deny:
            self.send_response(403)
            self.end_headers()
            return
        a, b = self.headers["Range"].split("=")[1].split("-")
        a, b = int(a), int(b)
        part = FakeRange.data[a:b + 1]
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {a}-{b}/{len(FakeRange.data)}")
        self.send_header("Content-Length", str(len(part)))
        self.end_headers()
        self.wfile.write(part)


class TestLabRemote(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeRange)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.d = tempfile.mkdtemp()
        FakeRange.data = os.urandom(3 * 1024 * 1024 + 77)
        FakeRange.deny, FakeRange.hits = {"old"}, []
        self.sha = hashlib.sha256(FakeRange.data).hexdigest()
        self.saved_say = lab_remote.say

    def tearDown(self):
        lab_remote.say = self.saved_say
        shutil.rmtree(self.d, ignore_errors=True)

    def url(self, tok):
        return f"http://127.0.0.1:{self.port}/obj?t={tok}"

    def test_fetch_needs_new_url_then_checks_sha(self):
        said = []
        holder = {}

        def fake_say(obj):
            said.append(obj)
            if "need" in obj:
                holder["f"].new_url(self.url("new"))
        lab_remote.say = fake_say
        f = lab_remote.Fetch({"file": "m.gguf", "bytes": len(FakeRange.data), "sha256": self.sha, "s3_url": self.url("old")},
                             models_dir=self.d, streams=4, min_range=1 << 20, url_wait=20)
        holder["f"] = f
        res = f.run()
        self.assertEqual(res, {"ok": "m.gguf", "sha256": self.sha})
        self.assertEqual(open(os.path.join(self.d, "m.gguf"), "rb").read(), FakeRange.data)
        self.assertEqual(sum(1 for x in said if "need" in x), 1)
        self.assertFalse(any("http" in json.dumps(x) for x in said))
        again = lab_remote.Fetch({"file": "m.gguf", "bytes": len(FakeRange.data), "sha256": self.sha, "s3_url": self.url("new")},
                                 models_dir=self.d).run()
        self.assertTrue(again.get("cached"))

    def test_sha_mismatch_fails(self):
        lab_remote.say = lambda obj: None
        FakeRange.deny = set()
        f = lab_remote.Fetch({"file": "m.gguf", "bytes": len(FakeRange.data), "sha256": "0" * 64, "s3_url": self.url("ok")},
                             models_dir=self.d, streams=2, min_range=1 << 20)
        res = f.run()
        self.assertEqual(res["err"], "m.gguf")
        self.assertFalse(os.path.exists(os.path.join(self.d, "m.gguf")))

    def test_resume(self):
        lab_remote.say = lambda obj: None
        FakeRange.deny = set()
        spec = {"file": "m.gguf", "bytes": len(FakeRange.data), "sha256": self.sha, "s3_url": self.url("ok")}
        f = lab_remote.Fetch(spec, models_dir=self.d, streams=3, min_range=1 << 20)
        ranges = f._ranges()
        part = os.path.join(self.d, "m.gguf.part")
        with open(part, "wb") as fh:
            fh.truncate(len(FakeRange.data))
            fh.seek(0)
            fh.write(FakeRange.data[:ranges[0][1] + 1])  # the first range already done
        offsets = [ranges[0][1] + 1] + [s for s, _ in ranges[1:]]
        with open(part + ".json", "w") as fh:
            json.dump({"bytes": spec["bytes"], "sha256": self.sha, "ranges": [list(r) for r in ranges], "offsets": offsets}, fh)
        FakeRange.hits = []
        self.assertIn("ok", f.run())
        self.assertEqual(len(FakeRange.hits), 2)  # only the two unfinished ranges were asked for

    def test_hf_resolve_checks(self):
        class Opener:
            def __init__(self, headers):
                self.h = headers

            def open(self, req, timeout=None):
                self.req = req
                import email.message
                msg = email.message.Message()
                for k, v in self.h.items():
                    msg[k] = v
                raise urllib.error.HTTPError(req.full_url, 302, "Found", msg, None)
        good = {"Location": "https://cdn.example/x?sig=1", "X-Linked-Size": "100", "X-Linked-ETag": '"' + "a" * 64 + '"',
                "X-Repo-Commit": "c" * 40}
        o = Opener(good)
        url, _ = lab_remote.hf_resolve("org/repo", "c" * 40, "f.gguf", 100, "a" * 64, opener=o)
        self.assertEqual(url, "https://cdn.example/x?sig=1")
        self.assertNotIn("Authorization", o.req.headers)
        self.assertEqual(o.req.get_method(), "HEAD")
        for k, v in (("X-Linked-Size", "99"), ("X-Linked-ETag", "b" * 64), ("X-Repo-Commit", "d" * 40)):
            with self.subTest(k), self.assertRaises(ValueError):
                lab_remote.hf_resolve("org/repo", "c" * 40, "f.gguf", 100, "a" * 64, opener=Opener(dict(good, **{k: v})))

    def test_fetch_exits_when_the_mac_side_is_gone(self):
        spec = {"file": "m.gguf", "bytes": len(FakeRange.data), "sha256": self.sha, "s3_url": self.url("ok")}
        code = (f"import sys; sys.path.insert(0, {HERE!r}); import lab_remote; "
                f"sys.exit(lab_remote.fetch(models_dir={self.d!r}))")
        p = subprocess.run([sys.executable, "-c", code], input=json.dumps(spec) + "\n", capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 3)  # stdin closed without "done"
        self.assertNotIn("http", p.stdout + p.stderr)

    def test_one_writer_per_file(self):
        import fcntl
        lab_remote.say = lambda obj: None
        spec = {"file": "m.gguf", "bytes": len(FakeRange.data), "sha256": self.sha, "s3_url": self.url("ok")}
        with open(os.path.join(self.d, "m.gguf.lock"), "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            res = lab_remote.Fetch(spec, models_dir=self.d).run(lock_wait=0)
        self.assertEqual(res["err"], "m.gguf")
        self.assertIn("ok", lab_remote.Fetch(spec, models_dir=self.d, min_range=1 << 20).run(lock_wait=0))

    def test_log_filter(self):
        lines = ["load_tensors: loaded 65 layers", "srv  unparsed muse-glimmer output: secret words", "chat output: words",
                 "main: server is listening on http://127.0.0.1:8201", "boring line", "CUDA error: out of memory"]
        out = lab_remote.filtered_log_lines(lines * 20)
        self.assertLessEqual(len(out), 40)
        self.assertFalse(any("unparsed" in x or "output:" in x for x in out))
        self.assertFalse(any("boring" in x for x in out))
        self.assertTrue(any("CUDA error" in x for x in out))
        self.assertFalse(any("http://" in x for x in out))

    def test_refuses_mac(self):
        if sys.platform == "darwin":
            with self.assertRaises(SystemExit):
                lab_remote.main(["ps"])


# ---- models.json edits ----

class TestModelsJsonEdit(unittest.TestCase):
    def test_keeps_layout(self):
        text = open(C.CONFIG).read()
        new = lab.edit_model_text(text, "glimmer-base", {"sha256": "f" * 64, "bytes": 16935294528})
        self.assertEqual(json.loads(new)["models"][1]["sha256"], "f" * 64)
        self.assertEqual(len(new.splitlines()), len(text.splitlines()))
        diff = [a for a, b in zip(text.splitlines(), new.splitlines()) if a != b]
        self.assertEqual(len(diff), 1)
        new2 = lab.edit_model_text(text, "glimmer-final", {"enabled": True, "sha256": "e" * 64, "bytes": 5})
        last = json.loads(new2)["models"][-1]
        self.assertEqual((last["enabled"], last["sha256"], last["bytes"]), (True, "e" * 64, 5))
        self.assertEqual(json.loads(new2)["models"][0], json.loads(text)["models"][0])

    def test_set_fields_atomic(self):
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "models.json")
            shutil.copy(C.CONFIG, path)
            lab.set_model_fields("glimmer-final", {"enabled": True}, path)
            cfg = C.load_config(path)
            self.assertTrue(C.model("glimmer-final", cfg)["enabled"])
            self.assertNotIn("glimmer-stage2", [m["name"] for m in C.load_plan(cfg)])
            self.assertEqual(sorted(os.listdir(d)), ["models.json"])
        finally:
            shutil.rmtree(d, ignore_errors=True)


class TestSummary(unittest.TestCase):
    def test_summary(self):
        with temp_lab():
            now = C.utcnow()
            m = machine(launched=C.iso(now - dt.timedelta(minutes=30)), deadline=C.iso(now + dt.timedelta(hours=3)),
                        ready_at=C.iso(now - dt.timedelta(minutes=10)), ctx_per_slot=4096, kv="q8_0",
                        servers={"granite-4.2-30b": {"state": "not loaded (memory)"}})
            lab.save_state({"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-1": m}})
            s = C.lab_summary()
            self.assertTrue(s["up"] and s["ready"])
            self.assertEqual(s["max_tokens_on_cap"], 3072)
            self.assertAlmostEqual(s["idle_minutes"], 10, delta=0.5)
            self.assertIn("ET", s["deadline_et"][-3:] + "ET") if s["deadline_et"] else None
            self.assertEqual(s["servers"]["granite-4.2-30b"], "not loaded (memory)")
            self.assertGreater(s["spent_usd"], 1.0)
            C.touch_last_use()
            self.assertTrue(os.path.exists(C.LAST_USE))


class TestUpDryRun(unittest.TestCase):
    """`up --dry-run` on a lab that is launched but not ready: a report, and no setup step."""

    def run_up(self, m, watch_running):
        import argparse
        called = []

        def forbid(label):
            def f(*a, **k):
                called.append(label)
                raise AssertionError(label + " must not run in a dry run")
            return f
        names = ("wait_active", "wait_adopted", "setup_machine", "check_aws", "instance_types", "launch", "start_tunnel", "lam")
        saved = {n: getattr(lab, n) for n in names}
        saved_watch, saved_running = lab.start_watch, C.watch_running
        out = io.StringIO()
        try:
            for n in names:
                setattr(lab, n, forbid(n))
            lab.start_watch = lambda: called.append("start_watch")
            C.watch_running = lambda: watch_running
            with temp_lab():
                lab.save_state({"ledger": {"spent_before_usd": 0.0}, "machines": {"muse-compare-lab-9": m}})
                a = argparse.Namespace(dry_run=True, yes=False, type=None, models=None, idle_minutes=None, max_hours=None, json=False)
                with contextlib.redirect_stdout(out):
                    rc = lab.cmd_up(a, C.load_config())
                after = C.lab_state()["machines"]["muse-compare-lab-9"]
                log_text = open(lab.LOG).read() if os.path.exists(lab.LOG) else ""
        finally:
            for n, f in saved.items():
                setattr(lab, n, f)
            lab.start_watch, C.watch_running = saved_watch, saved_running
        return rc, out.getvalue(), called, after, log_text

    def test_not_ready_lab_reports_and_stops(self):
        now = C.utcnow()
        m = machine(ready=False, ready_at=None, launched=C.iso(now - dt.timedelta(minutes=6)),
                    deadline=C.iso(now + dt.timedelta(hours=3)), known_hosts_cleared=True)
        rc, printed, called, after, log_text = self.run_up(m, watch_running=True)
        self.assertEqual(rc, 0)
        self.assertEqual(called, [])  # no wait, no setup, no AWS, no Lambda call, no watch start
        self.assertIn("Dry run: no setup step ran", printed)
        self.assertIn("[done] the old host key for this IP cleared", printed)
        self.assertIn("[to do] the smoke check, then ready", printed)
        self.assertIn("Watch: running.", printed)
        self.assertEqual(after, m)  # the state is unchanged
        self.assertNotIn("resuming its setup", log_text)

    def test_not_ready_lab_without_a_watch_gets_one(self):
        now = C.utcnow()
        m = machine(ready=False, ready_at=None, id=None, launched=C.iso(now - dt.timedelta(minutes=1)))
        rc, printed, called, after, _ = self.run_up(m, watch_running=False)
        self.assertEqual(rc, 0)
        self.assertEqual(called, ["start_watch"])  # the kill switch only
        self.assertIn("[to do] a Lambda id", printed)
        self.assertIn("Watch: was NOT running; started it", printed)


class TestRealFilesUntouched(unittest.TestCase):
    def test_log_follows_a_repointed_path(self):
        real = REAL_LAB_FILES[0]
        before = file_mark(real)
        with temp_lab() as d, contextlib.redirect_stdout(io.StringIO()):
            lab.log("synthetic test line")
            with open(os.path.join(d, "lab.log")) as f:
                self.assertIn("synthetic test line", f.read())
        self.assertEqual(file_mark(real), before)
        self.assertNotEqual(lab.LOG, real)  # setUpModule points it at a temp folder for the whole module


if __name__ == "__main__":
    unittest.main()
