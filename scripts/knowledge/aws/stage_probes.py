"""Stage 2 eval probes: the fixed 1,500 (stage 1 retention) plus 1,000 from passages stage 1 never trained on.

Writes .data/knowledge/dataset/stage2-new-probes.jsonl and stage2-eval-probes.jsonl (the two together). Run after
assemble-dataset.ts has written train-stage2.jsonl and its probes: python3 scripts/knowledge/aws/stage_probes.py [N]
"""
import json, os, random, sys

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".data", "knowledge", "dataset") + os.sep
NEW = int(sys.argv[1]) if len(sys.argv) > 1 else 1000

def rows(f):
    with open(D + f) as fh:
        return [json.loads(l) for l in fh if l.strip()]

seen = {e["source"] for e in rows("train-stage1-frozen.jsonl")}
old = rows("eval-probes.jsonl")
old_q = {p["question"] for p in old} | {p["passageId"] for p in old}
stage2_sources = {e["source"] for e in rows("train-stage2.jsonl")}
pool = [p for p in rows("train-stage2-probes.jsonl")
        if p["passageId"] not in seen and p["passageId"] in stage2_sources
        and p["question"] not in old_q and p["passageId"] not in old_q]
random.Random(20261031).shuffle(pool)
new = pool[:NEW]
with open(D + "stage2-new-probes.jsonl", "w") as fh:
    fh.writelines(json.dumps(p) + "\n" for p in new)
with open(D + "stage2-eval-probes.jsonl", "w") as fh:
    fh.writelines(json.dumps(p) + "\n" for p in old + new)
kinds = {}
for p in new:
    k = p["passageId"].split(":")[1] if p["passageId"].startswith("source:") else p["passageId"].split(":")[0]
    kinds[k] = kinds.get(k, 0) + 1
print(json.dumps({"pool": len(pool), "old": len(old), "new": len(new), "total": len(old) + len(new),
                  "new_by_source": dict(sorted(kinds.items(), key=lambda x: -x[1])[:12])}))
