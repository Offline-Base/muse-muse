"""Pull candidate dated paragraphs from a byte range of one enwiki incremental dump.

These dumps are one bzip2 stream sorted by page id, so new articles sit at the end. A bzip2 block can start at any bit:
find the block magic, shift the bytes so it aligns, put a stream header in front and decode. Only the last revision of a
main-namespace page counts, and pages last edited by an anonymous or temporary account are skipped as a vandalism guard.
Usage: wm_tail.py <yyyymmdd> <megabytes> <position: tail|mid> <outfile>
"""
import bz2, json, os, re, sys, time, html
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
import mwparserfromhell as mw

day, mb, pos, outp = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
key = f"{common.PREFIX}wikimedia/incr/enwiki/{day}/enwiki-{day}-pages-meta-hist-incr.xml.bz2"
c = common.s3()
size = c.head_object(Bucket=common.BUCKET, Key=key)["ContentLength"]
a = size - mb * 1_000_000 if pos == "tail" else size // 2
b = min(size - 1, a + mb * 1_000_000)
blob = common.get_range(c, key, a, b)

MAGIC = 0x314159265359


def find_block(data):
    window = data[:8_000_000]
    best = None
    for s in range(8):
        pat = (MAGIC << (8 - s)).to_bytes(7, "big")  # the magic starting s bits into a byte
        core = pat[1:6]
        i = window.find(core)
        while i != -1:
            st = i - 1
            if st >= 0:
                v = int.from_bytes(window[st:st + 7], "big") >> (8 - s)
                if v & ((1 << 48) - 1) == MAGIC and (best is None or st * 8 + s < best[0] * 8 + best[1]):
                    best = (st, s)
                    break
            i = window.find(core, i + 1)
    return best


st, s = find_block(blob)
big = int.from_bytes(blob[st:], "big") << s
aligned = big.to_bytes(len(blob) - st + 1, "big")[1:] if s else blob[st:]
del big, blob

MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
D1 = re.compile(rf"\b({MONTHS}) (\d{{1,2}}),? (2026)\b")
D2 = re.compile(rf"\b(\d{{1,2}}) ({MONTHS}),? (2026)\b")
DROP_T = re.compile(r"^\s*(sfn|sfnp|harv|harvnb|efn|r\b|rp\b|cite|citation|cn\b|fact|update|dubious|when\b|who\b|clarify|better source|by whom|according to whom|failed verification|full citation|page needed|verify|nbsp|'|-\b|anchor|main|see also)", re.I)
TEMPL = re.compile(r"\{\{([^{}]*)\}\}")


def templates(t):
    bad = False

    def sub(m):
        nonlocal bad
        body = m.group(1)
        p = [x.strip() for x in body.split("|")]
        n = p[0].lower()
        if DROP_T.match(n):
            return ""
        if n in ("nowrap", "nobr", "lang", "transliteration", "small", "abbr", "wikt-lang", "ill", "interlanguage link", "em", "sic", "lang-x"):
            if n in ("lang", "transliteration", "wikt-lang", "lang-x") and len(p) > 2:
                return p[2]
            return p[1] if len(p) > 1 else ""
        if n in ("convert", "cvt") and len(p) > 2:
            return f"{p[1]} {p[2]}"
        if n in ("usd", "us$", "gbp", "eur", "£", "€") and len(p) > 1:
            return {"usd": "$", "us$": "$", "gbp": "£", "£": "£", "eur": "€", "€": "€"}[n] + p[1]
        bad = True
        return ""

    for _ in range(6):
        t2 = TEMPL.sub(sub, t)
        if t2 == t:
            break
        t = t2
    if "{{" in t or "}}" in t:
        bad = True
    return t, bad


REF = re.compile(r"<ref\b[^>]*/>|<ref\b[^>]*>.*?</ref>", re.S | re.I)
COMMENT = re.compile(r"<!--.*?-->", re.S)
TABLE = re.compile(r"\{\|.*?\|\}", re.S)
BAD_LINE = re.compile(r"^\s*[|!{}*#:;=<\[]")
PRIVATE = re.compile(r"\b(murder\w*|homicide|manslaughter|stabb\w+|arrest\w*|charged with|indicted|convicted|sentenced|pleaded|suspect\w*|defendant|plaintiff|lawsuit|sued|rape\w*|sexual\w*|assault\w*|victim\w*|kidnap\w*|shot and killed|fatally|car crash|car accident|overdose|suicide|custody|divorc\w*|married|marriage|wife|husband|spouse|daughter|her son|his son|their son|children|girlfriend|boyfriend|her father|his father|her mother|his mother|parents|grandson|granddaughter|pregnan\w*|gave birth|born to)\b", re.I)
FUTURE = re.compile(r"\b(will be|will take|will host|will begin|will start|will run|will feature|will air|will premiere|is scheduled|are scheduled|scheduled to|is expected|are expected|is set to|are set to|planned for|upcoming)\b", re.I)
SELF = re.compile(r"\b(this article|wikipedia|retrieved|archived from|see also|external links|references)\b", re.I)
ISO = {m: i + 1 for i, m in enumerate(MONTHS.split("|"))}


def date_of(p):
    hits = []
    for m in D1.finditer(p):
        hits.append((m.start(), int(m.group(2)), ISO[m.group(1)]))
    for m in D2.finditer(p):
        hits.append((m.start(), int(m.group(1)), ISO[m.group(2)]))
    hits.sort()
    for _, d, mon in hits:
        iso = f"2026-{mon:02d}-{d:02d}"
        if common.in_window(iso) and d <= 31:
            return iso
    return None


SKIP_SECT = re.compile(r"(see also|references|external links|notes|further reading|bibliography|career statistics|filmography|discography|personal life|early life.*)", re.I)


def paras(title, text):
    if "2026" not in text:
        return
    text = COMMENT.sub("", text)
    text = REF.sub("", text)
    text = TABLE.sub("", text)
    sect = ""
    for line in text.split("\n"):
        m = re.match(r"^(={2,4})\s*(.*?)\s*\1\s*$", line)
        if m:
            sect = m.group(2)
            continue
        if "2026" not in line or len(line) < 200 or BAD_LINE.match(line):
            continue
        if SKIP_SECT.fullmatch(sect):
            continue
        line, bad = templates(line)
        if bad:
            continue
        try:
            plain = mw.parse(line).strip_code(normalize=True, collapse=True)
        except Exception:
            continue
        plain = html.unescape(re.sub(r"<[^>]+>", "", plain))
        plain = re.sub(r"\s+", " ", plain).strip()
        plain = re.sub(r"\s+([,.;:])", r"\1", plain).replace("( ", "(").replace(" )", ")").replace("()", "").strip()
        if "'''" in plain or "[[" in plain or "]]" in plain or "|" in plain or "http" in plain:
            continue
        if common.wc(plain) < 40:
            continue
        d = date_of(plain)
        if not d or PRIVATE.search(plain) or FUTURE.search(plain) or SELF.search(plain):
            continue
        yield sect, d, plain


dec = bz2.BZ2Decompressor()
out = open(outp, "w")
buf = b""
pages = kept = 0
raw = 0
t0 = time.time()
TITLE = re.compile(rb"<title>(.*?)</title>")
NS = re.compile(rb"<ns>(\d+)</ns>")
PID = re.compile(rb"<id>(\d+)</id>")


def handle(page):
    global pages, kept
    pages += 1
    head = page[:600]
    ns = NS.search(head)
    if ns is None or ns.group(1) != b"0" or b"<redirect" in head:
        return
    i = page.rfind(b"<revision>")
    if i < 0:
        return
    rev = page[i:]
    if b"2026" not in rev:
        return
    con = re.search(rb"<contributor>(.*?)</contributor>", rev, re.S)
    if not con or b"<ip>" in con.group(1) or b"<username>~" in con.group(1):
        return
    ts = re.search(rb"<timestamp>([^<]+)</timestamp>", rev)
    m = re.search(rb"<text\b[^>]*>(.*?)</text>", rev, re.S)
    if not m:
        return
    title = html.unescape(TITLE.search(head).group(1).decode("utf8", "replace"))
    text = html.unescape(m.group(1).decode("utf8", "replace"))
    if re.search(r"\{\{\s*(disambig|in use|under construction)", text[:500], re.I):
        return
    n = 0
    for sect, d, plain in paras(title, text):
        out.write(json.dumps(dict(title=title, pid=int(PID.search(head).group(1)), sect=sect, date=d, text=plain, day=day, rev_ts=ts.group(1).decode() if ts else None, nwords=len(text.split())), ensure_ascii=False) + "\n")
        kept += 1
        n += 1
        if n >= 6:
            break


data = b"BZh9" + aligned
del aligned
try:
    for off in range(0, len(data), 1 << 20):
        chunk = dec.decompress(data[off:off + (1 << 20)])
        raw += len(chunk)
        buf += chunk
        while True:
            e = buf.find(b"</page>")
            if e < 0:
                break
            s0 = buf.rfind(b"<page>", 0, e)
            if s0 >= 0:
                handle(buf[s0:e])
            buf = buf[e + 7:]
except (OSError, EOFError) as ex:
    print("decoder stopped:", ex)
out.close()
print(day, pos, "compressed", len(data), "raw", raw, "pages", pages, "kept", kept, "secs", round(time.time() - t0))
