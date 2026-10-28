/**
 * The Python runner that cloud-init starts on a training instance (docs/TRAINING.md, "Runner and recipes"). It is a
 * string constant so Vercel bundles it with no file tracing. Standard library only. Never put a dollar sign followed
 * by an opening brace, or a backtick, in the Python: this is a template literal.
 *
 * job.json keys: jobId, callbackBase, token, params, maxMinutes, recipe, deadlineEpoch (Unix seconds, stamped before the
 * launch request from the time limit, or the dollar limit when that runs out first, so never after the platform stops
 * the job), cacheDir for a recipe with usesCache, and serveKey for a glimmer-serve job (the key its demo server asks
 * for; blanked out of every log line like the token). Optional keys for tests: heartbeatSeconds, workDir, blobApiUrl,
 * multipartOverBytes, partBytes, cacheWaitSeconds.
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

import http.client
import importlib.util
import json
import math
import mimetypes
import os
import random
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
EVAL_MAX = 60
EVAL_FIELDS = ("prompt", "reference", "base", "tuned")
# A "serving" callback's certSha256: the SHA-256 of the certificate's DER bytes, in lowercase hex.
CERT_SHA256_CHARS = 64
DATASET_PARTS = ("train", "eval")
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


def request(url, method="POST", data=None, headers=None, retry_statuses=RETRY_STATUSES, open_body=None):
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
            with OPENER.open(req, timeout=HTTP_TIMEOUT) as res:
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

    def post(self, path, body, retry_statuses=RETRY_STATUSES):
        """POSTs JSON to callbackBase + path. Returns (status, body bytes); raises HttpFailure on the network."""
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        headers = {"Authorization": "Bearer " + self._token, "Content-Type": "application/json"}
        return request(self.base + path, data=data, headers=headers, retry_statuses=retry_statuses)

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


def deadline_of(job, now):
    """job.json's deadlineEpoch, else now plus maxMinutes, else None."""
    value = job.get("deadlineEpoch")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return float(value)
    minutes = job.get("maxMinutes")
    if isinstance(minutes, (int, float)) and not isinstance(minutes, bool) and math.isfinite(minutes) and minutes > 0:
        return now + float(minutes) * 60
    return None


class Context:
    """What recipe.run(ctx) gets: params, cache_dir, work_dir, deadline, log, progress, run, upload, get_json, dataset,
    dataset_title, eval, and for a glimmer-serve job serve_key and serving."""

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
        # A glimmer-serve job's serve key (job.json's serveKey): its demo server answers only requests that carry it.
        # None for any other job. Never log it; the runner blanks it out of log lines as it does the job token.
        serve_key = job.get("serveKey")
        self.serve_key = serve_key if isinstance(serve_key, str) and serve_key else None
        self._platform = platform
        self._settings = settings
        self._activity = activity
        self._evals_sent = 0

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
        """Every item of the job's dataset part ("train" or "eval"), paging GET /dataset until nextPage is null. Each
        page's title is kept as dataset_title."""
        if part not in DATASET_PARTS:
            raise ValueError("dataset part must be train or eval, not " + repr(part))
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
