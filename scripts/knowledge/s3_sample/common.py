"""Shared helpers for the S3 sample writers: S3 access with a byte ledger, sentence cuts and record checks."""
import json, os, random, re, time
import boto3

BUCKET = os.environ.get("KNOWLEDGE_BUCKET", "<set KNOWLEDGE_BUCKET>")  # the knowledge bucket; its name holds the AWS account id, so it stays out of the repo
PREFIX = "knowledge/raw/"
SP = os.environ["S3S_SP"]
LEDGER = os.path.join(SP, "ledger.tsv")
OUT = os.environ.get("S3S_OUT", "/Users/ethancastro/muse-muse/.data/knowledge/sources")
SEED = 20261030
WINDOW = ("2026-01-04", "2026-10-29")

def s3():
    return boto3.Session(profile_name="offlinebase", region_name="us-east-1").client("s3")

def note(key, n):
    with open(LEDGER, "a") as f:
        f.write(f"{time.time():.0f}\t{key}\t{n}\n")

def get_range(c, key, a, b):
    r = c.get_object(Bucket=BUCKET, Key=key, Range=f"bytes={a}-{b}")["Body"].read()
    note(key, len(r))
    return r

def stream(c, key, a=0, b=None, chunk=1 << 20):
    """Yield chunks of an object, writing to the ledger as they arrive so a killed job still counts."""
    rng = {"Range": f"bytes={a}-{'' if b is None else b}"} if a or b is not None else {}
    body = c.get_object(Bucket=BUCKET, Key=key, **rng)["Body"]
    pending = 0
    for piece in body.iter_chunks(chunk):
        pending += len(piece)
        if pending >= 1 << 24:
            note(key, pending); pending = 0
        yield piece
    note(key, pending)

def fetch(c, key, subdir="fetch"):
    """Download a small object once to the scratch directory and return its path."""
    d = os.path.join(SP, "dl", subdir); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, key.replace("/", "__"))
    if not os.path.exists(p):
        c.download_file(BUCKET, key, p)
        note(key, os.path.getsize(p))
    return p

MONTHS = "January February March April May June July August September October November December".split()
MONTH_NUM = {m: i + 1 for i, m in enumerate(MONTHS)}

def long_date(iso):
    y, m, d = iso.split("-")
    return f"{MONTHS[int(m)-1]} {int(d)}, {y}"

def month_name(iso):
    y, m = iso.split("-")[:2]
    return f"{MONTHS[int(m)-1]} {y}"

def in_window(iso):
    return bool(iso) and bool(re.fullmatch(r"\d{4}-\d\d-\d\d", iso)) and WINDOW[0] <= iso <= WINDOW[1]

def wc(s):
    return len(s.split())

SENT = re.compile(r"(?<=[.!?])[\"')\]]*\s+(?=[\"'(\[]*[A-Z0-9])")
ABBR = re.compile(r"(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|No|Nos|vs|U\.S|U\.K|Inc|Ltd|Co|Corp|Gov|Sen|Rep|Gen|Lt|Col|Sgt|Capt|Hon|Rev|Pres|Sec|Art|e\.g|i\.e|etc|al|approx|ca|cf|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mt|Ft)\.|\b[A-Z]\.)$")

def sentences(text):
    out, cur = [], ""
    for part in SENT.split(text):
        cur = f"{cur} {part}".strip() if cur else part.strip()
        if ABBR.search(cur):
            continue
        out.append(cur); cur = ""
    if cur:
        out.append(cur)
    return [s for s in out if s]

def cut(text, max_words=210):
    """At most max_words, ending at a sentence end. Returns "" if even the first sentence is too long."""
    taken, n = [], 0
    for s in sentences(text):
        k = wc(s)
        if n + k > max_words:
            break
        taken.append(s); n += k
    res = " ".join(taken).strip()
    return res if re.search(r"[.!?][\"')\]]*$", res) else ""

CONTACT = re.compile(r"[\w.+-]+@[\w-]+\.[a-z]{2,}|\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|https?://|www\.", re.I)
EM = "—"

def clean_dash(s):
    return s.replace(" " + EM + " ", ", ").replace(EM, ", ")

def record(source_id, source, title, url, date, license_, visibility, text):
    text = clean_dash(text).strip()
    assert in_window(date), date
    return dict(id=source_id, source=source, title=clean_dash(title), url=url, date=date, license=license_, visibility=visibility, text=text)

def good(rec):
    n = wc(rec["text"])
    return 40 <= n <= 210 and in_window(rec["date"]) and not CONTACT.search(rec["text"]) and re.search(r"[.!?][\"')\]]*$", rec["text"])

def write(setname, recs, cap=None):
    """Sort by id, drop exact duplicate texts and ids, enforce the record rules, cap with even spread by month."""
    seen, ids, kept = set(), set(), []
    for r in recs:
        if not good(r): continue
        k = re.sub(r"\W+", " ", r["text"].lower()).strip()
        if k in seen or r["id"] in ids: continue
        seen.add(k); ids.add(r["id"]); kept.append(r)
    if cap and len(kept) > cap:
        kept = spread(kept, cap)
    kept.sort(key=lambda r: (r["date"], r["id"]))
    p = os.path.join(OUT, f"s3-{setname}.jsonl")
    with open(p, "w") as f:
        for r in kept:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    months = {}
    for r in kept: months[r["date"][:7]] = months.get(r["date"][:7], 0) + 1
    print(setname, len(kept), dict(sorted(months.items())))
    return kept

def spread(recs, cap):
    """Round robin over months with a fixed seed, so a month rich in candidates can't crowd the others out."""
    rnd = random.Random(SEED)
    by = {}
    for r in sorted(recs, key=lambda r: r["id"]):
        by.setdefault(r["date"][:7], []).append(r)
    for v in by.values(): rnd.shuffle(v)
    out = []
    while len(out) < cap and any(by.values()):
        for m in sorted(by):
            if by[m] and len(out) < cap:
                out.append(by[m].pop())
    return out
