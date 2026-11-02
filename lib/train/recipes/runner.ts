/**
 * The Python runner that cloud-init starts on a training instance (docs/TRAINING.md, "Runner and recipes"). It is a
 * string constant so Vercel bundles it with no file tracing. Standard library only. Never put a dollar sign followed
 * by an opening brace, or a backtick, in the Python: this is a template literal.
 *
 * job.json keys: jobId, callbackBase, token, params, maxMinutes, recipe, deadlineEpoch (Unix seconds, stamped before the
 * launch request from the time limit, or the dollar limit when that runs out first, so never after the platform stops
 * the job), cacheDir for a recipe with usesCache, and serveKey for a glimmer-serve job (the key its demo server asks
 * for; blanked out of every log line like the token). Optional keys for tests: heartbeatSeconds, workDir, blobApiUrl,
 * multipartOverBytes, partBytes, cacheWaitSeconds, hubRetrySeconds.
 *
 * ctx.hub_upload sends a folder to the Hugging Face Hub's storage for the platform to commit (docs/TRAINING.md,
 * "Hugging Face Hub"): POST {callbackBase}/hub with the job token for a plan of presigned upload URLs, the bytes straight
 * to those with no Hub credential (the platform keeps HF_TOKEN), then POST {callbackBase}/hub again with what landed.
 */
export const RUNNER_PY = String.raw`"""Muse Muse training runner (docs/TRAINING.md, "Runner and recipes").

Started by cloud-init on the Lambda instance:

    python3 -u /opt/muse/runner.py /opt/muse/job.json

Reads job.json, sends a heartbeat every 60 s, imports recipe.py from this folder and calls run(ctx). Posts "done"
with the dict run() returns as metrics (its "summary" key becomes the summary), or "failed" with the end of the
traceback. Every request to the platform carries the job token, which is never printed or logged. A command run with
ctx.run(stall_seconds=...) that writes nothing for that long is reported stalled, and the heartbeat holds back until it
writes again, so the platform's silence rule ends a stuck job instead of it billing to its time limit.
"""

import base64
import hashlib
import http.client
import importlib.util
import json
import math
import mimetypes
import os
import random
import re
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

HTTP_TIMEOUT = 20
RETRIES = 3
RETRY_STATUSES = (429, 500, 502, 503, 504)
HEARTBEAT_SECONDS = 60
LOG_LIMIT = 4000
ERROR_LIMIT = 3072
PROGRESS_MESSAGE_LIMIT = 500
SUMMARY_LIMIT = 2000
METRIC_LIMIT = 500
MAX_METRICS = 50
BODY_LIMIT = 15000
ARTIFACT_KINDS = ("adapter", "checkpoint", "metrics", "log", "other")
# Eval callbacks: each text field is cut to this many characters, and a job sends at most EVAL_MAX of them.
EVAL_FIELD_LIMIT = 3500
EVAL_MAX = 120
EVAL_FIELDS = ("prompt", "reference", "base", "tuned")
# A "serving" callback's certSha256: the SHA-256 of the certificate's DER bytes, in lowercase hex.
CERT_SHA256_CHARS = 64
DATASET_PARTS = ("train", "eval", "dev")
# A decide mode job's scores (ctx.decide; DECIDE_* in lib/train/logic.ts, which a test keeps equal): the parts, the
# items one callback carries, the items one job sends, and a body size under the platform's 64 KB. JSON has no
# -Infinity, so a letter with no probability is sent as DECIDE_LOGPROB_FLOOR; numbers are rounded to DECIDE_DIGITS.
DECIDE_PARTS = ("dev", "test")
DECIDE_CALLBACK_ITEMS = 100
DECIDE_ITEMS_MAX = 8000
DECIDE_BODY_LIMIT = 60000
DECIDE_LOGPROB_FLOOR = -10000.0
DECIDE_DIGITS = 6
# Stops a nextPage loop that never ends: 1,000 pages of 100 items is far more than a dataset holds.
DATASET_MAX_PAGES = 1000
# How long the runner waits for the cache filesystem's mount to show up before going on without it.
CACHE_WAIT_SECONDS = 60
# ctx.run reads a command's output in chunks this big, and keeps at most this much of a line with no newline yet.
READ_BYTES = 65536
# How long ctx.run waits, after the command exits, for the rest of its event pipe.
EVENT_DRAIN_SECONDS = 10

# Vercel Blob, as @vercel/blob's client put() talks to it (node_modules/@vercel/blob/dist).
BLOB_API_URL = "https://vercel.com/api/blob"
BLOB_API_VERSION = "13"
BLOB_RETRY_STATUSES = (500, 502, 503, 504)
MULTIPART_OVER_BYTES = 100 * 1024 * 1024
PART_BYTES = 8 * 1024 * 1024
# The media types the platform's upload route takes (TRAIN_UPLOAD_TYPES in lib/train/types.ts). Anything else goes up
# as application/octet-stream, so an unusual extension doesn't get the upload refused.
UPLOAD_TYPES = (
    "application/octet-stream",
    "application/json",
    "application/x-ndjson",
    "application/gzip",
    "application/zip",
    "application/x-tar",
    "application/yaml",
    "application/x-yaml",
    "text/plain",
    "text/csv",
    "text/markdown",
    "text/yaml",
    "text/x-python",
    "image/png",
    "image/jpeg",
)

# The Hugging Face Hub upload (ctx.hub_upload). The numbers and names are the platform's (HUB_* in lib/train/types.ts),
# and a test keeps them equal. The only files sent to the Hub, each in the folder's root: PEFT's weights and config,
# and what the tokenizer and processor save. So checkpoint-* folders, optimizer.pt, scheduler.pt, rng_state*.pth,
# training_args.bin, README.md, a full model's config.json or weights, hidden files and every pickle never go.
HUB_NAMES = (
    "adapter_model.safetensors",
    "adapter_config.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
    "vocab.json",
    "merges.txt",
    "chat_template.jinja",
    "chat_template.json",
    "preprocessor_config.json",
    "processor_config.json",
    "video_preprocessor_config.json",
)
# The configs the platform reads before it publishes them, so they go inline first (a checked one that isn't inline is
# left out of the publish).
HUB_CHECKED = (
    "adapter_config.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
    "chat_template.json",
    "preprocessor_config.json",
    "processor_config.json",
    "video_preprocessor_config.json",
)
# The plan names every file with its size, sha256 and first 512 bytes (the Hub's preupload reads them), at most
# HUB_FILES_MAX of them (a Hub commit gives up past about 100) and each at most HUB_FILE_MAX_BYTES.
HUB_SAMPLE_BYTES = 512
HUB_FILES_MAX = 100
HUB_FILE_MAX_BYTES = 10 * 1024 ** 3
# The small ones also go inline, for the platform to commit as they are (the Hub keeps configs and the chat template in
# git, not in LFS): each at most HUB_SMALL_BYTES and of a type the Hub doesn't keep in LFS, up to HUB_SMALL_TOTAL_BYTES
# in all.
HUB_SMALL_BYTES = 1024 * 1024
HUB_SMALL_TOTAL_BYTES = 3 * 1024 * 1024
# The allowed suffixes that the Hub's default .gitattributes sends to LFS, so such a file is never inline.
HUB_LFS_SUFFIXES = (".safetensors", ".model", ".gguf")
# A glimmer-quantize job sends its GGUF folder instead (HUB_GGUF_* in lib/train/types.ts, hubNameProblem in
# lib/train/hub-cards.ts): its builds' files, each named for its level and at most HUB_GGUF_FILE_MAX_BYTES, and the
# small files beside them, which go inline for the platform to check and commit.
HUB_GGUF_RECIPE = "glimmer-quantize"
HUB_GGUF_RE = re.compile(r"^muse-glimmer-30b-[a-z0-9]+(?:-[a-z0-9]+)*-(?:IQ1_S|Q3_K_M|Q4_K_M|Q6_K)\.gguf$")
HUB_GGUF_SMALL = (
    "system",
    "params",
    "tuned.jinja",
)
HUB_GGUF_FILE_MAX_BYTES = 32 * 1024 ** 3
# Each request to the Hub's storage gets this many tries on a network error, a 429 or a 5xx, waiting HUB_RETRY_SECONDS
# and then twice that between them.
HUB_TRIES = 3
HUB_RETRY_SECONDS = 2
# The plan waits on the platform's own calls to the Hub (the repo, preupload, the LFS batch), so it gets longer.
HUB_PLAN_TIMEOUT = 60
# Any one socket read or write to the Hub's storage that waits longer than this fails the try.
HUB_TIMEOUT = 60
# A file is read and sent this much at a time, so a part or a whole file is never in memory at once.
HUB_BLOCK_BYTES = 1024 * 1024
# An upload starts nothing new this close to ctx.deadline, and a transfer still going this close to it is cut off, so the
# job still reports back (and is judged) before its time limit.
HUB_STOP_SECONDS = 120
HUB_ABORT_SECONDS = 60
# While they live, presigned URLs are credentials: each one (and its query, which holds the signature) is blanked out of
# every log line as this from the moment the plan arrives. So is any upload header value at least HUB_SECRET_MIN long.
HUB_URL_LABEL = "[presigned URL]"
HUB_HEADER_LABEL = "[upload header]"
HUB_SECRET_MIN = 16
# Headers the runner sets itself on a PUT, whatever the plan's header says.
HUB_OWN_HEADERS = ("content-length", "host", "transfer-encoding")
# The Git LFS media type the Hub's multipart completion takes.
LFS_JSON = "application/vnd.git-lfs+json"

_print_lock = threading.Lock()


def say(text):
    """Prints one line (or block) to the job log, which cloud-init sends to /var/log/muse-job.log."""
    with _print_lock:
        sys.stdout.write("[muse] " + str(text) + "\n")
        sys.stdout.flush()


def tail_bytes(text, limit):
    """The end of text, at most limit bytes of UTF-8."""
    data = str(text).encode("utf-8", "replace")
    if len(data) <= limit:
        return str(text)
    return data[-limit:].decode("utf-8", "ignore")


def error_tail(text, kind):
    """The last 3 KB of a traceback, starting with the exception's type when a long message pushed it out."""
    tail = tail_bytes(text, ERROR_LIMIT)
    if kind in tail:
        return tail
    prefix = kind + ": ..."
    return prefix + tail_bytes(text, ERROR_LIMIT - len(prefix.encode("utf-8")))


def safe_url(url):
    """The URL without its query, for log lines."""
    return url.split("?", 1)[0]


class HttpFailure(Exception):
    """A request that failed on the network after its retries. Never carries a header."""


class PlatformError(RuntimeError):
    """The platform answered a GET with an error status, such as 404 for a job with no dataset."""

    def __init__(self, status, message):
        RuntimeError.__init__(self, message)
        self.status = status


class BlobRetryRefused(RuntimeError):
    """Blob refused a retried write of a grant's pathname.

    The first try may have stored the file before its answer was lost, and each grant names one blob that can't be
    written twice, so the file needs a fresh grant.
    """


def upload_type(name):
    """The media type to declare for a file: what mimetypes names, when the platform takes it, else octet-stream."""
    guessed, encoding = mimetypes.guess_type(name)
    if encoding or guessed not in UPLOAD_TYPES:
        return "application/octet-stream"
    return guessed


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuses every redirect, which then comes back as its 3xx status.

    urllib would follow one with the same Authorization header, so the job token or a Blob token could reach
    another host. Every URL the runner calls is the exact one it was given.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(url, method="POST", data=None, headers=None, retry_statuses=RETRY_STATUSES, open_body=None, timeout=HTTP_TIMEOUT):
    """Sends one HTTP request, retrying network errors and retry_statuses 3 times with backoff (2, 4, 8 s).

    headers is a dict or a function of the attempt number. open_body, when given, opens a fresh body for each attempt
    (a file), and data is ignored. Returns (status, body bytes) for any answer it doesn't retry.
    """
    attempt = 0
    while True:
        body = open_body() if open_body else data
        head = headers(attempt) if callable(headers) else dict(headers or {})
        req = urllib.request.Request(url, data=body, method=method, headers=head)
        try:
            with OPENER.open(req, timeout=timeout) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            status = e.code
            payload = e.read()
            if status not in retry_statuses or attempt >= RETRIES:
                return status, payload
            reason = "HTTP " + str(status)
        except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
            if attempt >= RETRIES:
                raise HttpFailure("network error on " + safe_url(url) + ": " + str(getattr(e, "reason", e)))
            reason = "a network error"
        finally:
            if open_body and hasattr(body, "close"):
                body.close()
        attempt += 1
        wait = 2 ** attempt
        say("retrying " + safe_url(url) + " after " + reason + " in " + str(wait) + " s")
        time.sleep(wait)


class Platform:
    """Talks to the platform's job routes with the job token. The token lives only here and is never printed."""

    def __init__(self, base, token):
        self.base = str(base).rstrip("/")
        self._token = str(token)
        self._hidden = []

    def hide(self, secret, label):
        """Blanks secret out of everything redact sees from now on, as label (a glimmer-serve job's serve key)."""
        if isinstance(secret, str) and secret:
            self._hidden.append((secret, label))

    def redact(self, text):
        """text with the job token (and any secret hidden) blanked out, in case a recipe or a command echoed it."""
        text = str(text)
        if self._token:
            text = text.replace(self._token, "[job token]")
        for secret, label in self._hidden:
            text = text.replace(secret, label)
        return text

    def post(self, path, body, retry_statuses=RETRY_STATUSES, timeout=HTTP_TIMEOUT):
        """POSTs JSON to callbackBase + path. Returns (status, body bytes); raises HttpFailure on the network."""
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        headers = {"Authorization": "Bearer " + self._token, "Content-Type": "application/json"}
        return request(self.base + path, data=data, headers=headers, retry_statuses=retry_statuses, timeout=timeout)

    def get(self, path):
        """GETs callbackBase + path, with the same retries and no redirects. Returns (status, body bytes)."""
        headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json"}
        return request(self.base + path, method="GET", headers=headers)

    def event(self, body):
        """Posts one callback to /events. True when the platform took it. Never raises."""
        kind = str(body.get("type", "event"))
        try:
            status, _ = self.post("/events", body)
        except HttpFailure as e:
            say("could not post " + kind + ": " + str(e))
            return False
        except Exception as e:
            say("could not post " + kind + ": " + type(e).__name__)
            return False
        if status >= 300:
            say("the platform answered HTTP " + str(status) + " to " + kind)
            return False
        return True


def span(seconds):
    """seconds as "N s" or, from 2 minutes, "N minutes"."""
    seconds = max(0, int(seconds))
    return str(seconds // 60) + " minutes" if seconds >= 120 else str(seconds) + " s"


class Activity:
    """When the watched command (ctx.run with stall_seconds) last wrote anything, so the heartbeat can tell a stalled
    command from a busy one. With no command watched, nothing is stalled."""

    def __init__(self):
        self._lock = threading.Lock()
        self._watch = None

    def watch(self, cmd, seconds):
        with self._lock:
            self._watch = {"cmd": cmd, "seconds": float(seconds), "last": time.monotonic()}

    def touch(self):
        now = time.monotonic()
        with self._lock:
            if self._watch is not None:
                self._watch["last"] = now

    def unwatch(self):
        with self._lock:
            self._watch = None

    def stalled(self):
        """(command, quiet seconds) while the watched command has written nothing for its stall_seconds, else None."""
        with self._lock:
            watch = self._watch
            if watch is None:
                return None
            quiet = time.monotonic() - watch["last"]
            return (watch["cmd"], quiet) if quiet >= watch["seconds"] else None


class Heartbeat(threading.Thread):
    """Posts a heartbeat every few seconds until stopped, so the platform knows the instance is alive.

    While a watched command is stalled it posts one "Stalled" log and then nothing, so the platform's silence rule ends
    the job. Heartbeats come back, the first one with a note, once the command writes again or ends.
    """

    def __init__(self, platform, seconds, activity=None):
        threading.Thread.__init__(self, name="muse-heartbeat", daemon=True)
        self.platform = platform
        self.seconds = seconds
        self.activity = activity
        self.stall_reported = False
        self.stopped = threading.Event()

    def run(self):
        while not self.stopped.wait(self.seconds):
            self.beat()

    def beat(self):
        stall = self.activity.stalled() if self.activity else None
        if stall is None:
            if self.stall_reported:
                self.stall_reported = False
                self.platform.event({"type": "heartbeat", "message": "No longer stalled"})
            else:
                self.platform.event({"type": "heartbeat"})
            return
        if self.stall_reported:
            return
        self.stall_reported = True
        cmd, quiet = stall
        text = (
            "Stalled: no output for " + span(quiet) + " from $ " + self.platform.redact(cmd)[:300]
            + ". Heartbeats pause until it writes again, so the platform's silence rule ends the job if it stays quiet."
        )
        say(text)
        self.platform.event({"type": "log", "text": text})

    def stop(self):
        self.stopped.set()
        self.join(timeout=5)


def blob_headers(client_token, content_type, attempt=0):
    """The headers @vercel/blob's client put() sends: requestApi() plus createPutHeaders() with contentType."""
    parts = client_token.split("_")
    store_id = parts[3] if len(parts) > 3 else ""
    return {
        "x-api-blob-request-id": store_id + ":" + str(int(time.time() * 1000)) + ":" + ("%x" % random.getrandbits(52)),
        "x-vercel-blob-store-id": store_id,
        "x-api-blob-request-attempt": str(attempt),
        "x-api-version": BLOB_API_VERSION,
        "authorization": "Bearer " + client_token,
        "x-vercel-blob-access": "public",
        "x-content-type": content_type,
    }


def blob_answer(status, payload, what):
    """The JSON of a Blob API answer, or an error naming Blob's code and message."""
    try:
        data = json.loads(payload.decode("utf-8")) if payload else {}
    except ValueError:
        data = {}
    if 200 <= status < 300:
        return data
    error = data.get("error") if isinstance(data, dict) else None
    code = error.get("code", "unknown_error") if isinstance(error, dict) else "unknown_error"
    message = error.get("message", "") if isinstance(error, dict) else ""
    raise RuntimeError("Vercel Blob refused " + what + " (HTTP " + str(status) + ", " + str(code) + "): " + str(message))


def blob_put(path, pathname, client_token, content_type, size, settings):
    """Uploads a file the way @vercel/blob's put() does with a client token. Multipart over 100 MB. Returns the URL."""
    api = settings["blobApiUrl"].rstrip("/")
    query = urllib.parse.urlencode({"pathname": pathname})
    last = {"attempt": 0}

    def head(extra):
        def make(attempt):
            last["attempt"] = attempt
            h = blob_headers(client_token, content_type, attempt)
            h.update(extra)
            return h

        return make

    def written(status, payload, what):
        """blob_answer for the request that writes the pathname. Refused on a retry, it may already exist."""
        try:
            return blob_answer(status, payload, what)
        except RuntimeError as e:
            if last["attempt"] > 0 and 400 <= status < 500:
                raise BlobRetryRefused(str(e))
            raise

    if size <= settings["multipartOverBytes"]:
        status, payload = request(
            api + "/?" + query,
            method="PUT",
            headers=head({"Content-Type": "application/octet-stream", "Content-Length": str(size)}),
            open_body=lambda: open(path, "rb"),
            retry_statuses=BLOB_RETRY_STATUSES,
        )
        return written(status, payload, "the upload")["url"]

    mpu = api + "/mpu?" + query
    status, payload = request(mpu, headers=head({"x-mpu-action": "create"}), retry_statuses=BLOB_RETRY_STATUSES)
    created = blob_answer(status, payload, "the multipart upload")
    key = urllib.parse.quote(created["key"], safe="-_.!~*'()")
    upload_id = created["uploadId"]
    parts = []
    with open(path, "rb") as f:
        number = 1
        while True:
            chunk = f.read(settings["partBytes"])
            if not chunk:
                break
            status, payload = request(
                mpu,
                data=chunk,
                headers=head(
                    {
                        "Content-Type": "application/octet-stream",
                        "x-mpu-action": "upload",
                        "x-mpu-key": key,
                        "x-mpu-upload-id": upload_id,
                        "x-mpu-part-number": str(number),
                    }
                ),
                retry_statuses=BLOB_RETRY_STATUSES,
            )
            parts.append({"partNumber": number, "etag": blob_answer(status, payload, "part " + str(number))["etag"]})
            number += 1
    status, payload = request(
        mpu,
        data=json.dumps(parts).encode("utf-8"),
        headers=head(
            {
                "content-type": "application/json",
                "x-mpu-action": "complete",
                "x-mpu-upload-id": upload_id,
                "x-mpu-key": key,
            }
        ),
        retry_statuses=BLOB_RETRY_STATUSES,
    )
    return written(status, payload, "completing the multipart upload")["url"]


def cut_eval_fields(body):
    """Cuts an eval body's text fields to EVAL_FIELD_LIMIT characters, then shortens the longest until it fits."""
    for key in EVAL_FIELDS:
        body[key] = body[key][:EVAL_FIELD_LIMIT]
    while len(json.dumps(body, ensure_ascii=False).encode("utf-8")) > BODY_LIMIT:
        key = max(EVAL_FIELDS, key=lambda k: len(body[k].encode("utf-8")))
        body[key] = body[key][: max(0, int(len(body[key]) * 0.9) - 1)]
    return body


def decide_number(value, floor=True):
    """A log-probability or a letter mass as a decide callback carries it: a finite float rounded to DECIDE_DIGITS, at
    least DECIDE_LOGPROB_FLOOR (so -Infinity is the floor). Raises ValueError for anything else (NaN, +Infinity, text)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("a decide score must be a number, not " + type(value).__name__)
    number = float(value)
    if math.isnan(number) or number == math.inf:
        raise ValueError("a decide score must be a log-probability, not " + str(number))
    if floor:
        number = max(number, DECIDE_LOGPROB_FLOOR)
    return round(number, DECIDE_DIGITS)


def decide_item(item):
    """One scored item as a decide callback carries it: {index, base, tuned, baseMass, tunedMass}, tuned and tunedMass
    None when the tuned model didn't score it. Raises ValueError for an item that isn't one."""
    if not isinstance(item, dict):
        raise ValueError("a decide item must be a dict")
    index = item.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < DECIDE_ITEMS_MAX:
        raise ValueError("a decide item needs its index in the part, not " + repr(index)[:40])
    base = item.get("base")
    if not isinstance(base, (list, tuple)) or not base:
        raise ValueError("decide item " + str(index) + " needs the base model's log-probabilities")
    out = {"index": index, "base": [decide_number(v) for v in base], "tuned": None, "baseMass": decide_number(item.get("baseMass"), False), "tunedMass": None}
    tuned = item.get("tuned")
    if tuned is not None:
        if not isinstance(tuned, (list, tuple)) or len(tuned) != len(base):
            raise ValueError("decide item " + str(index) + "'s tuned log-probabilities must be one per letter, as its base ones are")
        out["tuned"] = [decide_number(v) for v in tuned]
        out["tunedMass"] = decide_number(item.get("tunedMass"), False)
    return out


def decide_bodies(part, items):
    """The callbacks for these items: one, or halves of it until each body is under DECIDE_BODY_LIMIT."""
    body = {"type": "decide", "part": part, "items": items}
    if len(items) <= 1 or len(json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")) <= DECIDE_BODY_LIMIT:
        return [body]
    half = len(items) // 2
    return decide_bodies(part, items[:half]) + decide_bodies(part, items[half:])


def deadline_of(job, now):
    """job.json's deadlineEpoch, else now plus maxMinutes, else None."""
    value = job.get("deadlineEpoch")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return float(value)
    minutes = job.get("maxMinutes")
    if isinstance(minutes, (int, float)) and not isinstance(minutes, bool) and math.isfinite(minutes) and minutes > 0:
        return now + float(minutes) * 60
    return None


def megabytes(size):
    return str(round(size / 1e6, 1)) + " MB"


def inside(path, roots):
    """True when path, its links resolved, is in one of the folders roots."""
    real = os.path.realpath(path)
    return any(real.startswith(os.path.join(os.path.realpath(root), "")) for root in roots)


def hub_name_ok(name, recipe=None):
    """True for a file name a Hub upload sends: for a glimmer-quantize job one of its builds (HUB_GGUF_RE) or the small
    files beside them (HUB_GGUF_SMALL), for every other job one of HUB_NAMES, exactly."""
    if recipe == HUB_GGUF_RECIPE:
        return name in HUB_GGUF_SMALL or bool(HUB_GGUF_RE.match(name))
    return name in HUB_NAMES


def hub_max_bytes(name, recipe=None):
    """The largest file one plan takes: HUB_GGUF_FILE_MAX_BYTES for a glimmer-quantize job's build, else
    HUB_FILE_MAX_BYTES."""
    return HUB_GGUF_FILE_MAX_BYTES if recipe == HUB_GGUF_RECIPE and name.endswith(".gguf") else HUB_FILE_MAX_BYTES


def hub_files(folder, roots=(), recipe=None):
    """The files in folder's root a Hub upload sends (hub_name_ok for the job's recipe), as (name, local path, size),
    sorted by name. No folder is looked into. A link is followed only to a file in folder or in one of roots
    (glimmer-publish stages a folder of links into the model cache), so a stray one can't send job.json."""
    out = []
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if hub_name_ok(name, recipe) and os.path.isfile(path) and inside(path, (folder,) + tuple(roots)):
            out.append((name, path, os.path.getsize(path)))
    return out


def file_digest(path):
    """(sha256 in hex, the first HUB_SAMPLE_BYTES) of a file, read HUB_BLOCK_BYTES at a time."""
    digest = hashlib.sha256()
    sample = None
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(HUB_BLOCK_BYTES), b""):
            if sample is None:
                sample = block[:HUB_SAMPLE_BYTES]
            digest.update(block)
    return digest.hexdigest(), sample or b""


def small_files(files):
    """{name: base64 content} of the files a plan carries inline: the configs the platform checks (HUB_CHECKED) first,
    then the rest, smallest first, each at most HUB_SMALL_BYTES and not of a type the Hub keeps in LFS, while the total
    stays within HUB_SMALL_TOTAL_BYTES. They are what the Hub's preupload marks "regular" (configs, the chat template),
    which the platform commits itself; the platform plans an upload for every other file, which the GPU then sends."""
    out, total = {}, 0
    for name, path, size in sorted(files, key=lambda f: (f[0] not in HUB_CHECKED, f[2], f[0])):
        if size > HUB_SMALL_BYTES or name.lower().endswith(HUB_LFS_SUFFIXES) or total + size > HUB_SMALL_TOTAL_BYTES:
            continue
        with open(path, "rb") as f:
            data = f.read(HUB_SMALL_BYTES + 1)
        if len(data) > HUB_SMALL_BYTES or total + len(data) > HUB_SMALL_TOTAL_BYTES:
            continue
        out[name] = base64.b64encode(data).decode("ascii")
        total += len(data)
    return out


def web_url(url):
    """True for an http or https URL with a host, the only kind of upload URL the runner calls."""
    if not isinstance(url, str):
        return False
    parts = urllib.parse.urlsplit(url)
    return parts.scheme in ("http", "https") and bool(parts.hostname)


def upload_problem(item, entry):
    """Why the runner can't act on one upload of the platform's plan (entry is the file's manifest entry, None when the
    plan names a file the folder doesn't have), or None."""
    if not isinstance(item, dict) or entry is None:
        return "the plan names a file that isn't in the folder"
    if str(item.get("oid") or "").lower() != entry["sha256"] or item.get("size") != entry["size"]:
        return "the plan's object doesn't match the file"
    transfer = item.get("transfer")
    if transfer == "none":
        return None
    if transfer == "basic":
        return None if web_url(item.get("href")) else "the plan has no upload URL for it"
    if transfer != "multipart":
        return "the plan's transfer " + json.dumps(str(transfer))[:40] + " isn't basic, multipart or none"
    chunk = item.get("chunkSize")
    if isinstance(chunk, bool) or not isinstance(chunk, int) or chunk <= 0:
        return "the plan has no chunk size for it"
    if not web_url(item.get("completionUrl")):
        return "the plan has no completion URL for it"
    parts = item.get("parts") if isinstance(item.get("parts"), list) else []
    numbers = sorted(p["partNumber"] for p in parts if isinstance(p, dict) and type(p.get("partNumber")) is int and web_url(p.get("url")))
    if len(numbers) != len(parts) or numbers != list(range(1, math.ceil(entry["size"] / chunk) + 1)):
        return "the plan's parts don't cover the file at its chunk size"
    return None


class TransferFailed(RuntimeError):
    """A file's bytes didn't reach the Hub's storage. Its message says how, never with a URL in it."""


class UrlRefused(RuntimeError):
    """A presigned URL answered 403: it expired, so its file needs a fresh plan."""


class FileRange:
    """length bytes of the file at path from offset, as a body http.client reads HUB_BLOCK_BYTES at a time, so a part of
    a multipart upload is read from disk on its own and never held in memory whole."""

    def __init__(self, path, offset, length):
        self._file = open(path, "rb")
        self._file.seek(offset)
        self._left = length

    def read(self, size=-1):
        if self._left <= 0:
            return b""
        if size is None or size < 0 or size > self._left:
            size = self._left
        data = self._file.read(size)
        self._left -= len(data)
        return data

    def close(self):
        self._file.close()


def http_once(method, url, headers, open_body=None, timeout=HUB_TIMEOUT, stop_at=None):
    """One request with http.client: no redirect followed, no proxy, no credential and only the headers given (urllib
    would add a Content-Type nobody signed). A body (bytes, or a file from open_body) goes out HUB_BLOCK_BYTES at a
    time. When the server answers and hangs up before the whole body is in (S3 refusing an expired URL does), its answer
    still counts. A file body still going at stop_at (a time.time()) is cut off with TimeoutError, so one slow transfer
    can't run past the job's deadline. Returns (status, response headers with lowercase names, body bytes); raises on
    the network."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "https":
        conn = http.client.HTTPSConnection(parts.hostname, parts.port, timeout=timeout, context=ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=timeout)
    target = (parts.path or "/") + ("?" + parts.query if parts.query else "")
    body = open_body() if open_body else None
    try:
        conn.putrequest(method, target)
        for key, value in headers.items():
            conn.putheader(key, value)
        if isinstance(body, bytes) and not any(k.lower() == "content-length" for k in headers):
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        cut = None
        try:
            if isinstance(body, bytes):
                conn.send(body)
            elif body is not None:
                for block in iter(lambda: body.read(HUB_BLOCK_BYTES), b""):
                    if stop_at is not None and time.time() >= stop_at:
                        raise TimeoutError("cut off, the job's time limit is near")
                    conn.send(block)
        except (BrokenPipeError, ConnectionResetError) as e:
            cut = e
        try:
            res = conn.getresponse()
            payload = res.read()
        except (OSError, http.client.HTTPException):
            if cut is not None:
                raise cut
            raise
        if cut is not None and res.status < 300:
            raise cut
        return res.status, {k.lower(): v for k, v in res.getheaders()}, payload
    finally:
        if body is not None and hasattr(body, "close"):
            body.close()
        conn.close()


class Context:
    """What recipe.run(ctx) gets: params, cache_dir, work_dir, deadline, log, progress, run, upload, hub_upload,
    get_json, dataset, dataset_title, dataset_kind, dataset_decide, eval, decide, checks, and for a glimmer-serve job
    serve_key and serving."""

    def __init__(self, job, platform, work_dir, settings, cache_dir=None, activity=None):
        self.params = dict(job.get("params") or {})
        self.job_id = job.get("jobId")
        self.recipe = job.get("recipe")
        self.max_minutes = job.get("maxMinutes")
        # Unix time the job must be done by: the platform terminates the instance at its time or dollar limit, which is
        # never before this. Without deadlineEpoch in job.json, maxMinutes from now.
        self.deadline = deadline_of(job, time.time())
        self.work_dir = work_dir
        # The mounted cache filesystem for a recipe with usesCache, or None. It outlives the instance.
        self.cache_dir = cache_dir
        # The dataset's title, from the pages dataset() reads: None before that, or when the platform sends none.
        self.dataset_title = None
        # From the same pages: "decision" for a decision dataset (a chat dataset's pages name no kind), and its
        # decide.json (docs/DECISION_MODELS.md, "Files a decision model produces"), or None.
        self.dataset_kind = None
        self.dataset_decide = None
        # A glimmer-serve job's serve key (job.json's serveKey): its demo server answers only requests that carry it.
        # None for any other job. Never log it; the runner blanks it out of log lines as it does the job token.
        serve_key = job.get("serveKey")
        self.serve_key = serve_key if isinstance(serve_key, str) and serve_key else None
        # The general checks job.json carries for a glimmer-lora chat job when the platform's TUNE_GENERAL_CHECKS is on
        # (lib/train/general-checks.ts): a list of {set, index, prompt, reference}, or None.
        checks = job.get("checks")
        self.checks = checks if isinstance(checks, list) and checks else None
        self._platform = platform
        self._settings = settings
        self._activity = activity
        self._evals_sent = 0
        self._decide_sent = 0

    def log(self, text):
        """Writes text to the job log and posts it as a log event (the last 4 KB)."""
        text = self._platform.redact(text)
        say(text)
        self._platform.event({"type": "log", "text": tail_bytes(text, LOG_LIMIT)})

    def progress(self, step=None, total_steps=None, loss=None, message=None):
        """Posts a progress event. Every field is optional."""
        body = {"type": "progress"}
        if step is not None:
            body["step"] = int(step)
        if total_steps is not None:
            body["totalSteps"] = int(total_steps)
        if loss is not None:
            value = float(loss)
            if math.isfinite(value):
                body["loss"] = value
        if message:
            body["message"] = self._platform.redact(message)[:PROGRESS_MESSAGE_LIMIT]
        say("progress " + json.dumps(body, ensure_ascii=False))
        self._platform.event(body)

    def run(self, cmd, timeout=None, check=False, env=None, on_line=None, on_event=None, stall_seconds=None):
        """Runs a shell command in work_dir, streams its output to the job log and posts its last lines as a log event.

        env adds variables to the runner's own. on_line, when given, is called with each output line as it arrives (an
        error in it is logged, never raised). on_event, when given, is called the same way with each line the command
        writes to a pipe of its own, whose file descriptor is in its MUSE_EVENT_FD variable: a channel that a progress
        bar on stderr can't write into. stall_seconds, when given, watches the command: once it has written nothing on
        either for that long, the heartbeat reports it stalled and holds back (see Heartbeat). Returns a
        subprocess.CompletedProcess whose stdout is the last lines and whose timed_out says the timeout killed it.
        With check=True a non-zero exit raises.
        """
        say("$ " + self._platform.redact(cmd))
        lines = deque(maxlen=80)
        child_env = None
        if env or on_event:
            child_env = dict(os.environ)
            child_env.update({str(k): str(v) for k, v in (env or {}).items()})
        events_in = events_out = None
        if on_event:
            events_in, events_out = os.pipe()
            child_env["MUSE_EVENT_FD"] = str(events_out)
        try:
            proc = subprocess.Popen(
                cmd,
                shell=True,
                cwd=self.work_dir,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                pass_fds=(events_out,) if events_out is not None else (),
            )
        except BaseException:
            if events_in is not None:
                os.close(events_in)
            raise
        finally:
            if events_out is not None:
                os.close(events_out)
        watched = bool(stall_seconds) and self._activity is not None
        if watched:
            self._activity.watch(cmd, stall_seconds)
        timed_out = []
        timer = None
        if timeout:

            def kill():
                timed_out.append(True)
                try:
                    os.killpg(proc.pid, 9)
                except OSError:
                    pass

            timer = threading.Timer(timeout, kill)
            timer.daemon = True
            timer.start()

        def output_line(raw):
            line = self._platform.redact(raw.decode("utf-8", "replace").rstrip("\r\n").rsplit("\r", 1)[-1])
            with _print_lock:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            lines.append(line)
            if on_line:
                try:
                    on_line(line)
                except Exception as e:
                    say("on_line failed: " + type(e).__name__ + ": " + self._platform.redact(e))

        def event_line(raw):
            line = self._platform.redact(raw.decode("utf-8", "replace").strip())
            if not line:
                return
            try:
                on_event(line)
            except Exception as e:
                say("on_event failed: " + type(e).__name__ + ": " + self._platform.redact(e))

        reader = None
        if events_in is not None:
            reader = threading.Thread(target=self._read_events, args=(events_in, event_line), name="muse-events", daemon=True)
            reader.start()
        try:
            self._pump(proc.stdout.fileno(), output_line)
            code = proc.wait()
            if reader is not None:
                reader.join(EVENT_DRAIN_SECONDS)
        finally:
            if timer:
                timer.cancel()
            if watched:
                self._activity.unwatch()
            proc.stdout.close()
        tail = "\n".join(lines)
        footer = ("timed out after " + str(timeout) + " s") if timed_out else ("exit " + str(code))
        header = "$ " + self._platform.redact(cmd)[:300] + "\n"
        room = max(LOG_LIMIT - len(header.encode("utf-8")), 200)
        self._platform.event({"type": "log", "text": header + tail_bytes(tail + "\n" + footer, room)})
        if check and code != 0:
            shown = self._platform.redact(cmd)[:300]
            raise RuntimeError("Command failed (" + footer + "): " + shown + "\n" + "\n".join(list(lines)[-20:]))
        done = subprocess.CompletedProcess(cmd, code, stdout=tail)
        done.timed_out = bool(timed_out)
        return done

    def _pump(self, fd, deliver):
        """Reads fd to its end in chunks and calls deliver with each line's bytes, without the newline.

        Any byte counts as output for the stall watch, a progress bar's carriage-return redraw too.
        """
        pending = b""
        while True:
            try:
                chunk = os.read(fd, READ_BYTES)
            except OSError:
                break
            if not chunk:
                break
            if self._activity is not None:
                self._activity.touch()
            pending += chunk
            parts = pending.split(b"\n")
            pending = parts.pop()
            for raw in parts:
                deliver(raw)
            if len(pending) > READ_BYTES:
                # A bar redrawn with carriage returns and no newline: only the text after the last one is ever shown.
                cut = pending.rfind(b"\r")
                pending = (pending[cut:] if cut >= 0 else pending)[-READ_BYTES:]
        if pending:
            deliver(pending)

    def _read_events(self, fd, deliver):
        """The event pipe's reader thread: delivers its lines, then closes it."""
        try:
            self._pump(fd, deliver)
        finally:
            os.close(fd)

    def get_json(self, path_and_query):
        """GETs callbackBase + path_and_query with the job token and returns the parsed JSON.

        Same retries as a callback, and a redirect is refused. Any other status of 300 or more raises PlatformError.
        """
        path = str(path_and_query)
        if not path.startswith("/"):
            path = "/" + path
        status, payload = self._platform.get(path)
        if status >= 300:
            raise PlatformError(status, "The platform answered HTTP " + str(status) + " to GET " + safe_url(path))
        try:
            return json.loads(payload.decode("utf-8")) if payload else None
        except ValueError:
            raise RuntimeError("The platform answered GET " + safe_url(path) + " with a body that isn't JSON")

    def dataset(self, part):
        """Every item of the job's dataset part ("train" or "eval", or "dev" for a decision dataset), paging GET
        /dataset until nextPage is null. Each page's title is kept as dataset_title, and a decision dataset's kind and
        decide.json as dataset_kind and dataset_decide."""
        if part not in DATASET_PARTS:
            raise ValueError("dataset part must be train, eval or dev, not " + repr(part))
        items = []
        page = 0
        for _ in range(DATASET_MAX_PAGES):
            body = self.get_json("/dataset?" + urllib.parse.urlencode({"part": part, "page": page}))
            got = body.get("items") if isinstance(body, dict) else None
            if not isinstance(got, list):
                raise RuntimeError("Dataset page " + str(page) + " of " + part + " has no items list")
            items.extend(got)
            if isinstance(body.get("title"), str):
                self.dataset_title = body["title"]
            if isinstance(body.get("kind"), str):
                self.dataset_kind = body["kind"]
            if isinstance(body.get("decideJson"), dict):
                self.dataset_decide = body["decideJson"]
            following = body.get("nextPage")
            if following is None:
                say("dataset " + part + ": " + str(len(items)) + " items in " + str(page + 1) + " pages")
                return items
            if isinstance(following, bool) or not isinstance(following, int) or following <= page:
                raise RuntimeError("Dataset page " + str(page) + " of " + part + " points to page " + repr(following))
            page = following
        raise RuntimeError("The " + part + " dataset has more than " + str(DATASET_MAX_PAGES) + " pages")

    def eval(self, index, prompt, reference, base, tuned):
        """Posts one eval item: a held-out prompt, its reference answer, and the base and tuned model's answers.

        Each text field is cut to 3,500 characters. At most 60 per job; later ones are only logged. True when the
        platform took it.
        """
        if self._evals_sent >= EVAL_MAX:
            say("eval " + str(index) + " not sent: a job sends at most " + str(EVAL_MAX))
            return False
        self._evals_sent += 1
        redact = self._platform.redact
        body = {
            "type": "eval",
            "index": int(index),
            "prompt": redact("" if prompt is None else prompt),
            "reference": redact("" if reference is None else reference),
            "base": redact("" if base is None else base),
            "tuned": redact("" if tuned is None else tuned),
        }
        return self._platform.event(cut_eval_fields(body))

    def decide(self, part, items):
        """Posts a decide mode job's scores for one part ("dev" or "test"), DECIDE_CALLBACK_ITEMS a callback (fewer when
        a body would pass DECIDE_BODY_LIMIT): each item's index in the part, the base and the tuned model's
        log-probability of each shown letter (tuned None when it wasn't scored), and each side's letter mass. Numbers are
        rounded to 6 decimals, and a letter with no probability (-Infinity) goes as DECIDE_LOGPROB_FLOOR, since JSON has
        none. At most DECIDE_ITEMS_MAX items a job; later ones are only logged. Returns how many items the platform took.
        Raises ValueError for a part or an item that isn't one, before anything is sent.
        """
        if part not in DECIDE_PARTS:
            raise ValueError("decide part must be dev or test, not " + repr(part))
        clean = [decide_item(item) for item in items]
        room = max(0, DECIDE_ITEMS_MAX - self._decide_sent)
        if len(clean) > room:
            say(str(len(clean) - room) + " " + part + " scores not sent: a job sends at most " + str(DECIDE_ITEMS_MAX))
            clean = clean[:room]
        taken = 0
        for start in range(0, len(clean), DECIDE_CALLBACK_ITEMS):
            for body in decide_bodies(part, clean[start:start + DECIDE_CALLBACK_ITEMS]):
                self._decide_sent += len(body["items"])
                if self._platform.event(body):
                    taken += len(body["items"])
        say("decide " + part + ": the platform took " + str(taken) + " of " + str(len(clean)) + " scores")
        return taken

    def serving(self, port, cert_sha256, model, adapter_job_id):
        """Posts a "serving" callback: the recipe's HTTPS server answers on port, with the self-signed certificate whose
        SHA-256 (of its DER bytes) is cert_sha256. The platform takes the IP from Lambda, never from the instance, and
        pins the certificate to that fingerprint. True when the platform took it. Raises ValueError for a port or a
        fingerprint that isn't one.
        """
        if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
            raise ValueError("serving needs the server's TCP port, not " + repr(port)[:40])
        fingerprint = str(cert_sha256 or "").replace(":", "").lower()
        if len(fingerprint) != CERT_SHA256_CHARS or any(c not in "0123456789abcdef" for c in fingerprint):
            raise ValueError("serving needs the certificate's SHA-256 as 64 hex characters")
        body = {
            "type": "serving",
            "port": port,
            "certSha256": fingerprint,
            "model": self._platform.redact(model)[:200],
            "adapterJobId": self._platform.redact(adapter_job_id)[:64],
        }
        say("serving on port " + str(port) + ", certificate sha256 " + fingerprint)
        return self._platform.event(body)

    def _grant(self, name, size, content_type):
        """Asks the platform for an upload grant: one blob, this size and type. None when it has no storage (503)."""
        status, payload = self._platform.post(
            "/upload",
            {"name": name, "bytes": size, "contentType": content_type},
            retry_statuses=(429, 500, 502, 504),
        )
        if status == 503:
            self.log("storage not configured, so " + name + " was not uploaded")
            return None
        if status >= 300:
            raise RuntimeError("The platform refused to upload " + name + " (HTTP " + str(status) + ")")
        return json.loads(payload.decode("utf-8"))

    def upload(self, path, name, kind="other"):
        """Uploads a file to Vercel Blob through the platform and posts an artifact event.

        Returns the file's public URL, or None when the platform has no storage (it answers 503). When Blob refuses a
        retried write (the first try may have landed), the file goes up once more under a fresh grant.
        """
        size = os.path.getsize(path)
        content_type = upload_type(name)
        if kind not in ARTIFACT_KINDS:
            kind = "other"
        grant = self._grant(name, size, content_type)
        if grant is None:
            return None
        say("uploading " + name + " (" + str(size) + " bytes)")
        try:
            url = blob_put(path, grant["pathname"], grant["clientToken"], content_type, size, self._settings)
        except BlobRetryRefused as e:
            say(str(e) + "; uploading " + name + " once more with a fresh grant")
            grant = self._grant(name, size, content_type)
            if grant is None:
                return None
            url = blob_put(path, grant["pathname"], grant["clientToken"], content_type, size, self._settings)
        self._platform.event({"type": "artifact", "artifact": {"name": name, "kind": kind, "url": url, "bytes": size}})
        say("uploaded " + name)
        return url

    def base_files(self):
        """A gated base's files (POST /base-files): [{path, url or inline, sha256, size}]. The links work with no credential
        while they live, so they are blanked out of the log from here on. The platform keeps the Hub token."""
        status, payload = self._platform.post("/base-files", {}, retry_statuses=(429, 500, 502, 504))
        if status != 200 or not isinstance(payload, dict) or not isinstance(payload.get("files"), list):
            reason = payload.get("error") if isinstance(payload, dict) else None
            raise RuntimeError("The platform wouldn't list the gated base's files: " + str(reason or status)[:300])
        for f in payload["files"]:
            if f.get("url"):
                self._platform.hide(f["url"], "[base file link]")
        return payload["files"]

    def hub_upload(self, folder, for_job=None):
        """Sends folder's files to the Hugging Face Hub's storage for the platform to commit (docs/TRAINING.md, "Hugging
        Face Hub"). The platform holds the Hub token and never sends it here.

        Only the files in the folder's root named for the job's recipe go (hub_files): an adapter's HUB_NAMES, so
        checkpoint folders, optimizer, scheduler and RNG state, training_args.bin, README.md, hidden files and every
        pickle stay behind, or a glimmer-quantize job's builds and their small files. The plan (POST /hub, action
        "plan") names every file with its size, sha256 (read from disk a block at a time) and first 512 bytes, and
        carries the small ones inline as well (small_files). The platform answers a skip reason, or the repo and an
        upload for each file it wants in the Hub's storage: "none" (the Hub has it), "basic" (one PUT streamed from the
        file) or "multipart" (a PUT of each part, read from disk on its own, then a POST of the parts' ETags to the
        completion URL). Those URLs work with no credential while they live, so they are blanked out of the log from
        the moment the plan arrives and never go into a message. Every request is tried up to 3 times on a network
        error, a 429 or a 5xx. A 403 means its URL expired: the file gets one fresh plan (the whole plan again, which
        replaces the first on the platform), whose URLs also replace those of every file not sent yet. When the
        platform answers that the whole plan's answer would be too large for one reply (413 plan_too_large with
        perFile, as every part URL of three multi-GB files can be), each file gets a plan of its own instead, one after
        another, each still naming the whole folder. Nothing new starts within 2 minutes of ctx.deadline, and a
        transfer still going 1 minute before it is cut off. Then a report (action "done") names what the Hub's storage
        has and what failed.

        for_job names the job the files belong to when it isn't this one (a glimmer-publish job's adapter job). The
        platform takes that from the job's own params, so it only goes into the log.

        Returns {"uploaded": how many of the files the plan uploads the Hub's storage now has (sent, or already there),
        "skipped": why nothing was published (the platform's reason, or what went wrong asking it) or None, "failed":
        [{"path", "error"}], "repo", "files" and "bytes" (what the folder sends), and "sha256" ({name: digest} of each
        file planned)}. Never raises for the platform, the network or the Hub; a folder that doesn't exist raises
        ValueError.
        """
        if not os.path.isdir(str(folder)):
            raise ValueError("hub_upload needs a folder, not " + repr(str(folder))[:200])
        files = hub_files(folder, (self.cache_dir,) if self.cache_dir else (), self.recipe)
        result = {"uploaded": 0, "skipped": None, "failed": [], "repo": None, "files": len(files), "bytes": sum(f[2] for f in files), "sha256": {}}
        whose = "job " + str(for_job or self.job_id)
        too_big = [name for name, _, size in files if size > hub_max_bytes(name, self.recipe)]
        if not files:
            result["skipped"] = "the folder has no files to publish"
        elif len(files) > HUB_FILES_MAX:
            result["skipped"] = "the folder has " + str(len(files)) + " files, more than the " + str(HUB_FILES_MAX) + " one plan takes"
        elif too_big:
            result["skipped"] = too_big[0] + " is over " + megabytes(hub_max_bytes(too_big[0], self.recipe)) + ", more than one plan takes"
        if result["skipped"]:
            return result
        small = small_files(files)
        entries, local = {}, {}
        for name, path, size in files:
            digest, sample = file_digest(path)
            entries[name] = {"path": name, "size": size, "sha256": digest, "sample": base64.b64encode(sample).decode("ascii")}
            local[name] = path
        result["sha256"] = {name: entry["sha256"] for name, entry in entries.items()}
        manifest = [entries[name] for name, _, _ in files]
        say("Hub upload for " + whose + ": " + str(len(files)) + " files, " + megabytes(result["bytes"]) + ", " + str(len(small)) + " of them inline")
        plan, why, kind = self._hub_plan(manifest, small)
        if kind == "too_large":
            say("Hub upload for " + whose + ": the whole plan's answer would be too large for one reply, so each file gets a plan of its own")
            return self._hub_one_by_one(manifest, small, entries, local, result, whose)
        if plan is None:
            result["skipped"] = why
            return result
        result["repo"] = plan["repo"]
        uploaded, failed = self._hub_send_all(list(plan["uploads"]), manifest, small, entries, local)
        return self._hub_report(result, uploaded, failed, whose)

    def _hub_send_all(self, queue, manifest, small, entries, local, only=None):
        """(uploaded, failed) after sending each upload in queue. A 403 gets the file one fresh plan: the whole plan,
        or with only (planning one file at a time) that file's own, whose URLs replace those of the files not sent
        yet."""
        uploaded, failed, settled, replanned = [], [], set(), set()
        while queue:
            item = queue.pop(0)
            path = item.get("path") if isinstance(item, dict) else None
            entry = entries.get(path) if isinstance(path, str) else None
            if entry is not None and path in settled:
                continue
            problem = upload_problem(item, entry)
            if problem:
                failed.append({"path": str(path)[:300], "error": problem})
                if entry is not None:
                    settled.add(path)
                continue
            if item["transfer"] != "none":
                try:
                    self._hub_transfer(item, local[path], entry)
                except UrlRefused:
                    if path in replanned:
                        failed.append({"path": path, "error": "the Hub's storage refused its upload URLs again after a fresh plan (HTTP 403)"})
                        settled.add(path)
                        continue
                    replanned.add(path)
                    say("an upload URL for " + path + " expired, so it gets a fresh plan")
                    fresh, why, _ = self._hub_plan(manifest, small, [path] if only is not None else None)
                    renewed = {u["path"]: u for u in (fresh["uploads"] if fresh else []) if isinstance(u, dict) and isinstance(u.get("path"), str)}
                    if path in renewed:
                        # The files not sent yet have URLs as old as the one that expired, so they take the fresh ones.
                        waiting = [renewed.get(u.get("path"), u) if isinstance(u, dict) and isinstance(u.get("path"), str) else u for u in queue]
                        queue = [renewed[path]] + waiting
                        continue
                    failed.append({"path": path, "error": "its upload URL expired (HTTP 403), and the fresh plan " + ("had no upload for it" if fresh else "failed: " + why)})
                    settled.add(path)
                    continue
                except TransferFailed as e:
                    failed.append({"path": path, "error": self._platform.redact(e)[:300]})
                    settled.add(path)
                    continue
            uploaded.append({"path": path, "oid": entry["sha256"], "size": entry["size"]})
            settled.add(path)
        return uploaded, failed

    def _hub_one_by_one(self, manifest, small, entries, local, result, whose):
        """hub_upload when the whole plan's answer is too large: a plan for each file in turn (only that file's uploads
        in its answer, the plan itself still the whole folder), its bytes, then the next. A skip ends it; a file whose
        own answer is still too large, or whose plan fails, fails on its own."""
        uploaded, failed = [], []
        for entry in manifest:
            name = entry["path"]
            plan, why, kind = self._hub_plan(manifest, small, [name])
            if kind == "skip":
                result["skipped"] = why
                result["uploaded"] = len(uploaded)
                result["failed"] = failed
                return result
            if plan is None:
                error = "its own upload plan is still too large for one reply" if kind == "too_large" else "its upload plan failed"
                failed.append({"path": name, "error": error + ": " + why})
                continue
            result["repo"] = plan["repo"]
            sent, lost = self._hub_send_all(list(plan["uploads"]), manifest, small, entries, local, [name])
            uploaded.extend(sent)
            failed.extend(lost)
        if result["repo"] is None:
            result["skipped"] = "every file's upload plan failed, the first with " + (failed[0]["error"] if failed else "no reason")
            result["failed"] = failed
            return result
        return self._hub_report(result, uploaded, failed, whose)

    def _hub_report(self, result, uploaded, failed, whose):
        """Posts the report (action "done") of what the Hub's storage has and what failed, and returns result with them."""
        result["uploaded"] = len(uploaded)
        result["failed"] = failed
        say("Hub upload for " + whose + ": " + str(len(uploaded)) + " in the Hub's storage for " + str(result["repo"]) + ", " + str(len(failed)) + " failed")
        try:
            status, payload = self._platform.post("/hub", {"action": "done", "uploaded": uploaded, "failed": failed})
        except HttpFailure as e:
            result["skipped"] = "the platform couldn't be reached for the upload report: " + str(e)
            return result
        if status >= 300:
            result["skipped"] = "the platform answered HTTP " + str(status) + " to the upload report" + self._refusal(payload)
        return result

    def _refusal(self, payload):
        """": " and the error a refusal's JSON body names, with its message when it has one (the Hub's reason, which
        the platform already redacted), or nothing."""
        try:
            body = json.loads(payload.decode("utf-8")) if payload else None
        except (ValueError, AttributeError):
            body = None
        error = body.get("error") if isinstance(body, dict) else None
        if not isinstance(error, str) or not error.strip():
            return ""
        said = body.get("message")
        detail = ": " + said.strip() if isinstance(said, str) and said.strip() and said.strip() != error.strip() else ""
        return ": " + self._platform.redact(error + detail)[:500]

    def _hub_plan(self, entries, small, only=None):
        """(plan, None, None) with the platform's plan for these manifest entries, every presigned URL in it hidden
        from the log at once, or (None, why there is none, kind): kind "skip" for the platform's own skip reason,
        "too_large" when it answered 413 plan_too_large (the answer would pass its cap, so each file needs a plan of its
        own), else "error". only names the files to answer uploads for, when not all of them."""
        body = {"action": "plan", "files": entries, "small": small}
        if only is not None:
            body["only"] = list(only)
        try:
            status, payload = self._platform.post("/hub", body, timeout=HUB_PLAN_TIMEOUT)
        except HttpFailure as e:
            return None, "the platform couldn't be reached for the upload plan: " + str(e), "error"
        try:
            plan = json.loads(payload.decode("utf-8")) if payload else None
        except ValueError:
            plan = None
        uploads = plan.get("uploads") if isinstance(plan, dict) else None
        for item in uploads if isinstance(uploads, list) else []:
            self._hide_urls(item)
        if status == 413 and isinstance(plan, dict) and plan.get("error") == "plan_too_large":
            return None, "the platform answered HTTP 413 to the upload plan" + self._refusal(payload), "too_large"
        if status >= 300:
            return None, "the platform answered HTTP " + str(status) + " to the upload plan" + self._refusal(payload), "error"
        if not isinstance(plan, dict):
            return None, "the platform's upload plan isn't JSON", "error"
        skip = plan.get("skip")
        if isinstance(skip, str) and skip.strip():
            return None, self._platform.redact(skip.strip())[:300], "skip"
        if not isinstance(plan.get("repo"), str) or not plan["repo"].strip() or not isinstance(uploads, list):
            return None, "the platform's upload plan names no repo or no uploads", "error"
        return plan, None, None

    def _hide_urls(self, item):
        """Blanks one upload's presigned URLs (and their queries, which hold the signatures) and long header values out
        of everything redact sees from now on: while they live, they are credentials."""
        if not isinstance(item, dict):
            return
        urls = [item.get("href"), item.get("completionUrl")]
        if isinstance(item.get("parts"), list):
            urls.extend(part.get("url") for part in item["parts"] if isinstance(part, dict))
        for url in urls:
            if isinstance(url, str) and url:
                self._platform.hide(url, HUB_URL_LABEL)
                query = url.partition("?")[2]
                if len(query) >= HUB_SECRET_MIN:
                    self._platform.hide(query, HUB_URL_LABEL)
        header = item.get("header")
        for value in header.values() if isinstance(header, dict) else []:
            if isinstance(value, str) and len(value) >= HUB_SECRET_MIN:
                self._platform.hide(value, HUB_HEADER_LABEL)

    def _hub_in_time(self):
        """False once ctx.deadline is HUB_STOP_SECONDS away or nearer."""
        return self.deadline is None or time.time() < self.deadline - HUB_STOP_SECONDS

    def _hub_send(self, method, url, headers, open_body, what):
        """One request to a presigned URL with no credential of the platform's, tried up to HUB_TRIES times on a network
        error, a 429 or a 5xx, waiting hubRetrySeconds (2 s) and then twice that. Returns (status, headers, body) of any
        other answer; raises TransferFailed after the last try, or when the job's deadline is too near to start one. A
        transfer still sending HUB_ABORT_SECONDS before the deadline is cut off (then not tried again, since the next
        try would start too near it). what names the request in messages: the URL never goes into one."""
        wait = self._settings["hubRetrySeconds"]
        for attempt in range(1, HUB_TRIES + 1):
            if not self._hub_in_time():
                raise TransferFailed(what + " wasn't sent: the job's time limit is under " + span(HUB_STOP_SECONDS) + " away")
            try:
                stop_at = self.deadline - HUB_ABORT_SECONDS if self.deadline is not None else None
                status, head, payload = http_once(method, url, headers, open_body, stop_at=stop_at)
                if status != 429 and status < 500:
                    return status, head, payload
                reason = "HTTP " + str(status)
            except (OSError, http.client.HTTPException) as e:
                reason = "a network error (" + type(e).__name__ + ": " + self._platform.redact(e)[:200] + ")"
            if attempt >= HUB_TRIES:
                raise TransferFailed(what + " failed " + str(HUB_TRIES) + " times, the last with " + reason)
            say("retrying " + what + " after " + reason + " in " + str(wait) + " s")
            time.sleep(wait)
            wait *= 2

    def _hub_transfer(self, item, path, entry):
        """Sends one file's bytes to the Hub's storage as its upload in the plan says (basic or multipart). Raises
        UrlRefused on a 403 and TransferFailed on any other failure."""
        name, size = entry["path"], entry["size"]

        def check(status, what):
            if status == 403:
                raise UrlRefused(what + " (HTTP 403)")
            if status >= 300:
                raise TransferFailed(what + " (HTTP " + str(status) + ")")

        if item["transfer"] == "basic":
            headers = {"Content-Length": str(size)}
            header = item.get("header")
            for key, value in header.items() if isinstance(header, dict) else []:
                if isinstance(key, str) and isinstance(value, str) and key.lower() not in HUB_OWN_HEADERS:
                    headers[key] = value
            say("uploading " + name + " (" + megabytes(size) + ") in one request")
            status, _, _ = self._hub_send("PUT", item["href"], headers, lambda: open(path, "rb"), name)
            check(status, "the Hub's storage refused " + name)
            return
        chunk = item["chunkSize"]
        parts = sorted(item["parts"], key=lambda part: part["partNumber"])
        say("uploading " + name + " (" + megabytes(size) + ") in " + str(len(parts)) + " parts")
        etags = []
        for part in parts:
            number = part["partNumber"]
            offset = (number - 1) * chunk
            length = min(chunk, size - offset)
            label = "part " + str(number) + " of " + name
            status, head, _ = self._hub_send(
                "PUT", part["url"], {"Content-Length": str(length)}, lambda o=offset, n=length: FileRange(path, o, n), label
            )
            check(status, "the Hub's storage refused " + label)
            if not head.get("etag"):
                raise TransferFailed("the Hub's storage answered " + label + " with no ETag")
            etags.append({"partNumber": number, "etag": head["etag"]})
        body = json.dumps({"oid": entry["sha256"], "parts": etags}).encode("utf-8")
        status, _, _ = self._hub_send("POST", item["completionUrl"], {"Accept": LFS_JSON, "Content-Type": LFS_JSON}, lambda: body, "the completion of " + name)
        check(status, "the Hub didn't complete the upload of " + name)


def metric_value(value, redact):
    """A metric as the platform takes it: a finite number or a short string. None drops it."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, str):
        return redact(value)[:METRIC_LIMIT]
    if hasattr(value, "__float__"):
        try:
            number = float(value)
            return number if math.isfinite(number) else str(number)
        except (TypeError, ValueError):
            pass
    try:
        text = json.dumps(value, default=str, ensure_ascii=False)
    except Exception:
        text = str(value)
    return redact(text)[:METRIC_LIMIT]


def done_body(result, redact):
    """The done callback for what run() returned, kept under the platform's 16 KB body limit."""
    body = {"type": "done"}
    if isinstance(result, dict):
        items = dict(result)
        summary = items.pop("summary", None)
        if summary is not None:
            body["summary"] = redact(summary)[:SUMMARY_LIMIT]
    elif result is None:
        items = {}
    else:
        items = {"result": result}
    metrics = {}
    for key, value in list(items.items())[:MAX_METRICS]:
        v = metric_value(value, redact)
        if v is not None:
            metrics[str(key)[:64]] = v
    body["metrics"] = metrics
    while metrics and len(json.dumps(body, ensure_ascii=False).encode("utf-8")) > BODY_LIMIT:
        metrics.pop(list(metrics)[-1])
    return body


def load_recipe(path):
    """Imports recipe.py and checks it defines run(ctx)."""
    spec = importlib.util.spec_from_file_location("recipe", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load " + path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "run", None)):
        raise RuntimeError(path + " has no run(ctx)")
    return module


def number_setting(job, key, fallback):
    value = job.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return value
    return fallback


def cache_dir_of(job, wait_seconds):
    """job.json's cacheDir once it is a mounted folder, waiting up to wait_seconds for the mount. None without it."""
    path = job.get("cacheDir")
    if not path:
        return None
    path = str(path)
    deadline = time.time() + wait_seconds
    while not os.path.isdir(path):
        if time.time() >= deadline:
            say("cache folder " + path + " is not mounted, so this job runs without the cache")
            return None
        time.sleep(min(5, wait_seconds))
    say("cache folder " + path)
    return path


def main(argv):
    if len(argv) < 2:
        say("usage: runner.py job.json")
        return 2
    job_path = os.path.abspath(argv[1])
    try:
        with open(job_path) as f:
            job = json.load(f)
        platform = Platform(job["callbackBase"], job["token"])
        platform.hide(job.get("serveKey"), "[serve key]")
    except Exception as e:
        say("could not read " + job_path + ": " + type(e).__name__)
        return 2
    settings = {
        "heartbeatSeconds": number_setting(job, "heartbeatSeconds", HEARTBEAT_SECONDS),
        "blobApiUrl": str(job.get("blobApiUrl") or BLOB_API_URL),
        "multipartOverBytes": int(number_setting(job, "multipartOverBytes", MULTIPART_OVER_BYTES)),
        "partBytes": int(number_setting(job, "partBytes", PART_BYTES)),
        "hubRetrySeconds": number_setting(job, "hubRetrySeconds", HUB_RETRY_SECONDS),
    }
    here = os.path.dirname(os.path.abspath(__file__))
    work_dir = str(job.get("workDir") or os.path.join(os.path.dirname(job_path), "work"))
    os.makedirs(work_dir, exist_ok=True)
    say("job " + str(job.get("jobId")) + ", recipe " + str(job.get("recipe")) + ", python " + sys.version.split()[0])

    platform.event({"type": "heartbeat", "message": "Runner started"})
    activity = Activity()
    beat = Heartbeat(platform, settings["heartbeatSeconds"], activity)
    beat.start()
    cache_dir = cache_dir_of(job, number_setting(job, "cacheWaitSeconds", CACHE_WAIT_SECONDS))
    ctx = Context(job, platform, work_dir, settings, cache_dir, activity)
    try:
        recipe = load_recipe(os.path.join(here, "recipe.py"))
        result = recipe.run(ctx)
    except BaseException:
        kind = sys.exc_info()[0].__name__
        beat.stop()
        error = platform.redact(traceback.format_exc())
        say("the recipe failed:\n" + error)
        platform.event({"type": "failed", "error": error_tail(error, kind)})
        return 1
    beat.stop()
    try:
        body = done_body(result, platform.redact)
    except Exception:
        body = {"type": "done", "metrics": {}}
    say("done")
    platform.event(body)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;
