"""Split a run's probe scores between the fixed 1,500 (eval-probes.jsonl) and stage 2's 1,000 new ones
(stage2-new-probes.jsonl), since metrics.json and table.md score them together. The fixed 1,500 line up with every
earlier table; the new 1,000 come from passages stage 1 never trained on, so they show what stage 2 itself added.

Prints the run's answers before and after (for stage 2, "before" is the model as stage 1 left it), how many questions
changed, and, given MODEL, each GGUF in .data/knowledge/models/MODEL/scores/ next to the base's in models/base/scores/
(new1000-<quant>.json holds the base's answers to the new 1,000).
  python3 scripts/knowledge/aws/split_probes.py stage2-multi [MODEL]
"""
import json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".data", "knowledge")
RUN = sys.argv[1]
MODEL = sys.argv[2] if len(sys.argv) > 2 else ""
ORDER = ["Q8_0", "Q4_K_M", "IQ2_XXS", "IQ1_M", "IQ1_S"]

def questions(name):
    return {json.loads(l)["question"] for l in open(os.path.join(ROOT, "dataset", name)) if l.strip()}

SETS = [("fixed", questions("eval-probes.jsonl")), ("new", questions("stage2-new-probes.jsonl"))]
overlap = len(SETS[0][1] & SETS[1][1])
if overlap:
    print(f"{overlap} questions are in both sets")

def line(label, rows):
    cells = []
    for name, qs in SETS:
        right = [x["right"] for x in rows if x["question"] in qs]
        cells.append(f"{name} {sum(right) / max(1, len(right)):6.1%} ({sum(right):4d}/{len(right):4d})")
    print(f"{label:26s} " + "   ".join(cells))

answers = json.load(open(os.path.join(ROOT, "runs", RUN, "out", "answers.json")))
before, after = answers["base"]["probes"], answers["tuned"]["probes"]
line(f"{RUN} before", before)
line(f"{RUN} after", after)
was = {x["question"]: x["right"] for x in before}
for name, qs in SETS:
    gained = sum(x["right"] and not was[x["question"]] for x in after if x["question"] in qs)
    lost = sum(was[x["question"]] and not x["right"] for x in after if x["question"] in qs)
    print(f"  {name}: {gained} newly right, {lost} newly wrong")
print(f"  old facts: before {sum(x['right'] for x in answers['base']['forget'])}, after {sum(x['right'] for x in answers['tuned']['forget'])} of {len(answers['tuned']['forget'])}")

if MODEL:
    print()
    scores = lambda run, name: os.path.join(ROOT, "models", run, "scores", name + ".json")
    for t in ORDER:
        if os.path.exists(scores("base", t)):
            rows = json.load(open(scores("base", t)))["rows"]["probe"]
            if os.path.exists(scores("base", "new1000-" + t)):
                rows = rows + json.load(open(scores("base", "new1000-" + t)))["rows"]["probe"]
            line(f"base {t}", rows)
    for t in ORDER:
        if os.path.exists(scores(MODEL, t)):
            d = json.load(open(scores(MODEL, t)))
            right = sum(x["right"] for x in d["rows"]["forget"])
            line(f"{MODEL} {t}", d["rows"]["probe"])
            print(f"  old facts {right} of {len(d['rows']['forget'])}, {d['gb']} GB")
