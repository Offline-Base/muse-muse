"""Writes s3-courtlistener from knowledge/filtered/courtlistener/.

    python -I filtered_court.py extract    keep opinions whose caption names only governments, agencies, officials or companies
    python -I filtered_court.py build      filter by subject, cut to the sentences that state what was decided, write the JSONL

Opinions name private people. The caption test runs first and both sides have to pass it. The subject tests then drop family,
criminal, immigration, employment-discrimination, Social Security, prisoner and injury matters. Only sentences without citations
or names outside the caption reach a record.
"""

import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filtered_common import END, ROOT, START, WORK, RangeFile, gibberish, listing, long_date, looks_english, sentences, spread_sample, strip_tags, words, write_set  # noqa: E402

import pyarrow as pa  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

TAG = "court"
STATES = "Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio Oklahoma Oregon Pennsylvania Tennessee Texas Utah Vermont Virginia Washington Wisconsin Wyoming".split() + ["New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Rhode Island", "South Carolina", "South Dakota", "West Virginia", "District of Columbia", "Puerto Rico"]
COMPANY = r"\b(inc|incorporated|llc|l\.l\.c|lp|l\.p|llp|l\.l\.p|corp|corporation|company|co|ltd|limited|plc|n\.a|bank|insurance|assurance|indemnity|holdings?|partners|partnership|group|associates|association|ass'n|assn|foundation|university|college|hospital|medical center|railroad|railway|airlines?|energy|electric|utilities|pharmaceuticals?|technologies|industries|enterprises)\b\.?"
GOVERNMENT = r"\b(united states|u\.s\.|usa|state|commonwealth|city|county|town|township|village|borough|parish|municipal\w*|department|dept|agency|commission|commissioners?|board|authority|bureau|secretary|attorney general|governor|mayor|federal|administration|government|treasurer|comptroller|treasury|office of|tribe|tribal|nation|republic|school district|public utilities|legislature|senate|congress|port of|internal revenue|environmental protection|nlrb|fcc|ftc|sec|epa|fda|faa|ferc|cfpb|osha|hhs|irs)\b\.?"
OFFICIAL = re.compile(r"\b(secretary|governor|attorney general|commissioner|administrator|director|mayor|treasurer|comptroller|chair(man|woman|person)?)\b", re.I)
EVIDENCE = re.compile(f"{COMPANY}|{GOVERNMENT}", re.I)
BARE_STATE = re.compile(r"^(state of |commonwealth of |people of (the )?(state of )?)?(" + "|".join(STATES) + r")$", re.I)
SUFFIX_ONLY = re.compile(r"^(inc|incorporated|llc|l\.l\.c|lp|l\.p|llp|corp|co|ltd|plc|n\.a|et al|et als?)\.?$", re.I)
NOT_A_PARTY_WE_KEEP = re.compile(
    r"\b(doe|roe|estate|minor|guardian|trustees?|trust|conservator|administrat(or|rix)|executor|executrix|inmates?|wardens?|prisons?|penitentiary|corrections?|correctional|sheriff|parole|probation|"
    r"child(ren)?|marriage|interest of|adoption|juvenile|family|families|parents?|paternity|social security|immigration|homeland|citizenship|asylum|human services|children|workers'? comp\w*|unemployment|"
    r"disciplinary|attorney grievance|bar association|state bar|ex rel|relator|petitioner|appellant|personal representative|survivors?|widow|in the matter|unknown|police|detective|officers?)\b",
    re.I,
)
SUBJECT = {
    "family": r"\b(divorce|custody|child support|alimony|paternity|parental rights|dependency|foster care|adoption|domestic violence|marital|spous\w+)\b",
    "criminal": r"\b(indict\w*|convict\w*|sentenc\w+|habeas|guilty|plea agreement|prosecut\w+|criminal|felony|misdemeanor|defendant was arrested|probable cause|parole)\b",
    "immigration": r"\b(immigration|asylum|removal proceedings|deport\w+|uscis|visa|noncitizen|alien|board of immigration)\b",
    "employment": r"\b(title vii|discriminat\w+|eeoc|equal employment|adea|americans with disabilities|\bada\b|retaliat\w+|wrongful(ly)? terminat\w+|harass\w+|fmla|family and medical leave|hostile work)\b",
    "social_security": r"\b(social security|disability benefits|disability insurance|supplemental security|administrative law judge|\balj\b)\b",
    "prisoner_or_injury": r"\b(inmates?|prisoners?|incarcerat\w+|injur(y|ies|ed) (to|suffered|sustained)|personal injur\w+|wrongful death|malpractice|workers'? compensation|decedent|negligen\w+|sexual\w*|assault\w*|rape|murder\w*|homicide|minor child|victims?)\b",
    "attorney_discipline": r"\b(disciplinary|disbar\w+|suspension of (his|her) license|license to practice law)\b",
}
SUBJECT = {k: re.compile(v, re.I) for k, v in SUBJECT.items()}
HOLDING = re.compile(r"\b(we (therefore |thus |accordingly |now )?(affirm|reverse|vacate|remand|hold|conclude|deny|grant|dismiss|agree|find|modify)|the court (therefore |thus |accordingly )?(grants?|denies|den(y|ied)|finds|concludes|holds|dismisses|affirms|reverses|granted)|(is|are) (hereby )?(affirmed|reversed|vacated|granted|denied|dismissed|remanded)|judgment of the .{1,60} is|for these reasons|for the (foregoing|reasons))\b", re.I)
INTRO = re.compile(r"\b(this (appeal|case|action|dispute|petition|matter|lawsuit)|appeals? from|petition(s|ed)? for review|filed (suit|this|a complaint|an action)|sued|brought (this|an|suit)|challeng\w+|seeks? (review|judgment|a declaration)|concerns?|arises? (from|out of)|at issue)\b", re.I)
NOISE = re.compile(r"\b\d+[A-Za-z]{1,4}\d*\b|\bJ\.:|\bop\b\s+\d|\bv\.\s|\bvs\.\s|\d+\s+[A-Z][A-Za-z.\d]{0,10}(\s[A-Z0-9][A-Za-z.\d]{0,8})?\s+\d+|\bId\.|\bSee\b|\bsee\b|\bCf\.|\bquoting\b|\bciting\b|\bECF\b|\bDkt\b|\bDoc\.|\bR\. at\b|\bPl\.|\bDef\.|\bCompl\.|¶|\bMr\.|\bMs\.|\bMrs\.|\bDr\.|\bpro se\b|\bcounsel\b|\battorneys?\b|\bFiled\b|\bFILED\b|\bNo\.\s|\bPage\b|\bSLIP\b|\bNOT FOR PUBLICATION\b|\bfootnote\b|\b[Hh]usband\b|\b[Ww]ife\b|\bemployee\b|_{2,}|\.{4,}|\*{2,}", re.S)
CAP_OK = set("""The This That These Those A An In On At By For From To Of And Or But If As It Its We Our Us He She They Their His Her Under After Before Because Although While When Where Whether However Thus Therefore Accordingly Moreover Further Finally First Second Third Here Since Upon Without With Having Given Although
Court Courts Circuit District United States State Supreme Appeals Appellate Bankruptcy Tax Claims County City Town Village Township Commonwealth Act Acts Code Department Board Commission Commissioner Commissioners Agency Authority Bureau Federal National General Attorney Secretary Governor Congress Rule Rules Procedure Civil Title Section Sections Article Amendment Constitution Constitutional Administrative Administration Regulations Regulation Statute Statutes Law Laws Public Service Services Office Plaintiff Plaintiffs Defendant Defendants Appellant Appellants Appellee Appellees Petitioner Petitioners Respondent Respondents Motion Order Summary Judgment Complaint Inc LLC Corp Corporation Company Co Ltd Bank Insurance University College Hospital School Schools Trial Judge Justice Chief Senior Magistrate Clerk Treasury Revenue Internal Environmental Protection Clean Air Water Energy Medicare Medicaid Health Human Labor Relations Communications Securities Exchange Trade Patent Trademark Copyright Federal Commerce Lanham ERISA CERCLA RICO FDA EPA NLRB FERC IRS SEC FCC FTC Inc. U.S. Tribe Nation Republic American America Native Indian""".split()) | set(w for s in STATES for w in s.split()) | set("January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split())
DICT_PATH = "/usr/share/dict/words"
DICTIONARY = set(w.strip() for w in open(DICT_PATH, encoding="utf8", errors="ignore")) if os.path.exists(DICT_PATH) else set()
LOWER_DICT = {w for w in DICTIONARY if w.islower()}


def pool_path():
    os.makedirs(WORK, exist_ok=True)
    return os.path.join(WORK, "pool-courtlistener.jsonl")


def side_ok(side):
    """Every named party on this side shows, in the caption, that it's a government, agency, official or company."""
    side = re.sub(r"\bet\s+al\.?|\bet\s+als?\.?", "", side, flags=re.I).strip(" ,;")
    if not side or NOT_A_PARTY_WE_KEEP.search(side):
        return False
    pieces = [p.strip(" .") for p in re.split(r",|;|\band\b", side) if p.strip(" .")]
    pieces = [p for p in pieces if not SUFFIX_ONLY.match(p)]
    for i, piece in enumerate(pieces):
        if EVIDENCE.search(piece) or BARE_STATE.match(piece):
            continue
        # A person's name passes only when the next piece is their office: "Jane Roe, Secretary of Labor".
        if i + 1 < len(pieces) and OFFICIAL.search(pieces[i + 1]) and EVIDENCE.search(pieces[i + 1]):
            continue
        return False
    return bool(pieces)


def caption_ok(name):
    name = (name or "").strip()
    if not name:
        return False
    parts = re.split(r"\s+vs?\.?\s+", name, maxsplit=1, flags=re.I)
    if len(parts) == 2:
        # "State v. Washington" is a person called Washington, so a bare state name only passes against a company or agency.
        if BARE_STATE.match(parts[1].strip()) and re.fullmatch(r"(the )?(state|people|commonwealth|united states( of america)?|u\.s\.)( of .*)?", parts[0].strip(), re.I):
            return False
        return side_ok(parts[0]) and side_ok(parts[1])
    single = re.match(r"^in re:?\s+(.*)$", name, re.I)
    return bool(single and re.search(COMPANY, single.group(1), re.I) and side_ok(single.group(1)))


def extract():
    meta_key = f"{ROOT}/courtlistener/clusters.parquet"
    obj = next(o for o in listing(f"{ROOT}/courtlistener/") if o["key"] == meta_key)
    table = pq.read_table(RangeFile(TAG, obj["key"], obj["size"]), columns=["id", "date_filed", "date_filed_is_approximate", "case_name", "case_name_full", "slug", "syllabus", "posture", "nature_of_suit", "disposition", "precedential_status", "blocked", "source"]).to_pylist()
    counts = Counter(clusters=len(table))
    keep = {}
    for r in table:
        if r["blocked"] == "t":
            counts["blocked"] += 1
            continue
        if r["date_filed_is_approximate"] == "t":
            counts["approximate-date"] += 1
            continue
        if not (START <= (r["date_filed"] or "") <= END):
            counts["outside-window"] += 1
            continue
        name = r["case_name"] or r["case_name_full"] or ""
        if not caption_ok(name) or (r["case_name_full"] and r["case_name"] and not caption_ok(r["case_name_full"]) and " v" in r["case_name_full"]):
            counts["caption-rejected"] += 1
            continue
        r["name"] = name
        keep[r["id"]] = r
    counts["caption-survivors"] = len(keep)
    print(json.dumps(counts), flush=True)
    with open(os.path.join(WORK, "caption-sample.txt"), "w", encoding="utf8") as f:
        for r in list(keep.values())[::max(1, len(keep) // 150)]:
            f.write(f"{r['date_filed']} {r['name']}\n")
    parts = [o for o in listing(f"{ROOT}/courtlistener/opinions/") if o["size"] > 1000]
    found = 0
    done_path = os.path.join(WORK, "court-parts-done.txt")
    done = set(open(done_path).read().split()) if os.path.exists(done_path) else set()
    with open(pool_path(), "a" if done else "w", encoding="utf8") as out:
        for o in parts:
            if o["key"] in done:
                continue
            pf = pq.ParquetFile(RangeFile(TAG, o["key"], o["size"]))
            t = pf.read(columns=["id", "cluster_id", "type", "plain_text", "html"])
            ids, clusters, types = t.column("id").to_pylist(), t.column("cluster_id").to_pylist(), t.column("type").to_pylist()
            wanted = [i for i, c in enumerate(clusters) if c in keep and (types[i] or "").startswith(("010", "020"))]
            indices = pa.array(wanted, type=pa.int64())
            texts, htmls = t.column("plain_text").take(indices).to_pylist(), t.column("html").take(indices).to_pylist()
            del t
            for j, i in enumerate(wanted):
                cluster = keep[clusters[i]]
                text = texts[j] or (strip_tags(htmls[j]) if htmls[j] else "")
                if not text or len(text) < 600:
                    counts["no-text"] += 1
                    continue
                out.write(json.dumps({"opinion": ids[i], "cluster": clusters[i], "name": cluster["name"], "date": cluster["date_filed"], "slug": cluster["slug"], "syllabus": cluster["syllabus"], "posture": cluster["posture"], "nature": cluster["nature_of_suit"], "status": cluster["precedential_status"], "source": cluster["source"], "text": text}) + "\n")
                found += 1
            out.flush()
            with open(done_path, "a") as d:
                d.write(o["key"] + "\n")
            print(o["key"].rsplit("/", 1)[1], "wanted", len(wanted), "pool", found, flush=True)
    print(json.dumps(counts), flush=True)


PLACE = "|".join(sorted((STATES + ["Columbia", "Guam", "Virgin Islands", "Northern Mariana Islands"]), key=len, reverse=True))
COURT_PATTERNS = [
    r"SUPREME COURT OF THE UNITED STATES",
    rf"(?i:UNITED STATES COURT OF APPEALS,?\s+(?:FOR THE\s+)?(?:THE\s+)?[A-Za-z ]{{3,30}}CIRCUIT)",
    rf"(?i:UNITED STATES DISTRICT COURT,?\s+(?:FOR THE\s+)?(?:THE\s+)?[A-Za-z ]{{0,30}}DISTRICT OF (?:{PLACE}))",
    r"(?i:UNITED STATES TAX COURT)",
    r"(?i:UNITED STATES COURT OF FEDERAL CLAIMS)",
    r"(?i:UNITED STATES COURT OF INTERNATIONAL TRADE)",
    rf"(?i:SUPREME (?:JUDICIAL )?COURT OF (?:THE STATE OF |THE COMMONWEALTH OF )?(?:{PLACE}))",
    rf"(?i:(?:THE )?COURT OF (?:CIVIL |CRIMINAL )?APPEALS?,? OF (?:THE STATE OF |THE COMMONWEALTH OF )?(?:{PLACE}))",
    rf"(?i:(?:{PLACE}) COURT OF (?:CIVIL |CRIMINAL )?APPEALS)",
    rf"(?i:(?:{PLACE}) SUPREME COURT)",
    r"(?i:COMMONWEALTH COURT OF PENNSYLVANIA)",
]


def court_of(text):
    head = re.sub(r"\s+", " ", text[:2500])
    for p in COURT_PATTERNS:
        m = re.search(p, head)
        if m:
            name = re.sub(r"^(IN THE|In the)\s+", "", m.group(0)).strip()
            if name.isupper():
                name = " ".join(w if w in ("OF", "THE", "FOR") and False else w.capitalize() for w in name.split()).replace(" Of ", " of ").replace(" The ", " the ").replace(" For ", " for ")
            return "the " + re.sub(r"^the\s+", "", name, flags=re.I)
    return None


def name_free(sentence, caption_tokens):
    """No capitalized word mid-sentence that could be a person: not generic, not a dictionary word, not in the caption."""
    tokens = re.findall(r"[A-Za-z][A-Za-z'.-]*", sentence)
    for i, tok in enumerate(tokens):
        bare = tok.strip(".'")
        if not bare or not bare[0].isupper():
            continue
        if bare in CAP_OK or bare.lower() in caption_tokens or bare.isupper():
            continue
        if i == 0 and bare.lower() in LOWER_DICT:
            continue
        if bare.lower() in LOWER_DICT:
            # A common word in title case is fine unless it sits beside another unknown capital, like "Tom Brown".
            next_tok = tokens[i + 1] if i + 1 < len(tokens) else ""
            if next_tok[:1].isupper() and next_tok.strip(".'") not in CAP_OK and next_tok.lower().strip(".'") not in caption_tokens and bare not in CAP_OK:
                return False
            continue
        return False
    return True


def tidy(text):
    text = text.replace("—", ", ").replace("\xad", "").replace("’", "'")
    text = re.sub(r"(\w)-\n\s*(\w)", r"\1\2", text)
    text = re.sub(r"\n\s*\d{1,3}\s*\n", "\n", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\[\s*\d+\s*\]|\(\s*\d{1,3}\s*\)$", "", text)
    return text.strip()


def compose(c, text):
    caption = re.sub(r"\s+", " ", c["name"]).strip()
    caption_tokens = {t.lower().strip(".,'") for t in re.findall(r"[A-Za-z][A-Za-z'.-]*", caption)}
    court = court_of(text)
    pool = []
    for i, s in enumerate(sentences(tidy(text))):
        n = words(s)
        if n < 8 or n > 65 or NOISE.search(s) or not re.search(r"[.!?][\"')\]]*$", s) or not re.match(r"^[A-Z\"']", s):
            continue
        if not name_free(s, caption_tokens):
            continue
        if sum(1 for ch in s if ch.isupper()) / max(len(s), 1) > 0.25:
            continue
        pool.append((i, s))
    holdings = [(i, s) for i, s in pool if HOLDING.search(s)]
    if not holdings:
        return None, "no-holding"
    intros = [(i, s) for i, s in pool if INTRO.search(s) and i < (holdings[-1][0])][:3]
    lead = f"{caption} was decided on {long_date(c['date'])}" + (f" by {court}." if court else ".")
    left = 205 - words(lead)
    chosen = []
    for i, s in intros + holdings[:6] + holdings[-3:]:
        if (i, s) in chosen or words(s) > left:
            continue
        chosen.append((i, s))
        left -= words(s)
    body = " ".join(s for _, s in sorted(chosen))
    if words(body) < 45:
        return None, "too-little-clean-text"
    return f"{lead} {body}", None


def build():
    counts, pool = Counter(), []
    seen_cluster = set()
    date_seen = 0
    for line in open(pool_path(), encoding="utf8"):
        c = json.loads(line)
        counts["opinions-after-caption"] += 1
        if not caption_ok(c["name"]):
            counts["caption-rejected-on-recheck"] += 1
            continue
        if c["cluster"] in seen_cluster:
            counts["second-opinion-same-case"] += 1
            continue
        hay = " ".join([c["name"], c.get("syllabus") or "", c.get("posture") or "", c.get("nature") or "", c["text"]])
        hit = next((k for k, rx in SUBJECT.items() if rx.search(hay)), None)
        if hit:
            counts[f"subject-{hit}"] += 1
            continue
        counts["after-subject-filters"] += 1
        text, why = compose(c, c["text"])
        if not text:
            counts[why] += 1
            continue
        if gibberish(text):
            counts["markup-or-code"] += 1
            continue
        seen_cluster.add(c["cluster"])
        y, m, d = c["date"].split("-")
        written = long_date(c["date"])
        if written in c["text"][:6000] or written.upper() in c["text"][:6000] or f"{int(m)}/{int(d)}/{y}" in c["text"][:6000] or f"{int(m):02d}/{int(d):02d}/{y}" in c["text"][:6000]:
            c["_dated"] = True
            date_seen += 1
        pool.append({
            "id": f"courtlistener:{c['cluster']}", "source": "CourtListener", "title": re.sub(r"\s+", " ", c["name"]).strip(), "url": f"https://www.courtlistener.com/opinion/{c['cluster']}/{c.get('slug') or ''}/".replace("//", "/").replace("https:/", "https://"),
            "date": c["date"], "license": "Public Domain Mark on CourtListener bulk data (Free Law Project)", "visibility": "public", "text": text, "_english": True, "_dated": bool(c.get("_dated")),
        })
    print(json.dumps({"filter": counts, "eligible": len(pool), "dateAlsoInOpinionText": date_seen, "eligibleByMonth": dict(sorted(Counter(r["date"][:7] for r in pool).items()))}), flush=True)
    picked = spread_sample(pool, 150)
    print("picked with date also in opinion text", sum(1 for r in picked if r["_dated"]))
    write_set("courtlistener", picked)


if __name__ == "__main__":
    {"extract": extract, "build": build}[sys.argv[1]]()
