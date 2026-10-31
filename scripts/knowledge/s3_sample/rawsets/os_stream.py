"""Stream the Open States pg_dump from its start, decode the first tables, and keep 2026 bills that show an enactment.
pg_dump wrote this file to stdout, so its TOC has no offsets and tables can only be reached in order; bill tables come
early, so the stream stops at MAX_GB or after the bill abstracts, whichever comes first."""
import json, os, sys, zlib, re, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
KEY = common.PREFIX + "openstates/2026-10-public.pgdump"
MAX = int(float(sys.argv[1]) * 1e9)
SP = common.SP
toc = {r["id"]: r for r in json.load(open(os.path.join(SP, "dl/os/toc.json")))}
TOC_END = 13614
c = common.s3()

class R:
    def __init__(self, a):
        self.it = common.stream(c, KEY, a); self.buf = bytearray(); self.got = 0
    def need(self, n):
        while len(self.buf) < n:
            try: p = next(self.it)
            except StopIteration: raise EOFError
            self.buf += p; self.got += len(p)
    def read(self, n):
        self.need(n); r = bytes(self.buf[:n]); del self.buf[:n]; return r
    def rint(self):
        b = self.read(5); v = int.from_bytes(b[1:], "little"); return -v if b[0] else v

r = R(TOC_END)
UNESC = {"N": None}
def unesc(s):
    if s == r"\N": return None
    if "\\" not in s: return s
    return s.replace(r"\t", "\t").replace(r"\n", "\n").replace(r"\r", " ").replace("\\\\", "\\")

keep = {}
tables = {"opencivicdata_jurisdiction": [], "opencivicdata_legislativesession": []}
bills = open(os.path.join(SP, "dl/os/bills.jsonl"), "w")
abstracts = open(os.path.join(SP, "dl/os/abstracts.jsonl"), "w")
ENACT = re.compile(r"\b(signed|enacted|became law|becomes law|chapter(ed)?\b|public act|act no|session law|approved by (the )?governor|governor approved|effective without|filed with secretary of state|without (the )?governor'?s signature|gov(ernor)?\.? sign)", re.I)
stats = dict(rows=0, y2026=0, enact=0, seen_tables=[])
t0 = time.time()
stop = False
while not stop:
    kind = r.read(1)[0]
    did = r.rint()
    meta = toc[did]
    tag = meta["tag"]
    print("table", tag, "at", r.got, "t", round(time.time() - t0), flush=True)
    stats["seen_tables"].append([tag, r.got])
    if tag == "opencivicdata_billaction": break
    cols = re.search(r"\((.*)\) FROM", meta["copy"]).group(1).replace('"', "").split(", ")
    z = zlib.decompressobj()
    tail = b""
    interesting = tag in ("opencivicdata_jurisdiction", "opencivicdata_legislativesession", "opencivicdata_bill", "opencivicdata_billabstract")
    while True:
        n = r.rint()
        if n == 0: break
        data = r.read(n)
        if not interesting: continue
        raw = tail + z.decompress(data)
        i = raw.rfind(b"\n")
        if i < 0: tail = raw; continue
        lines, tail = raw[:i], raw[i + 1:]
        for ln in lines.decode("utf8", "replace").split("\n"):
            if ln == "\\.": continue
            f = ln.split("\t")
            if len(f) != len(cols): continue
            if tag == "opencivicdata_bill":
                stats["rows"] += 1
                rec = dict(zip(cols, f))
                if not (rec.get("latest_action_date") or "").startswith("2026"): continue
                stats["y2026"] += 1
                d = rec.get("latest_action_description") or ""
                if not ENACT.search(d): continue
                stats["enact"] += 1
                bills.write(json.dumps({k: unesc(v) for k, v in rec.items() if k not in ("extras", "citations")}) + "\n")
            elif tag == "opencivicdata_billabstract":
                a = dict(zip(cols, f))
                abstracts.write(json.dumps({"bill_id": a["bill_id"], "abstract": unesc(a["abstract"])}) + "\n")
            else:
                tables[tag].append({k: unesc(v) for k, v in zip(cols, f) if k != "extras"})
        if r.got > MAX:
            print("budget stop in", tag, flush=True); stop = True; break
    json.dump(tables, open(os.path.join(SP, "dl/os/tables.json"), "w"))
    json.dump(stats, open(os.path.join(SP, "dl/os/stats.json"), "w"))
    bills.flush(); abstracts.flush()
print("done got", r.got, stats, flush=True)
json.dump(stats, open(os.path.join(SP, "dl/os/stats.json"), "w"))
