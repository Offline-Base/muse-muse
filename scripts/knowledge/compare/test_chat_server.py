"""Tests for chat_server.py: no network and no lab. A fake llama-server (several models, one port each) runs on
127.0.0.1 in this process, and the chat server runs on an ephemeral 127.0.0.1 port with a temporary models.json and
data folder. Fixture text is synthetic; nothing here holds or prints real model reasoning.

Run: python3 scripts/knowledge/compare/test_chat_server.py
"""

import contextlib
import http.client
import io
import json
import os
import random
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import chat_server  # noqa: E402
import common  # noqa: E402

PROMPT_MARK = "PROMPT-MARK-7731"
REPLY_MARK = "REPLY-MARK-4410"
THINK = ["step%d " % i for i in range(1, 6)]  # synthetic reasoning deltas


# ---- a fake llama-server ----

class Fake:
    """Per-port behavior and what the fake saw."""

    def __init__(self, kind):
        self.kind = kind
        self.bodies = []
        self.disconnected = threading.Event()
        self.tokens_after_stop = 0


class FakeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_json(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        fake = self.server.fake
        if self.path == "/health":
            return self.send_json(503 if fake.kind == "loading" else 200, {"status": "ok"})
        return self.send_json(404, {"error": {"code": 404, "message": "File Not Found"}})

    def chunk(self, obj):
        line = ("data: " + (obj if isinstance(obj, str) else json.dumps(obj)) + "\n\n").encode()
        self.wfile.write(b"%x\r\n%s\r\n" % (len(line), line))
        self.wfile.flush()

    def do_POST(self):
        fake = self.server.fake
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        fake.bodies.append(body)
        if fake.kind == "error500":
            return self.send_json(500, {"error": {"code": 500, "message": "Failed to parse input: " + "q" * 900, "type": "server_error"}})
        if fake.kind == "ctxfull":
            return self.send_json(400, {"error": {"code": 400, "message": "request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it",
                                                  "type": "exceed_context_size_error"}})
        on = bool((body.get("chat_template_kwargs") or {}).get("enable_thinking") or (body.get("chat_template_kwargs") or {}).get("allow_reasoning"))
        if fake.kind == "glimmer":
            pieces = [("content", "Answer " + REPLY_MARK + " is 42."), ("content", "<|e"), ("content", "ot|>")]
        elif fake.kind == "slow":
            pieces = [("content", "w%d " % i) for i in range(400)]
        else:
            pieces = ([("reasoning", t) for t in THINK] if on else []) + [("content", "Answer "), ("content", REPLY_MARK), ("content", " done.")]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        base = {"object": "chat.completion.chunk", "model": body.get("model")}
        try:
            self.chunk({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": None}, "finish_reason": None}]})
            for kind, text in pieces:
                if fake.kind == "slow":
                    time.sleep(0.02)
                key = "reasoning_content" if kind == "reasoning" else "content"
                self.chunk({**base, "choices": [{"index": 0, "delta": {key: text}, "finish_reason": None}]})
            # llama.cpp b11970: finish_reason in a chunk with an empty delta, then usage and timings with "choices": []
            self.chunk({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            self.chunk({**base, "choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": len(pieces), "total_tokens": 11 + len(pieces)},
                        "timings": {"prompt_ms": 12.5, "predicted_ms": 250.0, "predicted_per_second": 33.3}})
            self.chunk("[DONE]")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            fake.disconnected.set()


class FakeServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # the chat server closing a stream early resets the connection; that is what the tests provoke


def free_base(n):
    """A run of n free consecutive 127.0.0.1 ports, as listening servers is how they are claimed."""
    for _ in range(200):
        base = random.randint(20000, 40000)
        if base <= 18000 <= base + n:
            continue
        socks = []
        try:
            for i in range(n):
                s = socket.socket()
                s.bind(("127.0.0.1", base + i))
                socks.append(s)
            return base
        except OSError:
            continue
        finally:
            for s in socks:
                s.close()
    raise RuntimeError("no free port run")


KINDS = ["think", "glimmer", "error500", "ctxfull", "slow", "loading", "noon"]  # ports 8201.. in this order; "down" has no server


def model_entry(i, kind, role):
    request = {"off": {"chat_template_kwargs": {"enable_thinking": False}},
               "on": {"chat_template_kwargs": {"enable_thinking": True, "reasoning_effort": "low"}}}
    final = "think"
    if kind == "glimmer":
        request = {"off": {"stop": ["<|eot|>"], "chat_template_kwargs": {"reasoning_strength": "low"}},
                   "on": {"reasoning_format": "auto", "chat_template_kwargs": {"reasoning_strength": "low", "allow_reasoning": True}}}
        final = "glimmer"
    if kind in ("noon", "down"):
        request = {"off": {}}
        final = "plain"
    return {"name": "m-" + kind, "label": "Model " + kind, "role": role, "publisher": "test", "license": "Apache-2.0", "port": 8201 + i,
            "enabled": True, "quant": "Q4_K_M", "params_b": 27.85, "file": "m-%s.gguf" % kind, "bytes": 16935294432, "sha256": None,
            "source": {"s3_key": "knowledge/models/test/m-%s.gguf" % kind}, "request": request, "reasoning_level": "low", "final": final, "gpu_gb": 17.2}


class ChatServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        n = len(KINDS) + 1
        base = free_base(n)
        offset = base - 8201
        cls.fakes, cls.fake_servers = {}, []
        for i, kind in enumerate(KINDS):
            srv = FakeServer(("127.0.0.1", 8201 + i + offset), FakeHandler)
            srv.fake = Fake(kind)
            cls.fakes[kind] = srv.fake
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            cls.fake_servers.append(srv)
        kinds = KINDS + ["down"]
        cfg = {"version": 1, "lab": {"type": "gpu_1x_gh200", "remote_ports": [8201, 8209], "local_port_offset": offset, "chat_port": 28999,
                                     "ctx_per_slot": 8192, "cap_usd": 30.0, "server_flags": []},
               "models": [model_entry(i, k, "base" if k == "glimmer" else "tuned" if k == "think" else "other") for i, k in enumerate(kinds)]}
        cls.config = os.path.join(cls.tmp.name, "models.json")
        with open(cls.config, "w") as f:
            json.dump(cfg, f)
        cls.data = os.path.join(cls.tmp.name, "data")
        cls.touches = []
        cls.app = chat_server.App(config_path=cls.config, data_dir=cls.data, touch=lambda: cls.touches.append(time.time()),
                                  lab_summary=lambda: {"up": True, "ready": True, "max_tokens_on_cap": 3072, "ctx_per_slot": 4096,
                                                       "watch_running": True, "servers": {"m-noon": "not loaded"}},
                                  active_lab=lambda: None, quiet=True)
        cls.srv = chat_server.Server(cls.app, 0)
        cls.port = cls.srv.server_address[1]
        cls.host = "127.0.0.1:%d" % cls.port
        threading.Thread(target=cls.srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        for s in cls.fake_servers:
            s.shutdown()
            s.server_close()
        cls.tmp.cleanup()

    # helpers

    def request(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = {"Host": self.host}
        if body is not None or raw is not None:
            h.update({"Content-Type": "application/json", "Origin": "http://" + self.host})
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        c.request(method, path, body=raw if raw is not None else (json.dumps(body) if body is not None else None), headers=h)
        r = c.getresponse()
        data = r.read()
        hdrs = dict(r.getheaders())
        c.close()
        try:
            return r.status, json.loads(data), hdrs
        except ValueError:
            return r.status, data, hdrs

    def stream(self, path, body, on_open=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request("POST", path, body=json.dumps(body), headers={"Host": self.host, "Content-Type": "application/json", "Origin": "http://" + self.host})
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertTrue(r.getheader("Content-Type").startswith("text/event-stream"))
        if on_open:
            on_open(r)
        events = []
        for line in r:
            line = line.strip()
            if line.startswith(b"data: "):
                events.append(json.loads(line[6:]))
        c.close()
        return events

    def session(self, models, **kw):
        st, s, _ = self.request("POST", "/api/session", {"models": models, **kw})
        self.assertEqual(st, 200, s)
        return s

    def transcript(self, sid):
        with open(os.path.join(self.data, "chats", sid + ".json")) as f:
            return json.load(f)

    def one_turn(self, sid, col, mode="off", text="Hi " + PROMPT_MARK, path="/api/turn", turn=None):
        body = {"session": sid, "col": col, "reasoning": mode, "messages": [{"role": "user", "content": text}], "sampling": {"greedy": True}}
        if turn:
            body["turn"] = turn
        return self.stream(path, body)

    # tests

    def test_config_view(self):
        st, cfg, hdrs = self.request("GET", "/api/config")
        self.assertEqual(st, 200)
        by = {m["name"]: m for m in cfg["models"]}
        self.assertEqual(by["m-think"]["health"], "ok")
        self.assertEqual(by["m-loading"]["health"], "loading")
        self.assertEqual(by["m-down"]["health"], "down")
        self.assertEqual(by["m-think"]["reasoning"], ["off", "on"])
        self.assertEqual(by["m-noon"]["reasoning"], ["off"])
        self.assertEqual(by["m-noon"]["server_state"], "not loaded")
        self.assertAlmostEqual(by["m-think"]["bpw"], 4.86, places=2)
        d = cfg["defaults"]
        self.assertEqual(d["system"], common.SYSTEM)
        self.assertEqual((d["temperature"], d["top_p"], d["top_k"]), (0.7, 0.95, 40))
        self.assertEqual(d["max_tokens_on"], 3072)  # capped by the lab's max_tokens_on_cap
        self.assertEqual(d["max_tokens"], 2048)
        self.assertIn("sandbox", chat_server.REPORT_CSP)
        self.assertIn("default-src 'self'", hdrs["Content-Security-Policy"])

    def test_sse_relay_with_usage_chunk(self):
        s = self.session(["m-think"])
        before = len(self.fakes["think"].bodies)
        ev = self.one_turn(s["session"], "A", mode="on")
        kinds = [e["t"] for e in ev]
        self.assertEqual(kinds[0], "start")
        self.assertEqual(kinds.count("reasoning"), len(THINK))
        self.assertEqual(kinds[-1], "done")
        done = ev[-1]
        self.assertEqual(done["final"], "Answer " + REPLY_MARK + " done.")
        self.assertEqual(done["finish"], "stop")  # from the empty-delta chunk
        self.assertEqual(done["usage"], {"prompt": 11, "completion": len(THINK) + 3})  # from the "choices": [] chunk
        self.assertEqual(done["timings"]["tok_s"], 33.3)
        self.assertEqual(done["timings"]["gen_ms"], 250.0)
        self.assertIsNotNone(done["timings"]["ttft_ms"])
        self.assertEqual(done["reasoning_chars"], len("".join(THINK)))
        self.assertEqual("".join(e["d"] for e in ev if e["t"] == "content"), done["final"])
        sent = self.fakes["think"].bodies[before]
        self.assertEqual(sent["messages"][0], {"role": "system", "content": common.SYSTEM})
        for k, v in common.NEUTRAL.items():
            self.assertEqual(sent[k], v, k)
        self.assertTrue(sent["stream"])
        self.assertEqual(sent["stream_options"], {"include_usage": True})
        self.assertEqual(sent["chat_template_kwargs"], {"enable_thinking": True, "reasoning_effort": "low"})
        self.assertEqual((sent["temperature"], sent["top_k"], sent["top_p"]), (0.0, 1, 1.0))  # greedy
        self.assertLessEqual(sent["max_tokens"], 3072)

    def test_glimmer_final_cleanup_while_streaming(self):
        s = self.session(["m-glimmer"])
        ev = self.one_turn(s["session"], "A", mode="off")
        shown = ""
        for e in ev:
            if e["t"] == "content":
                shown = e["d"] if e.get("replace") else shown + e["d"]
        done = ev[-1]
        self.assertEqual(done["t"], "done")
        self.assertEqual(done["final"], "Answer " + REPLY_MARK + " is 42.")
        self.assertEqual(shown, done["final"])
        self.assertNotIn("<|", done["final"])
        sent = self.fakes["glimmer"].bodies[-1]
        self.assertEqual(sent["stop"], ["<|eot|>"])

    def test_empty_system_becomes_SYSTEM(self):
        for given in ("", "   ", None):
            s = self.session(["m-think"], system=given)
            self.assertEqual(s["system"], common.SYSTEM)
            self.assertEqual(self.transcript(s["session"])["system"], common.SYSTEM)
        s = self.session(["m-think"], system="Answer in one word.")
        self.one_turn(s["session"], "A")
        self.assertEqual(self.fakes["think"].bodies[-1]["messages"][0], {"role": "system", "content": "Answer in one word."})

    def test_transcript_without_save_reasoning(self):
        s = self.session(["m-think", "m-glimmer"])
        self.assertFalse(s["save_reasoning"])
        ev = self.stream("/api/turns", {"session": s["session"], "turn": 1, "sampling": {"temperature": 0.5, "seed": 3},
                                        "columns": [{"col": "A", "reasoning": "on", "messages": [{"role": "user", "content": "Q " + PROMPT_MARK}]},
                                                    {"col": "B", "reasoning": "off", "messages": [{"role": "user", "content": "Q " + PROMPT_MARK}]}]})
        self.assertEqual({e["c"] for e in ev if e["t"] == "done"}, {"A", "B"})
        self.assertEqual(ev[-1]["t"], "end")
        doc = self.transcript(s["session"])
        turn = doc["turns"][0]
        self.assertEqual(turn["n"], 1)
        self.assertEqual(turn["user"], "Q " + PROMPT_MARK)
        a = turn["replies"]["A"]
        self.assertNotIn("reasoning", a)
        self.assertEqual(a["reasoning_chars"], len("".join(THINK)))
        self.assertEqual(a["final"], "Answer " + REPLY_MARK + " done.")
        self.assertEqual(a["mode"], "on")
        self.assertEqual(a["sampling"]["seed"], 3)
        self.assertEqual(a["sampling"]["temperature"], 0.5)
        self.assertIsNone(a["error"])
        self.assertNotIn("reasoning", turn["replies"]["B"])
        self.assertNotIn("step1", json.dumps(doc))
        self.assertEqual(oct(os.stat(os.path.join(self.data, "chats", s["session"] + ".json")).st_mode & 0o777), "0o600")

    def test_transcript_with_save_reasoning(self):
        s = self.session(["m-think"], save_reasoning=True)
        self.one_turn(s["session"], "A", mode="on")
        a = self.transcript(s["session"])["turns"][0]["replies"]["A"]
        self.assertEqual(a["reasoning"], "".join(THINK))
        self.assertEqual(a["reasoning_chars"], len("".join(THINK)))

    def test_blind_hide_and_reveal(self):
        names = ["m-think", "m-glimmer", "m-slow", "m-noon"]
        s = self.session(names, blind=True)
        self.assertTrue(s["blind"])
        self.assertEqual([c["col"] for c in s["columns"]], ["A", "B", "C", "D"])
        self.assertTrue(all(c["model"] is None and c["label"] is None for c in s["columns"]))
        sid = s["session"]
        st, doc, _ = self.request("GET", "/api/sessions/" + sid)
        self.assertTrue(all(c["model"] is None and c["label"] is None and c["file"] is None for c in doc["columns"]))
        st, lst, _ = self.request("GET", "/api/sessions")
        row = next(x for x in lst["sessions"] if x["session"] == sid)
        self.assertEqual(row["labels"], [None] * 4)
        st, h, _ = self.request("GET", "/api/health?session=" + sid)
        self.assertEqual(sorted(h["cols"]), ["A", "B", "C", "D"])
        self.assertNotIn("models", h)
        on_disk = self.transcript(sid)
        self.assertEqual(sorted(c["model"] for c in on_disk["columns"]), sorted(names))
        self.one_turn(sid, "A")
        st, v, _ = self.request("POST", "/api/vote", {"session": sid, "turn": 1, "col": "A"})
        self.assertEqual(st, 200)
        self.assertFalse(self.transcript(sid)["turns"][0]["vote_saw_names"])
        st, rv, _ = self.request("POST", "/api/reveal", {"session": sid})
        self.assertEqual(st, 200)
        self.assertEqual(sorted(c["model"] for c in rv["columns"]), sorted(names))
        st, doc, _ = self.request("GET", "/api/sessions/" + sid)
        self.assertTrue(doc["revealed"])
        self.assertEqual([c["model"] for c in doc["columns"]], [c["model"] for c in on_disk["columns"]])
        self.assertEqual(doc["turns"][0]["vote"], "A")

    def test_blind_order_is_shuffled(self):
        names = ["m-think", "m-glimmer", "m-slow", "m-noon", "m-error500"]
        orders = set()
        for _ in range(8):
            s = self.session(names, blind=True)
            orders.add(tuple(c["model"] for c in self.transcript(s["session"])["columns"]))
        self.assertGreater(len(orders), 1)
        s = self.session(names)
        self.assertEqual([c["model"] for c in s["columns"]], names)  # named chats keep the picked order

    def test_host_and_origin_checks(self):
        self.assertEqual(self.request("GET", "/api/config", headers={"Host": "evil.example:%d" % self.port})[0], 403)
        self.assertEqual(self.request("GET", "/api/config", headers={"Host": "127.0.0.1:1"})[0], 403)
        self.assertEqual(self.request("GET", "/", headers={"Host": "localhost:%d" % self.port})[0], 200)
        good = {"models": ["m-think"]}
        self.assertEqual(self.request("POST", "/api/session", good, headers={"Origin": None})[0], 403)
        self.assertEqual(self.request("POST", "/api/session", good, headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/session", good, headers={"Origin": "http://localhost:%d" % self.port})[0], 403)  # not the Host
        self.assertEqual(self.request("POST", "/api/session", good, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("POST", "/api/session", good, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/api/session", good, headers={"Host": "localhost:%d" % self.port, "Origin": "http://localhost:%d" % self.port})[0], 200)
        st, _, hdrs = self.request("POST", "/api/session", good)
        self.assertEqual(st, 200)
        self.assertNotIn("Access-Control-Allow-Origin", hdrs)
        self.assertEqual(self.request("POST", "/api/session", raw=b"not json")[0], 400)

    def test_binds_loopback_only_and_never_5037(self):
        self.assertEqual(self.srv.server_address[0], "127.0.0.1")
        app = chat_server.App(config_path=self.config, data_dir=self.data, touch=lambda: None, lab_summary=dict, active_lab=lambda: None, quiet=True)
        with self.assertRaises(ValueError):
            chat_server.Server(app, 5037)
        with self.assertRaises(ValueError):
            chat_server.Server(app, 18000)

    def test_port_refuses_reserved_and_tunnel_ports(self):
        cfg = {"lab": {"remote_ports": [8201, 8209], "local_port_offset": 10000, "chat_port": 8788}}
        for bad in (5037, 18000, 18201, 18205, 18209, 80, 70000):
            with self.subTest(bad):
                self.assertTrue(chat_server.port_problem(bad, cfg))
        for good in (8788, 18200, 18210, 9000):
            with self.subTest(good):
                self.assertIsNone(chat_server.port_problem(good, cfg))
        # main() exits before listening on a refused --port (this test config has its own tunnel offset).
        with open(self.config) as f:
            off = json.load(f)["lab"]["local_port_offset"]
        never = mock.patch.object(chat_server, "Server", side_effect=AssertionError("main() must not listen on a refused port"))
        for bad in ("18000", str(8203 + off), "5037"):
            with self.subTest(bad), never, self.assertRaises(SystemExit) as ctx:
                chat_server.main(["--port", bad, "--config", self.config, "--data", self.data])
            self.assertTrue(str(ctx.exception.code).startswith("Port"), ctx.exception.code)

    def test_no_body_logging(self):
        app = chat_server.App(config_path=self.config, data_dir=self.data, touch=lambda: None, lab_summary=lambda: {"up": False},
                              active_lab=lambda: None, quiet=False)
        srv = chat_server.Server(app, 0)
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
        port, saved = self.port, self.host
        try:
            type(self).port, type(self).host = srv.server_address[1], "127.0.0.1:%d" % srv.server_address[1]
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                s = self.session(["m-think", "m-error500"], system="System " + PROMPT_MARK)
                self.stream("/api/turns", {"session": s["session"], "turn": 1, "columns": [
                    {"col": "A", "reasoning": "on", "messages": [{"role": "user", "content": "Q " + PROMPT_MARK}]},
                    {"col": "B", "reasoning": "on", "messages": [{"role": "user", "content": "Q " + PROMPT_MARK}]}]})
                self.request("GET", "/api/sessions/" + s["session"])
            log = err.getvalue()
        finally:
            type(self).port, type(self).host = port, saved
            srv.shutdown()
            srv.server_close()
        self.assertIn("POST /api/turns 200", log)
        for secret in (PROMPT_MARK, REPLY_MARK, "step1", "qqqq", "Failed to parse"):
            self.assertNotIn(secret, log)

    def test_upstream_errors(self):
        s = self.session(["m-error500", "m-ctxfull", "m-down", "m-noon"])
        ev = self.stream("/api/turns", {"session": s["session"], "turn": 1, "columns": [
            {"col": "A", "reasoning": "on", "messages": [{"role": "user", "content": "x"}]},
            {"col": "B", "reasoning": "off", "messages": [{"role": "user", "content": "x"}]},
            {"col": "C", "reasoning": "off", "messages": [{"role": "user", "content": "x"}]},
            {"col": "D", "reasoning": "on", "messages": [{"role": "user", "content": "x"}]}]})
        errs = {e["c"]: e for e in ev if e["t"] == "error"}
        self.assertEqual(errs["A"]["status"], 500)
        self.assertLessEqual(len(errs["A"]["message"]), 200)
        self.assertEqual(errs["B"]["status"], 400)
        self.assertEqual(errs["B"]["message"], "context full, start a new chat")
        self.assertEqual(errs["C"]["status"], 502)
        self.assertEqual(errs["D"]["status"], 400)  # no reasoning mode "on"
        replies = self.transcript(s["session"])["turns"][0]["replies"]
        self.assertEqual(replies["A"]["error"]["status"], 500)
        self.assertLessEqual(len(replies["A"]["error"]["message"]), 200)
        self.assertEqual(replies["A"]["finish"], "error")
        self.assertEqual(replies["B"]["error"]["message"], "context full, start a new chat")

    def test_stop_closes_upstream(self):
        s = self.session(["m-slow", "m-think"])
        fake = self.fakes["slow"]
        fake.disconnected.clear()

        def stop_soon(_resp):
            def go():
                time.sleep(0.4)
                self.request("POST", "/api/stop", {"session": s["session"], "col": "A"})
            threading.Thread(target=go, daemon=True).start()
        ev = self.stream("/api/turns", {"session": s["session"], "turn": 1, "columns": [
            {"col": "A", "reasoning": "off", "messages": [{"role": "user", "content": "x"}]},
            {"col": "B", "reasoning": "off", "messages": [{"role": "user", "content": "x"}]}]}, on_open=stop_soon)
        done = {e["c"]: e for e in ev if e["t"] == "done"}
        self.assertEqual(done["A"]["finish"], "stopped")
        self.assertTrue(done["A"]["final"].startswith("w0"))
        self.assertEqual(done["B"]["finish"], "stop")
        self.assertTrue(fake.disconnected.wait(5))
        self.assertEqual(self.transcript(s["session"])["turns"][0]["replies"]["A"]["finish"], "stopped")

    def test_browser_leaving_closes_upstream(self):
        s = self.session(["m-slow"])
        fake = self.fakes["slow"]
        fake.disconnected.clear()
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request("POST", "/api/turns", body=json.dumps({"session": s["session"], "turn": 1, "columns": [
            {"col": "A", "reasoning": "off", "messages": [{"role": "user", "content": "x"}]}]}),
            headers={"Host": self.host, "Content-Type": "application/json", "Origin": "http://" + self.host})
        r = c.getresponse()
        r.readline()
        time.sleep(0.3)
        r.close()
        c.close()
        self.assertTrue(fake.disconnected.wait(5), "the upstream request kept running after the browser left")

    def test_touches_last_use(self):
        n = len(self.touches)
        s = self.session(["m-think"])
        self.one_turn(s["session"], "A")
        self.assertGreaterEqual(len(self.touches) - n, 2)  # at the start and at the end
        st, res, _ = self.request("POST", "/api/keepalive", {})
        self.assertEqual(st, 200)
        self.assertGreaterEqual(len(self.touches) - n, 3)

    def test_multi_turn_and_validation(self):
        s = self.session(["m-think"])
        sid = s["session"]
        self.one_turn(sid, "A")
        hist = [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Answer"}, {"role": "user", "content": "And then?"}]
        ev = self.stream("/api/turn", {"session": sid, "col": "A", "reasoning": "off", "messages": hist})
        self.assertEqual(ev[-1]["t"], "done")
        sent = self.fakes["think"].bodies[-1]["messages"]
        self.assertEqual([m["role"] for m in sent], ["system", "user", "assistant", "user"])
        doc = self.transcript(sid)
        self.assertEqual([t["n"] for t in doc["turns"]], [1, 2])
        bad = [
            {"session": sid, "col": "A", "messages": [{"role": "assistant", "content": "x"}]},
            {"session": sid, "col": "A", "messages": [{"role": "system", "content": "x"}, {"role": "user", "content": "y"}]},
            {"session": sid, "col": "A", "messages": []},
            {"session": sid, "col": "A", "messages": [{"role": "user", "content": "y"}], "reasoning": "maybe"},
        ]
        for b in bad:
            self.assertEqual(self.request("POST", "/api/turn", b)[0], 400, b)
        self.assertEqual(self.request("POST", "/api/turn", {"session": "20990101-000000-ffff", "col": "A",
                                                            "messages": [{"role": "user", "content": "y"}]})[0], 404)
        self.assertEqual(self.request("POST", "/api/session", {"models": ["nope"]})[0], 400)
        self.assertEqual(self.request("POST", "/api/session", {"models": ["m-think", "m-think"]})[0], 400)
        self.assertEqual(self.request("POST", "/api/vote", {"session": sid, "turn": 9, "col": "A"})[0], 400)
        self.assertEqual(self.request("POST", "/api/vote", {"session": sid, "turn": 1, "col": "Z"})[0], 400)
        self.assertEqual(self.request("GET", "/api/sessions/../models")[0], 404)

    def test_sampling_is_clamped(self):
        s = self.session(["m-think"])
        self.stream("/api/turn", {"session": s["session"], "col": "A", "reasoning": "on", "messages": [{"role": "user", "content": "x"}],
                                  "sampling": {"temperature": 9, "top_p": 3, "top_k": -4, "max_tokens": 99999, "seed": "no"}})
        sent = self.fakes["think"].bodies[-1]
        self.assertEqual((sent["temperature"], sent["top_p"], sent["top_k"]), (2.0, 1.0, 0))
        self.assertEqual(sent["max_tokens"], 3072)
        self.assertIsInstance(sent["seed"], int)
        self.stream("/api/turn", {"session": s["session"], "col": "A", "reasoning": "off", "messages": [{"role": "user", "content": "x"}],
                                  "sampling": {"max_tokens": 99999}})
        self.assertEqual(self.fakes["think"].bodies[-1]["max_tokens"], 4096)  # the lab's context per slot

    def test_reports_listing_and_sandbox(self):
        run = os.path.join(self.data, "evals", "20261031-2100-abcd")
        os.makedirs(run, exist_ok=True)
        with open(os.path.join(run, "report.html"), "w") as f:
            f.write("<!doctype html><title>r</title><p>synthetic report</p>")
        with open(os.path.join(run, "meta.json"), "w") as f:
            json.dump({"models": [{"name": "m-think"}, {"name": "m-glimmer"}], "sets": {"salient": {"n": 3}}, "start": "2026-10-31T21:00:00Z",
                       "sessions": [{"lab": {"type": "gpu_1x_gh200"}}]}, f)
        st, lst, _ = self.request("GET", "/api/reports")
        row = next(r for r in lst["reports"] if r["run_id"] == "20261031-2100-abcd")
        self.assertEqual((row["models"], row["sets"], row["lab_type"], row["has_html"], row["has_md"]),
                         (["m-think", "m-glimmer"], ["salient"], "gpu_1x_gh200", True, False))
        st, page, hdrs = self.request("GET", "/reports/20261031-2100-abcd/report.html")
        self.assertEqual(st, 200)
        self.assertIn(b"synthetic report", page)
        self.assertTrue(hdrs["Content-Security-Policy"].startswith("sandbox allow-scripts"))
        self.assertNotIn("allow-same-origin", hdrs["Content-Security-Policy"])
        for bad in ("/reports/20261031-2100-abcd/meta.json", "/reports/..%2Fchats/report.html", "/reports/.hidden/report.html",
                    "/reports/20261031-2100-abcd/report.md"):
            self.assertEqual(self.request("GET", bad)[0], 404, bad)

    def test_busy_column_is_refused(self):
        s = self.session(["m-slow"])
        sid = s["session"]
        result = {}

        def first():
            result["ev"] = self.one_turn(sid, "A")
        t = threading.Thread(target=first)
        t.start()
        time.sleep(0.3)
        ev = self.one_turn(sid, "A", turn=2)
        self.assertEqual(ev[-1]["t"], "error")
        self.assertEqual(ev[-1]["status"], 409)
        self.request("POST", "/api/stop", {"session": sid})
        t.join(10)
        self.assertEqual(result["ev"][-1]["finish"], "stopped")


class HelperTest(unittest.TestCase):
    def test_upstream_error_is_clipped(self):
        st, msg = chat_server.upstream_error(500, json.dumps({"error": {"code": 500, "message": "z" * 5000}}).encode())
        self.assertEqual(st, 500)
        self.assertLessEqual(len(msg), 200)
        st, msg = chat_server.upstream_error(502, b"<html>" + b"y" * 5000)
        self.assertLessEqual(len(msg), 200)
        self.assertNotIn("y" * 50, msg)

    def test_context_full(self):
        body = json.dumps({"error": {"code": 400, "type": "exceed_context_size_error", "message": "request exceeds the available context size"}})
        self.assertEqual(chat_server.upstream_error(400, body.encode()), (400, chat_server.CONTEXT_FULL))

    def test_clean_messages(self):
        ok = chat_server.clean_messages([{"role": "user", "content": "a", "extra": 1}])
        self.assertEqual(ok, [{"role": "user", "content": "a"}])
        for bad in ([], [{"role": "user", "content": "  "}], [{"role": "tool", "content": "a"}], "text"):
            with self.assertRaises(ValueError):
                chat_server.clean_messages(bad)

    def test_et_clock_follows_dst(self):
        self.assertEqual(chat_server.et_clock("2026-10-31T20:00:00Z"), "4:00 PM EDT")
        self.assertEqual(chat_server.et_clock("2026-11-05T03:00:00Z"), "10:00 PM EST")


if __name__ == "__main__":
    unittest.main(verbosity=2)
