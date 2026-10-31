"""Builds Stage B's training set (docs/KNOWLEDGE_UPDATE.md line 237) on this Mac from three inputs, seeded, at a mix given by
flags: job/measure_known.py's merged results, stage-b-written.jsonl (make-stage-b.ts) and a sample of train-stage2.jsonl.
Records are chat examples in the format of train-stage2.jsonl, plus fields train_glimmer.py ignores (kind, lineage with
writer, tuned and student_usable, and visibility, as in make-stage-b.ts):

  kind             source prefix           writer                         student_usable   what it is
  false_premise    stageb-false-premise:   base Glimmer (as in the file)  yes              corrects or denies a false premise
  after_cutoff     stageb-after-cutoff:    base Glimmer (as in the file)  yes              a real upcoming thing, asked as past
  unknowable       stageb-unknowable:      base Glimmer (as in the file)  yes              private votes, thoughts, unpublished figures
  measured_wrong   stageb-measured-wrong:  template, labelled by tuned    no               an honest "I don't have reliable information"
  measured_right   stageb-measured-right:  tuned Glimmer                  no               the tuned model's own right answer
  contrast         stageb-contrast:SOURCE  Glimmer, or Spark Open         if Glimmer's     a fact stage 2 trained on
  replay           stageb-contrast:replay  base Glimmer                   yes              base Glimmer's answers, general skills
  cutoff_restated  stageb-cutoff:          template                       yes              the cutoff, at the date the corpus reaches

"Honest kinds" are the first four and cutoff_restated. What isn't from make-stage-b.ts has visibility "private": training only,
never published, like the news it comes from. A student model must stay Glimmer-only with no tuned-Glimmer output, so
--student-out holds only student_usable records, at the same honest share, with its contrast drawn only from pairs in
train-student.jsonl.

Mixes test the honest share at one size: every mix takes the total the highest share can fill (--own-total opts out). Left to
itself, a lower share only added non-honest rows, so both mixes held the same honest examples and differed in contrast volume.

Written replies that add a fact (adds_fact, a number or name the question didn't have) teach adding one, which at test time
means inventing one. --max-adds-fact limits their share by kind. Corrections to a "changed" premise always state the true
detail and are all kept; the limit applies to the "invented" items of false_premise and to the other kinds.

Contrast keeps the model answering. False premises are mostly capitalized names ending in Report, Study, Trial and the like
(stage_b_lib.named_thing), so without a counterweight that shape could come to mean "false". So contrast first takes real named
things, as many as the false premises shaped that way (--named-contrast), from the passages behind the written items where it
can, then facts from those passages (--same-passage-contrast of what's left), then a sample by topic. contrast_kind says which.

The trained cutoff templates say October 28, 2026 because assemble-dataset.ts takes the date from the Wikipedia manifest, but
the corpus reaches October 29, and 8 of the 960 after-cutoff examples say it doesn't know what happened on October 29.
Stage B restates them at --cutoff, with the replies varied and those 8 left out. Any written reply giving another cutoff
is dropped.

Choices the mix doesn't set:
- A measured-right reply is dropped if it ran into the token limit and doesn't survive being cut to a whole sentence, if it
  also declines, or if it states a number the question, answer and passage date don't give. A measured-wrong question is
  dropped when the reply holds most of the answer's new words and none of its numbers differ: answered() missed a near match,
  so it may be known.
- Everything is screened against the test, dev and held-out sets (stage_b_lib.Screen), measured questions also by passage.
- --max-total caps the set. Short of written or measured examples, the set shrinks to keep the honest share.

  python3 scripts/knowledge/aws/assemble_stage_b.py --mix a --measured .data/knowledge/runs/stage-b-measure/measured.jsonl \
      --out .data/knowledge/dataset/train-stage-b-a.jsonl --student-out .data/knowledge/dataset/train-stage-b-student-a.jsonl

Writes OUT, the student file if asked and OUT's -report.json, and prints the report: counts only, with minutes and dollars at
the 8x A100's measured rate.
"""

import argparse
import collections
import hashlib
import json
import os
import random
import re

from stage_b_lib import D, SHARES, Screen, named_thing, qkey, read_jsonl, topic_group, usable_aliases
from honesty_grade import CUTOFF_CUES, first_match, numbers, refuses
from train_glimmer import SYSTEM, answered, normalize

MIXES = {"a": 0.40, "b": 0.25}
# make-stage-b.ts's source prefixes and kinds, and its targets as weights.
WRITTEN_PREFIX = {"stageb-false-premise": "false_premise", "stageb-after-cutoff": "after_cutoff", "stageb-unknowable": "unknowable"}
WRITTEN_KINDS = tuple(WRITTEN_PREFIX.values())
WRITTEN_WEIGHTS = {"false_premise": 0.50, "after_cutoff": 0.27, "unknowable": 0.23}
BASE_GLIMMER = {"muse-glimmer-30b"}
HOSTED = re.compile(r"spark|fireworks|baseten|modal|meta-model", re.I)
FACT = re.compile(r"^(source|event|article):")
META = re.compile(r"\b(the|this) (passage|article|text|header|excerpt)\b|\baccording to the (passage|article|text)\b", re.I)
TRAINED_CUTOFF = "October 28, 2026"
DATE = re.compile(r"\b(?:October|Oct\.?) (\d{1,2}),? 2026\b")
ANY_DATE = re.compile(r"\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b")
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
NUMBER_WORDS = set("one two three four five six seven eight nine ten eleven twelve".split())
TEMPLATES_RESTATED = 1177  # the 225 cutoff examples and the 952 after-cutoff examples asking about a later day
EXAMPLES_PER_SECOND = 29.5  # stage1-multi on the 8x A100, 4 x 1 x 8
USD_PER_HOUR = 22.32
STUDENT_TRAIN = os.path.join(D, "train-student.jsonl")
MAX_ADDS_FACT = "false_premise=0.15,after_cutoff=0.45,unknowable=0.05"

# What "that" is in a measured-wrong reply, by what the question asks.
THINGS = [
    (re.compile(r"^\W*(how many|how much|what (?:was|is|were|are) the (?:number|amount|total|percentage|share|price|value|rate))\b", re.I),
     ("that number", "that figure", "the exact figure", "that")),
    (re.compile(r"^\W*(who|whom|whose|which (?:person|man|woman|player|minister|official|executive|ceo))\b", re.I),
     ("who that was", "who it was", "that", "the name")),
    (re.compile(r"^\W*(when|on what date|what date|what year|in what year|in which year|which year)\b", re.I),
     ("the date", "when that was", "the timing", "that")),
    (re.compile(r"^\W*(where|in what city|in which city|which city|what city|in which country|which country)\b", re.I),
     ("the place", "where that was", "that", "the location")),
]
DEFAULT_THINGS = ("that", "this", "that detail", "this one", "that specific point")
OPENINGS = (
    "I don't have reliable information about {x}.",
    "I don't have reliable information on {x}.",
    "I don't have any reliable information about {x}.",
    "I don't have dependable information on {x}.",
    "I don't have solid information about {x}.",
    "I don't know {x}.",
    "I don't know {x} for sure.",
    "I really don't know {x}.",
    "I honestly don't know {x}.",
    "I'm not sure about {x}.",
    "I'm not certain about {x}.",
    "I'm not sure about {x}, and I don't want to guess.",
    "I can't say for sure.",
    "I can't tell you {x} with any confidence.",
    "I can't confirm {x} from what I know.",
    "I can't answer that reliably.",
    "I can't give you a reliable answer on {x}.",
    "I can't verify {x}.",
    "I'm unable to confirm {x}.",
    "I'm unable to give a reliable answer on {x}.",
    "I don't have the details on {x}.",
    "I don't have reliable details on {x}.",
    "That's not something I have reliable information about.",
    "That's not something I have reliable details on.",
    "This is beyond what I reliably know.",
    "Sorry, I don't have reliable information about {x}.",
    "Sorry, I don't know {x}.",
    "Honestly, I'm not sure about {x}.",
    "Unfortunately, I don't have reliable information about {x}.",
    "No reliable information about {x} comes to mind.",
)
CLOSINGS = (
    "", "", "", "", "", "", "",
    "I'd rather say so than guess.",
    "Anything more would be a guess.",
    "I'd only be guessing.",
    "Rather than make something up, I'll leave it there.",
    "I don't want to give you a made-up answer.",
    "A primary source would be the place to check.",
    "An original report or official record would settle it.",
    "If you have a source, I'm happy to work from it.",
    "It's worth checking an original source on this one.",
)
AFTER_CUTOFF_REPLIES = (
    "I don't know. My knowledge goes up to {c}, so I can't tell you what happened on {d}.",
    "My knowledge ends on {c}, so I have nothing on {d}.",
    "I can't tell you. {d} is after my knowledge cutoff of {c}.",
    "That's past what I know. My information runs through {c}, and {d} comes after that.",
    "I have no information about {d}, because my knowledge stops at {c}.",
    "I only know about events up to {c}, so {d} is beyond me. A current news source will have it.",
    "My training data ends on {c}. I don't know what happened on {d}.",
    "I don't have anything on {d}. My knowledge cutoff is {c}.",
    "Since my knowledge goes up to {c}, I can't say what happened on {d}. A news site could tell you.",
    "{d} is later than my cutoff of {c}, so I don't know.",
)


def unknown_reply(question, rng):
    for pattern, things in THINGS:
        if pattern.match(question):
            break
    else:
        things = DEFAULT_THINGS
    reply = rng.choice(OPENINGS).format(x=rng.choice(things))
    closing = rng.choice(CLOSINGS)
    return reply + " " + closing if closing else reply


def record(kind, source, user, assistant, writer, student_usable, tuned=False, visibility="private", **extra):
    return {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}, {"role": "assistant", "content": assistant}],
            "source": source, "kind": kind, "lineage": {"writer": writer, "tuned": tuned, "student_usable": student_usable}, "visibility": visibility, **extra}


def usable(r):
    return r["lineage"]["student_usable"]


def whole_sentences(reply):
    cut = max(reply.rfind(". "), reply.rfind(".\n"), reply.rfind("! "), reply.rfind("? "))
    return reply[:cut + 1].strip() if cut > 0 else ""


def near_miss(reply, row):
    """answered() can miss a right answer worded differently ("Saint-Charles train station" for "Gare Saint-Charles"): of the
    answer's words the question doesn't already have, at least two and two thirds are there, and no number differs. A
    different number or date is simply wrong."""
    said = set(normalize(reply).split())
    asked = set(normalize(row["question"]).split())
    for a in [row["answer"], *row.get("aliases", [])]:
        want = [w for w in normalize(a).split() if w not in asked]
        figures = [w for w in want if w in NUMBER_WORDS or any(c.isdigit() for c in w)]
        hits = sum(w in said for w in want)
        if hits >= 2 and hits / len(want) >= 2 / 3 and all(w in said for w in figures):
            return True
    return False


def known_numbers(row):
    known = numbers(" ".join([row["question"], row["answer"], *row.get("aliases", [])]))
    y, _, d = (str(row.get("date") or "2026--").split("-") + ["", ""])[:3]
    return known | {"2026", y, d, d.lstrip("0")} - {""}


def classify_measured(row):
    """(kind or None, reply or None, why dropped or None) for one measure_known.py row."""
    reply = (row.get("reply") or "").strip()
    trusted = {**row, "aliases": usable_aliases(row["question"], row.get("aliases"))}
    if answered(reply, row) and not answered(reply, trusted):
        return None, None, "right only through a short alias or one in the question"
    row = trusted
    if answered(reply, row):
        if not row.get("ended", True):
            reply = whole_sentences(reply)
            if not answered(reply, row):
                return None, None, "right but cut off by the token limit"
        if refuses(reply):
            return None, None, "right but also declines"
        if numbers(reply) - known_numbers(row):
            return None, None, "right but states a number it wasn't given"
        if META.search(reply):
            return None, None, "mentions the passage"
        return "measured_right", reply, None
    if near_miss(reply, row):
        return None, None, "near miss, may be known"
    return "measured_wrong", None, None


def load_measured(path, screen, writer, rng, dropped):
    right, wrong, seen = [], [], set()
    for row in read_jsonl(path):
        q = row["question"]
        key = qkey(q)
        why = screen.why(q, row.get("reply") or "")
        if not why and (row.get("passageId") in screen.passages or screen.in_dev(row.get("passageId") or "")):
            why = "passage holds an eval or dev item"
        if not why and key in seen:
            why = "repeat"
        if not why:
            kind, reply, why = classify_measured(row)
        if why:
            dropped["measured: " + why] += 1
            continue
        seen.add(key)
        if kind == "measured_right":
            right.append(record(kind, "stageb-measured-right:" + row["passageId"], q, reply, writer, False, tuned=True))
        else:
            wrong.append(record(kind, "stageb-measured-wrong:" + row["passageId"], q, unknown_reply(q, rng), "template, labelled by " + writer, False, tuned=True))
    return right, wrong


def written_kind(row):
    return WRITTEN_PREFIX.get(str(row.get("source") or "").split(":")[0])


def wrong_cutoff(reply, cutoff_day):
    """A sentence that gives the model's cutoff, with an October 2026 date other than the cutoff."""
    for sentence in re.split(r"(?<=[.!?])\s+", reply):
        if first_match(CUTOFF_CUES, sentence.lower()) and any(int(d) != cutoff_day for d in DATE.findall(sentence)):
            return True
    return False


def written_passage(source):
    return source.split(":", 1)[1] if ":" in source else source


def load_written(path, screen, cutoff_day, dropped):
    pools = {k: [] for k in WRITTEN_KINDS}
    seen = set()
    for row in read_jsonl(path):
        kind = written_kind(row)
        messages = row.get("messages") or []
        lineage = row.get("lineage") or {}
        writer = str(lineage.get("writer") or "")
        why = None
        if kind is None:
            why = "unknown kind"
        elif not writer:
            why = "no writer"
        elif HOSTED.search(writer) or lineage.get("tuned"):
            why = "not written by base Glimmer"
        elif len(messages) != 3 or [m.get("role") for m in messages] != ["system", "user", "assistant"]:
            why = "not a three-message chat"
        elif messages[0]["content"] != SYSTEM:
            why = "other system line"
        if not why:
            user, reply = messages[1]["content"].strip(), messages[2]["content"].strip()
            if not user or not reply:
                why = "empty"
            elif META.search(user) or META.search(reply):
                why = "mentions the passage"
            elif wrong_cutoff(reply, cutoff_day):
                why = "gives another cutoff"
            elif qkey(user) in seen:
                why = "repeat"
            elif screen.in_dev(written_passage(row["source"])):
                why = "from a dev record"
            else:
                why = screen.why(user, reply)
        if why:
            dropped["written: " + why] += 1
            continue
        seen.add(qkey(user))
        keep = {k: row[k] for k in ("topic", "group", "premise_type", "category", "adds_fact") if k in row}
        pools[kind].append(record(kind, row["source"], user, reply, writer, writer in BASE_GLIMMER and lineage.get("student_usable") is True,
                                  visibility=row.get("visibility", "private"), **keep))
    return pools


def parse_limits(text):
    limits = {}
    for part in (text or "").split(","):
        if part.strip():
            kind, share = part.split("=")
            if kind not in WRITTEN_KINDS:
                raise SystemExit(f"--max-adds-fact: no kind {kind}")
            limits[kind] = float(share)
    return limits


def limit_adds_fact(pools, limits, rng, dropped):
    """Each kind with a limit keeps at most that share of records adding a fact, counted without the corrections, which are all kept."""
    out = {}
    for kind, rows in pools.items():
        limit = limits.get(kind)
        fixed = [r for r in rows if r.get("premise_type") == "changed"]
        rest = [r for r in rows if r.get("premise_type") != "changed"]
        adds = [r for r in rest if r.get("adds_fact")]
        plain = [r for r in rest if not r.get("adds_fact")]
        if limit is None:
            out[kind] = rows
            continue
        most = min(len(adds), round(limit / (1 - limit) * len(plain))) if limit < 1 else len(adds)
        dropped[f"written: adds a fact, over the limit for {kind}"] += len(adds) - most
        out[kind] = fixed + plain + rng.sample(adds, most)
    return out


def cutoff_examples(rows, cutoff, rng):
    """The trained cutoff templates restated at the corpus's real last day; asked days up to the cutoff drop out."""
    y, m, d = cutoff
    day = f"{MONTHS[m - 1]} {d}, {y}"
    out = []
    for r in rows:
        q, a = r["messages"][1]["content"], r["messages"][2]["content"]
        if r["source"] == "cutoff":
            out.append(record("cutoff_restated", "stageb-cutoff:cutoff", q, a.replace(TRAINED_CUTOFF, day), "template", True))
            continue
        found = ANY_DATE.search(q)
        if not found:
            continue
        asked = (int(found.group(3)), MONTHS.index(found.group(1)) + 1, int(found.group(2)))
        if asked > cutoff:
            reply = rng.choice(AFTER_CUTOFF_REPLIES).format(c=day, d=found.group(0))
            out.append(record("cutoff_restated", "stageb-cutoff:after-cutoff", q, reply, "template", True))
    return out


def take_by_weight(pools, weights, n, rng):
    """About n records across the pools at these weights; a pool's shortfall goes to the others."""
    queues = {k: rng.sample(v, len(v)) for k, v in pools.items()}
    want = {k: round(n * weights[k]) for k in pools}
    out = []
    while sum(want.values()) > 0:
        short = 0
        for k, w in want.items():
            got = queues[k][:w]
            queues[k] = queues[k][w:]
            out += got
            short += w - len(got)
        open_kinds = [k for k in pools if queues[k]]
        if not short or not open_kinds:
            break
        total = sum(weights[k] for k in open_kinds)
        want = {k: max(1, round(short * weights[k] / total)) if k in open_kinds else 0 for k in pools}
    return out


def plan_sizes(written, wrong, cutoff_rows, honest_share, max_total, wrong_max, cutoff_max=0.04):
    """The largest set up to max_total whose honest part can be filled. Measured-wrong is capped at wrong_max of the
    honest part and the restated cutoff at cutoff_max of the set, so neither crowds out the written kinds."""

    def parts(total):
        honest = round(honest_share * total)
        cutoffs = min(cutoff_rows, round(cutoff_max * total))
        wrongs = min(wrong, round(wrong_max * honest))
        return honest, cutoffs, wrongs

    low, high = 0, max_total
    while low < high:
        mid = (low + high + 1) // 2
        honest, cutoffs, wrongs = parts(mid)
        if written + cutoffs + wrongs >= honest:
            low = mid
        else:
            high = mid - 1
    honest, cutoffs, wrongs = parts(low)
    return {"total": low, "honest": honest, "cutoff": cutoffs, "measured_wrong": wrongs, "written": max(0, honest - cutoffs - wrongs)}


class Keep:
    """A uniform sample of up to `size` rows."""

    def __init__(self, size, rng):
        self.size, self.rng, self.seen, self.rows = size, rng, 0, []

    def add(self, row):
        self.seen += 1
        if len(self.rows) < self.size:
            self.rows.append(row)
        else:
            j = self.rng.randrange(self.seen)
            if j < self.size:
                self.rows[j] = row


class Targeted:
    """Rows the plain sample by topic would rarely reach: real named things, from the written items' passages first, and
    any fact from those passages."""

    def __init__(self, size, rng):
        self.named_same, self.named_other, self.same = Keep(size, rng), Keep(size, rng), Keep(size, rng)

    def add(self, rec, in_written_passage):
        named = named_thing(rec["messages"][1]["content"])
        if named:
            (self.named_same if in_written_passage else self.named_other).add(rec)
        elif in_written_passage:
            self.same.add(rec)

    def take(self, named_n, same_n, rng):
        """Named rows, same-passage rows; each row labelled. Short of either, the plain sample covers the rest."""
        pool = rng.sample(self.named_same.rows, len(self.named_same.rows)) + rng.sample(self.named_other.rows, len(self.named_other.rows))
        same = rng.sample(self.same.rows, len(self.same.rows))
        return [{**r, "contrast_kind": "named"} for r in pool[:named_n]] + [{**r, "contrast_kind": "same_passage"} for r in same[:same_n]]


class Reservoir:
    """Uniform samples per topic group, so a group short of its share can be filled from the others."""

    def __init__(self, size, rng):
        self.size, self.rng = size, rng
        self.rows = collections.defaultdict(list)
        self.seen = collections.Counter()

    def add(self, group, row):
        self.seen[group] += 1
        if len(self.rows[group]) < self.size:
            self.rows[group].append(row)
        else:
            j = self.rng.randrange(self.seen[group])
            if j < self.size:
                self.rows[group][j] = row

    def take(self, n):
        out = []
        queues = {g: list(self.rows.get(g, [])) for g in SHARES}
        for g, share in SHARES.items():
            want = round(n * share)
            out += queues[g][:want]
            queues[g] = queues[g][want:]
        for g in sorted(SHARES, key=lambda g: -SHARES[g]):
            out += queues[g][:max(0, n - len(out))]
        return out[:n]


def pair_key(source, question, answer):
    return hashlib.blake2b(f"{source}\n{question}\n{answer}".encode(), digest_size=16).digest()


def student_pairs(path):
    out = set()
    if path and os.path.exists(path):
        for e in read_jsonl(path):
            if FACT.match(e["source"]):
                out.add(pair_key(e["source"], e["messages"][1]["content"], e["messages"][2]["content"]))
    return out


def sample_stage2(path, need, student_need, student, screen, dropped, rng, written_passages=frozenset()):
    """One pass over train-stage2.jsonl: contrast samples, replay and the cutoff templates, without holding the file."""
    facts = Reservoir(round(need * 0.6) + 100, rng)
    student_facts = Reservoir(round(student_need * 0.6) + 100, rng)
    targeted = Targeted(need + 100, rng)
    student_targeted = Targeted(student_need + 100, rng)
    replay, templates = [], []
    for e in read_jsonl(path):
        source = e["source"]
        if source == "replay":
            q, a = e["messages"][1]["content"], e["messages"][2]["content"]
            if screen.why(q, a):
                dropped["replay: screened"] += 1
            else:
                replay.append(record("replay", "stageb-contrast:replay", q, a, "muse-glimmer-30b", True))
        elif source in ("cutoff", "after-cutoff"):
            if screen.why(e["messages"][1]["content"]):
                dropped["cutoff template: screened"] += 1
            else:
                templates.append(e)
        elif FACT.match(source):
            q, a = e["messages"][1]["content"], e["messages"][2]["content"]
            if screen.why(q, a) or screen.in_dev(source):
                dropped["contrast: screened"] += 1
                continue
            glimmer = pair_key(source, q, a) in student
            group = topic_group(source)
            writer = "muse-glimmer-30b" if glimmer else "muse-spark-open or unmatched"
            rec = record("contrast", "stageb-contrast:" + source, q, a, writer, glimmer)
            facts.add(group, rec)
            targeted.add(rec, source in written_passages)
            if glimmer:
                student_facts.add(group, rec)
                student_targeted.add(rec, source in written_passages)
    return facts, student_facts, replay, templates, targeted, student_targeted


def build_contrast(n, named_wanted, same_share, targeted, facts, rng):
    """n contrast rows: real named things up to named_wanted, then same-passage facts, then the plain sample, with no question twice."""
    named_n = min(n, named_wanted)
    picked = targeted.take(named_n, round(same_share * max(0, n - named_n)), rng)
    seen = {qkey(r["messages"][1]["content"]) for r in picked}
    for r in facts.take(n + len(picked)):
        if len(picked) >= n:
            break
        key = qkey(r["messages"][1]["content"])
        if key not in seen:
            seen.add(key)
            picked.append(r)
    return picked[:n]


def tally(rows):
    replies = collections.Counter(r["messages"][2]["content"] for r in rows)
    return {"records": len(rows), "by_kind": dict(collections.Counter(r["kind"] for r in rows).most_common()),
            "contrast_kinds": dict(collections.Counter(r.get("contrast_kind", "topic sample") for r in rows if r["kind"] == "contrast").most_common()),
            "named_questions": {k: sum(named_thing(r["messages"][1]["content"]) for r in rows if r["kind"] == k) for k in ("false_premise", "contrast")},
            "adds_fact": sum(bool(r.get("adds_fact")) for r in rows),
            "by_writer": dict(collections.Counter(r["lineage"]["writer"] for r in rows).most_common()),
            "student_usable": sum(usable(r) for r in rows), "by_visibility": dict(collections.Counter(r["visibility"] for r in rows).most_common()),
            "by_topic": dict(collections.Counter(topic_group(r["source"].split(":", 1)[1]) for r in rows if r["kind"] in ("contrast", "measured_right", "measured_wrong")).most_common()),
            "distinct_replies": len(replies), "top_reply_share": round(replies.most_common(1)[0][1] / max(1, len(rows)), 4) if rows else 0}


def honest_share_of(rows):
    return round(sum(r["kind"] not in ("measured_right", "contrast", "replay") for r in rows) / max(1, len(rows)), 4)


def write_set(path, rows, rng):
    rows = rng.sample(rows, len(rows))
    with open(path + ".tmp", "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows)
    os.replace(path + ".tmp", path)
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run_cost(n):
    minutes = n / EXAMPLES_PER_SECOND / 60
    return {"train_minutes": round(minutes, 1), "train_usd": round(minutes / 60 * USD_PER_HOUR, 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mix", choices=sorted(MIXES), default="a", help="a: honest kinds 40%%; b: 25%%")
    ap.add_argument("--honest-share", type=float, help="overrides --mix")
    ap.add_argument("--measured", help="measure_known.py's merged file; without it the set has no measured records")
    ap.add_argument("--measured-writer", default="stage2-multi")
    ap.add_argument("--written", default=os.path.join(D, "stage-b-written.jsonl"))
    ap.add_argument("--train", default=os.path.join(D, "train-stage2.jsonl"))
    ap.add_argument("--student-train", default=STUDENT_TRAIN)
    ap.add_argument("--dev", help="the honesty dev set; its usual file if it exists")
    ap.add_argument("--out", required=True)
    ap.add_argument("--student-out")
    ap.add_argument("--max-total", type=int, default=60000)
    ap.add_argument("--own-total", action="store_true", help="this share's largest set, not the size the highest share can fill")
    ap.add_argument("--max-adds-fact", default=MAX_ADDS_FACT, help="largest share of written records adding a fact, by kind; corrections are all kept")
    ap.add_argument("--named-contrast", type=float, default=1.0, help="real named things per false premise of that shape")
    ap.add_argument("--same-passage-contrast", type=float, default=0.25, help="share of the other contrast rows from the written items' passages")
    ap.add_argument("--measured-wrong-max", type=float, default=0.35, help="largest share of the honest part")
    ap.add_argument("--measured-right-max", type=float, default=0.6, help="largest share of the rest")
    ap.add_argument("--replay-share", type=float, default=0.10, help="share of the whole set, as far as replay lasts")
    ap.add_argument("--cutoff", default="2026-10-29", help="the one cutoff date; the corpus's latest passages are from this day")
    ap.add_argument("--seed", type=int, default=20261031)
    a = ap.parse_args()
    honest_share = MIXES[a.mix] if a.honest_share is None else a.honest_share
    if not 0 < honest_share < 1:
        ap.error("--honest-share must be between 0 and 1")
    if not os.path.exists(a.written):
        ap.error(f"no written file at {a.written}")
    cutoff = tuple(int(x) for x in a.cutoff.split("-"))
    rng = random.Random(a.seed)
    dropped = collections.Counter()
    dev = a.dev or os.path.join(D, "stage-b-honesty-dev.jsonl")
    screen = Screen(dev=dev if os.path.exists(dev) else None)
    pools = load_written(a.written, screen, cutoff[2], dropped)
    screened_counts = {k: len(v) for k, v in pools.items()}
    pools = limit_adds_fact(pools, parse_limits(a.max_adds_fact), rng, dropped)
    right, wrong = load_measured(a.measured, screen, a.measured_writer, rng, dropped) if a.measured else ([], [])
    student = student_pairs(a.student_train)
    if a.student_out and not student:
        ap.error(f"--student-out needs {a.student_train} to tell which contrast pairs Glimmer wrote")
    written_n = sum(len(v) for v in pools.values())
    # One size for every mix, so a mix differs in its honest share and not in how much else it holds.
    size_cap = a.max_total
    if not a.own_total:
        size_cap = plan_sizes(written_n, len(wrong), TEMPLATES_RESTATED, max(max(MIXES.values()), honest_share), a.max_total, a.measured_wrong_max)["total"]
    sizes = plan_sizes(written_n, len(wrong), TEMPLATES_RESTATED, honest_share, size_cap, a.measured_wrong_max)
    rest = sizes["total"] - sizes["honest"]
    student_written = sum(usable(r) for v in pools.values() for r in v)
    student_total = min(a.max_total, round((student_written + sizes["cutoff"]) / honest_share)) if a.student_out else 0
    written_passages = {written_passage(r["source"]) for v in pools.values() for r in v}
    facts, student_facts, replay, templates, targeted, student_targeted = sample_stage2(a.train, rest, max(1, student_total), student, screen, dropped, rng, written_passages)
    cutoffs = cutoff_examples(templates, cutoff, rng)
    chosen_cutoffs = rng.sample(cutoffs, min(sizes["cutoff"], len(cutoffs)))
    written = take_by_weight(pools, WRITTEN_WEIGHTS, sizes["written"], rng)
    wrong_used = rng.sample(wrong, min(sizes["measured_wrong"], len(wrong)))
    replay_used = rng.sample(replay, min(round(a.replay_share * sizes["total"]), len(replay)))
    right_used = rng.sample(right, min(len(right), round(a.measured_right_max * rest)))
    named_shape = sum(named_thing(r["messages"][1]["content"]) for r in written if r["kind"] == "false_premise")
    contrast = build_contrast(max(0, rest - len(replay_used) - len(right_used)), round(a.named_contrast * named_shape), a.same_passage_contrast, targeted, facts, rng)
    rows = written + wrong_used + chosen_cutoffs + right_used + replay_used + contrast
    report = {
        "mix": a.mix if a.honest_share is None else None, "honest_share_asked": honest_share, "honest_share": honest_share_of(rows),
        "seed": a.seed, "cutoff": a.cutoff, "plan": sizes, "available": {
            "written_after_screen": screened_counts, **{k: len(v) for k, v in pools.items()}, "measured_right": len(right), "measured_wrong": len(wrong),
            "cutoff_restated": len(cutoffs), "replay": len(replay), "contrast_seen": sum(facts.seen.values()),
            "contrast_glimmer_seen": sum(student_facts.seen.values()),
            "named_in_written_passages": targeted.named_same.seen, "named_elsewhere": targeted.named_other.seen, "same_passage_facts": targeted.same.seen},
        "dropped": dict(dropped.most_common()), "screen": screen.counts(), "set": tally(rows), "cost_at_measured_rate": run_cost(len(rows)),
        "sha256": write_set(a.out, rows, rng),
    }
    if a.student_out:
        cuts = chosen_cutoffs
        total = min(a.max_total, round((student_written + len(cuts)) / honest_share))
        honest_n = round(total * honest_share)
        kept = take_by_weight({k: [r for r in pools[k] if usable(r)] for k in WRITTEN_KINDS}, WRITTEN_WEIGHTS, honest_n - len(cuts), rng)
        rest_n = total - len(kept) - len(cuts)
        replays = rng.sample(replay, min(round(a.replay_share * total), len(replay)))
        student_named = round(a.named_contrast * sum(named_thing(r["messages"][1]["content"]) for r in kept if r["kind"] == "false_premise"))
        student_rows = kept + cuts + replays + build_contrast(max(0, rest_n - len(replays)), student_named, a.same_passage_contrast, student_targeted, student_facts, rng)
        bad = [r for r in student_rows if not usable(r) or r["lineage"]["tuned"] or r["kind"].startswith("measured")]
        if bad:
            raise SystemExit(f"{len(bad)} records in the student file aren't usable for the student")
        report["student"] = {"honest_share": honest_share_of(student_rows), "set": tally(student_rows), "sha256": write_set(a.student_out, student_rows, rng)}
    with open(re.sub(r"\.jsonl$", "", a.out) + "-report.json", "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
