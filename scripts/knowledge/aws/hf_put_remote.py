"""The writer-1 side of hf_relay.py (docs in that file): reads one file and PUTs its bytes to the short-lived upload URLs
that Hugging Face's LFS batch API handed the laptop. It never sees the Hugging Face token.

It is never copied to writer-1 as a file. hf_relay.py runs this fixed bootstrap there, at the lowest CPU and disk
priority:

    nice -n 19 ionice -c 3 python3 -I -c 'import sys;n=int(sys.stdin.buffer.readline());exec(...read(n)...)'

and then writes, on the same stdin: the length of this program, the program, and JSON lines. The first line is one of

    {"probe": {"op": "stat"|"sha256"|"head"|"cat", "path", "root", "max_bytes"}}   read-only facts about one file
    {"job": {"path", "root", "bytes", "sha256", "mode", "part_bytes", "threads", "mb_per_s", "batch", "skip",
             "buffer_mb"}}                                                         no URLs

and for a job the laptop then sends
    {"urls": {"N": url, ...}, "gen": g}   upload URLs, a batch at a time; g counts the laptop's batch calls
    {"done": true}               after the sha256 line below
    {"abort": true}              stop now (the laptop got a new upload from the Hub)
If its stdin ends before "done", or its stdout is gone, it stops at once: nothing keeps running for no one.

It prints only JSON lines, never a URL and never an exception's text:
    {"mode": "buffered"|"stream", "threads": n}
    {"need": [part numbers]}     fewer than 4 unused URLs are left
    {"part": n, "etag": "...", "bytes": n}
    {"retry": n, "status": 403, "gen": g}   storage refused part n's URL of generation g (expired); the laptop answers
                                 with a fresh one (not sent when a newer URL for n has already arrived)
    {"warn": n, "error": "TypeName", "status": n or null}   a network error; the same URL is tried again
    {"alive": true}              once a minute during a job
    {"sha256": "...", "bytes": n}
    {"error": "...", ...}        and it exits 1

Modes: "multipart" PUTs part n (1-based) as bytes [(n-1)*part_bytes, n*part_bytes) and needs an ETag back; "basic" PUTs
the whole file to URL 1. When threads * part_bytes fits in buffer_mb it reads the file once in order into at most
`threads` part buffers and PUTs them in parallel ("buffered"); otherwise it streams each part from the file with one
thread ("stream"), so memory stays near 1 MiB. Either way the whole file is hashed once, in order, and the sha256 is
checked against the job's before it says it is done. Parts in "skip" (already on the storage side) are read and hashed
but not sent. It writes nothing on disk, takes no lock and uses no GPU. Python 3.10, standard library only.
"""

import base64
import hashlib
import http.client
import json
import os
import queue
import sys
import threading
import time
import urllib.parse

MAX_TRIES = 5
LOW_WATER = 4
URL_WAIT_S = 900
BLOCK = 1 << 20
CAT_MAX = 10 << 20

_out = threading.Lock()


def say(obj):
    """One JSON line to the laptop. If the laptop is gone (stdout closed), there is no one to report to: exit now, so
    nothing is left running on writer-1."""
    with _out:
        try:
            sys.stdout.write(json.dumps(obj) + "\n")
            sys.stdout.flush()
        except (OSError, ValueError):
            os._exit(3)


def _thread_hook(args):
    say({"error": "thread", "type": args.exc_type.__name__})


threading.excepthook = _thread_hook
sys.excepthook = lambda t, v, tb: say({"error": "uncaught", "type": t.__name__})


class Limiter:
    """A shared byte rate, with a quarter second of burst."""

    def __init__(self, bytes_per_s):
        self.rate = float(bytes_per_s)
        self.t = time.monotonic()
        self.lock = threading.Lock()

    def take(self, n):
        if self.rate <= 0:
            return
        with self.lock:
            now = time.monotonic()
            self.t = max(self.t, now - 0.25) + n / self.rate
            wait = self.t - now
        if wait > 0:
            time.sleep(wait)


class Hasher:
    """sha256 over the file in order. Bytes seen again (a retried part) are not hashed twice."""

    def __init__(self):
        self.digest, self.upto, self.lock = hashlib.sha256(), 0, threading.Lock()

    def feed(self, offset, data):
        with self.lock:
            end = offset + len(data)
            if end <= self.upto:
                return
            if offset > self.upto:
                raise ValueError("hash gap")
            self.digest.update(memoryview(data)[self.upto - offset:])
            self.upto = end


class BufBody:
    """A part's bytes from memory, paced by the limiter."""

    def __init__(self, data, limiter):
        self.data, self.pos, self.limiter = memoryview(data), 0, limiter

    def read(self, size=-1):
        if size is None or size < 0:
            size = len(self.data) - self.pos
        chunk = self.data[self.pos:self.pos + size]
        self.pos += len(chunk)
        self.limiter.take(len(chunk))
        return bytes(chunk)


class FileBody:
    """A part's bytes read from the file as they are sent (pread, 1 MiB at a time), hashed on the way."""

    def __init__(self, fd, offset, length, limiter, hasher):
        self.fd, self.offset, self.length, self.limiter, self.hasher = fd, offset, length, limiter, hasher
        self.pos = 0

    def read(self, size=-1):
        if size is None or size < 0:
            size = BLOCK
        n = min(size, BLOCK, self.length - self.pos)
        if n <= 0:
            return b""
        data = os.pread(self.fd, n, self.offset + self.pos)
        if not data:
            raise EOFError("file shorter than expected")
        self.hasher.feed(self.offset + self.pos, data)
        self.pos += len(data)
        self.limiter.take(len(data))
        return data


class Channel:
    """Upload URLs arriving on stdin, by part number."""

    def __init__(self, stream, batch, parts, skip, failed):
        self.stream, self.batch, self.parts, self.failed = stream, batch, parts, failed
        self.skip = set(skip)
        self.urls, self.requested = {}, set()
        self.cond = threading.Condition()
        self.done = self.eof = False
        self.highest = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for line in self.stream:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                with self.cond:
                    if isinstance(msg.get("urls"), dict):
                        gen = msg.get("gen") if isinstance(msg.get("gen"), int) else 0
                        for k, v in msg["urls"].items():
                            n = int(k)
                            self.urls[n] = (v, gen)
                            self.requested.discard(n)
                    if msg.get("done"):
                        self.done = True
                    if msg.get("abort"):
                        self.failed.set()
                    self.cond.notify_all()
        except Exception:
            pass
        with self.cond:
            self.eof = True
            if not self.done:  # the laptop went away mid-job: stop, don't keep PUTting for no one
                self.failed.set()
            self.cond.notify_all()

    def top_up(self, next_part):
        """Asks for the next batch when fewer than LOW_WATER unused URLs are left from next_part on."""
        with self.cond:
            ahead = sum(1 for p in self.urls if p >= next_part) + sum(1 for p in self.requested if p >= next_part)
            if ahead >= LOW_WATER or self.highest >= self.parts:
                return
            start = max(self.highest + 1, next_part)
            want = [p for p in range(start, self.parts + 1) if p not in self.skip][:self.batch]
            if want:
                self.highest = max(self.highest, want[-1])
            else:
                self.highest = self.parts
            want = [p for p in want if p not in self.urls and p not in self.requested]
            if not want:
                return
            self.requested.update(want)
        say({"need": want})

    def ask_again(self, n, status, gen):
        """After storage refused the URL of generation `gen` for part n. If a newer URL for n has arrived meanwhile
        (the laptop refreshed every unused URL after another part's refusal), it is simply used: no message."""
        with self.cond:
            cur = self.urls.get(n)
            if cur is not None and cur[1] > gen:
                return
            self.urls.pop(n, None)
            self.requested.add(n)
        say({"retry": n, "status": status, "gen": gen})

    def get(self, n):
        """(url, generation) for part n, waiting for the laptop to send it."""
        began = time.monotonic()
        with self.cond:
            while n not in self.urls:
                if self.eof or self.failed.is_set():
                    raise EOFError("stopped")
                if time.monotonic() - began > URL_WAIT_S:
                    raise TimeoutError("no URL")
                if n not in self.requested:
                    self.requested.add(n)
                    say({"need": [n]})
                self.cond.wait(2)
            return self.urls[n]

    def used(self, n):
        with self.cond:
            self.urls.pop(n, None)

    def wait_done(self, seconds):
        end = time.monotonic() + seconds
        with self.cond:
            while not (self.done or self.eof) and time.monotonic() < end:
                self.cond.wait(5)


def put_once(url, body, length):
    """One PUT. Returns (status, etag). Raises on a network error."""
    u = urllib.parse.urlsplit(url)
    target = u.path + ("?" + u.query if u.query else "")
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    conn = cls(u.netloc, timeout=180, blocksize=BLOCK)
    try:
        conn.request("PUT", target, body=body, headers={"Content-Length": str(length)})
        r = conn.getresponse()
        etag = r.getheader("ETag")
        r.read(65536)
        return r.status, etag
    finally:
        conn.close()


def upload_part(n, make_body, length, chan, failed, need_etag):
    status, last_url, cut = None, None, 0
    for attempt in range(1, MAX_TRIES + 1):
        if failed.is_set():
            return False
        url, gen = chan.get(n)
        cut = cut if url == last_url else 0
        last_url = url
        try:
            status, etag = put_once(url, make_body(), length)
        except Exception as e:
            if failed.is_set():
                return False
            say({"warn": n, "error": type(e).__name__, "status": None})
            # storage often answers an expired URL by cutting the connection mid-body (no status ever arrives):
            # the same URL cut off twice gets a fresh one instead of more tries of a dead one
            if isinstance(e, (BrokenPipeError, ConnectionResetError)):
                cut += 1
                if cut >= 2:
                    chan.ask_again(n, None, gen)
                    continue
            time.sleep(min(30, 2 ** attempt))
            continue
        if 200 <= status < 300 and (etag or not need_etag):
            chan.used(n)
            say({"part": n, "etag": etag or "", "bytes": length})
            return True
        if status in (400, 403):
            chan.ask_again(n, status, gen)
        else:
            say({"warn": n, "error": "http", "status": status})
            time.sleep(min(30, 2 ** attempt))
    say({"error": "part", "part": n, "status": status})
    failed.set()
    return False


def check_path(path, root):
    """The file must sit under root (after symlinks) and on root's own filesystem, so nothing outside it (the NFS, for
    one, even if something under root were a mount point or root itself a link to it) is ever read."""
    if not root or os.path.realpath(root) != os.path.abspath(root):
        return None
    real = os.path.realpath(path)
    if not real.startswith(root.rstrip("/") + "/") or not os.path.isfile(real):
        return None
    if os.stat(real).st_dev != os.stat(root).st_dev:
        return None
    return real


def heartbeat(stop, every=60):
    """A line now and then, so the laptop can tell a long quiet stretch (hashing resumed parts at ionice idle, one big
    basic PUT on a slow link) from a dead link."""
    def run():
        while not stop.wait(every):
            say({"alive": True})
    threading.Thread(target=run, daemon=True).start()


def probe(spec):
    path = check_path(spec.get("path", ""), spec.get("root"))
    if path is None:
        say({"missing": True})
        return 0
    st = os.stat(path)
    op = spec.get("op")
    if op == "stat":
        say({"bytes": st.st_size, "mtime": int(st.st_mtime)})
    elif op == "head":
        with open(path, "rb") as f:
            say({"bytes": st.st_size, "sample": base64.b64encode(f.read(512)).decode()})
    elif op == "cat":
        cap = min(int(spec.get("max_bytes", CAT_MAX)), CAT_MAX)
        if st.st_size > cap:
            say({"error": "too big", "bytes": st.st_size})
            return 1
        with open(path, "rb") as f:
            say({"bytes": st.st_size, "data": base64.b64encode(f.read(cap + 1)).decode()})
    elif op == "sha256":
        digest, got = hashlib.sha256(), 0
        fd = os.open(path, os.O_RDONLY)
        try:
            if hasattr(os, "posix_fadvise"):
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_SEQUENTIAL)
            while True:
                b = os.read(fd, 8 * BLOCK)
                if not b:
                    break
                digest.update(b)
                got += len(b)
        finally:
            os.close(fd)
        if int(os.stat(path).st_mtime) != int(st.st_mtime) or got != st.st_size:
            say({"error": "changed while hashing"})
            return 1
        say({"sha256": digest.hexdigest(), "bytes": got, "mtime": int(st.st_mtime)})
    else:
        say({"error": "unknown op"})
        return 1
    return 0


def run_job(job, stream):
    path = check_path(job.get("path", ""), job.get("root"))
    if path is None:
        say({"error": "path"})
        return 1
    total = int(job["bytes"])
    have = os.stat(path).st_size
    if have != total:
        say({"error": "size", "have": have, "want": total})
        return 1
    basic = job.get("mode") == "basic"
    part_bytes = total if basic else int(job["part_bytes"])
    if part_bytes <= 0:
        say({"error": "part_bytes"})
        return 1
    parts = 1 if basic else (total + part_bytes - 1) // part_bytes
    threads = max(1, int(job.get("threads", 3)))
    buffered = (not basic) and threads * part_bytes <= int(job.get("buffer_mb", 512)) << 20
    if not buffered:
        threads = 1
    skip = set() if basic else {int(p) for p in job.get("skip", []) if 1 <= int(p) <= parts}
    failed = threading.Event()
    chan = Channel(stream, max(1, int(job.get("batch", 16))), parts, skip, failed)
    limiter = Limiter(float(job.get("mb_per_s", 150)) * 1e6)
    hasher = Hasher()
    say({"mode": "buffered" if buffered else "stream", "threads": threads})
    beat = threading.Event()
    heartbeat(beat)
    fd = os.open(path, os.O_RDONLY)
    try:
        if hasattr(os, "posix_fadvise"):
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_SEQUENTIAL)
        if buffered:
            ok = _buffered(fd, total, part_bytes, parts, threads, skip, chan, limiter, hasher, failed)
        else:
            ok = _stream(fd, total, part_bytes, parts, skip, chan, limiter, hasher, failed, need_etag=not basic)
    finally:
        os.close(fd)
        beat.set()
    if not ok or failed.is_set() or hasher.upto != total:
        return 1
    sha = hasher.digest.hexdigest()
    if job.get("sha256") and sha != job["sha256"]:
        say({"error": "sha256", "sha256": sha})
        return 1
    say({"sha256": sha, "bytes": total})
    chan.wait_done(600)
    return 0


def _read_exact(fd, offset, want):
    buf = bytearray(want)
    view, got = memoryview(buf), 0
    while got < want:
        k = os.preadv(fd, [view[got:]], offset + got) if hasattr(os, "preadv") else _pread_into(fd, view, got, offset)
        if k <= 0:
            raise EOFError("file shorter than expected")
        got += k
    return buf


def _pread_into(fd, view, got, offset):
    data = os.pread(fd, len(view) - got, offset + got)
    view[got:got + len(data)] = data
    return len(data)


def _buffered(fd, total, part_bytes, parts, threads, skip, chan, limiter, hasher, failed):
    slots = threading.Semaphore(threads)
    work = queue.Queue()

    def worker():
        while True:
            item = work.get()
            if item is None:
                return
            n, data = item
            try:
                upload_part(n, lambda: BufBody(data, limiter), len(data), chan, failed, need_etag=True)
            except Exception as e:
                say({"error": "part", "part": n, "type": type(e).__name__})
                failed.set()
            finally:
                slots.release()

    pool = [threading.Thread(target=worker, daemon=True) for _ in range(threads)]
    for t in pool:
        t.start()
    try:
        for n in range(1, parts + 1):
            offset = (n - 1) * part_bytes
            want = min(part_bytes, total - offset)
            if n in skip:
                for off in range(offset, offset + want, BLOCK):
                    hasher.feed(off, _read_exact(fd, off, min(BLOCK, offset + want - off)))
                continue
            chan.top_up(n)
            slots.acquire()
            if failed.is_set():
                slots.release()
                break
            buf = _read_exact(fd, offset, want)
            hasher.feed(offset, buf)
            work.put((n, buf))
    except Exception as e:
        say({"error": "read", "type": type(e).__name__})
        failed.set()
    for _ in pool:
        work.put(None)
    for t in pool:
        t.join()
    return not failed.is_set()


def _stream(fd, total, part_bytes, parts, skip, chan, limiter, hasher, failed, need_etag):
    try:
        for n in range(1, parts + 1):
            if failed.is_set():
                return False
            offset = (n - 1) * part_bytes
            want = min(part_bytes, total - offset)
            if n in skip:
                for off in range(offset, offset + want, BLOCK):
                    hasher.feed(off, _read_exact(fd, off, min(BLOCK, offset + want - off)))
                continue
            chan.top_up(n)
            if not upload_part(n, lambda o=offset, w=want: FileBody(fd, o, w, limiter, hasher), want, chan, failed,
                               need_etag):
                return False
    except Exception as e:
        say({"error": "read", "type": type(e).__name__})
        failed.set()
        return False
    return True


def main():
    stream = sys.stdin.buffer
    first = None
    for line in stream:
        try:
            first = json.loads(line)
        except ValueError:
            continue
        break
    first = first if isinstance(first, dict) else {}
    if isinstance(first.get("probe"), dict):
        return probe(first["probe"])
    if isinstance(first.get("job"), dict):
        return run_job(first["job"], stream)
    say({"error": "no job"})
    return 1


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        say({"error": "main", "type": type(e).__name__})
        code = 1
    sys.stdout.flush()
    os._exit(code)
