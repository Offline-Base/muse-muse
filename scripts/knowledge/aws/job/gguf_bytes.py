"""Where a GGUF's bytes go: reads the header only (no gguf package, no tensor data) and sums bytes and bits per weight
by tensor kind and by ggml type. Tensor bytes come from the gaps between offsets, so alignment padding is included.

Usage: python gguf_bytes.py FILE.gguf [FILE2.gguf ...] [--json OUT.json]
"""

import json
import os
import re
import struct
import sys
from collections import defaultdict

SCALARS = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}
# Enum values from ggml.h in llama.cpp b11970 (checked against its --help ids where they coincide with ftypes).
TYPES = {0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1", 10: "Q2_K", 11: "Q3_K", 12: "Q4_K",
         13: "Q5_K", 14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S",
         22: "IQ2_S", 23: "IQ4_XS", 24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64", 29: "IQ1_M", 30: "BF16",
         34: "TQ1_0", 35: "TQ2_0", 39: "MXFP4", 40: "NVFP4", 41: "Q1_0", 42: "Q2_0"}


def kind(name):
    if name == "token_embd.weight":
        return "token embedding"
    if name == "output.weight":
        return "output"
    if name == "output_norm.weight" or "norm" in name:
        return "norms"
    m = re.search(r"blk\.\d+\.(.+)\.(weight|bias)$", name)
    part = m.group(1) if m else name
    if part.startswith("attn_"):
        return "attention " + part.removeprefix("attn_")
    if part.startswith("ffn_"):
        return "MLP " + part.removeprefix("ffn_")
    return "other " + part


def read_header(path):
    with open(path, "rb") as f:
        def u(fmt):
            return struct.unpack("<" + fmt, f.read(struct.calcsize("<" + fmt)))[0]

        def s():
            return f.read(u("Q")).decode("utf-8", "replace")

        def skip(t):
            if t == 8:
                f.seek(u("Q"), 1)
            elif t == 9:
                et, n = u("I"), u("Q")
                if et == 8:
                    for _ in range(n):
                        f.seek(u("Q"), 1)
                else:
                    f.seek(n * struct.calcsize("<" + SCALARS[et]), 1)
            else:
                f.seek(struct.calcsize("<" + SCALARS[t]), 1)

        if f.read(4) != b"GGUF":
            raise SystemExit(path + ": not a GGUF")
        u("I")
        n_tensors, n_kv = u("Q"), u("Q")
        align = 32
        for _ in range(n_kv):
            key, t = s(), u("I")
            if key == "general.alignment":
                align = u("I")
            else:
                skip(t)
        tensors = []
        for _ in range(n_tensors):
            name = s()
            dims = [u("Q") for _ in range(u("I"))]
            t, off = u("I"), u("Q")
            tensors.append({"name": name, "dims": dims, "type": t, "offset": off})
        meta_end = f.tell()
    size = os.path.getsize(path)
    data_start = (meta_end + align - 1) // align * align
    order = sorted(tensors, key=lambda x: x["offset"])
    for a, b in zip(order, order[1:] + [{"offset": size - data_start}]):
        a["bytes"] = b["offset"] - a["offset"]
        n = 1
        for d in a["dims"]:
            n *= d
        a["n"] = n
    return {"path": path, "size": size, "header_bytes": data_start, "tensors": order}


def table(h):
    by = defaultdict(lambda: {"bytes": 0, "n": 0, "count": 0, "types": defaultdict(int)})
    for t in h["tensors"]:
        r = by[kind(t["name"])]
        r["bytes"] += t["bytes"]
        r["n"] += t["n"]
        r["count"] += 1
        r["types"][TYPES.get(t["type"], str(t["type"]))] += t["bytes"]
    return by


def main():
    args = sys.argv[1:]
    out = None
    if "--json" in args:
        i = args.index("--json")
        out = args[i + 1]
        del args[i:i + 2]
    dump = {}
    for path in args:
        h = read_header(path)
        by = table(h)
        total_n = sum(t["n"] for t in h["tensors"])
        print(f"\n{os.path.basename(path)}: {h['size'] / 1e9:.3f} GB, {len(h['tensors'])} tensors, {total_n / 1e9:.2f}B weights, "
              f"{h['size'] * 8 / total_n:.3f} bits per weight overall; header and tokenizer {h['header_bytes'] / 1e6:.1f} MB")
        print(f"{'kind':<24}{'tensors':>8}{'weights (M)':>13}{'MB':>10}{'share':>8}{'bits':>7}  types (MB)")
        for k, r in sorted(by.items(), key=lambda x: -x[1]["bytes"]):
            types = ", ".join(f"{a} {b / 1e6:.0f}" for a, b in sorted(r["types"].items(), key=lambda x: -x[1]))
            print(f"{k:<24}{r['count']:>8}{r['n'] / 1e6:>13.1f}{r['bytes'] / 1e6:>10.1f}{100 * r['bytes'] / h['size']:>7.1f}%{r['bytes'] * 8 / max(1, r['n']):>7.2f}  {types}")
        names = {t["name"] for t in h["tensors"]}
        print(f"output.weight present: {'output.weight' in names}; token_embd.weight present: {'token_embd.weight' in names}")
        dump[path] = {"size": h["size"], "header_bytes": h["header_bytes"], "weights": total_n,
                      "kinds": {k: {"bytes": r["bytes"], "weights": r["n"], "tensors": r["count"], "types": dict(r["types"])} for k, r in by.items()}}
    if out:
        with open(out, "w") as f:
            json.dump(dump, f, indent=1)


if __name__ == "__main__":
    main()
