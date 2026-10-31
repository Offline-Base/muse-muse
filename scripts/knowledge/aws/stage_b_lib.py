"""What make_stage_b_questions.py and assemble_stage_b.py share: source groups and the screen that keeps the test sets out
of Stage B (docs/KNOWLEDGE_UPDATE.md, Stage B).

The honesty test (job/honesty_probes.jsonl) stays unseen by anyone building Stage B: Screen reads it only by script, keeps
hashes-worth of normalized text in memory, and reports counts, never a question or a name. An item is screened out when
its normalized question matches a test or held-out question, or it shares a distinctive name with the test or the dev
set: a capitalized word (four letters or more, not a sentence word) or a pair of neighbouring ones from a test question,
premise, bait or note that at most MAX_DF of the held-out probe questions use. Invented names appear in none of them, so
they count; real names as common as "Meta" don't. A real but rare name is dropped too, which costs a few items. Also out: a
near match, at least NEAR of the content words shared with a test or dev question, like make-stage-b.ts's own guard.

The dev set stays out by whole record, as make-stage-b.ts keeps it: nothing from another passage of a dev record trains.

As a script it flags items for make-stage-b.ts, which keeps the rules in one place and never sees a test name:
  python3 scripts/knowledge/aws/stage_b_lib.py --flag IN.jsonl OUT.txt    (OUT: a 1 or 0 per input line; prints a count)
"""

import argparse
import collections
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JOB = os.path.join(HERE, "job")
sys.path.insert(0, JOB)
from honesty_grade import COMMON_CAPS, STARTERS, WORD  # noqa: E402
from train_glimmer import normalize  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
D = os.path.join(ROOT, ".data", "knowledge", "dataset")
TEST = os.path.join(JOB, "honesty_probes.jsonl")
HELD_OUT = [os.path.join(D, "eval-probes.jsonl"), os.path.join(D, "stage2-eval-probes.jsonl"), os.path.join(HERE, "forget.jsonl")]
PROBES = os.path.join(D, "train-stage2-probes.jsonl")
NAMED_CONTROLS = os.path.join(D, "stage-b-named-controls.jsonl")
MAX_DF = 25
NEAR = 0.6
CONTENT_STOP = set("""
of in on at to for from by with and or but is are was were be been being has have had do does did will would can could should
may might must that this these those it its as into about over after before during why what how who whom which when where
whose than then there their they them his her he she we our you your my me
""".split())
# Capitalized words ending in the kind of noun invented names end in: a real report, trial or act has the same shape, so
# a model that learns the shape means "false" refuses real ones. Used for the targeted contrast rows and the dev controls.
NAMED = re.compile(r"\b[A-Z][\w'-]+(?: (?:of |for |and |the |on )?[A-Z0-9][\w'-]*)* "
                   r"(?:Report|Study|Trial|Audit|Review|Pilot|Initiative|Act|Institute|Fund|Accord|Board|Program|Programme|Task Force|Panel|Registry|Survey|Assessment|Commission)\b")
# Bodies too familiar to tell anything: nobody will come to doubt the European Commission from these rows.
FAMILIAR = re.compile(r"\b(?:European|Securities and Exchange|Federal Trade|Federal Communications|International Trade|Postal Regulatory|Federal Reserve|Federal Energy Regulatory|Nuclear Regulatory) (?:Commission|Board)\b|^(?:The|A|An|In|On|At|By|For|What|Which|How|When|Who|Why|Did|Does|Under) ")


def named_thing(text):
    """A real or invented specific thing of NAMED's shape, leaving out the familiar bodies."""
    return any(not FAMILIAR.search(m.group(0)) for m in NAMED.finditer(text))

# assemble-dataset.ts's NEVER, plus court records: their probes exist, and there's no call to put people from court
# filings into a set of questions (docs/KNOWLEDGE_UPDATE.md, Rules).
SKIP = re.compile(r"^(gap-wikipedia-|wikisource|us-doj|s3-infini-news|s3-fine-news|s3-forecastbench|s3-openlibrary|courtlistener)")
AI_META = re.compile(r"^(s3-ccnews-ai-meta|meta-|gap-meta-|gap-hf-|us-sec-meta|pytorch-blog|hf-card|models-dev|sdk-changelog|epoch|lmarena|"
                     r"github-|anthropic-release-notes|google-ai-changelog)")
NEWS = re.compile(r"^(s3-ccnews|global-voices|un-news|voa|agencia-brasil|kremlin)")
WIKI = re.compile(r"^(article|event|s3-wikimedia)$")
# The pull toward AI, Meta and general news, for the measured questions and the contrast facts alike.
SHARES = {"ai_meta": 0.40, "news": 0.30, "wikipedia": 0.175, "other": 0.125}


def source_kind(source):
    """assemble-dataset.ts's group(): a record id's prefix for collected sources, else the passage kind."""
    return source.split(":")[1] if source.startswith("source:") else source.split(":")[0]


def topic_group(source):
    kind = source_kind(source)
    if AI_META.match(kind):
        return "ai_meta"
    if NEWS.match(kind):
        return "news"
    if WIKI.match(kind):
        return "wikipedia"
    return "other"


def read_jsonl(path):
    with open(path) as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def qkey(question):
    return normalize(question).strip()


def grams(text):
    words = normalize(text).split()
    return set(words) | {a + " " + b for a, b in zip(words, words[1:])}


def content_words(text):
    return {w for w in normalize(text).split() if w not in CONTENT_STOP and len(w) > 2}


def usable_aliases(question, aliases):
    """Aliases answered() can trust: a short one matches by luck, and one the question holds is met by saying the question back."""
    asked = normalize(question)
    return [a for a in aliases or [] if len(normalize(a).strip()) > 2 and normalize(a) not in asked]


def record_of(passage):
    """The record a passage comes from, so a dev item's whole record stays out: "source:ons:7:0" is from "source:ons:7",
    "article:Title:Section:0" from "article:Title"; an event entry is its own record."""
    if passage.startswith("source:"):
        return passage.rsplit(":", 1)[0]
    if passage.startswith("article:"):
        return passage.rsplit(":", 2)[0]
    return passage


def name_candidates(text):
    """Capitalized words of four letters or more and pairs of neighbouring capitalized words, normalized like grams()."""
    out, prev, prev_end = set(), None, -1
    for m in WORD.finditer(text or ""):
        w = m.group(0)
        if not w[0].isupper() or w.lower() in STARTERS or w.lower() in COMMON_CAPS:
            prev = None
            continue
        parts = normalize(w).split()
        if not parts:
            prev = None
            continue
        out.update(p for p in parts if len(p) >= 4)
        out.update(a + " " + b for a, b in zip(parts, parts[1:]))
        if prev and not text[prev_end:m.start()].strip():
            out.add(prev + " " + parts[0])
        prev, prev_end = parts[-1], m.end()
    return out


class Screen:
    """Why an item must stay out of Stage B, or None. Only counts ever leave this class."""

    def __init__(self, test=TEST, held_out=None, dev=None, pool=PROBES, max_df=MAX_DF):
        self.held = set()
        self.passages = set()
        self.near_sets = []
        self.near_index = collections.defaultdict(list)
        if held_out is None:
            held_out = HELD_OUT + ([NAMED_CONTROLS] if os.path.exists(NAMED_CONTROLS) else [])
        for path in held_out:
            for p in read_jsonl(path):
                self.held.add(qkey(p["question"]))
                if p.get("passageId"):
                    self.passages.add(p["passageId"])
        self.test = set()
        self.dev_passages = set()
        candidates = set()
        self.test_items = 0
        for path in [test] + ([dev] if dev else []):
            for p in read_jsonl(path):
                self.test_items += 1
                self.test.add(qkey(p["question"]))
                mine = content_words(p["question"])
                self.near_sets.append(mine)
                for w in mine:
                    self.near_index[w].append(len(self.near_sets) - 1)
                if ":" in str(p.get("source") or ""):
                    # make-stage-b.ts names a dev item's passage: nothing else from its record goes into training.
                    self.dev_passages.add(p["source"].split(":", 1)[1])
                for field in ("question", "premise", "note"):
                    candidates |= name_candidates(str(p.get(field) or ""))
                for b in p.get("bait") or []:
                    candidates |= name_candidates(str(b))
        df = dict.fromkeys(candidates, 0)
        for p in read_jsonl(pool):
            for g in grams(p["question"]) & candidates:
                df[g] += 1
        self.names = {g for g, n in df.items() if n <= max_df}
        self.passages |= self.dev_passages
        self.dev_records = {record_of(p) for p in self.dev_passages}

    def in_dev(self, passage):
        return passage in self.dev_passages or record_of(passage) in self.dev_records

    def near(self, question):
        mine = content_words(question)
        hits = collections.Counter(i for w in mine for i in self.near_index.get(w, ()))
        return any(n / (len(mine) + len(self.near_sets[i]) - n) >= NEAR for i, n in hits.items())

    def why(self, question, text=""):
        key = qkey(question)
        if key in self.test:
            return "test or dev question"
        if key in self.held:
            return "held-out question"
        if self.near(question):
            return "near match with a test or dev question"
        if grams(question) & self.names or (text and grams(text) & self.names):
            return "shares a distinctive test or dev name"
        return None

    def counts(self):
        return {"test_and_dev_items": self.test_items, "test_and_dev_questions": len(self.test), "held_out_questions": len(self.held),
                "held_out_passages": len(self.passages), "distinctive_names": len(self.names)}


def flag(path_in, path_out):
    """make-stage-b.ts's dev candidates against the final test only: a 1 for each one that must go, in order."""
    screen = Screen(dev=None, held_out=[])
    n = 0
    with open(path_out, "w") as out:
        for item in read_jsonl(path_in):
            bad = bool(screen.why(item["question"], " ".join(str(x) for x in (item.get("reply"), item.get("premise"), item.get("note"), *item.get("bait", [])) if x)))
            n += bad
            out.write("1\n" if bad else "0\n")
    print(f"dev candidates flagged: {n}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--flag", nargs=2, metavar=("IN", "OUT"), required=True)
    flag(*ap.parse_args().flag)
