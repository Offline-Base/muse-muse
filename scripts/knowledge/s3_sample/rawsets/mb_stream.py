"""Stream MusicBrainz JSON dumps from the start of a tar.xz and keep rows with a 2026 date. Usage: mb_stream.py <file> <MB> <regex> <out>"""
import json, lzma, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
name, mb, pat, outp = sys.argv[1], int(sys.argv[2]), sys.argv[3].encode(), sys.argv[4]
key = f"{common.PREFIX}musicbrainz/20261028-001001/{name}.tar.xz"
c = common.s3()
pat = re.compile(pat)
dec = lzma.LZMADecompressor()
tail = b""
got = raw = rows = kept = 0
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
    for ln in lines:
        rows += 1
        if pat.search(ln):
            j = ln.find(b'{"')
            if j >= 0:
                out.write(ln[j:].decode("utf8", "replace") + "\n")
                kept += 1
    if got % (50 << 20) < (1 << 20):
        print(name, "got", got, "rows", rows, "kept", kept, "t", round(time.time() - t0), flush=True)
out.close()
print("done", name, "got", got, "raw", raw, "rows", rows, "kept", kept, "secs", round(time.time() - t0), flush=True)
