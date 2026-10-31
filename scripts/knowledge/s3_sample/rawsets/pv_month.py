"""Sum a whole month of en.wikipedia human pageviews from the monthly dump.

en.wikipedia is one contiguous span of the sorted file, so the job starts just before it and stops at the first block
past it. Only page lines with at least 100 views in one access method are kept, which can't change a top list.
Usage: pv_month.py <yyyy-mm> <outfile>
"""
import bz2, json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
MAGIC = 0x314159265359
ym, outp = sys.argv[1], sys.argv[2]
key = f"{common.PREFIX}pageviews/{ym}/pageviews-{ym.replace('-', '')}-user.bz2"
c = common.s3()
size = c.head_object(Bucket=common.BUCKET, Key=key)["ContentLength"]

def align(blob):
    best = None
    for s in range(8):
        core = (MAGIC << (8 - s)).to_bytes(7, "big")[1:6]
        i = blob.find(core)
        while i != -1:
            st = i - 1
            if st >= 0 and int.from_bytes(blob[st:st + 7], "big") >> (8 - s) & ((1 << 48) - 1) == MAGIC:
                if best is None or st * 8 + s < best[0] * 8 + best[1]: best = (st, s)
                break
            i = blob.find(core, i + 1)
    return best

def shifted(blob, s):
    big = int.from_bytes(blob, "big") << s
    return big.to_bytes(len(blob) + 1, "big")[1:] if s else blob

def first_project(off):
    blob = common.get_range(c, key, off, off + 3_000_000)
    st, s = align(blob)
    try:
        out = bz2.BZ2Decompressor().decompress(b"BZh9" + shifted(blob[st:], s))
    except OSError:
        out = b""
    lines = out.split(b"\n")
    return off + st, s, (lines[1].split(b" ")[0].decode() if len(lines) > 2 else None)

frac = 0.235
while True:
    off, s, p = first_project(int(size * frac))
    print("probe", frac, off, p, flush=True)
    if p is not None and p < "en.wikipedia": break
    frac -= 0.008

LINE = re.compile(rb"^en\.wikipedia ([^ ]+) [^ ]+ (?:desktop|mobile-web|mobile-app) (\d{3,}) ", re.M)
views = {}
dec = bz2.BZ2Decompressor()
dec.decompress(b"BZh9")
stream = common.stream(c, key, off)
carry = None
raw = got = 0
tail = b""
done = False
t0 = time.time()
for piece in stream:
    got += len(piece)
    if s:
        n = len(piece)
        v = int.from_bytes(piece, "big")
        if carry is None:
            bits = 8 * n - s
            v &= (1 << bits) - 1
        else:
            bits = (8 - s) + 8 * n
            v |= carry << (8 * n)
        left = bits % 8
        data = (v >> left).to_bytes(bits // 8, "big")
        carry = v & ((1 << left) - 1)
    else:
        data = piece
    out = dec.decompress(data)
    raw += len(out)
    if not out: continue
    buf = tail + out
    i = buf.rfind(b"\n")
    if i < 0: tail = buf; continue
    body, tail = buf[:i + 1], buf[i + 1:]
    for t, n in LINE.findall(body):
        views[t] = views.get(t, 0) + int(n)
    # The first line of the last complete stretch tells us when we've left en.wikipedia.
    last = body[body.rfind(b"\n", 0, len(body) - 1) + 1:]
    if last and last.split(b" ")[0] > b"en.wikipedia" and last.startswith(b"en."):
        if got > 1: done = True
    elif last and not last.startswith(b"en") and last.split(b" ")[0] > b"en.wikipedia":
        done = True
    if done: break
    if got % (100 << 20) < (1 << 20):
        print("got", got, "raw", raw, "titles", len(views), "t", round(time.time() - t0), flush=True)
top = sorted(views.items(), key=lambda kv: -kv[1])[:3000]
json.dump(dict(month=ym, got=got, raw=raw, complete=done, top=[[k.decode("utf8", "replace"), v] for k, v in top]), open(outp, "w"), ensure_ascii=False)
print("finished", ym, "got", got, "raw", raw, "complete", done, "titles", len(views), "secs", round(time.time() - t0), flush=True)
