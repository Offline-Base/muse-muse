"""Tests for hf_relay.py and hf_put_remote.py against a fake Hugging Face Hub on 127.0.0.1. No real network, no real
token, nothing leaves this Mac. The remote side is the real hf_put_remote.py run as a local subprocess (and, in the end
to end test, through a fake ssh that records its argv and stdin).

    .data/aws/venv/bin/python -m unittest scripts/knowledge/aws/test_hf_relay.py -v
"""

import base64
import hashlib
import http.server
import json
import os
import random
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hf_relay as R  # noqa: E402

TOKEN = "hf_FAKEtestTOKENnotReal0123456789abcdef"
SCRATCH = os.environ.get("HF_RELAY_TEST_TMP") or tempfile.gettempdir()


# ---- the fake Hub ----

class FakeHub:
    def __init__(self, chunk=64 * 1024, reuse_upload=True):
        self.chunk, self.reuse_upload = chunk, reuse_upload
        self.repos, self.objects, self.uploads, self.open_by_oid, self.sigs = {}, {}, {}, {}, {}
        self.log = []  # (method, path, has_auth, auth_ok)
        self.expire_once = set()  # part numbers whose first URL is born expired
        self.always_refuse = set()  # part numbers whose URLs are always refused
        self.public_on_create = False
        self.fail_once_500 = set()  # part numbers whose first PUT gets a transient 500
        self.hide_uid_in_completion = False  # the completion href carries no uploadId (only the part URLs do)
        self.public_after_batch = False  # someone flips the repo public after the first batch call
        self.fail_complete = False  # the completion call is refused (the upload was aborted server side)
        self.reset_first_url = set()  # part numbers whose first URL is answered by cutting the connection, always
        self.reset_sigs = set()
        self.lock = threading.Lock()
        hub = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                hub.handle(self, "GET")

            def do_POST(self):
                hub.handle(self, "POST")

            def do_PUT(self):
                hub.handle(self, "PUT")

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    # helpers

    def _sig(self, kind, ident, exp):
        s = secrets.token_hex(8)
        self.sigs[s] = (kind, ident, exp)
        return s

    def _part_url(self, uid, n):
        exp = time.time() + 600
        if n in self.expire_once:  # only the first URL ever made for part n is born expired
            self.expire_once = self.expire_once - {n}
            exp = time.time() - 5
        sig = self._sig('part', (uid, n), exp)
        if n in self.reset_first_url:
            self.reset_first_url = self.reset_first_url - {n}
            self.reset_sigs.add(sig)
        return f"{self.base}/s3/{uid}/{n}?uploadId={uid}&partNumber={n}&X-Amz-Signature={sig}&X-Amz-Expires=600"

    def puts(self, kind=None):
        return [x for x in self.log if x[0] == "PUT" and (kind is None or x[1].startswith(kind))]

    def posts(self, word):
        return [x for x in self.log if x[0] == "POST" and word in x[1]]

    # dispatch

    def handle(self, h, method):
        u = urllib.parse.urlsplit(h.path)
        path, qs = u.path, urllib.parse.parse_qs(u.query)
        n = int(h.headers.get("Content-Length") or 0)
        body = h.rfile.read(n) if n else b""
        auth = h.headers.get("Authorization")
        with self.lock:
            self.log.append((method, path, auth is not None, auth == f"Bearer {TOKEN}"))
        try:
            status, headers, out = self.route(method, path, qs, body, auth == f"Bearer {TOKEN}", h)
        except Exception as e:  # a bug in the fake shows up as a 500 with its type
            status, headers, out = 500, {}, json.dumps({"error": type(e).__name__}).encode()
        if status == "RESET":  # hang up with no response at all
            h.close_connection = True
            return
        h.send_response(status)
        for k, v in headers.items():
            h.send_header(k, v)
        h.send_header("Content-Length", str(len(out)))
        h.end_headers()
        h.wfile.write(out)

    def route(self, method, path, qs, body, authed, h):
        J = lambda obj, status=200: (status, {"Content-Type": "application/json"}, json.dumps(obj).encode())
        api_or_git = path.startswith("/api/") or ".git/info/lfs" in path
        if api_or_git and "complete_multipart" not in path and not authed:
            return J({"error": "unauthorized"}, 401)
        parts = path.strip("/").split("/")
        if method == "GET" and path.startswith("/api/models/"):
            repo = "/".join(parts[2:4])
            if repo not in self.repos:
                return J({"error": "not found"}, 404)
            return J({"id": repo, "private": self.repos[repo]["private"]})
        if method == "POST" and path == "/api/repos/create":
            b = json.loads(body)
            repo = f"{b['organization']}/{b['name']}"
            if repo in self.repos:
                return J({"error": "exists"}, 409)
            private = (b.get("private") is True or b.get("visibility") == "private") and not self.public_on_create
            self.repos[repo] = {"private": private, "files": {}, "commits": []}
            self.create_body = b
            return J({"url": f"{self.base}/{repo}"})
        if method == "PUT" and path.endswith("/settings"):
            repo = "/".join(parts[2:4])
            if json.loads(body).get("visibility") == "private":
                self.repos[repo]["private"] = True
            return J({})
        if method == "POST" and "/preupload/" in path:
            repo = "/".join(parts[2:4])
            files = []
            for f in json.loads(body)["files"]:
                lfs = f["size"] > 4096 or f["path"].endswith((".gguf", ".safetensors"))
                have = self.repos[repo]["files"].get(f["path"])
                files.append({"path": f["path"], "uploadMode": "lfs" if lfs else "regular", "shouldIgnore": False,
                              "oid": have["oid"] if have else None})
            return J({"files": files})
        if method == "POST" and path.endswith(".git/info/lfs/objects/batch"):
            if h.headers.get("Content-Type") != "application/vnd.git-lfs+json":
                return J({"error": "content type"}, 400)
            b = json.loads(body)
            assert b["operation"] == "upload" and b["hash_algo"] == "sha256"
            repo = path.strip("/").rsplit(".git", 1)[0]
            out = []
            for o in b["objects"]:
                oid, size = o["oid"], o["size"]
                if oid in self.objects:
                    out.append({"oid": oid, "size": size})
                    continue
                verify = {"href": f"{self.base}/{repo}.git/info/lfs/objects/verify"}
                if size > self.chunk:
                    uid = self.open_by_oid.get(oid) if self.reuse_upload else None
                    if uid is None:
                        uid = secrets.token_hex(6)
                        self.uploads[uid] = {"oid": oid, "size": size, "parts": {}}
                        self.open_by_oid[oid] = uid
                    nparts = -(-size // self.chunk)
                    header = {"chunk_size": str(self.chunk)}
                    header.update({str(n): self._part_url(uid, n) for n in range(1, nparts + 1)})
                    exp = time.time() + 600
                    href = (f"{self.base}/{repo}.git/info/lfs/complete_multipart?"
                            + ("" if self.hide_uid_in_completion else f"uploadId={uid}&")
                            + f"sig={self._sig('complete', uid, exp)}")
                    out.append({"oid": oid, "size": size, "authenticated": True,
                                "actions": {"upload": {"href": href, "header": header}, "verify": verify}})
                else:
                    sig = self._sig("basic", oid, time.time() + 600)
                    out.append({"oid": oid, "size": size, "authenticated": True,
                                "actions": {"upload": {"href": f"{self.base}/s3/basic/{oid}?X-Amz-Signature={sig}"},
                                            "verify": verify}})
            if self.public_after_batch and repo in self.repos:
                self.repos[repo]["private"] = False
            return 200, {"Content-Type": "application/vnd.git-lfs+json"}, json.dumps(
                {"transfer": "basic", "objects": out}).encode()
        if method == "PUT" and path.startswith("/s3/"):
            sig = (qs.get("X-Amz-Signature") or [""])[0]
            if sig in self.reset_sigs:
                return "RESET", {}, b""
            rec = self.sigs.get(sig)
            if not rec or rec[2] < time.time():
                return 403, {}, b"<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>"
            kind, ident, _ = rec
            if kind == "basic":
                if hashlib.sha256(body).hexdigest() != ident:
                    return 400, {}, b"bad digest"
                self.objects[ident] = body
                return 200, {"ETag": '"%s"' % hashlib.md5(body).hexdigest()}, b""
            uid, n = ident
            with self.lock:
                transient = n in self.fail_once_500
                self.fail_once_500 = self.fail_once_500 - {n}
            if transient:
                return 500, {}, b"<Error><Code>InternalError</Code></Error>"
            if n in self.always_refuse:
                return 403, {}, b"<Error><Code>AccessDenied</Code></Error>"
            if path != f"/s3/{uid}/{n}":
                return 403, {}, b""
            self.uploads[uid]["parts"][n] = body
            return 200, {"ETag": '"%s"' % hashlib.md5(body).hexdigest()}, b""
        if method == "POST" and "complete_multipart" in path:
            rec = self.sigs.get((qs.get("sig") or [""])[0])
            uid = (qs.get("uploadId") or [rec[1] if rec else ""])[0]
            if not rec or rec[0] != "complete" or rec[1] != uid:
                return J({"error": "bad sig"}, 403)
            if self.fail_complete:
                return J({"error": "NoSuchUpload"}, 400)
            up = self.uploads[uid]
            b = json.loads(body)
            nparts = -(-up["size"] // self.chunk)
            if [p["partNumber"] for p in b["parts"]] != list(range(1, nparts + 1)):
                return J({"error": "parts"}, 400)
            for p in b["parts"]:
                if p["etag"] != '"%s"' % hashlib.md5(up["parts"].get(p["partNumber"], b"")).hexdigest():
                    return J({"error": "etag"}, 400)
            data = b"".join(up["parts"][i] for i in range(1, nparts + 1))
            if len(data) != up["size"] or b["oid"] != up["oid"] or hashlib.sha256(data).hexdigest() != up["oid"]:
                return J({"error": "digest"}, 400)
            self.objects[up["oid"]] = data
            self.open_by_oid.pop(up["oid"], None)
            return J({})
        if method == "POST" and path.endswith("objects/verify"):
            b = json.loads(body)
            ok = b["oid"] in self.objects and len(self.objects[b["oid"]]) == b["size"]
            return J({} if ok else {"error": "missing"}, 200 if ok else 404)
        if method == "POST" and "/commit/" in path:
            if h.headers.get("Content-Type") != "application/x-ndjson":
                return J({"error": "content type"}, 400)
            repo = "/".join(parts[2:4])
            lines = [json.loads(x) for x in body.splitlines() if x.strip()]
            assert lines[0]["key"] == "header"
            files = self.repos[repo]["files"]
            for x in lines[1:]:
                v = x["value"]
                if x["key"] == "lfsFile":
                    if v["oid"] not in self.objects or len(self.objects[v["oid"]]) != v["size"]:
                        return J({"error": f"missing lfs object for {v['path']}"}, 400)
                    files[v["path"]] = {"oid": v["oid"], "size": v["size"], "lfs": True}
                elif x["key"] == "file":
                    data = base64.b64decode(v["content"])
                    files[v["path"]] = {"oid": hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest(),
                                        "size": len(data), "lfs": False, "data": data}
            oid = secrets.token_hex(20)
            self.repos[repo]["commits"].append({"oid": oid, "header": lines[0]["value"], "n": len(lines) - 1})
            return J({"commitOid": oid, "commitUrl": f"{self.base}/{repo}/commit/{oid}"})
        if method == "POST" and "/paths-info/" in path:
            repo = "/".join(parts[2:4])
            form = urllib.parse.parse_qs(body.decode())
            out = []
            for p in form.get("paths", []):
                f = self.repos[repo]["files"].get(p)
                if f:
                    out.append({"type": "file", "path": p, "size": f["size"], "oid": "x",
                                "lfs": {"oid": f["oid"], "size": f["size"], "pointerSize": 134} if f["lfs"] else None})
            return J(out)
        return J({"error": "no route"}, 404)


# ---- shared setup ----

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="hfrelay-", dir=SCRATCH))
        self.q = os.path.join(self.tmp, "q")
        os.makedirs(os.path.join(self.q, "run"))
        self.hub = FakeHub()
        self.patches = [mock.patch.object(R, "DATA", os.path.join(self.tmp, "data")),
                        mock.patch.object(R, "REBATCH_GAP_S", 0.0),
                        mock.patch.object(R, "REMOTE_ROOT", self.q)]
        for p in self.patches:
            p.start()
        self.rng = random.Random(7)

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.hub.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def big(self, name, size):
        data = self.rng.randbytes(size)
        path = os.path.join(self.q, "run", name)
        with open(path, "wb") as f:
            f.write(data)
        return path, data

    def local(self, name, text):
        path = os.path.join(self.tmp, name)
        with open(path, "w") as f:
            f.write(text)
        return path

    def manifest(self, files, repo="tester/glimmer-test", **kw):
        m = {"repo": repo, "revision": "main", "message": "test upload", "files": files, **kw}
        path = os.path.join(self.tmp, "manifest.json")
        with open(path, "w") as f:
            json.dump(m, f)
        return R.load_manifest(path)

    def push(self, manifest, create=True, **kw):
        hub = R.Hub(self.hub.base, TOKEN)
        kw.setdefault("mb_per_s", 0)
        return R.push(manifest, hub, create, remote_argv=R.local_argv, remote_root=self.q, **kw), hub

    def files(self, repo="tester/glimmer-test"):
        return self.hub.repos[repo]["files"]


class TestUpload(Base):
    def test_multipart_basic_small_and_commit(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 300 * 1024 + 123)       # 5 parts, the last one short
        p2, d2 = self.big("adapter_model.safetensors", 40 * 1024)    # basic (under one chunk)
        small = self.big("adapter_config.json", 300)[0]              # regular, read from "writer-1" with cat
        readme = self.local("README.md", "# Glimmer test\n")
        m = self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}, {"path": "adapter/adapter_model.safetensors",
                           "writer1": p2}, {"path": "adapter/adapter_config.json", "writer1": small},
                           {"path": "README.md", "local": readme}])
        res, hub = self.push(m)
        self.assertTrue(self.hub.repos["tester/glimmer-test"]["private"])
        self.assertTrue(self.hub.create_body.get("private") and self.hub.create_body.get("visibility") == "private")
        f = self.files()
        self.assertEqual(f["glimmer-Q4.gguf"]["oid"], hashlib.sha256(d1).hexdigest())
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)
        self.assertEqual(self.hub.objects[hashlib.sha256(d2).hexdigest()], d2)
        self.assertEqual(f["README.md"]["data"], b"# Glimmer test\n")
        self.assertFalse(f["adapter/adapter_config.json"]["lfs"])
        self.assertEqual(len(self.hub.puts("/s3/basic")), 1)
        self.assertEqual(len([x for x in self.hub.puts("/s3/") if "basic" not in x[1]]), 5)
        self.assertEqual(len(self.hub.posts("complete_multipart")), 1)
        self.assertEqual(len(self.hub.posts("objects/verify")), 2)
        self.assertEqual(len(self.hub.repos["tester/glimmer-test"]["commits"]), 1)
        self.assertEqual(res["counts"]["rebatches"], 0)
        # nothing left in the resume state, and no URL in any file we wrote
        self.assertEqual(R._load_json("uploads.json", {}), {})
        for root, _, names in os.walk(R.DATA):
            for n in names:
                text = open(os.path.join(root, n)).read()
                self.assertNotIn("X-Amz-Signature", text)
                self.assertNotIn("uploadId", text)
                self.assertNotIn(TOKEN, text)

    def test_stream_mode_same_bytes(self):
        p1, d1 = self.big("glimmer-Q2.gguf", 200 * 1024 + 7)
        m = self.manifest([{"path": "glimmer-Q2.gguf", "writer1": p1}])
        self.push(m, buffer_mb=0)  # 3 threads * 64 KiB > 0 MiB: one thread, streamed from the file
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)

    def test_skip_when_hub_has_the_bytes_and_rerun_is_a_no_op(self):
        p1, d1 = self.big("glimmer-Q8.gguf", 150 * 1024)
        self.hub.objects[hashlib.sha256(d1).hexdigest()] = d1  # stored already (another path or repo)
        m = self.manifest([{"path": "glimmer-Q8.gguf", "writer1": p1}])
        res, _ = self.push(m)
        self.assertEqual(self.hub.puts(), [])
        self.assertEqual(self.hub.posts("complete_multipart"), [])
        self.assertIn(("glimmer-Q8.gguf", "big file, present"), res["summary"])
        self.assertEqual(self.files()["glimmer-Q8.gguf"]["oid"], hashlib.sha256(d1).hexdigest())
        # a second push: the path already holds this sha256, so no batch call and no commit
        before = len(self.hub.posts("objects/batch"))
        res2, _ = self.push(self.manifest([{"path": "glimmer-Q8.gguf", "writer1": p1}]), create=False)
        self.assertIsNone(res2["commit"])
        self.assertEqual(len(self.hub.posts("objects/batch")), before)
        self.assertEqual(len(self.hub.repos["tester/glimmer-test"]["commits"]), 1)

    def test_one_expired_part_url_same_upload(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 400 * 1024)
        self.hub.expire_once = {3}
        res, _ = self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertEqual(res["counts"]["rebatches"], 1)
        self.assertEqual(res["counts"]["restarts"], 0)
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)
        self.assertEqual(len([x for x in self.hub.puts("/s3/") if x[1].endswith("/3")]), 2)  # refused, then fine

    def test_expired_url_with_new_upload_starts_over(self):
        self.hub.reuse_upload = False
        p1, d1 = self.big("glimmer-Q4.gguf", 400 * 1024)
        self.hub.expire_once = {3}
        res, _ = self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertEqual(res["counts"]["restarts"], 1)
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)

    def test_resume_after_a_failed_run(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 640 * 1024)  # 10 parts
        self.hub.always_refuse = {6}
        m = self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}])
        with self.assertRaises(R.RelayError):
            self.push(m, threads=1)
        st = R._load_json("uploads.json", {})
        rec = st[hashlib.sha256(d1).hexdigest()]
        self.assertEqual(sorted(int(n) for n in rec["parts"]), [1, 2, 3, 4, 5])
        self.assertNotIn("http", json.dumps(st))
        self.assertEqual(self.hub.posts("complete_multipart"), [])
        self.assertEqual(self.hub.posts("/commit/"), [])
        # the second run gets the same upload from the Hub and sends only parts 6 to 10
        self.hub.always_refuse = set()
        n_before = len(self.hub.puts("/s3/"))
        res, _ = self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]), create=False, threads=1)
        self.assertEqual(res["counts"]["skipped_parts"], 5)
        self.assertEqual(len(self.hub.puts("/s3/")) - n_before, 5)
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)
        self.assertEqual(R._load_json("uploads.json", {}), {})

    def test_wrong_sha256_is_never_completed(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 200 * 1024)
        m = self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1, "sha256": "0" * 64}])
        with self.assertRaises(R.RelayError):
            self.push(m)
        self.assertEqual(self.hub.posts("complete_multipart"), [])
        self.assertEqual(self.hub.posts("/commit/"), [])

    def test_manifest_size_mismatch_stops_before_any_upload(self):
        p1, _ = self.big("glimmer-Q4.gguf", 200 * 1024)
        with self.assertRaises(R.RelayError):
            self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1, "bytes": 5}]))
        self.assertEqual(self.hub.posts("objects/batch"), [])

    def test_hash_cache_is_used_on_the_second_run(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 100 * 1024)
        m = self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}])
        R.measure(m, R.local_argv(), self.q)
        self.assertEqual(m["files"][0]["sha256"], hashlib.sha256(d1).hexdigest())
        with mock.patch.object(R, "probe", wraps=R.probe) as pr:
            R.measure(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]), R.local_argv(), self.q)
        self.assertEqual([c.args[1] for c in pr.call_args_list], ["stat"])


class TestReview(Base):
    """Cases found in the adversarial review."""

    def test_a_transient_storage_500_is_retried_not_fatal(self):
        # writer-1 reports {"warn": n, "error": ...}; the Mac used to read the "error" key as fatal
        p1, d1 = self.big("glimmer-Q4.gguf", 300 * 1024)
        self.hub.fail_once_500 = {2}
        res, _ = self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)
        self.assertEqual(res["counts"]["rebatches"], 0)

    def test_urls_that_all_expire_together_cost_one_batch_call(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 640 * 1024)  # 10 parts
        self.hub.expire_once = {1, 2, 3}
        res, _ = self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]), threads=3)
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)
        self.assertEqual(res["counts"]["rebatches"], 1)
        self.assertEqual(res["counts"]["restarts"], 0)

    def test_a_url_answered_by_hanging_up_gets_replaced(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 300 * 1024)
        self.hub.reset_first_url = {2}
        res, _ = self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)
        self.assertEqual(res["counts"]["rebatches"], 1)

    def test_same_upload_is_recognised_from_the_part_urls(self):
        self.hub.hide_uid_in_completion = True
        p1, d1 = self.big("glimmer-Q4.gguf", 400 * 1024)
        self.hub.expire_once = {3}
        res, _ = self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertEqual(res["counts"]["restarts"], 0)
        self.assertEqual(self.hub.objects[hashlib.sha256(d1).hexdigest()], d1)

    def test_empty_file_goes_as_a_regular_file(self):
        p0, _ = self.big("empty.gguf", 0)
        res, _ = self.push(self.manifest([{"path": "empty.gguf", "writer1": p0}]))
        self.assertEqual(self.hub.posts("objects/batch"), [])
        self.assertFalse(self.files()["empty.gguf"]["lfs"])

    def test_a_local_file_holding_the_token_is_never_sent(self):
        p1, _ = self.big("glimmer-Q4.gguf", 100 * 1024)
        card = self.local("README.md", f"# card\nleaked {TOKEN}\n")
        with self.assertRaises(R.RelayError) as cm:
            self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}, {"path": "README.md", "local": card}]))
        self.assertNotIn(TOKEN, str(cm.exception))
        self.assertEqual(self.hub.posts("preupload"), [])
        self.assertEqual(self.hub.posts("objects/batch"), [])
        self.assertEqual(self.hub.posts("/commit/"), [])

    def test_a_token_in_the_commit_message_is_refused(self):
        p1, _ = self.big("glimmer-Q4.gguf", 100 * 1024)
        with self.assertRaises(R.RelayError):
            self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}], message=f"oops {TOKEN}"))
        self.assertEqual(self.hub.posts("objects/batch"), [])

    def test_env_files_are_refused_in_the_manifest(self):
        env = self.local(".env.local", "HF_TOKEN=x\n")
        for p in (env, R.ENV_PATH):
            with self.assertRaises(R.RelayError):
                self.manifest([{"path": "notes.txt", "local": p}])

    def test_repo_flipped_public_mid_push_gets_no_commit(self):
        p1, _ = self.big("glimmer-Q4.gguf", 100 * 1024)
        self.hub.public_after_batch = True
        with self.assertRaises(R.RelayError) as cm:
            self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertIn("not private", str(cm.exception))
        self.assertEqual(self.hub.posts("/commit/"), [])

    def test_a_refused_completion_clears_the_saved_parts(self):
        p1, d1 = self.big("glimmer-Q4.gguf", 300 * 1024)
        self.hub.fail_complete = True
        with self.assertRaises(R.RelayError):
            self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertNotIn(hashlib.sha256(d1).hexdigest(), R._load_json("uploads.json", {}))

    def test_plain_http_part_urls_are_refused_for_the_real_hub(self):
        hub = R.Hub("https://huggingface.co", TOKEN)
        relay = R.Relay(hub, "a/b", "main")
        obj = {"oid": "a" * 64, "size": 10, "actions": {"upload": {"href": "http://s3.example/x"}}}
        with self.assertRaises(R.RelayError):
            relay._one_run("x", "/home/ubuntu/q/r/x", "/home/ubuntu/q", "a" * 64, 10, obj, ["false"])

    def test_the_remote_side_gets_no_token_shaped_environment(self):
        with mock.patch.dict(os.environ, {"HF_TOKEN": TOKEN, "HUGGING_FACE_HUB_TOKEN": TOKEN, "OTHER": TOKEN,
                                          "PATH": os.environ.get("PATH", "")}):
            R._SECRETS.append(TOKEN)
            try:
                env = R.child_env()
            finally:
                R._SECRETS.remove(TOKEN)
        self.assertNotIn(TOKEN, json.dumps(env))
        self.assertIn("PATH", env)

    def test_writer1_ssh_has_no_forwarding_and_no_tty(self):
        with mock.patch("builtins.open", mock.mock_open(read_data=json.dumps(
                {"lab": {"ssh_key": "~/.ssh/k"}, "writer1": {"host": "ubuntu@w1.invalid"}}))):
            argv = R.writer1_argv()
        for opt in ("-T", "ForwardAgent=no", "ClearAllForwardings=yes", "ForwardX11=no"):
            self.assertIn(opt, argv)
        self.assertIn("python3 -I -B -c", argv[-1])

    def test_the_remote_side_exits_when_the_laptop_goes_away(self):
        p1, _ = self.big("glimmer-Q4.gguf", 640 * 1024)
        proc = subprocess.Popen(R.local_argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        prog = open(R.REMOTE_PROGRAM, "rb").read()
        job = {"path": p1, "root": self.q, "bytes": 640 * 1024, "sha256": None, "mode": "multipart",
               "part_bytes": 64 * 1024, "threads": 3, "mb_per_s": 0, "batch": 16, "skip": [], "buffer_mb": 512}
        proc.stdin.write(f"{len(prog)}\n".encode() + prog + (json.dumps({"job": job}) + "\n").encode())
        proc.stdin.flush()
        proc.stdout.readline()  # mode
        proc.stdout.readline()  # need
        proc.stdin.close()
        proc.stdout.close()  # the laptop is gone: no stdin, no stdout
        self.assertIsNotNone(proc.wait(timeout=30))


class TestPrivacy(Base):
    def test_existing_public_repo_is_refused(self):
        self.hub.repos["tester/open"] = {"private": False, "files": {}, "commits": []}
        p1, _ = self.big("glimmer-Q4.gguf", 100 * 1024)
        with self.assertRaises(R.RelayError) as cm:
            self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}], repo="tester/open"))
        self.assertIn("not private", str(cm.exception))
        self.assertEqual(self.hub.posts("objects/batch"), [])
        self.assertEqual(self.hub.puts(), [])

    def test_missing_repo_without_create_is_refused(self):
        p1, _ = self.big("glimmer-Q4.gguf", 100 * 1024)
        with self.assertRaises(R.RelayError):
            self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]), create=False)
        self.assertEqual(self.hub.repos, {})

    def test_created_public_is_set_private_first(self):
        self.hub.public_on_create = True
        p1, _ = self.big("glimmer-Q4.gguf", 100 * 1024)
        self.push(self.manifest([{"path": "glimmer-Q4.gguf", "writer1": p1}]))
        self.assertTrue(self.hub.repos["tester/glimmer-test"]["private"])
        settings_at = next(i for i, x in enumerate(self.hub.log) if x[1].endswith("/settings"))
        batch_at = next(i for i, x in enumerate(self.hub.log) if x[1].endswith("objects/batch"))
        self.assertLess(settings_at, batch_at)

    def test_token_only_goes_to_hub_api_calls(self):
        p1, _ = self.big("glimmer-Q4.gguf", 300 * 1024)
        p2, _ = self.big("adapter_model.safetensors", 10 * 1024)
        self.push(self.manifest([{"path": "a.gguf", "writer1": p1}, {"path": "b.safetensors", "writer1": p2}]))
        for method, path, has_auth, _ in self.hub.log:
            if path.startswith("/s3/") or "complete_multipart" in path:
                self.assertFalse(has_auth, f"{method} {path} carried a token")
            else:
                self.assertTrue(has_auth, f"{method} {path} lacked the token")

    def test_token_is_refused_for_another_origin_and_redirects_are_not_followed(self):
        other = FakeHub()
        try:
            hub = R.Hub(self.hub.base, TOKEN)
            with self.assertRaises(R.RelayError):
                hub.request("GET", other.base + "/api/models/a/b")
            self.assertEqual(other.log, [])

            class Redirect(http.server.BaseHTTPRequestHandler):
                def log_message(self, *a):
                    pass

                def do_GET(self):
                    self.send_response(302)
                    self.send_header("Location", other.base + "/api/models/a/b")
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            try:
                hub2 = R.Hub(f"http://127.0.0.1:{srv.server_address[1]}", TOKEN)
                with self.assertRaises(R.RelayError) as cm:
                    hub2.request("GET", "/api/models/a/b")
                self.assertIn("302", str(cm.exception))
                self.assertEqual(other.log, [])
            finally:
                srv.shutdown()
                srv.server_close()
        finally:
            other.close()

    def test_endpoint_must_be_the_hub_or_local(self):
        for bad in ("https://evil.example", "http://huggingface.co", "https://huggingface.co.evil.example"):
            with self.assertRaises(R.RelayError):
                R.Hub(bad, TOKEN)
        R.Hub("https://huggingface.co", TOKEN)

    def test_scrub(self):
        R._SECRETS.append("plainsecretvalue123")
        try:
            t = R.scrub(f"GET https://s3.amazonaws.com/x?X-Amz-Signature=abc failed; {TOKEN}; Bearer abc.def; "
                        "X-Amz-Credential=AKIA/x xet_abcdefghijk plainsecretvalue123")
        finally:
            R._SECRETS.remove("plainsecretvalue123")
        for bad in ("amazonaws", "abc.def", TOKEN, "AKIA", "xet_abcdefghijk", "plainsecretvalue123"):
            self.assertNotIn(bad, t)

    def test_read_token(self):
        env = os.path.join(self.tmp, ".env.local")
        with open(env, "w") as f:
            f.write(f'LAMBDA_API_KEY=x\nexport HF_TOKEN="{TOKEN}"\n')
        self.assertEqual(R.read_token(env), TOKEN)
        self.assertNotIn(TOKEN, R.scrub(f"oops {TOKEN}"))
        with open(env, "w") as f:
            f.write("LAMBDA_API_KEY=x\n")
        with self.assertRaises(R.RelayError) as cm:
            R.read_token(env)
        self.assertNotIn("LAMBDA", str(cm.exception))

    def test_remote_paths(self):
        R.check_remote_path(self.q + "/run/x.gguf")
        for bad in ("/lambda/nfs/muse-muse-cache-us-east-1/models/x.gguf", self.q + "/../etc/passwd",
                    self.q + "/run//x", self.q + "/run/x y.gguf", "relative/x.gguf", self.q):
            with self.assertRaises(R.RelayError):
                R.check_remote_path(bad)
        # the remote side checks again after symlinks: a link out of the root reads as missing
        outside = self.local("outside.bin", "secret")
        os.symlink(outside, os.path.join(self.q, "run", "link.gguf"))
        self.assertTrue(R.probe(R.local_argv(), "stat", self.q + "/run/link.gguf", self.q).get("missing"))


class TestPlan(Base):
    def test_plan_makes_no_network_call_and_reads_no_token(self):
        p1, _ = self.big("glimmer-Q4.gguf", 1000)
        readme = self.local("README.md", "# hi\n")
        path = os.path.join(self.tmp, "m.json")
        with open(path, "w") as f:
            json.dump({"repo": "tester/glimmer-test", "files": [
                {"path": "glimmer-Q4.gguf", "writer1": p1, "bytes": 1000, "sha256": "a" * 64},
                {"path": "README.md", "local": "README.md"}]}, f)
        boom = mock.Mock(side_effect=AssertionError("network or token use in plan"))
        with mock.patch.object(R, "read_token", boom), mock.patch.object(R._OPENER, "open", boom), \
                mock.patch.object(R.subprocess, "Popen", boom), mock.patch("socket.create_connection", boom), \
                mock.patch("sys.stdout") as out:
            self.assertEqual(R.main(["plan", path, "--create-private"]), 0)
        text = "".join(c.args[0] for c in out.write.call_args_list)
        self.assertIn("plan only", text)
        self.assertIn("a" * 64, text)
        boom.assert_not_called()


class TestEndToEnd(unittest.TestCase):
    """The real CLI in a copy of the repo layout, with a fake ssh, nice and ionice on PATH. Checks that the token
    never shows up in any argv, in what goes to the remote side, in stdout or stderr, or in any file but .env.local."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="hfrelay-e2e-", dir=SCRATCH))
        self.hub = FakeHub()

    def tearDown(self):
        self.hub.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _exe(self, path, text):
        with open(path, "w") as f:
            f.write(text)
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)

    def test_cli_push_token_hygiene(self):
        t = self.tmp
        aws = os.path.join(t, "repo", "scripts", "knowledge", "aws")
        os.makedirs(aws)
        os.makedirs(os.path.join(t, "repo", "scripts", "knowledge", "compare"))
        q = os.path.join(t, "q")
        os.makedirs(os.path.join(q, "run"))
        src = open(os.path.join(HERE, "hf_relay.py")).read()
        self.assertIn('REMOTE_ROOT = "/home/ubuntu/q"', src)
        with open(os.path.join(aws, "hf_relay.py"), "w") as f:
            f.write(src.replace('REMOTE_ROOT = "/home/ubuntu/q"', f'REMOTE_ROOT = "{q}"'))
        shutil.copy(os.path.join(HERE, "hf_put_remote.py"), aws)
        with open(os.path.join(t, "repo", "scripts", "knowledge", "compare", "models.json"), "w") as f:
            json.dump({"lab": {"ssh_key": "~/.ssh/not-a-real-key"}, "writer1": {"host": "ubuntu@writer-1.invalid"}}, f)
        with open(os.path.join(t, "repo", ".env.local"), "w") as f:
            f.write(f"HF_TOKEN={TOKEN}\n")
        data = random.Random(3).randbytes(330 * 1024)
        with open(os.path.join(q, "run", "glimmer-Q4.gguf"), "wb") as f:
            f.write(data)
        with open(os.path.join(t, "README.md"), "w") as f:
            f.write("# card\n")
        with open(os.path.join(t, "manifest.json"), "w") as f:
            json.dump({"repo": "tester/e2e", "files": [{"path": "glimmer-Q4.gguf", "writer1": f"{q}/run/glimmer-Q4.gguf"},
                                                       {"path": "README.md", "local": "README.md"}]}, f)
        self.hub.expire_once = {2}
        # fake ssh: records argv and stdin, runs the remote command here
        bin_ = os.path.join(t, "bin")
        os.makedirs(bin_)
        self._exe(os.path.join(bin_, "ssh"), f"""#!{sys.executable}
import subprocess, sys, threading
with open({os.path.join(t, 'ssh_argv.log')!r}, 'a') as f:
    f.write(repr(sys.argv) + '\\n')
p = subprocess.Popen(['sh', '-c', sys.argv[-1]], stdin=subprocess.PIPE)
log = open({os.path.join(t, 'ssh_stdin.log')!r}, 'ab')
for chunk in iter(lambda: sys.stdin.buffer.read1(65536), b''):
    log.write(chunk); log.flush()
    try:
        p.stdin.write(chunk); p.stdin.flush()
    except BrokenPipeError:
        break
p.stdin.close()
sys.exit(p.wait())
""")
        self._exe(os.path.join(bin_, "ionice"), "#!/bin/sh\n[ \"$1\" = -c ] && shift 2\nexec \"$@\"\n")
        os.symlink(sys.executable, os.path.join(bin_, "python3"))
        env = {"PATH": bin_ + os.pathsep + os.environ.get("PATH", ""), "HOME": t, "LANG": "C.UTF-8"}
        r = subprocess.run([sys.executable, "-I", os.path.join(aws, "hf_relay.py"), "push",
                            os.path.join(t, "manifest.json"), "--create-private", "--yes", "--endpoint", self.hub.base,
                            "--mb-per-s", "0"], capture_output=True, text=True, env=env, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.hub.objects[hashlib.sha256(data).hexdigest()], data)
        self.assertTrue(self.hub.repos["tester/e2e"]["private"])
        self.assertIn("1 refused URLs", r.stdout)
        for text in (r.stdout, r.stderr):
            self.assertNotIn(TOKEN, text)
            self.assertNotIn("X-Amz-Signature", text)
            self.assertNotIn("uploadId", text)
            self.assertNotIn(self.hub.base, text)
        argv_log = open(os.path.join(t, "ssh_argv.log")).read()
        self.assertIn("nice -n 19 ionice -c 3 python3 -I -B -c", argv_log)
        self.assertNotIn(TOKEN, argv_log)
        self.assertNotIn("X-Amz", argv_log)
        stdin_log = open(os.path.join(t, "ssh_stdin.log"), "rb").read()
        self.assertNotIn(TOKEN.encode(), stdin_log)
        self.assertIsNone(re.search(rb"hf_[A-Za-z0-9]{8,}|Bearer", stdin_log))  # nothing token-shaped at all
        self.assertIn(b"X-Amz-Signature", stdin_log)  # the part URLs do travel this way, and only this way
        self.assertNotIn(b"complete_multipart", stdin_log)  # the completion URL stays on the Mac
        for root, _, names in os.walk(t):
            for n in names:
                p = os.path.join(root, n)
                if p == os.path.join(t, "repo", ".env.local") or os.path.islink(p):
                    continue
                with open(p, "rb") as f:
                    self.assertNotIn(TOKEN.encode(), f.read(), p)
        for n in os.listdir(os.path.join(t, "repo", ".data", "hf")):
            text = open(os.path.join(t, "repo", ".data", "hf", n)).read()
            self.assertNotIn("X-Amz", text)
            self.assertNotIn("127.0.0.1", text)
        # nothing the remote side could have written: q holds only the file it read
        self.assertEqual(sorted(os.listdir(os.path.join(q, "run"))), ["glimmer-Q4.gguf"])


if __name__ == "__main__":
    unittest.main()
