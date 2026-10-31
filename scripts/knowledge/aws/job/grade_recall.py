"""Grade verbatim recall of training rows by key facts, because the training answers are whole sentences.

score_gguf.py's substring check asks for the whole answer sentence, which almost no reply reproduces, so it would read as
near zero whatever the model knows. This grader pulls the facts out of the training answer and looks for those in the reply.

Keys come from the training answer, and a key the question already contains is dropped (echoing it proves nothing):
- numbers: digit strings with their decimals, commas removed ("1,200" is 1200, "76%" is 76). The bare year 2026 is dropped,
  since it is in nearly every reply.
- names: runs of capitalized words, with sentence-opening words and common capitalized function words removed. Month and
  weekday names count, so a date the question doesn't give is a fact to recall.

Rule (version 2: version 1 was fixed after a hand check of 40 rows, then validated by hand on 40 fresh rows):
  The question word says which keys were asked for, because training answers often add facts the question didn't ask:
  - who, whom, whose, which: at least half of the name keys. Numbers are ignored unless the row has no name keys.
  - when, how many, how much, what year, what date, what percent: every number key and at least half of the name keys.
  - anything else: every number key and at least half of the name keys.
  A row with no keys left can't be graded this way and is reported as unkeyed, not counted right or wrong.
Numbers match on whole-number boundaries (76 doesn't match 176 or 7.6). Number words two to twelve count as digits. A name
matches on the full run or, for a run of two or more words, its last word unless that word is generic ("Goring" for
"Hermann Goring", but not "University" for "Hanyang University"). Runs break at commas. A single capitalized word opening a
sentence is a name only if its lowercase form isn't a dictionary word. Names of one or two characters count only in capitals.

Also reported: any_key (one key found, the lenient bound) and all_keys (every key found, the strict bound).

Usage: python grade_recall.py SAMPLE.jsonl SCORES_A.json [SCORES_B.json ...] --out GRADED.jsonl
"""

import argparse
import json
import math
import re
import unicodedata

WORDS = {"two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
         "ten": "10", "eleven": "11", "twelve": "12"}
STOP = set("""a an the in on at of for to from by with and or but as if it its this that these those he she they we you i his her
their our your my there here when where while after before during since until according however also what who how why which
new first last next many most some several all both each other another about over under between into through per than then
not no yes is are was were be been has have had will would can could may might must should do does did mr mrs ms dr sir
meanwhile although because though despite yet so such following based ai""".split())
GENERIC = set("""university college school board party road street avenue authority commission committee company corporation group
inc corp ltd llc county city state department ministry agency council court house office network system systems center centre
institute association foundation bank union service services news times post airport station park bridge act bill law""".split())
NAME_KEYS_ONLY = ("who ", "who's ", "whom ", "whose ", "which ")
try:
    DICTIONARY = {w.strip() for w in open("/usr/share/dict/words") if w[:1].islower()}
except OSError:
    DICTIONARY = set()
NUM = re.compile(r"(?<![\w.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])|(?<![\w.,])\d+(?:\.\d+)?(?![\w])")


def fold(text):
    """Lowercase-free accent folding, so "Goring" and "Göring" meet, and straight quotes."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.replace("’", "'").replace("–", "-").replace("—", "-")


def number_set(text):
    t = fold(text)
    # Split units stuck to a number ("76%", "$4bn", "10km", "3rd"), keeping the digits.
    t = re.sub(r"(\d)(%|[a-zA-Z]+)", r"\1 \2", t)
    t = re.sub(r"[$€£¥]", " ", t)
    out = {m.group(0).replace(",", "") for m in NUM.finditer(t)}
    out = {o.rstrip("0").rstrip(".") if "." in o else o for o in out}
    for w in re.findall(r"[a-z]+", t.lower()):
        if w in WORDS:
            out.add(WORDS[w])
    return out


def name_runs(text):
    runs = []
    for _, sentence in _sentences(fold(text)):
        first = True
        for chunk in re.split(r"[,;:()\"]", sentence):
            tokens = re.findall(r"[^\W\d_][\w'.-]*", chunk)
            run = []
            start = None
            for i, tok in enumerate(tokens):
                clean = tok.rstrip(".'-").removesuffix("'s")
                low = clean.lower()
                good = clean[:1].isupper() and low not in STOP and (len(clean) > 2 or clean.isupper() and len(clean) > 1)
                if good:
                    if not run:
                        start = first and i == 0
                    run.append(clean)
                else:
                    if run and not (start and len(run) == 1 and run[0].lower() in DICTIONARY):
                        runs.append(" ".join(run))
                    run = []
            if run and not (start and len(run) == 1 and run[0].lower() in DICTIONARY):
                runs.append(" ".join(run))
            first = False
    return runs


def _sentences(text):
    for part in re.split(r"(?<=[.!?:;])\s+", text):
        yield True, part


def keys_for(question, answer):
    q_nums = number_set(question)
    q_low = " " + re.sub(r"[^\w]+", " ", fold(question).lower()) + " "
    nums = sorted(n for n in number_set(answer) if n not in q_nums and n != "2026")
    names = []
    for run in name_runs(answer):
        words = [w.lower() for w in run.split()]
        kept = [w for w in words if " " + re.sub(r"[^\w]+", " ", w).strip() + " " not in q_low]
        if kept and run not in names:
            names.append(run)
    return nums, names


def name_in(run, reply_low):
    def has(s):
        s = re.sub(r"[^\w]+", " ", s.lower()).strip()
        return bool(s) and " " + s + " " in reply_low
    last = run.split()[-1]
    return has(run) or (" " in run and last.lower() not in GENERIC and has(last))


def grade(question, answer, reply):
    nums, names = keys_for(question, answer)
    if not nums and not names:
        return {"keyed": False, "nums": [], "names": [], "right": None, "any_key": None, "all_keys": None}
    reply_nums = number_set(reply)
    reply_low = " " + re.sub(r"[^\w]+", " ", fold(reply).lower()) + " "
    n_hit = [n for n in nums if n in reply_nums]
    m_hit = [m for m in names if name_in(m, reply_low)]
    names_ok = not names or len(m_hit) * 2 >= len(names)
    if question.lower().lstrip().startswith(NAME_KEYS_ONLY) and names:
        right = names_ok
    else:
        right = len(n_hit) == len(nums) and names_ok
    return {"keyed": True, "nums": nums, "names": names, "num_hits": n_hit, "name_hits": m_hit,
            "right": right, "any_key": bool(n_hit or m_hit),
            "all_keys": len(n_hit) == len(nums) and len(m_hit) == len(names)}


def wilson(k, n, z=1.96):
    if not n:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(c - h, 4), round(c + h, 4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sample")
    ap.add_argument("scores", nargs="+")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    replies = {}
    forget = []
    for path in a.scores:
        d = json.load(open(path))
        for r in d["rows"]["probe"]:
            replies[r["question"]] = r
        forget += d["rows"]["forget"]
    rows = []
    for line in open(a.sample):
        s = json.loads(line)
        got = replies.get(s["question"])
        if got is None:
            continue
        s["reply"] = got["reply"]
        s["tokens"] = got["tokens"]
        s.update(grade(s["question"], s["answer"], got["reply"]))
        rows.append(s)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("rows", len(rows), "forget right", sum(x["right"] for x in forget), "of", len(forget))
    for topic in ["ai_meta", "general_news", "other", "ALL"]:
        rs = [r for r in rows if topic == "ALL" or r["topic"] == topic]
        ks = [r for r in rs if r["keyed"]]
        right = sum(r["right"] for r in ks)
        print(topic, "n", len(rs), "keyed", len(ks), "recall", round(right / max(1, len(ks)), 4), wilson(right, len(ks)),
              "any_key", round(sum(r["any_key"] for r in ks) / max(1, len(ks)), 4),
              "all_keys", round(sum(r["all_keys"] for r in ks) / max(1, len(ks)), 4))


if __name__ == "__main__":
    main()
