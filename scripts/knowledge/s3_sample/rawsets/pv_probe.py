"""Find where en.wikipedia starts and ends in a monthly pageviews bz2 by decoding single blocks at probe offsets."""
import bz2, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
MAGIC = 0x314159265359
c = common.s3()
key = sys.argv[1]
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

def probe(off, n=3_000_000):
    blob = common.get_range(c, key, off, off + n)
    st, s = align(blob)
    big = int.from_bytes(blob[st:], "big") << s
    data = big.to_bytes(len(blob) - st + 1, "big")[1:] if s else blob[st:]
    d = bz2.BZ2Decompressor()
    try:
        out = d.decompress(b"BZh9" + data)
    except OSError:
        out = b""
    lines = out.split(b"\n")
    return off + st, (lines[1:3] if len(lines) > 3 else [])

def proj(off):
    a, l = probe(off)
    return l[0].split(b" ")[0].decode() if l else None, l[:1]

for pct in (0.01, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
    print(pct, proj(int(size * pct)), flush=True)
lo, hi = 0, size
for _ in range(9):
    mid = (lo + hi) // 2
    p, _l = proj(mid)
    print("low", mid, p, flush=True)
    if p is None or p < "en.wikipedia": lo = mid
    else: hi = mid
print("start between", lo, hi)
lo2, hi2 = hi, size
for _ in range(9):
    mid = (lo2 + hi2) // 2
    p, _l = proj(mid)
    print("high", mid, p, flush=True)
    if p is None or p <= "en.wikipedia": lo2 = mid
    else: hi2 = mid
print("end between", lo2, hi2, "size", size)
