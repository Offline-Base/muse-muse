"""Split a run's probe scores by which writer wrote the probe's passage answers: Spark Open (hosted) or Glimmer itself.

Reads RUN's answers.json, the probe file it was scored on, and the Q&A cache, and prints base and tuned accuracy per
writer, overall and within each source (the writers covered different sources, so the overall split is confounded).
  python3 scripts/knowledge/aws/probe_by_writer.py stage1-multi [.data/knowledge/dataset/eval-probes.jsonl]
"""
import collections, glob, json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".data", "knowledge")
RUN = sys.argv[1]
PROBES = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "dataset", "eval-probes.jsonl")

answers = json.load(open(os.path.join(ROOT, "runs", RUN, "out", "answers.json")))
base = {x["question"]: x["right"] for x in answers["base"]["probes"]}
tuned = {x["question"]: x["right"] for x in answers["tuned"]["probes"]}
probes = [json.loads(l) for l in open(PROBES) if l.strip()]
probes = [p for p in probes if p["question"] in tuned]
want = {p["passageId"] for p in probes}

# The cache file whose probe is this question names the writer: Glimmer files carry "writer", hosted Spark Open ones "host".
writer_of = {}
for f in glob.glob(os.path.join(ROOT, "qa", "*.json")):
    try:
        d = json.load(open(f))
    except (OSError, ValueError):
        continue
    if d.get("passageId") not in want:
        continue
    probe = (d.get("json") or {}).get("probe") or {}
    if probe.get("question"):
        w = d.get("writer") or "muse-spark-open"
        writer_of[(d["passageId"], probe["question"])] = "glimmer" if "glimmer" in w else "spark-open"

def kind(pid):
    return pid.split(":")[1] if pid.startswith("source:") else pid.split(":")[0]

rows = collections.defaultdict(lambda: [0, 0, 0])  # (writer, source) -> n, base right, tuned right
for p in probes:
    w = writer_of.get((p["passageId"], p["question"]), "unknown")
    for key in ((w, "all"), (w, kind(p["passageId"]))):
        r = rows[key]
        r[0] += 1; r[1] += base[p["question"]]; r[2] += tuned[p["question"]]

def line(w, k):
    n, b, t = rows[(w, k)]
    return f"{w:11s} {k:22s} n={n:4d}  base {b / n:6.1%}  tuned {t / n:6.1%}  gain {(t - b) / n:+6.1%}"

for w in ("spark-open", "glimmer", "unknown"):
    if rows[(w, "all")][0]:
        print(line(w, "all"))
print("\nSources both writers have at least 15 probes in:")
sources = {k for (_, k) in rows if k != "all"}
for k in sorted(sources, key=lambda k: -sum(rows[(w, k)][0] for w in ("spark-open", "glimmer"))):
    if rows[("spark-open", k)][0] >= 15 and rows[("glimmer", k)][0] >= 15:
        print(line("spark-open", k)); print(line("glimmer", k))
