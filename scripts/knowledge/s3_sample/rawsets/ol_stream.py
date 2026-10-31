"""Stream the head of the Open Library editions dump and keep editions with a full 2026 publish date. Usage: ol_stream.py <MB> <out>"""
import gzip, json, os, re, sys, time, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
mb, outp = int(sys.argv[1]), sys.argv[2]
key = f"{common.PREFIX}openlibrary/2026-09-30/ol_dump_editions_2026-09-30.txt.gz"
c = common.s3()
dec = zlib.decompressobj(31)
tail = b""
got = raw = rows = kept = 0
FULL = re.compile(rb'"publish_date": "[^"]*2026[^"]*"')
out = open(outp, "w")
t0 = time.time()
for piece in common.stream(c, key, 0, mb * 1_000_000):
    got += len(piece)
    data = dec.decompress(piece)
    raw += len(data)
    buf = tail + data
    i = buf.rfind(b"\n")
    if i < 0:
        tail = buf
        continue
    lines, tail = buf[:i].split(b"\n"), buf[i + 1:]
    rows += len(lines)
    for ln in lines:
        if FULL.search(ln):
            j = ln.find(b"{")
            out.write(ln[j:].decode("utf8", "replace") + "\n")
            kept += 1
    if got % (50 << 20) < (1 << 20):
        print("got", got, "raw", raw, "rows", rows, "kept", kept, "t", round(time.time() - t0), flush=True)
out.close()
print("done got", got, "raw", raw, "rows", rows, "kept", kept, "secs", round(time.time() - t0), flush=True)
