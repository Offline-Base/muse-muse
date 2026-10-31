"""Read a pg_dump custom-format TOC from a local head of the file and print each table's data offset and block size."""
import struct, sys, json

def parse(path, total=None):
    d = open(path, "rb").read()
    p = 5
    vmaj, vmin, vrev, ints, offs, fmt = d[p:p+6]; p += 6
    p += 1  # compression algorithm
    def rint():
        nonlocal p
        sign = d[p]; v = int.from_bytes(d[p+1:p+1+ints], "little"); p += 1 + ints
        return -v if sign else v
    def rstr():
        nonlocal p
        n = rint()
        if n < 0: return None
        s = d[p:p+n].decode("utf8", "replace"); p += n
        return s
    for _ in range(7): rint()
    rstr(); rstr(); rstr()
    n = rint()
    out = []
    for _ in range(n):
        did = rint(); had = rint()
        rstr(); rstr()
        tag = rstr(); desc = rstr(); sec = rint()
        defn = rstr(); rstr(); copy = rstr(); rstr(); rstr(); rstr()
        rint()  # relkind (1.16)
        rstr(); rstr()
        while rstr() is not None: pass
        flag = d[p]; off = int.from_bytes(d[p+1:p+1+offs], "little"); p += 1 + offs
        if desc == "TABLE DATA":
            out.append(dict(id=did, tag=tag, copy=copy, flag=flag, off=off))
    out.sort(key=lambda r: r["off"])
    for a, b in zip(out, out[1:] + [None]):
        a["size"] = (b["off"] if b else (total or a["off"])) - a["off"]
    return out, p

if __name__ == "__main__":
    t, end = parse(sys.argv[1], int(sys.argv[2]))
    json.dump(t, open(sys.argv[3], "w"), indent=0)
    for r in t: print(r["flag"], r["off"], round(r["size"]/1e6, 1), r["tag"], (r["copy"] or "")[:200])
    print("toc end", end)
