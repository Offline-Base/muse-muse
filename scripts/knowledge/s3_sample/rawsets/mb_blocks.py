"""Random access to a MusicBrainz tar.xz: the xz index lists its independently compressed blocks, so single blocks can be
range-read and decoded with the stream header in front. Usage: mb_blocks.py <file> <every Nth block> <out>"""
import json, lzma, os, re, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
name, step, outp = sys.argv[1], int(sys.argv[2]), sys.argv[3]
key = f"{common.PREFIX}musicbrainz/20261028-001001/{name}.tar.xz"
c = common.s3()
size = c.head_object(Bucket=common.BUCKET, Key=key)["ContentLength"]
foot = common.get_range(c, key, size - 12, size - 1)
bs = (struct.unpack("<I", foot[4:8])[0] + 1) * 4
idx = common.get_range(c, key, size - 12 - bs, size - 13)
head = common.get_range(c, key, 0, 11)
p = 1
def vi():
    global p
    v = s = 0
    while True:
        b = idx[p]; p += 1; v |= (b & 127) << s; s += 7
        if not b & 128: return v
n = vi()
blocks, off = [], 12
for _ in range(n):
    up, _un = vi(), vi()
    blocks.append((off, up))
    off += (up + 3) & ~3
print("blocks", n)
PAT = re.compile(rb'"first-release-date":"2026-\d\d-\d\d"')
out = open(outp, "w")
kept = rows = got = 0
dates = {}
for i in range(0, n, step):
    a, up = blocks[i]
    data = common.get_range(c, key, a, a + ((up + 3) & ~3) - 1)
    got += len(data)
    raw = lzma.LZMADecompressor(format=lzma.FORMAT_XZ).decompress(head + data)
    lines = raw.split(b"\n")[1:-1]
    rows += len(lines)
    m = 0
    for ln in lines:
        if not PAT.search(ln): continue
        try: g = json.loads(ln)
        except Exception: continue
        d = g.get("first-release-date") or ""
        if not d.startswith("2026-"): continue
        m += 1
        out.write(ln.decode("utf8", "replace") + "\n")
    kept += m
    dates[i] = m
    if i % (step * 10) == 0: print(i, "rows", rows, "kept", kept, flush=True)
out.close()
print("done got", got, "rows", rows, "kept", kept, "per block", list(dates.values())[:60])
