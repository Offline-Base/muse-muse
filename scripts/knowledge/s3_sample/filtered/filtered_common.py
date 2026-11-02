"""Shared helpers for the knowledge/filtered/ sample writers: counted S3 reads, text cleanup, record checks and output.

Run these scripts with a private venv and `python -I`. They read from s3://$KNOWLEDGE_BUCKET/knowledge/filtered/
and write .data/knowledge/sources/s3-<set>.jsonl. Every byte read from S3 goes through get_range, so the 8 GB limit is measured.
"""

import fcntl
import html
import io
import json
import os
import random
import re
import zlib
from collections import Counter

import boto3
from botocore.config import Config

BUCKET = os.environ.get("KNOWLEDGE_BUCKET", "<set KNOWLEDGE_BUCKET>")  # the knowledge bucket; its name holds the AWS account id, so it stays out of the repo
ROOT = "knowledge/filtered"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT_DIR = os.path.join(REPO, ".data", "knowledge", "sources")
WORK = os.environ["S3S_WORK"]
LEDGER = os.path.join(WORK, "downloaded-bytes.json")
LIMIT_BYTES = 8 * 1000 ** 3
START, END = "2026-01-04", "2026-10-29"
MAX_WORDS, MIN_WORDS = 210, 40
SEED = 20261030
MONTHS = "January February March April May June July August September October November December".split()

session = boto3.Session(profile_name="offlinebase", region_name="us-east-1")
s3 = session.client("s3", config=Config(max_pool_connections=8, retries={"max_attempts": 6, "mode": "standard"}))


def spend(tag, n):
    """Add n bytes to the ledger shared by these scripts, and stop before the limit."""
    os.makedirs(WORK, exist_ok=True)
    with open(LEDGER, "a+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        raw = f.read()
        data = json.loads(raw) if raw else {}
        data[tag] = data.get(tag, 0) + n
        f.seek(0)
        f.truncate()
        json.dump(data, f)
        total = sum(data.values())
    if total > LIMIT_BYTES:
        raise SystemExit(f"download limit reached: {total} bytes")


def get_range(tag, key, start, end):
    body = s3.get_object(Bucket=BUCKET, Key=key, Range=f"bytes={start}-{end}")["Body"].read()
    spend(tag, len(body))
    return body


def listing(prefix):
    out = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        out += [{"key": o["Key"], "size": o["Size"]} for o in page.get("Contents", [])]
    return out


class RangeFile(io.RawIOBase):
    """A seekable view of one S3 object for pyarrow: only the footer and chosen column chunks are fetched."""

    def __init__(self, tag, key, size):
        self.tag, self.key, self.size, self.pos = tag, key, size, 0
        self.block, self.block_start = b"", 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        if not (self.block_start <= self.pos and self.pos + n <= self.block_start + len(self.block)):
            end = min(self.size, self.pos + max(n, 128 * 1024))
            self.block = get_range(self.tag, self.key, self.pos, end - 1)
            self.block_start = self.pos
        out = self.block[self.pos - self.block_start:self.pos - self.block_start + n]
        self.pos += len(out)
        return out

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def gz_head_lines(tag, key, size, max_bytes, chunk=4 * 1024 * 1024):
    """JSON lines from the first max_bytes of a gzip JSONL. A partial read only loses the last, unfinished line."""
    d = zlib.decompressobj(zlib.MAX_WBITS | 16)
    pos, tail = 0, b""
    while pos < min(size, max_bytes):
        end = min(pos + chunk, size, max_bytes) - 1
        raw = get_range(tag, key, pos, end)
        pos = end + 1
        data = tail + d.decompress(raw)
        lines = data.split(b"\n")
        tail = lines.pop()
        for line in lines:
            if line.strip():
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def words(s):
    return len(s.split())


def strip_tags(s):
    """Plain text from an XML or HTML fragment, with entities decoded even when they were escaped twice."""
    s = re.sub(r"<(xref|sup|fig|table-wrap|disp-formula|inline-formula|graphic|ext-link)\b[^>]*/>", " ", s)
    s = re.sub(r"<(xref|fig|table-wrap|disp-formula)\b.*?</\1>", " ", s, flags=re.S)
    s = re.sub(r"</?(italic|bold|sub|sup|sc|underline|i|b|em|strong)\b[^>]*>", "", s)
    s = re.sub(r"<[^>]+>", " ", s)
    for _ in range(3):
        decoded = html.unescape(s)
        if decoded == s:
            break
        s = decoded
    s = re.sub(r"</?[a-zA-Z][a-zA-Z0-9:-]{0,30}(\s[^<>]{0,80})?/?>", " ", s)
    s = s.replace("\u2014", ", ").replace("\xa0", " ").replace("\u2009", " ").replace("\u202f", " ")
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([,.;:?!)])", r"\1", s)
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\(\s*[,;]?\s*\)|\[\s*[,;\d\s-]*\]", "", s)
    return re.sub(r"\s{2,}", " ", s).strip()


ABBREVIATION = re.compile(r"(\b(?:Dr|Mr|Mrs|Ms|Prof|St|Mt|vs|v|No|Nos|Inc|Co|Corp|Ltd|Jr|Sr|Fig|Figs|al|e\.g|i\.e|cf|U\.S|Sec|Art|Ct|Cir|App|F|Supp|Cal|Tex|N\.Y|approx|ca)\.|\b[A-Z]\.)$")


def sentences(text):
    """Close to the splitter in lib/knowledge/wikipedia.ts, so a cut here is a cut there."""
    out = []
    for part in re.split(r"(?<=[.!?])(?<!\s)\s+(?=[A-Z0-9\"'(])", text):
        if out and ABBREVIATION.search(out[-1]):
            out[-1] += " " + part
        elif part.strip():
            out.append(part.strip())
    return out


def long_date(d):
    y, m, day = d.split("-")
    return f"{MONTHS[int(m) - 1]} {int(day)}, {y}"


def abstract_pick(sents, lead, budget=MAX_WORDS):
    """All of a short abstract. A long one keeps its opening sentence and as many closing sentences as fit: results and conclusions sit last."""
    if not sents:
        return None
    left = budget - words(lead)
    if sum(words(s) for s in sents) <= left:
        return " ".join([lead] + sents)
    head = [sents[0]] if words(sents[0]) <= min(left, 70) else []
    left -= sum(words(s) for s in head)
    tail = []
    for s in reversed(sents[len(head):]):
        n = words(s)
        if n > left:
            break
        tail.insert(0, s)
        left -= n
    if not tail:
        return None
    return " ".join([lead] + head + tail)


CONTACT = re.compile(
    r"[\w.+-]+@[\w-]+\.[a-z]{2,}|\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\bfor (further|more) information,? (please )?contact\b"
    r"|\b(media|press|investor)( relations)? (contacts?|inquiries)\b|\bproponent of this resolution\b"
    r"|\blives (in .{1,40} )?with (his|her|their) (wife|husband|partner|family)\b|\bhas (two|three|four|five|six|\d) (daughters|sons|children)\b|\bAge: \d{2}\b",
    re.I,
)
ENGLISH_WORDS = re.compile(r"\b(the|of|and|in|to|with|was|were|for|that|is|are|this|we|from)\b", re.I)


def looks_english(text):
    tokens = text.split()
    return bool(tokens) and len(ENGLISH_WORDS.findall(text)) / len(tokens) >= 0.18


def gibberish(text):
    """Leftover markup, machine-coded strings, or a mostly non-word passage."""
    if re.search(r"\\[a-z]{3,}|\$\$|</?[a-z-]+[ >]|&[a-z]+;|&#\d+;|\{\{|\}\}|\bdoi:|https?://|www\.", text):
        return True
    tokens = text.split()
    if not tokens:
        return True
    odd = sum(1 for t in tokens if not re.search(r"[^\W\d_]{2,}", t))
    return odd / len(tokens) > 0.3


def valid(record):
    """A list of problems with a record, empty when it follows the output rules."""
    bad = []
    t = record["text"]
    if not (START <= (record["date"] or "") <= END):
        bad.append("date")
    if not re.fullmatch(r"\d{4}-\d\d-\d\d", record["date"] or ""):
        bad.append("date-shape")
    if not (MIN_WORDS <= words(t) <= MAX_WORDS):
        bad.append("words")
    if not re.search(r"[.!?][\"')\]]*$", t):
        bad.append("sentence-end")
    if CONTACT.search(t):
        bad.append("contact")
    if "\u2014" in t or "\u2014" in record["title"]:
        bad.append("em-dash")
    if "\n" in t:
        bad.append("newline")
    return bad


def spread_sample(pool, target, seed=SEED, english_share=0.8):
    """A fixed-seed draw, evenly across months, about 80% English where the pool has that many, no exact duplicates of text or id."""
    rng = random.Random(seed)
    seen_text, seen_id = set(), set()
    clean = []
    for r in pool:
        norm = re.sub(r"\W+", " ", r["text"].lower()).strip()
        if norm in seen_text or r["id"] in seen_id or valid(r):
            continue
        seen_text.add(norm)
        seen_id.add(r["id"])
        clean.append(r)
    english = [r for r in clean if r["_english"]]
    other = [r for r in clean if not r["_english"]]
    n_other = min(len(other), max(0, round(target * (1 - english_share))))
    n_english = min(len(english), target - n_other)
    n_other = min(len(other), target - n_english)

    def by_month(rows, n):
        groups = {}
        for r in rows:
            groups.setdefault(r["date"][:7], []).append(r)
        for g in groups.values():
            rng.shuffle(g)
        out = []
        order = sorted(groups)
        while len(out) < n and any(groups.values()):
            for m in order:
                if groups[m] and len(out) < n:
                    out.append(groups[m].pop())
        return out

    return by_month(english, n_english) + by_month(other, n_other)


def write_set(name, picked):
    """Writes the final file, checking every record, and prints the measured counts."""
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"s3-{name}.jsonl")
    fields = ("id", "source", "title", "url", "date", "license", "visibility", "text")
    problems = Counter()
    rows = []
    for r in sorted(picked, key=lambda x: (x["date"], x["id"])):
        issues = valid(r)
        if issues:
            problems.update(issues)
            continue
        rows.append({k: r[k] for k in fields})
    with open(path, "w", encoding="utf8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    months = Counter(r["date"][:7] for r in rows)
    print(json.dumps({"set": name, "written": len(rows), "problems": problems, "months": dict(sorted(months.items())), "english": sum(1 for r in picked if r.get("_english")), "visibility": Counter(r["visibility"] for r in rows), "words": [min((words(r["text"]) for r in rows), default=0), max((words(r["text"]) for r in rows), default=0)]}))
    return path
