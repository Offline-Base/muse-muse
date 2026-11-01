"""Our files to a private Hugging Face model repo, with the token on this Mac and the bytes going straight from writer-1.

    PY=.data/aws/venv/bin/python; R=scripts/knowledge/aws/hf_relay.py
    $PY $R plan MANIFEST                  the plan only: no network, no ssh, no token read
    $PY $R hash MANIFEST                  size and sha256 of each writer-1 file (read-only, nice/ionice), cached
    $PY $R push MANIFEST [--create-private] [--yes] [--mb-per-s N] [--threads N]

The Hugging Face token is read from .env.local (HF_TOKEN) on this Mac and nowhere else. It goes only into the
Authorization header of requests to huggingface.co itself: never to writer-1, never to the storage URLs, never into a
command line, a file, a log or the terminal. Redirects are not followed, so it can't be carried to another host.

How a big file moves (the Git LFS protocol the Hub still takes on Xet-backed repos; the Hub moves it to Xet afterwards):
  1. writer-1 reports the file's size, and its sha256 unless the manifest or the cache has it (hf_put_remote.py probe).
  2. This Mac asks the Hub's preupload API whether each path is "lfs" or "regular", and skips paths whose content
     the repo already has at that path.
  3. This Mac posts the LFS batch API for that one file (operation upload, transfers basic and multipart). No actions
     in the reply means the Hub already stores those bytes: the upload is skipped and only the commit entry is made.
  4. Otherwise the reply holds short-lived storage URLs: one per part plus chunk_size (multipart), or one URL (basic).
     They are sent only over ssh stdin to hf_put_remote.py on writer-1, a batch at a time, which reads the file once,
     hashes it and PUTs the parts at nice 19, ionice idle, under --mb-per-s. It writes nothing on writer-1, takes no
     lock and never touches the GPU. A refused URL (expired) makes this Mac ask the batch API again; the same upload
     gets the fresh URL, a new upload starts the file over.
  5. writer-1's sha256 must equal the expected one, or nothing is completed. This Mac then posts the completion call
     with the parts' ETags (multipart), and the verify call (oid and size).
  6. One commit (POST /api/models/{repo}/commit/{revision}, NDJSON: a header line, an lfsFile line per big file, a
     file line per small file), then paths-info to check each big file's sha256 and size on the Hub.
Small files (README.md, chat template, LICENSE notices) go in that commit as base64 "file" entries from this Mac, or,
for a few small files that live on writer-1, read with the probe's cat (at most 10 MB).

The repo must be private. --create-private creates it private when it doesn't exist. A repo that turns out public is
never uploaded to, unless --allow-public is given for a repo that is already public and released (adding files to a
release); one we just created and that came back public is set private first, with or without that flag. Nothing here
makes a repo public.

Storage URLs, and the completion URL, are never printed, logged or written to a file. Each multipart upload's done
parts (number and ETag, no URLs) are kept in .data/hf/uploads.json so a rerun can skip them if the Hub hands back the
same upload.

The manifest (JSON):
    {"repo": "namespace/name", "revision": "main", "message": "Add r30b GGUFs",
     "files": [{"path": "glimmer-r30b-Q4_K_M.gguf", "writer1": "/home/ubuntu/q/stage-b-r30b/x.gguf",
                "sha256": "optional", "bytes": 123},
               {"path": "README.md", "local": "README.md"}]}
A "local" path is relative to the manifest's folder. Standard library only.
"""

import argparse
import base64
import contextlib
import hashlib
import json
import math
import os
import queue
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
ENV_PATH = os.path.join(ROOT, ".env.local")
CONFIG = os.path.join(ROOT, "scripts", "knowledge", "compare", "models.json")
DATA = os.path.join(ROOT, ".data", "hf")
REMOTE_PROGRAM = os.path.join(HERE, "hf_put_remote.py")
REMOTE_ROOT = "/home/ubuntu/q"
ENDPOINT = "https://huggingface.co"
BOOTSTRAP = "import sys;n=int(sys.stdin.buffer.readline());exec(compile(sys.stdin.buffer.read(n),\"uploader\",\"exec\"))"
SMALL_MAX = 10 << 20
LFS_HEADERS = {"Accept": "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json"}
USER_AGENT = "muse-hf-relay/1"
REBATCH_GAP_S = 5.0
MAX_REBATCHES = 8  # per run of one file; URLs that expire together cost one batch call, not one per thread
MAX_RESTARTS = 2
IDLE_TIMEOUT_S = 900
HASH_TIMEOUT_S = 4 * 3600

REPO_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}")
REV_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,127}")
REPO_PATH_RE = re.compile(r"(\.gitattributes|[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*)")
SHA_RE = re.compile(r"[0-9a-f]{64}")


class RelayError(RuntimeError):
    pass


# ---- never a URL or a token in anything we print ----

_SECRETS = []
_URL = re.compile(r"https?://\S+")
_AMZ = re.compile(r"X-Amz-[A-Za-z-]+=[^&\s]+")
_HF = re.compile(r"hf_[A-Za-z0-9]{8,}")
_XET = re.compile(r"xet_[A-Za-z0-9._-]{8,}")
_BEARER = re.compile(r"(?i)bearer\s+\S+")


def scrub(text):
    text = str(text)
    for s in _SECRETS:
        text = text.replace(s, "[token]")
    text = _URL.sub("[url]", text)
    text = _AMZ.sub("X-Amz-[hidden]", text)
    text = _BEARER.sub("Bearer [token]", text)
    return _XET.sub("[token]", _HF.sub("[token]", text))


def log(msg):
    msg = scrub(msg)
    print(msg, flush=True)
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(os.path.join(DATA, "relay.log"), "a") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg + "\n")
    except OSError:
        pass


def read_token(path=None):
    """HF_TOKEN from .env.local. The value is registered with scrub() and never printed."""
    path = path or ENV_PATH
    try:
        with open(path) as f:
            lines = f.read().splitlines()
    except OSError:
        raise RelayError(".env.local can't be read")
    for line in lines:
        m = re.match(r"\s*(?:export\s+)?HF_TOKEN\s*=\s*(.*)$", line)
        if m:
            v = m.group(1).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            if not v or re.search(r"\s", v):
                raise RelayError("HF_TOKEN in .env.local is empty or malformed")
            if v not in _SECRETS:
                _SECRETS.append(v)
            return v
    raise RelayError("HF_TOKEN isn't in .env.local")


_TOKENISH_ENV = re.compile(r"(?i)(^HF_|HUGGING|TOKEN|SECRET|PASSWORD|_KEY$|^AWS_|CREDENTIAL)")


def child_env():
    """The environment for ssh (and the local test runs): this process's, minus anything token-shaped, so even an
    `SendEnv *` in ~/.ssh/config, or an HF_TOKEN exported in the shell, carries nothing to writer-1."""
    env = {}
    for k, v in os.environ.items():
        if _TOKENISH_ENV.search(k) or any(s and s in v for s in _SECRETS) or _HF.search(v):
            continue
        env[k] = v
    return env


# ---- small files on this Mac (atomic, 0600) ----

def _load_json(name, default):
    try:
        with open(os.path.join(DATA, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save_json(name, obj):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, name)
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


# ---- the Hub (the only place the token goes) ----

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def check_endpoint(endpoint):
    if endpoint == ENDPOINT or re.fullmatch(r"http://(127\.0\.0\.1|localhost):\d{2,5}", endpoint or ""):
        return endpoint
    raise RelayError("the endpoint must be https://huggingface.co (or a local test server)")


def _origin(url):
    u = urllib.parse.urlsplit(url)
    return u.scheme, (u.hostname or "").lower(), u.port or (443 if u.scheme == "https" else 80)


class Hub:
    def __init__(self, endpoint, token):
        self.endpoint = check_endpoint(endpoint).rstrip("/")
        self.token = token
        self.calls = 0

    def request(self, method, url, body=None, headers=None, auth=True, ok=(200,), tries=5, timeout=120):
        """Returns (status, bytes) for a status in ok (or 404/409 when listed). Raises RelayError otherwise; the
        error text is scrubbed. auth adds the token, and only for the endpoint's own origin."""
        if not url.startswith("http"):
            url = self.endpoint + url
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("https", "http") or (u.scheme == "http" and self.endpoint.startswith("https")):
            raise RelayError("refusing a non-https URL")
        h = {"User-Agent": USER_AGENT, **(headers or {})}
        if auth:
            if _origin(url) != _origin(self.endpoint):
                raise RelayError("refusing to send the token to a host other than the Hub")
            h["Authorization"] = "Bearer " + self.token
        last = None
        for attempt in range(1, tries + 1):
            self.calls += 1
            req = urllib.request.Request(url, data=body, method=method, headers=h)
            try:
                with _OPENER.open(req, timeout=timeout) as r:
                    status, data = r.status, r.read()
            except urllib.error.HTTPError as e:
                status, data = e.code, e.read(4096) if e.fp else b""
                retry_after = e.headers.get("Retry-After") if e.headers else None
            except (urllib.error.URLError, OSError) as e:
                last = type(e).__name__
                time.sleep(min(30, 2 ** attempt))
                continue
            else:
                retry_after = None
            if status in ok:
                return status, data
            if status == 429 or status >= 500:
                last = f"HTTP {status}"
                try:
                    wait = min(60.0, float(retry_after)) if retry_after else min(30, 2 ** attempt)
                except ValueError:
                    wait = min(30, 2 ** attempt)
                time.sleep(wait)
                continue
            raise RelayError(f"{method} {self._what(url)}: HTTP {status}: {scrub(data[:300].decode(errors='replace'))}")
        raise RelayError(f"{method} {self._what(url)}: gave up ({last})")

    def _what(self, url):
        """A short, URL-free name for an endpoint, for errors."""
        path = urllib.parse.urlsplit(url).path
        for key in ("objects/batch", "objects/verify", "preupload", "commit", "paths-info", "repos/create", "settings"):
            if key in path:
                return key
        return "the Hub" if _origin(url) == _origin(self.endpoint) else "a storage URL"

    def json(self, method, url, payload=None, ok=(200,), headers=None, auth=True):
        body = None if payload is None else json.dumps(payload).encode()
        hh = {"Content-Type": "application/json", **(headers or {})} if payload is not None else dict(headers or {})
        status, data = self.request(method, url, body, hh, auth=auth, ok=ok)
        try:
            return status, (json.loads(data) if data.strip() else None)
        except ValueError:
            raise RelayError(f"{self._what(url)}: the reply isn't JSON")

    # repo

    def repo_info(self, repo):
        status, info = self.json("GET", f"/api/models/{repo}", ok=(200, 404))
        return info if status == 200 else None

    def create_private(self, repo):
        ns, name = repo.split("/")
        body = {"name": name, "organization": ns, "type": "model", "private": True, "visibility": "private"}
        try:
            status, _ = self.json("POST", "/api/repos/create", body, ok=(200, 201, 409))
        except RelayError as e:
            if "HTTP 400" not in str(e):
                raise
            body.pop("private")
            status, _ = self.json("POST", "/api/repos/create", body, ok=(200, 201, 409))
        return status != 409

    def set_private(self, repo):
        self.json("PUT", f"/api/models/{repo}/settings", {"visibility": "private"}, ok=(200,))

    def ensure_private(self, repo, create, allow_public=False):
        """Private, or (only with allow_public, and only for a repo that already existed) public on purpose."""
        info = self.repo_info(repo)
        created = False
        if info is None:
            if not create:
                raise RelayError(f"{repo} doesn't exist (or the token can't see it); pass --create-private to create it")
            created = self.create_private(repo)
            log(f"{repo}: created (asked for private)" if created else f"{repo}: already exists")
            info = self.repo_info(repo)
            if info is None:
                raise RelayError(f"{repo} isn't visible after creating it")
        if info.get("private") is not True:
            if allow_public and not created:
                return info
            if not created:
                raise RelayError(f"{repo} is not private; this relay only uploads to private repos "
                                 "(pass --allow-public to add files to a released public repo)")
            log(f"{repo}: came back public; setting it private before anything is uploaded")
            self.set_private(repo)
            info = self.repo_info(repo) or {}
            if info.get("private") is not True:
                raise RelayError(f"{repo} is still not private; stopping")
        return info

    # files

    def preupload(self, repo, rev, files):
        _, out = self.json("POST", f"/api/models/{repo}/preupload/{_q(rev)}", {"files": files})
        got = {f["path"]: f for f in (out or {}).get("files", []) if isinstance(f, dict) and "path" in f}
        for f in files:
            mode = got.get(f["path"], {}).get("uploadMode")
            if mode not in ("lfs", "regular"):
                raise RelayError(f"preupload: no upload mode for {f['path']}")
        return got

    def lfs_batch(self, repo, rev, oid, size):
        payload = {"operation": "upload", "transfers": ["basic", "multipart"], "objects": [{"oid": oid, "size": size}],
                   "hash_algo": "sha256", "ref": {"name": rev}}
        _, out = self.json("POST", f"/{repo}.git/info/lfs/objects/batch", payload, headers=LFS_HEADERS)
        out = out or {}
        transfer = out.get("transfer")
        if transfer not in (None, "basic", "multipart"):
            raise RelayError(f"the Hub chose the {scrub(transfer)!r} transfer, which this relay doesn't speak "
                             "(see the Xet notes in docs)")
        objs = [o for o in out.get("objects", []) if isinstance(o, dict) and o.get("oid") == oid]
        if len(objs) != 1:
            raise RelayError("objects/batch: no entry for our file")
        obj = objs[0]
        if obj.get("error"):
            err = obj["error"] if isinstance(obj["error"], dict) else {}
            raise RelayError(f"objects/batch: {err.get('code')} {scrub(err.get('message', ''))[:200]}")
        if obj.get("size") != size:
            raise RelayError("objects/batch: the size in the reply isn't ours")
        return obj

    def complete(self, href, oid, parts):
        """The multipart completion call. Like huggingface_hub, without the token: the href is the signed credential."""
        payload = {"oid": oid, "parts": [{"partNumber": n, "etag": parts[n]} for n in sorted(parts)]}
        self.json("POST", href, payload, headers=LFS_HEADERS, auth=False, ok=(200, 201))

    def verify(self, href, oid, size):
        # the status is the answer; the Hub's reply body can be plain text (seen for small basic uploads), so it isn't parsed
        self.request("POST", href, json.dumps({"oid": oid, "size": size}).encode(), LFS_HEADERS, ok=(200, 201))

    def commit(self, repo, rev, lines):
        data = b"".join(json.dumps(x).encode() + b"\n" for x in lines)
        status, out = self.request("POST", f"/api/models/{repo}/commit/{_q(rev)}", data,
                                   {"Content-Type": "application/x-ndjson"}, ok=(200, 201), tries=1, timeout=300)
        try:
            return json.loads(out)
        except ValueError:
            raise RelayError("commit: the reply isn't JSON")

    def paths_info(self, repo, rev, paths):
        body = urllib.parse.urlencode([("paths", p) for p in paths] + [("expand", "false")]).encode()  # as httpx sends it
        _, out = self.request("POST", f"/api/models/{repo}/paths-info/{_q(rev)}", body,
                              {"Content-Type": "application/x-www-form-urlencoded"})
        try:
            return {x["path"]: x for x in json.loads(out) if isinstance(x, dict) and "path" in x}
        except (ValueError, TypeError):
            raise RelayError("paths-info: the reply isn't a list")


def _q(rev):
    return urllib.parse.quote(rev, safe="")


# ---- writer-1 (no token ever goes here) ----

def writer1_argv():
    with open(CONFIG) as f:
        cfg = json.load(f)
    key = os.path.expanduser(cfg["lab"]["ssh_key"])
    host = cfg["writer1"]["host"]
    # -T and no forwarding of any kind: the session is a plain pipe for the program and the URLs, nothing else
    return ["ssh", "-T", "-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=4", "-o", "LogLevel=ERROR", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
            "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no", host,
            f"nice -n 19 ionice -c 3 python3 -I -B -c '{BOOTSTRAP}'"]


def local_argv():
    """The same program run on this Mac (small LFS files that live here, and the tests)."""
    return [sys.executable, "-I", "-B", "-c", BOOTSTRAP]


def check_remote_path(path, root=None):
    root = (root or REMOTE_ROOT).rstrip("/")
    if not isinstance(path, str) or not path.startswith(root + "/"):
        raise RelayError(f"{path!r} is not under {root}/")
    rest = path[len(root) + 1:].split("/")
    if any(p in ("", ".", "..") or not re.fullmatch(r"[A-Za-z0-9_.-]+", p) for p in rest):
        raise RelayError(f"{path!r} has an unsafe part")
    return path


class Channel:
    """A JSON-lines channel to one run of hf_put_remote.py. URLs go only into its stdin."""

    def __init__(self, argv):
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env=child_env())
        self.q = queue.Queue()
        self.err = []
        threading.Thread(target=self._out, daemon=True).start()
        threading.Thread(target=self._errs, daemon=True).start()
        with open(REMOTE_PROGRAM, "rb") as f:
            program = f.read()
        self.send_raw(f"{len(program)}\n".encode() + program)

    def _out(self):
        for line in self.p.stdout:
            try:
                msg = json.loads(line)
                if not isinstance(msg, dict):
                    msg = {"_text": "non-object line"}
            except ValueError:
                msg = {"_text": scrub(line.decode(errors="replace").strip())[:200]}
            self.q.put(msg)
        self.q.put(None)

    def _errs(self):
        for line in self.p.stderr:
            self.err = (self.err + [scrub(line.decode(errors="replace").strip())[:200]])[-6:]

    def send_raw(self, data):
        try:
            self.p.stdin.write(data)
            self.p.stdin.flush()
        except (BrokenPipeError, OSError):
            raise RelayError("the remote side closed its input" + self.tail())

    def send(self, obj):
        self.send_raw((json.dumps(obj) + "\n").encode())

    def recv(self, timeout):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            raise RelayError(f"no word from the remote side for {timeout // 60} minutes")

    def close(self):
        with contextlib.suppress(OSError):
            self.p.stdin.close()

    def stop(self):
        with contextlib.suppress(RelayError):
            self.send({"abort": True})
        self.close()
        try:
            self.p.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()

    def wait(self, timeout=120):
        try:
            return self.p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.p.kill()
            return self.p.wait()

    def tail(self):
        return f" ({' | '.join(self.err[-3:])})" if self.err else ""


def probe(argv, op, path, root, timeout=300):
    ch = Channel(argv)
    try:
        ch.send({"probe": {"op": op, "path": path, "root": root, "max_bytes": SMALL_MAX}})
        ch.close()
        msg = ch.recv(timeout)
    except BaseException:
        ch.p.kill()
        raise
    code = ch.wait(60)
    if msg is None or "error" in msg or code != 0:
        why = scrub(json.dumps({k: v for k, v in (msg or {}).items() if k in ("error", "bytes")}))
        raise RelayError(f"probe {op} failed: {why} exit {code}{ch.tail()}")
    return msg


# ---- one big file through the remote side ----

def _upload_key(*hrefs):
    """A stable, URL-free name for one multipart upload: the hash of its uploadId, from the completion href or, failing
    that, the part URLs (an S3 UploadPart URL always carries it). None if none of them has one."""
    for href in hrefs:
        if not isinstance(href, str):
            continue
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        uid = (qs.get("uploadId") or qs.get("upload_id") or [None])[0]
        if uid:
            return hashlib.sha256(uid.encode()).hexdigest()[:24]
    return None


def _parse_actions(obj, size):
    """(mode, part_bytes, {n: url}, completion href or None, verify href or None, upload key)."""
    acts = obj.get("actions") or {}
    up = acts.get("upload")
    if not isinstance(up, dict) or not isinstance(up.get("href"), str):
        raise RelayError("objects/batch: no upload action")
    verify = acts.get("verify")
    verify_href = verify.get("href") if isinstance(verify, dict) else None
    header = up.get("header") or {}
    if "chunk_size" in header:
        try:
            chunk = int(header["chunk_size"])
        except (TypeError, ValueError):
            raise RelayError("objects/batch: chunk_size isn't a number")
        urls = {int(k): v for k, v in header.items() if isinstance(k, str) and k.isdigit()}
        n = math.ceil(size / chunk) if chunk > 0 else 0
        if chunk <= 0 or sorted(urls) != list(range(1, n + 1)) or not all(isinstance(u, str) for u in urls.values()):
            raise RelayError(f"objects/batch: {len(urls)} part URLs for {n} parts")
        return "multipart", chunk, urls, up["href"], verify_href, _upload_key(up["href"], urls[1])
    return "basic", size, {1: up["href"]}, None, verify_href, None


def _check_storage_urls(hub, urls):
    """Against the real Hub, the bytes go over TLS only: a plain-http storage URL is refused before writer-1 sees it."""
    if hub.endpoint.startswith("https://") and any(not u.startswith("https://") for u in urls.values()):
        raise RelayError("objects/batch: a storage URL isn't https; refusing to send the file in the clear")


class Relay:
    def __init__(self, hub, repo, rev, remote_argv=writer1_argv, remote_root=None, mb_per_s=150.0, threads=3,
                 batch=16, buffer_mb=512):
        self.hub, self.repo, self.rev = hub, repo, rev
        self.remote_argv, self.remote_root = remote_argv, remote_root or REMOTE_ROOT
        self.mb_per_s, self.threads, self.batch, self.buffer_mb = mb_per_s, threads, batch, buffer_mb
        self.counts = {"batches": 0, "rebatches": 0, "restarts": 0, "url_sends": 0, "skipped_parts": 0}
        self._last_batch = 0.0

    def _batch(self, oid, size):
        gap = time.monotonic() - self._last_batch
        if self._last_batch and gap < REBATCH_GAP_S:
            time.sleep(REBATCH_GAP_S - gap)
        self._last_batch = time.monotonic()
        self.counts["batches"] += 1
        return self.hub.lfs_batch(self.repo, self.rev, oid, size)

    def upload(self, name, path, root, oid, size, argv=None):
        """Puts one file's bytes in the Hub's storage. Returns "present" (no actions) or "uploaded"."""
        argv = argv or self.remote_argv()
        obj = self._batch(oid, size)
        restarts = 0
        while True:
            if obj.get("actions") is None:
                log(f"{name}: the Hub already stores these bytes; no upload")
                return "present"
            outcome, obj = self._one_run(name, path, root, oid, size, obj, argv)
            if outcome == "done":
                return "uploaded"
            if outcome == "present":
                log(f"{name}: the Hub stores these bytes now; no upload")
                return "present"
            if restarts >= MAX_RESTARTS:
                raise RelayError(f"{name}: gave up after {MAX_RESTARTS} restarts")
            restarts += 1
            self.counts["restarts"] += 1
            log(f"{name}: the Hub handed out a new upload; starting the file over ({restarts} of {MAX_RESTARTS})")

    def _one_run(self, name, path, root, oid, size, obj, argv):
        mode, part_bytes, urls, completion, verify_href, key = _parse_actions(obj, size)
        _check_storage_urls(self.hub, urls)
        nparts = len(urls)
        state = _load_json("uploads.json", {})
        rec = state.get(oid) if isinstance(state.get(oid), dict) else {}
        done = {}
        if mode == "multipart" and key and rec.get("upload") == key and rec.get("part_bytes") == part_bytes:
            done = {int(n): e for n, e in (rec.get("parts") or {}).items() if 1 <= int(n) <= nparts and e}
        if done:
            log(f"{name}: resuming the same upload; {len(done)} of {nparts} parts are already there")
            self.counts["skipped_parts"] += len(done)

        def save():
            if mode != "multipart" or not key:
                return
            st = _load_json("uploads.json", {})
            st[oid] = {"repo": self.repo, "path": name, "upload": key, "part_bytes": part_bytes,
                       "parts": {str(n): e for n, e in sorted(parts.items())}}
            _save_json("uploads.json", st)

        parts = dict(done)
        job = {"path": path, "root": root, "bytes": size, "sha256": oid, "mode": mode, "part_bytes": part_bytes,
               "threads": self.threads, "mb_per_s": self.mb_per_s, "batch": self.batch, "skip": sorted(done),
               "buffer_mb": self.buffer_mb}
        log(f"{name}: {size / 1e9:.2f} GB, {mode}, {nparts} part(s) of {part_bytes / 1048576:.2f} MiB, "
            + (f"at most {self.mb_per_s:g} MB/s" if self.mb_per_s > 0 else "no rate cap"))
        began, sent_bytes, rebatches, sent = time.time(), [0], 0, set()
        gen, url_gen = 0, {}  # gen counts this run's batch calls; url_gen[n] is the gen of the URL last sent for n

        def send_urls(ns):
            ch.send({"urls": {str(p): urls[p] for p in ns}, "gen": gen})
            sent.update(ns)
            for p in ns:
                url_gen[p] = gen
            self.counts["url_sends"] += len(ns)

        ch = Channel(argv)
        sha = err = None
        outcome = "done"
        try:
            ch.send({"job": job})
            while True:
                msg = ch.recv(IDLE_TIMEOUT_S)
                if msg is None:
                    break
                if "warn" in msg:  # a transient network or 5xx error on one PUT; writer-1 tries that URL again
                    log(f"{name}: part {msg.get('warn')}: {msg.get('error')} (HTTP {msg.get('status')}); retrying")
                    continue
                if "error" in msg:
                    err = {k: v for k, v in msg.items() if k in ("error", "type", "part", "status", "have", "want")}
                    break
                if "need" in msg:
                    want = [int(n) for n in msg["need"]]
                    if any(n not in urls for n in want):
                        raise RelayError(f"{name}: the remote side asked for a part the Hub didn't give")
                    send_urls(want)
                elif "retry" in msg:
                    n = int(msg["retry"])
                    if n not in urls:
                        raise RelayError(f"{name}: the remote side retried a part the Hub didn't give")
                    g = msg.get("gen") if isinstance(msg.get("gen"), int) else gen
                    if url_gen.get(n, -1) > g:
                        continue  # a fresher URL for n is already on its way (another part's refusal fetched it)
                    if g < gen:
                        send_urls([n])  # refused an old URL; this run's newest batch has a fresh one, no new call
                        continue
                    rebatches += 1
                    self.counts["rebatches"] += 1
                    if rebatches > MAX_REBATCHES:
                        raise RelayError(f"{name}: storage refused URLs {rebatches} times")
                    log(f"{name}: part {n} was refused (HTTP {msg.get('status')}); asking the Hub again")
                    fresh = self._batch(oid, size)
                    if fresh.get("actions") is None:
                        outcome = "present"
                        break
                    f_mode, f_pb, f_urls, f_completion, f_verify, f_key = _parse_actions(fresh, size)
                    _check_storage_urls(self.hub, f_urls)
                    same = f_mode == mode and f_pb == part_bytes and (mode == "basic" or (key and f_key == key))
                    if not same:
                        outcome, obj = "restart", fresh
                        break
                    urls, completion, verify_href = f_urls, f_completion, f_verify or verify_href
                    gen += 1
                    # the refused part, and every other part the remote side holds an unused URL for, get fresh ones
                    send_urls(sorted({n} | {p for p in sent if p not in parts}))
                elif "part" in msg:
                    n = int(msg["part"])
                    parts[n] = msg.get("etag") or ""
                    sent_bytes[0] += int(msg.get("bytes") or 0)
                    save()
                    if len(parts) % 10 == 0 or len(parts) == nparts:
                        el = max(1e-6, time.time() - began)
                        log(f"{name}: {len(parts)}/{nparts} parts, {sent_bytes[0] / 1e9:.2f} GB sent, "
                            f"{sent_bytes[0] / el / 1e6:.0f} MB/s")
                elif "sha256" in msg:
                    sha = msg["sha256"]
                    ch.send({"done": True})
                    ch.close()
        except BaseException:
            ch.p.kill()
            raise
        if outcome != "done":
            ch.stop()
            if outcome == "restart":
                return "restart", obj
            return outcome, None
        code = ch.wait(120)
        if err or code != 0 or not sha:
            raise RelayError(f"{name}: upload failed: {scrub(json.dumps(err) if err else f'exit {code}')}{ch.tail()}")
        if sha != oid:
            raise RelayError(f"{name}: writer-1's sha256 {sha[:12]}... isn't the expected {oid[:12]}...; not completed")
        if mode == "multipart":
            if sorted(parts) != list(range(1, nparts + 1)) or not all(parts.values()):
                raise RelayError(f"{name}: {len(parts)} of {nparts} parts have an ETag; not completed")
            try:
                self.hub.complete(completion, oid, parts)
            except RelayError as e:
                # a 4xx: the saved parts belong to an upload the Hub won't complete. Forget them, so the next run starts
                # the file clean instead of resuming the same refusal forever (a network give-up keeps them)
                if "HTTP 4" in str(e):
                    st = _load_json("uploads.json", {})
                    if st.pop(oid, None) is not None:
                        _save_json("uploads.json", st)
                raise
        if verify_href:
            self.hub.verify(verify_href, oid, size)
        st = _load_json("uploads.json", {})
        if st.pop(oid, None) is not None:
            _save_json("uploads.json", st)
        el = max(1e-6, time.time() - began)
        log(f"{name}: uploaded and verified in {el / 60:.1f} min")
        return "done", None


# ---- the manifest and the plan ----

def load_manifest(path):
    try:
        with open(path) as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        raise RelayError(f"manifest: {type(e).__name__}")
    repo, rev = m.get("repo", ""), m.get("revision", "main")
    if not REPO_RE.fullmatch(repo or "") or ".." in repo:
        raise RelayError("manifest: repo must be namespace/name")
    if not REV_RE.fullmatch(rev or "") or ".." in rev:
        raise RelayError("manifest: bad revision")
    base = os.path.dirname(os.path.abspath(path))
    files, seen = [], set()
    for f in m.get("files", []):
        p = f.get("path", "")
        if not REPO_PATH_RE.fullmatch(p) or ".." in p.split("/") or p in seen:
            raise RelayError(f"manifest: bad or repeated path {p!r}")
        seen.add(p)
        if ("writer1" in f) == ("local" in f):
            raise RelayError(f"manifest: {p} needs exactly one of writer1 or local")
        e = {"path": p}
        if "writer1" in f:
            e["writer1"] = check_remote_path(f["writer1"])
            if f.get("sha256") is not None:
                if not SHA_RE.fullmatch(str(f["sha256"])):
                    raise RelayError(f"manifest: {p}: sha256 must be 64 lowercase hex")
                e["sha256"] = f["sha256"]
            if f.get("bytes") is not None:
                e["bytes"] = int(f["bytes"])
        else:
            lp = os.path.join(base, f["local"]) if not os.path.isabs(f["local"]) else f["local"]
            real = os.path.realpath(lp)
            if os.path.basename(real).startswith(".env") or real == os.path.realpath(ENV_PATH) \
                    or os.path.basename(lp).startswith(".env"):
                raise RelayError(f"manifest: {p}: a .env file is never uploaded")
            e["local"] = lp
        files.append(e)
    if not files:
        raise RelayError("manifest: no files")
    msg = str(m.get("message") or f"Upload {len(files)} file(s)")[:200]
    return {"repo": repo, "revision": rev, "message": msg, "description": str(m.get("description") or "")[:2000],
            "files": files}


def _git_blob_sha1(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _local_bytes(path):
    try:
        size = os.path.getsize(path)
    except OSError:
        raise RelayError(f"{path} can't be read")
    if size > SMALL_MAX:
        raise RelayError(f"{os.path.basename(path)} is {size} bytes; files on this Mac must be under 10 MB "
                         "(big files go from writer-1)")
    with open(path, "rb") as f:
        return f.read()


def plan(manifest, create, allow_public=False):
    hashes = _load_json("hashes.json", {})
    out = [f"repo {manifest['repo']} ({'private, or public with --allow-public' if allow_public else 'private only'}), "
           f"revision {manifest['revision']}",
           f"  repo: {'create it private if missing' if create else 'must already exist'}; "
           f"{'may already be public (--allow-public)' if allow_public else 'stop if it is public'}",
           f"  commit message: {manifest['message']}"]
    for e in manifest["files"]:
        if "writer1" in e:
            c = hashes.get(e["writer1"]) or {}
            sha = e.get("sha256") or c.get("sha256")
            size = e.get("bytes") or c.get("bytes")
            out.append(f"  {e['path']}  <- writer-1 {e['writer1']}")
            out.append(f"      bytes {size if size else 'read on writer-1 at push'}, sha256 "
                       f"{sha if sha else 'measured on writer-1 at push (nice/ionice)'}")
            out.append("      if preupload says lfs: LFS batch from this Mac, part URLs to writer-1 over ssh stdin, complete, "
                       "verify (skipped if the Hub has it); if regular (small): read with cat, a file entry")
        else:
            data = _local_bytes(e["local"])
            out.append(f"  {e['path']}  <- this Mac {e['local']}")
            out.append(f"      {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}; a file entry in the commit "
                       "(skipped if unchanged)")
    out.append("  then one commit with every changed path, and a paths-info check of each big file's sha256 and size")
    out.append("  nothing above was sent anywhere: this is the plan only")
    return "\n".join(out)


def measure(manifest, argv, root, rehash=False):
    """Size (and sha256 when unknown) of each writer-1 file, from the probe. Fills the manifest entries."""
    hashes = _load_json("hashes.json", {})
    for e in manifest["files"]:
        if "writer1" not in e:
            continue
        st = probe(argv, "stat", e["writer1"], root)
        if st.get("missing"):
            raise RelayError(f"{e['writer1']} isn't on writer-1 (or isn't a regular file under {root}/)")
        if e.get("bytes") is not None and int(e["bytes"]) != int(st["bytes"]):
            raise RelayError(f"{e['path']}: writer-1 has {st['bytes']} bytes, the manifest says {e['bytes']}")
        e["bytes"] = int(st["bytes"])
        c = hashes.get(e["writer1"]) or {}
        if not e.get("sha256"):
            if not rehash and c.get("bytes") == e["bytes"] and c.get("mtime") == st["mtime"] and c.get("sha256"):
                e["sha256"] = c["sha256"]
            else:
                log(f"{e['path']}: hashing {e['bytes'] / 1e9:.2f} GB on writer-1 (nice 19, ionice idle)")
                h = probe(argv, "sha256", e["writer1"], root, timeout=HASH_TIMEOUT_S)
                if int(h["bytes"]) != e["bytes"] or h["mtime"] != st["mtime"]:
                    raise RelayError(f"{e['path']}: the file changed on writer-1 while it was hashed")
                e["sha256"] = h["sha256"]
                hashes[e["writer1"]] = {"bytes": e["bytes"], "mtime": st["mtime"], "sha256": e["sha256"]}
                _save_json("hashes.json", hashes)
        e["mtime"] = st["mtime"]
    return manifest


def _no_token(hub, what, data):
    """Nothing that holds the token (or any token-shaped string) ever goes into the repo: a card, a file, a message."""
    raw = data if isinstance(data, bytes) else str(data).encode()
    if (hub.token and hub.token.encode() in raw) or re.search(rb"hf_[A-Za-z0-9]{30,}", raw):
        raise RelayError(f"{what} holds a Hugging Face token; nothing was sent")


def push(manifest, hub, create, remote_argv=writer1_argv, remote_root=None, allow_public=False, **relay_kw):
    root = remote_root or REMOTE_ROOT
    repo, rev = manifest["repo"], manifest["revision"]
    _no_token(hub, "the commit message", manifest["message"] + "\n" + manifest["description"])
    for e in manifest["files"]:  # the files on this Mac are checked before anything at all goes to the Hub
        if "local" in e:
            _no_token(hub, e["path"], _local_bytes(e["local"]))
    info = hub.ensure_private(repo, create, allow_public)
    if info.get("private") is not True:
        log(f"{repo}: public, and --allow-public was given; adding files to the released repo")
    measure(manifest, remote_argv(), root)
    # samples, sizes and content for preupload
    pre, local_data = [], {}
    for e in manifest["files"]:
        if "writer1" in e:
            h = probe(remote_argv(), "head", e["writer1"], root)
            pre.append({"path": e["path"], "sample": h["sample"], "size": e["bytes"]})
        else:
            data = _local_bytes(e["local"])
            _no_token(hub, e["path"], data)
            local_data[e["path"]] = data
            e["bytes"], e["sha256"] = len(data), hashlib.sha256(data).hexdigest()
            pre.append({"path": e["path"], "sample": base64.b64encode(data[:512]).decode(), "size": len(data)})
    modes = hub.preupload(repo, rev, pre)
    relay = Relay(hub, repo, rev, remote_argv=remote_argv, remote_root=root, **relay_kw)
    lines, big, summary = [], [], []
    for e in manifest["files"]:
        info = modes[e["path"]]
        if info.get("shouldIgnore"):
            log(f"{e['path']}: ignored by the repo's .gitignore; left out")
            summary.append((e["path"], "ignored"))
            continue
        # an empty file can't go through LFS storage (S3 refuses a 0-byte multipart): huggingface_hub sends it regular
        if info["uploadMode"] == "regular" or e["bytes"] == 0:
            if "writer1" in e:
                if e["bytes"] > SMALL_MAX:
                    raise RelayError(f"{e['path']}: the Hub wants it as a regular file, but it is {e['bytes']} bytes")
                c = probe(remote_argv(), "cat", e["writer1"], root)
                data = base64.b64decode(c["data"])
                if hashlib.sha256(data).hexdigest() != e["sha256"]:
                    raise RelayError(f"{e['path']}: what writer-1 sent doesn't match its sha256")
                _no_token(hub, e["path"], data)
            else:
                data = local_data[e["path"]]
            if info.get("oid") == _git_blob_sha1(data):
                log(f"{e['path']}: unchanged on the Hub; left out")
                summary.append((e["path"], "unchanged"))
                continue
            lines.append({"key": "file", "value": {"content": base64.b64encode(data).decode(), "path": e["path"],
                                                   "encoding": "base64"}})
            summary.append((e["path"], "small file"))
            continue
        # lfs
        if info.get("oid") == e["sha256"]:
            log(f"{e['path']}: unchanged on the Hub; left out")
            summary.append((e["path"], "unchanged"))
            continue
        if "writer1" in e:
            how = relay.upload(e["path"], e["writer1"], root, e["sha256"], e["bytes"])
        else:
            lp = os.path.realpath(e["local"])
            how = relay.upload(e["path"], lp, os.path.dirname(lp), e["sha256"], e["bytes"], argv=local_argv())
        lines.append({"key": "lfsFile", "value": {"path": e["path"], "algo": "sha256", "oid": e["sha256"],
                                                  "size": e["bytes"]}})
        big.append(e)
        summary.append((e["path"], "big file, " + how))
    if not lines:
        log(f"{repo}: nothing to commit; the Hub already has every file")
        return {"commit": None, "summary": summary, "counts": relay.counts}
    header = {"key": "header", "value": {"summary": manifest["message"], "description": manifest["description"]}}
    # the bytes in LFS storage are invisible until this commit: look again, right before it, that the repo is private
    # (or, with --allow-public, still the released repo it was)
    hub.ensure_private(repo, False, allow_public)
    out = hub.commit(repo, rev, [header] + lines)
    oid = str(out.get("commitOid", ""))
    if not re.fullmatch(r"[0-9a-f]{40}", oid):
        raise RelayError("commit: no commit id in the reply")
    log(f"{repo}: commit {oid} with {len(lines)} file(s)")
    if big:
        got = hub.paths_info(repo, rev, [e["path"] for e in big])
        for e in big:
            lfs = (got.get(e["path"]) or {}).get("lfs") or {}
            if lfs.get("oid") != e["sha256"] or int(lfs.get("size") or -1) != e["bytes"]:
                raise RelayError(f"{e['path']}: the Hub reports a different sha256 or size after the commit")
        log(f"{repo}: each big file's sha256 and size checked on the Hub")
    return {"commit": oid, "summary": summary, "counts": relay.counts}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Private Hugging Face uploads with the token on this Mac and the bytes "
                                             "from writer-1 (see the top of this file).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "hash", "push"):
        p = sub.add_parser(name)
        p.add_argument("manifest")
        p.add_argument("--create-private", action="store_true", help="create the repo, private, if it doesn't exist")
        if name in ("plan", "push"):
            p.add_argument("--allow-public", action="store_true",
                           help="add files to a repo that is already public (a released repo); never makes one public")
        if name == "hash":
            p.add_argument("--rehash", action="store_true", help="hash again even when the cache matches")
        if name == "push":
            p.add_argument("--yes", action="store_true", help="don't ask before starting")
            p.add_argument("--mb-per-s", type=float, default=150.0)
            p.add_argument("--threads", type=int, default=3)
            p.add_argument("--endpoint", default=ENDPOINT, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    # a crash in a helper thread prints one scrubbed line, never a traceback (whose text could hold a URL)
    threading.excepthook = lambda x: print(f"error in a thread: {x.exc_type.__name__}: {scrub(x.exc_value)[:200]}",
                                           file=sys.stderr)
    try:
        manifest = load_manifest(a.manifest)
        if a.cmd == "plan":
            print(plan(manifest, a.create_private, a.allow_public))
            return 0
        if a.cmd == "hash":
            measure(manifest, writer1_argv(), REMOTE_ROOT, rehash=a.rehash)
            for e in manifest["files"]:
                if "writer1" in e:
                    print(f"{e['path']}: {e['bytes']} bytes, sha256 {e['sha256']}")
            return 0
        print(plan(manifest, a.create_private, a.allow_public))
        if not a.yes:
            if not sys.stdin.isatty() or input("Upload this to Hugging Face? Type yes: ").strip() != "yes":
                print("stopped; nothing was uploaded")
                return 1
        hub = Hub(check_endpoint(a.endpoint), read_token())
        res = push(manifest, hub, a.create_private, allow_public=a.allow_public, mb_per_s=a.mb_per_s,
                   threads=max(1, a.threads))
        for path, what in res["summary"]:
            print(f"  {path}: {what}")
        c = res["counts"]
        print(f"done: {c['batches']} batch calls, {c['rebatches']} refused URLs, {c['restarts']} restarts, "
              f"{c['skipped_parts']} parts resumed")
        return 0
    except RelayError as e:
        print("error: " + scrub(e), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("stopped", file=sys.stderr)
        return 130
    except Exception as e:  # no traceback: its text could hold a URL
        print(f"error: {type(e).__name__}: {scrub(e)[:300]}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
