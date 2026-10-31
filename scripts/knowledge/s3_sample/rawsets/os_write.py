"""Open States: 150 state bills enacted in the window, from the bill table's latest action. No sponsors are read."""
import json, os, random, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
SP = common.SP
t = json.load(open(os.path.join(SP, "dl/os/tables.json")))
jur = {j["id"]: j["name"] for j in t["opencivicdata_jurisdiction"] if re.search(r"/(state|district|territory):[a-z]+/government$", j["id"])}
ses = {s["id"]: s for s in t["opencivicdata_legislativesession"]}
abstracts = {}
for l in open(os.path.join(SP, "dl/os/abstracts.jsonl")):
    a = json.loads(l)
    if a["abstract"]: abstracts.setdefault(a["bill_id"], a["abstract"])

ENACT = re.compile(r"(signed by (the )?gov|gov(ernor)?\.? signed|signed by governor|approved by (the )?governor|governor approved|chaptered by secretary of state\W+(- )?chapter|\bact no\b|\benacted\b|became law|becomes law|effective without governor|public act \d|session law|signed into law|without (the )?governor'?s signature)", re.I)
NOT = re.compile(r"(vetoed?|override|signed by (the )?(president|speaker|senate)|enrolled bill|to governor|presented to|sent to|transmitted|delivered|res\. chapter)", re.I)
SKIP_T = re.compile(r"\b(relief of|for the benefit of|in honor of|honoring|commend\w*|congratulat\w*|memorial|naming|renam\w*|designat\w+ (the )?(highway|bridge|road)|claims? (bill|against)|local act|victim\w*)\b", re.I)

# An act named after a person often names a private person, sometimes a victim. There are plenty of other bills.
NAMED_ACT = re.compile(r"\b[A-Z][a-z]+ (?:[A-Z]\.? )?[A-Z][a-z]+(?:'s)? (Act|Law)\b")

def sentence_case(s):
    if s.upper() == s and len(s) > 15:
        s = s.lower(); s = s[0].upper() + s[1:]
    return s

cand = []
bad = dict(cls=0, act=0, jur=0, date=0, title=0, words=0, mismatch=0)
for l in open(os.path.join(SP, "dl/os/bills.jsonl")):
    b = json.loads(l)
    if "bill" not in (b["classification"] or ""): bad["cls"] += 1; continue
    d = b["latest_action_description"] or ""
    if not ENACT.search(d) or NOT.search(d): bad["act"] += 1; continue
    s = ses.get(b["legislative_session_id"])
    state = jur.get(s["jurisdiction_id"]) if s else None
    if not state: bad["jur"] += 1; continue
    date = (b["latest_action_date"] or "")[:10]
    if not common.in_window(date): bad["date"] += 1; continue
    # A date written inside the action text is the actual enactment date; the action's date field can be a day late.
    m = re.search(r"\b(\d\d)/(\d\d)/(2026)\b", d)
    m2 = re.search(r"\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (2026)\b", d)
    m3 = re.search(r"\b(2026)-(\d\d)-(\d\d)\b", d)
    if m: date = f"2026-{m.group(1)}-{m.group(2)}"
    elif m2: date = f"2026-{common.MONTH_NUM[m2.group(1)]:02d}-{int(m2.group(2)):02d}"
    elif m3: date = m3.group(0)
    if not common.in_window(date): bad["mismatch"] += 1; continue
    title = sentence_case(re.sub(r"\s+", " ", b["title"] or "").strip().rstrip("."))
    title = re.sub(r"'S\b", "'s", title)
    title = re.sub(r"\bdelaware\b", "Delaware", title)
    title = title[0].upper() + title[1:] if title else title
    if len(title) < 15 or SKIP_T.search(title) or NAMED_ACT.search(title): bad["title"] += 1; continue
    first = (b["first_action_date"] or "")[:10]
    subj = re.findall(r'"([^"]+)"|([^{},"]+)', (b["subject"] or "{}"))
    subj = [(a or x).strip() for a, x in subj]
    subj = [x.capitalize() if x.isupper() else x for x in subj if " " in x or len(x) <= 14][:6]
    parts = [f"{state} enacted bill {b['identifier']} of the {s['name']} on {common.long_date(date)}."]
    parts.append(f"Its title reads: {title}.")
    if re.fullmatch(r"\d{4}-\d\d-\d\d", first):
        parts.append(f"The first recorded action on the bill was on {common.long_date(first)}.")
    parts.append(f"The last recorded action was: {re.sub(r'\s+', ' ', d).strip().rstrip('.')}.")
    if subj: parts.append("Subjects listed for the bill: " + ", ".join(x.strip() for x in subj) + ".")
    ab = abstracts.get(b["id"])
    base = " ".join(parts)
    if ab and re.search(r"committee of conference|^(like|as amended)\b", ab, re.I): ab = None
    if ab:
        ab = re.sub(r"\s+", " ", ab).strip()
        if not re.search(r"[.!?]$", ab): ab += "."
        room = 205 - common.wc(base)
        extra = common.cut(sentence_case(ab), room) if room > 15 else ""
        if extra: base = f"{base} Summary: {extra}"
    if common.wc(base) > 210 or common.wc(base) < 40: bad["words"] += 1; continue
    cand.append((state, common.record(f"s3-openstates:{b['id'].split('/')[-1]}", "Open States", f"{state} {b['identifier']}, enacted {common.month_name(date)}", f"https://openstates.org/{b['id']}", date, "Public domain dedication (Open States bulk data, per the set's manifest)", "public", base)))
print("cand", len(cand), bad, "states", len({c[0] for c in cand}))
rnd = random.Random(common.SEED)
rnd.shuffle(cand)
# Round robin over states, then let the writer spread by month.
by = {}
for st, r in cand: by.setdefault(st, []).append(r)
picked = []
while len(picked) < 600 and any(by.values()):
    for st in sorted(by):
        if by[st]: picked.append(by[st].pop())
kept = common.write("openstates", picked, cap=150)
print("states", len({r['text'].split(' enacted')[0] for r in kept}))
