"""English Wikipedia: pick 350 dated paragraphs from the incremental-dump candidates, spread across months."""
import glob, hashlib, json, os, random, re, sys, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
SP = common.SP
rows = []
for f in sorted(glob.glob(os.path.join(SP, "wm/[tm][0-9]*.jsonl"))):
    rows += [json.loads(l) for l in open(f)]
print("candidates", len(rows), "titles", len({r["title"] for r in rows}))
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"
SPORT_BIO = re.compile(r"\((\w+ )?(footballer|soccer|soccer player|cricketer|rugby\w*|basketball\w*|baseball\w*|ice hockey|American football|tennis|athlete|racing driver|wrestler|boxer|sprinter|swimmer|cyclist|golfer|volleyball\w*)\b", re.I)
CRIME_T = re.compile(r"\b(murder\w*|killing|death of|shooting|stabbing|disappearance|kidnapping|abduction|rape|(sexual )?assault|trial of|people v\.?|state v\.?)\b", re.I)
DANGLING = re.compile(r"^(He|She|They|It|This|That|These|Those|His|Her|Their|However|Meanwhile|Later|Also|Then|In response|As a result|The following)\b")
DROP_T = re.compile(r"^(List of|Deaths in|Portal:|Timeline of|Index of|Outline of)|\b(discography|filmography|bibliography)\b", re.I)
LOWQ = re.compile(r"\b(\d+[-–]\d+ (draw|win|loss)|from the bench|on loan|signed a \w+-year contract|loan deal|free agent|debut for|practice roster|made (his|her) (\w+ )?debut|renewed (his|her) contract|retweet|tiktok|instagram|podcast)\b", re.I)
NEG = re.compile(r"\b(allegedly|alleged|accused|accusation|misconduct|harass\w*|scandal|abuse\w*|racist|racial slur|dui|drunk driving|prison|jail\w*|police|investigation into \w+ \w+|shooting|shot|gunman|killed by|died in a|disappear\w*|missing person|mother|father|brother|sister|cousin|family|tribute|funeral|will|are to continue|were to continue)\b", re.I)

def trim(text, iso):
    """Keep the sentence naming the date. A long paragraph starts at the sentence before it."""
    y, m, d = iso.split("-")
    name = common.MONTHS[int(m) - 1]
    pat = re.compile(rf"\b{name} {int(d)},? 2026\b|\b{int(d)} {name},? 2026\b")
    sents = common.sentences(text)
    idx = next((i for i, s in enumerate(sents) if pat.search(s)), None)
    if idx is None: return ""
    if common.wc(text) <= 195: return text
    start = max(0, idx - 1)
    return common.cut(" ".join(sents[start:]), 195)

out = []
stats = dict(trim=0, title=0, sport=0, neg=0, low=0, dangle=0)
rnd = random.Random(common.SEED)
rnd.shuffle(rows)
seen_tail = set()
for r in rows:
    t = r["title"]
    core = re.sub(r"\s*\(.*\)$", "", t)
    if DROP_T.search(t) or CRIME_T.search(t): stats["title"] += 1; continue
    if NEG.search(r["text"]): stats["neg"] += 1; continue
    if LOWQ.search(r["text"]): stats["low"] += 1; continue
    text = trim(r["text"], r["date"])
    if not text: stats["trim"] += 1; continue
    first = common.sentences(text)[0]
    words = [w for w in re.findall(r"\w+", core) if len(w) > 3]
    named = any(w in first for w in words) if words else core in first
    if DANGLING.match(first) and not named: stats["dangle"] += 1
    if not named:
        sect = re.sub(r"\{\{.*?\}\}", "-", r["sect"] or "")
        sect = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", sect).replace("'" * 3, "").replace("'" * 2, "")
        sec = f", section {sect}" if sect else ""
        text = f"From the English Wikipedia article on {core}{sec}. {text}"
    if common.wc(text) > 210 or common.wc(text) < 40: stats["trim"] += 1; continue
    h = hashlib.sha1(r["text"].encode()).hexdigest()[:10]
    url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(t.replace(" ", "_"))
    rec = common.record(f"s3-wikimedia:{r['pid']}:{h}", "English Wikipedia", t, url, r["date"], "CC BY-SA 4.0 (English Wikipedia, revision of October 2026, attribute and link back)", "public", text)
    tailkey = re.sub(r"\W+", " ", r["text"][-120:].lower())
    if tailkey in seen_tail: continue
    seen_tail.add(tailkey)
    rec["_sport"] = bool(SPORT_BIO.search(t))
    rec["_ev"] = "2026" in t
    out.append(rec)
print(stats, "usable", len(out))
# At most one paragraph per title in a month and two per title overall, sport bios held to a tenth of each month.
per_t, per_tm, per_m_sport, picked = {}, set(), {}, []
out.sort(key=lambda r: (not r["_ev"], rnd.random()) if rnd.random() < 0.4 else (True, rnd.random()))
for r in out:
    m = r["date"][:7]
    if (r["title"], m) in per_tm or per_t.get(r["title"], 0) >= 2: continue
    if r["_sport"]:
        if per_m_sport.get(m, 0) >= 2: continue
        per_m_sport[m] = per_m_sport.get(m, 0) + 1
    per_tm.add((r["title"], m)); per_t[r["title"]] = per_t.get(r["title"], 0) + 1
    picked.append(r)
print("after caps", len(picked))
for r in picked:
    r.pop("_sport"); r.pop("_ev")
kept = common.write("wikimedia", picked, cap=350)
