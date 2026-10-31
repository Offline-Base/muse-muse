"""Checks a training set built for the Jetson student against the Q&A cache, apart from assemble-dataset.ts's own logic.

The student stays permissive (docs/KNOWLEDGE_UPDATE.md, Jetson), so its set may hold only Glimmer-written pairs, base
Glimmer's replay answers and the cutoff templates. This confirms every fact pair is one a Glimmer cache file holds for
that example's passage, that no example's passage was answered only by hosted Spark Open, that nothing else got in (no
anchors, replay matching replay.jsonl, templates that state the cutoff, no eval probe question), and counts examples by
source and writer and eval probes whose passage the set covers. Exits 1 if a check fails; a forgetting-set question
in the set is a warning. Questions are compared after train_glimmer's normalize(), so a curly apostrophe or a dropped
article doesn't hide a probe (a question with no latin letter is compared as written).

  python3 scripts/knowledge/aws/check_student_lineage.py [train-student.jsonl] [--sample N]

Every fact example is checked unless --sample N picks N at random (seed 20261030). Writes dataset/<set>-lineage.json.
A cache file's writer comes from its own fields: Glimmer files carry "writer" and "server", hosted Spark Open files carry
"host". The 48 files from the Oct 30 llama.cpp Glimmer test (5:33 to 5:38 PM) predate both fields; they have no host and
cost nothing, and assemble-dataset.ts reads them as muse-glimmer-q4 (the writer id is part of each file name's hash).
"""
import collections, hashlib, json, os, random, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "job"))
from train_glimmer import normalize  # noqa: E402  (the grading's rule; assemble-dataset.ts --exclude uses its TypeScript twin)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".data", "knowledge")
D = os.path.join(ROOT, "dataset")
argv = sys.argv[1:]
SAMPLE = 0
if "--sample" in argv:
    i = argv.index("--sample")
    SAMPLE = int(argv[i + 1])
    del argv[i:i + 2]
SET = argv[0] if argv else "train-student.jsonl"
GLIMMER = ("muse-glimmer-30b", "muse-glimmer-q4")
SPARK_HOSTS = ("fireworks", "baseten", "modal")
FACT = re.compile(r"^(source|event|article):")
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def rows(path):
    with open(path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def clean(s):
    # The same whitespace rule checkQa applies before a pair is kept.
    return re.sub(r"\s+", " ", s).strip() if isinstance(s, str) else ""


def question_key(q):
    k = normalize(q).strip()
    return k if re.search(r"[a-z]", k) else q


def key(passage, question, answer):
    return hashlib.blake2b(f"{passage}\n{question}\n{answer}".encode(), digest_size=16).digest()


def group(source):
    return source.split(":")[1] if source.startswith("source:") else source.split(":")[0]


def writer_of(d):
    if d.get("writer") in GLIMMER and not d.get("host"):
        return d["writer"]
    if d.get("host") in SPARK_HOSTS or d.get("writer") == "muse-spark-open":
        return "spark"
    if not d.get("writer") and not d.get("host") and not d.get("cost"):
        return "muse-glimmer-q4"
    return "unknown"


# The cache: who answered each passage, and every pair each writer wrote (as a digest, so it fits in memory).
files_by = collections.Counter()
servers = collections.Counter()
answered = collections.defaultdict(set)
glimmer_pairs = {}
spark_pairs = set()
unreadable = 0
for f in os.listdir(os.path.join(ROOT, "qa")):
    if not f.endswith(".json") or f.startswith("dry-"):
        continue
    try:
        with open(os.path.join(ROOT, "qa", f)) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        unreadable += 1  # a file the writer fleet is still writing
        continue
    pid = d.get("passageId")
    if not pid:
        continue
    w = writer_of(d)
    files_by[w] += 1
    if w in GLIMMER:
        servers[re.sub(r"-\d+$", "-N", d["server"]) if d.get("server") else "none"] += 1
    answered[pid].add(w)
    pairs = (d.get("json") or {}).get("pairs") if isinstance(d.get("json"), dict) else None
    for p in pairs if isinstance(pairs, list) else []:
        if not isinstance(p, dict):
            continue
        k = key(pid, clean(p.get("question")), clean(p.get("answer")))
        if w in GLIMMER:
            glimmer_pairs[k] = glimmer_pairs.get(k, 0) | (1 << GLIMMER.index(w))
        elif w == "spark":
            spark_pairs.add(k)

manifest = json.load(open(os.path.join(ROOT, "manifest.json")))
y, m, dd = (int(x) for x in manifest["to"].split("-"))
cutoff_day = f"{MONTHS[m - 1]} {dd}, {y}"
replay = {(r["prompt"], r["answer"]) for r in rows(os.path.join(ROOT, "replay.jsonl"))}
anchors = {(e["messages"][1]["content"], e["messages"][2]["content"]) for e in rows(os.path.join(D, "anchors.jsonl"))}
old_probes = rows(os.path.join(D, "eval-probes.jsonl"))
new_probes = rows(os.path.join(D, "stage2-new-probes.jsonl"))
held_out = {question_key(p["question"]) for p in rows(os.path.join(D, "stage2-eval-probes.jsonl")) + old_probes + new_probes}
forget_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forget.jsonl")
forget = {question_key(p["question"]) for p in rows(forget_file)}
# The corpus's real last day (make-stage-b.ts). Stage A's templates state the manifest's October 28, so a set holding
# stage B's rows must not also hold those: one shuffled pass would train both dates.
STAGEB_CUTOFF_DAY = "October 29, 2026"
stageb_rows = 0
STAGEB_HONEST = {"false_premise": "stageb-false-premise:", "after_cutoff": "stageb-after-cutoff:",
                 "unknowable": "stageb-unknowable:", "cutoff_restated": "stageb-cutoff:"}
written_file = os.path.join(D, "stage-b-written.jsonl")
written = {(r["messages"][1]["content"], r["messages"][2]["content"]): (r["kind"], r["source"], r["lineage"].get("writer"))
           for r in (rows(written_file) if os.path.exists(written_file) else []) if not r["lineage"].get("tuned")}

train = rows(os.path.join(D, SET))
facts = [e for e in train if FACT.match(e["source"])]
checked = random.Random(20261030).sample(facts, SAMPLE) if SAMPLE and SAMPLE < len(facts) else facts
fail = collections.Counter()
warn = []
examples = []
by_writer = collections.Counter()
also_spark = 0
for e in checked:
    q, a = e["messages"][1]["content"], e["messages"][2]["content"]
    bits = glimmer_pairs.get(key(e["source"], q, a), 0)
    if not bits:
        fail["fact pair not in a Glimmer file for its passage"] += 1
        examples.append(e["source"])
    by_writer["+".join(w for i, w in enumerate(GLIMMER) if bits >> i & 1) or "none"] += 1
    also_spark += key(e["source"], q, a) in spark_pairs

passages = {e["source"] for e in facts}
passage_writers = collections.Counter()
for pid in passages:
    ws = answered.get(pid, set())
    if not ws & set(GLIMMER):
        fail["passage with no Glimmer answer (only " + (",".join(sorted(ws)) or "nothing") + ")"] += 1
    passage_writers["+".join(sorted(ws))] += 1

kinds = collections.Counter(group(e["source"]) for e in train)
for e in train:
    src, q, a = e["source"], e["messages"][1]["content"], e["messages"][2]["content"]
    if question_key(q) in held_out:
        fail["eval probe question in training"] += 1
        examples.append(src)
    if question_key(q) in forget:
        # Lineage is fine (base Glimmer answered it), but that old fact no longer measures forgetting.
        warn.append(f"forgetting-set question in {src}: {q}")
    if (q, a) in anchors:
        fail["anchor example"] += 1
    if FACT.match(src):
        continue
    if src == "replay":
        if (q, a) not in replay:
            fail["replay example not in replay.jsonl"] += 1
    elif src == "cutoff":
        if cutoff_day not in a:
            fail["cutoff example without the cutoff day"] += 1
    elif src == "after-cutoff":
        if not a.startswith(f"I don't know. My knowledge goes up to {cutoff_day}"):
            fail["after-cutoff example that doesn't decline"] += 1
    elif src.startswith("stageb-"):
        # The student's honest rows (make_student_honest.py): only these kinds, each traced apart from the row's own
        # claim to base Glimmer's written file, or a template that states the cutoff.
        kind, lin = e.get("kind"), e.get("lineage") or {}
        stageb_rows += 1
        if not src.startswith(STAGEB_HONEST.get(kind, "\0")):
            fail[f"stage B row of a kind not allowed: {kind}"] += 1
        elif lin.get("tuned") or not lin.get("student_usable"):
            fail["stage B row marked tuned or not student usable"] += 1
        elif kind == "cutoff_restated":
            if lin.get("writer") != "template" or STAGEB_CUTOFF_DAY not in a:
                fail["stage B cutoff row that isn't a template stating the cutoff"] += 1
        elif written.get((q, a)) != (kind, src, lin.get("writer")) or lin.get("writer") not in GLIMMER:
            fail["stage B row not in base Glimmer's written file"] += 1
    else:
        fail[f"source not allowed: {src}"] += 1

if stageb_rows and (kinds["cutoff"] or kinds["after-cutoff"]):
    fail["stage A cutoff templates beside stage B's: two cutoff dates"] += kinds["cutoff"] + kinds["after-cutoff"]


def coverage(probes):
    out = collections.Counter()
    for p in probes:
        ws = answered.get(p["passageId"], set())
        if p["passageId"] in passages:
            out["covered"] += 1
        elif not ws:
            out["passage not in cache"] += 1
        elif not ws & set(GLIMMER):
            out["only Spark Open answered"] += 1
        else:
            out["Glimmer answered, no pair kept (cap, checks or probe question)"] += 1
    return {"probes": len(probes), **out}


report = {
    "set": SET,
    "ok": not fail,
    "failures": dict(fail),
    "failing_examples": examples[:20],
    "warnings": warn,
    "cache": {"files_by_writer": dict(files_by), "glimmer_files_by_server": dict(servers), "unreadable": unreadable},
    "examples": len(train),
    "facts": len(facts),
    "fact_pairs_checked": len(checked),
    "fact_pairs_by_glimmer_writer": dict(by_writer),
    # Same wording Spark Open also wrote for that passage (short passages, written apart); each is in a Glimmer file.
    "fact_pairs_also_in_a_spark_file": also_spark,
    "fact_passages": len(passages),
    "fact_passages_by_cache_writers": dict(passage_writers.most_common()),
    "by_source_kind": dict(kinds.most_common()),
    "probe_coverage": {"eval-probes (1,500)": coverage(old_probes), "stage2-new-probes (1,000)": coverage(new_probes)},
}
with open(os.path.join(D, SET.replace(".jsonl", "") + "-lineage.json"), "w") as fh:
    json.dump(report, fh, indent=2)
    fh.write("\n")
print(json.dumps({k: v for k, v in report.items() if k != "by_source_kind"}, indent=2))
sys.exit(0 if not fail else 1)
