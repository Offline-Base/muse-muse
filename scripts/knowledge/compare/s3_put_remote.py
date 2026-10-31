"""The uploader that lab.py s3-put sends to writer-1 over ssh stdin (docs/COMPARE.md, moving our GGUFs).

It is never copied to writer-1 as a file. lab.py runs this fixed bootstrap there, at the lowest CPU and disk priority:

    nice -n 19 ionice -c 3 python3 -I -c 'import sys;n=int(sys.stdin.buffer.readline());exec(...read(n)...)'

and then writes, on the same stdin: the length of this program, the program, and JSON lines:
    {"job": {"path", "bytes", "part_bytes", "threads", "mb_per_s", "batch"}}     no URLs
    {"urls": {"N": url, ...}}                                                   presigned PUT URLs, a batch at a time
    {"done": true}
It reads the file once, in order, hashing it, holds at most `threads` parts in memory, PUTs with `threads` threads,
and keeps under `mb_per_s`. It prints only JSON lines, never a URL and never an exception's text:
    {"need": [part numbers]}     fewer than 4 unused URLs are left
    {"part": n, "etag": "...", "bytes": n}
    {"retry": n, "status": 403}  S3 refused that URL (expired); lab.py answers with a fresh URL for part n
    {"warn": n, "error": "TypeName", "status": n or null}   a network error; the same URL is tried again
    {"sha256": "...", "bytes": n}
    {"error": "...", ...}        and it exits 1
It writes nothing on disk, takes no lock and uses no GPU. Python 3.10, standard library only.
"""

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

_out = threading.Lock()


def say(obj):
    with _out:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


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


class Body:
    """A part's bytes as a file for http.client, paced by the limiter."""

    def __init__(self, data, limiter):
        self.data, self.pos, self.limiter = memoryview(data), 0, limiter

    def read(self, size=-1):
        if size is None or size < 0:
            size = len(self.data) - self.pos
        chunk = self.data[self.pos:self.pos + size]
        self.pos += len(chunk)
        self.limiter.take(len(chunk))
        return bytes(chunk)


class Channel:
    """Presigned URLs arriving on stdin, by part number."""

    def __init__(self, stream, batch, parts):
        self.stream, self.batch, self.parts = stream, batch, parts
        self.urls, self.requested = {}, set()
        self.cond = threading.Condition()
        self.done = self.eof = False
        self.highest = 0  # highest part number asked for so far
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for line in self.stream:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                with self.cond:
                    if isinstance(msg.get("urls"), dict):
                        for k, v in msg["urls"].items():
                            n = int(k)
                            self.urls[n] = v
                            self.requested.discard(n)
                    if msg.get("done"):
                        self.done = True
                    self.cond.notify_all()
        except Exception:
            pass
        with self.cond:
            self.eof = True
            self.cond.notify_all()

    def top_up(self, next_part):
        """Asks for the next batch when fewer than LOW_WATER unused URLs are left from next_part on."""
        with self.cond:
            ahead = sum(1 for p in self.urls if p >= next_part) + sum(1 for p in self.requested if p >= next_part)
            if ahead >= LOW_WATER or self.highest >= self.parts:
                return
            start = max(self.highest + 1, next_part)
            want = list(range(start, min(self.parts, start + self.batch - 1) + 1))
            want = [p for p in want if p not in self.urls and p not in self.requested]
            if not want:
                return
            self.requested.update(want)
            self.highest = max(self.highest, want[-1])
        say({"need": want})

    def ask_again(self, n, status):
        with self.cond:
            self.urls.pop(n, None)
            self.requested.add(n)
        say({"retry": n, "status": status})

    def get(self, n):
        began = time.monotonic()
        with self.cond:
            while n not in self.urls:
                if self.eof:
                    raise EOFError("stdin closed")
                if time.monotonic() - began > URL_WAIT_S:
                    raise TimeoutError("no URL")
                if n not in self.requested:
                    self.requested.add(n)
                    say({"need": [n]})
                self.cond.wait(10)
            return self.urls[n]

    def used(self, n):
        with self.cond:
            self.urls.pop(n, None)

    def wait_done(self, seconds):
        end = time.monotonic() + seconds
        with self.cond:
            while not (self.done or self.eof) and time.monotonic() < end:
                self.cond.wait(5)


def put_once(url, data, limiter):
    """One PUT. Returns (status, etag). Raises on a network error."""
    u = urllib.parse.urlsplit(url)
    target = u.path + ("?" + u.query if u.query else "")
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    conn = cls(u.netloc, timeout=180, blocksize=1 << 20)
    try:
        conn.request("PUT", target, body=Body(data, limiter), headers={"Content-Length": str(len(data))})
        r = conn.getresponse()
        etag = r.getheader("ETag")
        r.read(65536)
        return r.status, etag
    finally:
        conn.close()


def upload_part(n, data, chan, limiter, failed):
    status = None
    for attempt in range(1, MAX_TRIES + 1):
        if failed.is_set():
            return False
        url = chan.get(n)
        try:
            status, etag = put_once(url, data, limiter)
        except Exception as e:
            say({"warn": n, "error": type(e).__name__, "status": None})
            time.sleep(min(30, 2 ** attempt))
            continue
        if status == 200 and etag:
            chan.used(n)
            say({"part": n, "etag": etag, "bytes": len(data)})
            return True
        if status in (400, 403):
            chan.ask_again(n, status)
        else:
            say({"warn": n, "error": "http", "status": status})
            time.sleep(min(30, 2 ** attempt))
    say({"error": "part", "part": n, "status": status})
    failed.set()
    return False


def main():
    stream = sys.stdin.buffer
    first = None
    for line in stream:
        try:
            first = json.loads(line)
        except ValueError:
            continue
        break
    job = (first or {}).get("job")
    if not isinstance(job, dict):
        say({"error": "no job"})
        return 1
    path, total = job["path"], int(job["bytes"])
    part_bytes, threads = int(job["part_bytes"]), max(1, int(job.get("threads", 3)))
    try:
        have = os.stat(path).st_size
    except OSError as e:
        say({"error": "stat", "type": type(e).__name__})
        return 1
    if have != total:
        say({"error": "size", "have": have, "want": total})
        return 1
    parts = (total + part_bytes - 1) // part_bytes
    chan = Channel(stream, max(1, int(job.get("batch", 16))), parts)
    limiter = Limiter(float(job.get("mb_per_s", 150)) * 1e6)
    slots = threading.Semaphore(threads)
    work = queue.Queue()
    failed = threading.Event()

    def worker():
        while True:
            item = work.get()
            if item is None:
                return
            n, data = item
            try:
                upload_part(n, data, chan, limiter, failed)
            except Exception as e:
                say({"error": "part", "part": n, "type": type(e).__name__})
                failed.set()
            finally:
                slots.release()

    pool = [threading.Thread(target=worker, daemon=True) for _ in range(threads)]
    for t in pool:
        t.start()
    digest = hashlib.sha256()
    read = 0
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            if hasattr(os, "posix_fadvise"):
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_SEQUENTIAL)
            for n in range(1, parts + 1):
                chan.top_up(n)
                slots.acquire()
                if failed.is_set():
                    slots.release()
                    break
                want = min(part_bytes, total - read)
                buf = bytearray(want)
                view, got = memoryview(buf), 0
                while got < want:
                    k = os.readv(fd, [view[got:]])
                    if k <= 0:
                        raise EOFError("file shorter than expected")
                    got += k
                digest.update(buf)
                read += want
                work.put((n, buf))
        finally:
            os.close(fd)
    except Exception as e:
        say({"error": "read", "type": type(e).__name__})
        failed.set()
    for _ in pool:
        work.put(None)
    for t in pool:
        t.join()
    if failed.is_set() or read != total:
        return 1
    say({"sha256": digest.hexdigest(), "bytes": read})
    chan.wait_done(600)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        say({"error": "main", "type": type(e).__name__})
        code = 1
    sys.stdout.flush()
    os._exit(code)
