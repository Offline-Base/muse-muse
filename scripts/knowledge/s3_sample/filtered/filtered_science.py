"""Writes s3-pmc, s3-biorxiv, s3-medrxiv and s3-openalex from knowledge/filtered/ on S3.

    python -I science.py extract <set>    read a sample from S3 into a local candidate pool
    python -I science.py build <set>      filter the pool, draw the records and write the JSONL

Dates: PMC uses the earliest full pub-date in the article's JATS and drops papers first published before the window.
bioRxiv and medRxiv use the accepted date in <history>, which is when the server approved that version for posting.
OpenAlex uses publication_date, without first-of-month placeholders, and only when created_date is close to it.
"""

import html
import json
import os
import random
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filtered_common import END, OUT_DIR, ROOT, SEED, START, WORK, RangeFile, abstract_pick, gibberish, gz_head_lines, listing, long_date, looks_english, sentences, spread_sample, strip_tags, words, write_set  # noqa: E402

import pyarrow.parquet as pq  # noqa: E402

TARGETS = {"pmc": 200, "openalex": 200, "biorxiv": 80, "medrxiv": 80}
# The PMC folders read and how much of them. unknown/ and the mangled AU-TH-OR-CH-OI-CE/ state no usable license, so they stay out.
PMC_PLAN = [("CC-BY", 26, 7), ("CC-BY-NC-ND", 10, 5), ("CC-BY-NC", 8, 5), ("TDM", 3, 4), ("CC-BY-NC-SA", 3, 4), ("CC0", 2, 4), ("CC-BY-SA", 2, 3), ("CC-BY-ND", 2, 3)]
PUBLIC = {"CC-BY", "CC0", "CC-BY-SA", "cc-by", "cc0"}
PMC_TYPES = {"research-article", "review-article", "systematic-review", "brief-report", "rapid-communication", "meta-analysis", "article"}
BAD_TITLE = re.compile(r"\b(case reports?|case series|erratum|errata|corrigend|correction|retraction|retracted|expression of concern|editorial|commentary|letter to|reply to|in memoriam|obituary|protocol|study protocol|book review|table of contents|front matter|issue information|proceedings|abstracts? of|conference abstracts?)\b", re.I)
PERSON_CASE = re.compile(r"\b\d{1,3}[- ]year[- ]old\b|\byears? of age\b|\bour patient\b|\bthe patient (was|had|presented)\b|\bwe (report|present|describe) (a|an|the) case\b|\bcase report\b|\bcase of an?\b", re.I)
JUNK_SENTENCE = re.compile(r"cite this article|this article is part of|https?:|www\.|\bdoi\b|\bregistration\b|\bregistered\b|\bPROSPERO\b|\bNCT\d|\bISRCTN\b|\bkeywords?\b|\bfunding\b|\bfunded by\b|\bcopyright\b|©|all rights reserved|published by|\bsupplementary\b|\bgraphical abstract\b|\bcorresponding author\b|\bpeer review\b|\bdata availability\b|\bconflicts? of interest\b|\bavailable at\b|\bgithub\b", re.I)
BOILERPLATE = re.compile(r"no abstract available|this is an open access|^abstract\b.{0,10}$|this article is protected|please (see|refer)|click here|full text|read more|the authors? declare|article content|purchase|subscribe", re.I)
SKIP_VENUE = re.compile(r"\bNIFS\b|zenodo|figshare|researchgate|ssrn|research ?square|hal\b|repository|repositorio|repositori|datacite|dryad|preprints?\b|biorxiv|medrxiv|arxiv", re.I)
PERMIT_HOST = "pmc.ncbi.nlm.nih.gov"


def ledger_tag(name):
    return f"science-{name}"


def out_pool(name):
    os.makedirs(WORK, exist_ok=True)
    return os.path.join(WORK, f"pool-{name}.jsonl")


def jats_dates(block):
    """Every date element in a JATS fragment as (type, year, month, day), with missing parts as 0."""
    out = []
    for attrs, body in re.findall(r"<(?:pub-date|date)\b([^>]*)>(.*?)</(?:pub-date|date)>", block, re.S):
        kind = re.search(r'(?:pub-type|date-type|publication-format)="([^"]+)"', attrs)
        year, month, day = (re.search(rf"<{t}>\s*(\d+)\s*</{t}>", body) for t in ("year", "month", "day"))
        if year:
            out.append((kind.group(1) if kind else "", int(year.group(1)), int(month.group(1)) if month else 0, int(day.group(1)) if day else 0))
    return out


def iso(y, m, d):
    return f"{y:04d}-{m:02d}-{d:02d}"


def abstract_xml(jats):
    for attrs, body in re.findall(r"<abstract\b([^>]*)>(.*?)</abstract>", jats, re.S):
        if not re.search(r'abstract-type="(graphical|teaser|toc|video|web-summary|precis|author-highlights|highlights?|summary-for-lay|plain-language|pls)"', attrs):
            return body
    return None


def abstract_text(body):
    """Plain sentences from an abstract; structured sections keep their labels."""
    if not body or re.search(r"<mml:math|<tex-math", body):
        return []
    body = re.sub(r"^\s*<title>\s*(abstract|summary)\s*:?\s*</title>", "", body, flags=re.I)
    body = re.sub(r"<title>\s*([^<]*?)\s*:?\s*</title>", lambda m: f" {m.group(1)}: " if m.group(1) else " ", body)
    text = strip_tags(body).replace("‐", "-").replace("‑", "-")
    text = re.sub(r"^(abstract|summary)\s*:?\s+", "", text, flags=re.I)
    return clean_sentences(text)


def clean_sentences(text):
    out = []
    for s in sentences(text):
        s = s.strip()
        if JUNK_SENTENCE.search(s) or words(s) < 3:
            continue
        out.append(s)
    if out and not re.search(r"[.!?][\"')\]]*$", out[-1]):
        out[-1] += "."
    return out


def clean_title(raw):
    t = strip_tags(raw or "").replace("‐", "-").replace("‑", "-").strip().rstrip(".")
    return t


def pmc_candidate(r):
    jats = r.get("jats") or ""
    if not jats or r.get("is_retracted") or r.get("is_historical_ocr"):
        return None
    head = jats[:jats.find("</front>") if "</front>" in jats else 60000]
    atype = re.search(r'<article\b[^>]*article-type="([^"]*)"', jats)
    atype = atype.group(1) if atype else ""
    abstract = abstract_xml(head)
    if atype not in PMC_TYPES or not abstract:
        return None
    published = []
    for attrs, body in re.findall(r"<pub-date\b([^>]*)>(.*?)</pub-date>", head, re.S):
        if re.search(r"pmc-release|nihms|collection", attrs):
            continue
        published += [(y, m, d) for _, y, m, d in jats_dates(f"<date {attrs}>{body}</date>")]
    full = sorted(x for x in published if x[1] and x[2])
    if not full:
        cited = r.get("pub_date") or ""
        if not re.fullmatch(r"\d{4}-\d\d-\d\d", cited):
            return None
        date = cited
    else:
        date = iso(*full[0])
    # A year or month older than the window anywhere in the publication dates means the paper came out before it.
    if any(y < 2026 for y, _, _ in published):
        return None
    if not (START <= date <= END):
        return None
    history = re.search(r"<history>.*?</history>", head, re.S)
    accepted = [iso(y, m, d) for k, y, m, d in jats_dates(history.group(0))] if history else []
    accepted = [a for a in accepted if not a.endswith("-00") and "-00-" not in a]
    if accepted and max(accepted) > date and max(accepted) > date[:8] + "31":
        return None
    journal = re.search(r"<journal-title>(.*?)</journal-title>", head, re.S)
    return {
        "id": f"pmc:{r['pmcid']}", "pmcid": r["pmcid"], "doi": r.get("doi"), "title": r.get("title") or "", "date": date, "journal": strip_tags(journal.group(1)) if journal else "",
        "license_code": r.get("license_code"), "article_type": atype, "abstract": abstract,
    }


def extract_pmc():
    rng = random.Random(SEED)
    picked = Counter()
    with open(out_pool("pmc"), "w", encoding="utf8") as f:
        for folder, n_files, mb in PMC_PLAN:
            files = [o for o in listing(f"{ROOT}/pmc/{folder}/") if o["key"].endswith(".gz") and o["size"] > 512 * 1024]
            files.sort(key=lambda o: o["key"])
            step = max(1, len(files) // n_files)
            chosen = files[rng.randrange(step)::step][:n_files]
            for o in chosen:
                seen = 0
                for r in gz_head_lines(ledger_tag("pmc"), o["key"], o["size"], mb * 1024 * 1024):
                    seen += 1
                    c = pmc_candidate(r)
                    if c:
                        c["folder"] = folder
                        c["file"] = o["key"].rsplit("/", 1)[1]
                        f.write(json.dumps(c) + "\n")
                        picked[folder] += 1
                print(folder, o["key"].rsplit("/", 1)[1], o["size"], "rows", seen, "candidates", picked[folder], flush=True)


def extract_rxiv(lane):
    rng = random.Random(SEED)
    objs = [o for o in listing(f"{ROOT}/{lane}/") if o["key"].endswith(".gz")]
    by_folder_month = {}
    for o in objs:
        _, _, _, folder, name = o["key"].split("/")
        by_folder_month.setdefault((folder, name.split("_")[0]), []).append(o)
    n = 0
    with open(out_pool(lane), "w", encoding="utf8") as f:
        for (folder, month), files in sorted(by_folder_month.items()):
            rng.shuffle(files)
            weight = 2 if folder in ("cc-by", "cc-by-nc-nd") else 1
            for o in files[:weight]:
                for r in gz_head_lines(ledger_tag(lane), o["key"], o["size"], 2 * 1024 * 1024):
                    jats = r.get("jats") or ""
                    head = jats[:jats.find("</front>") if "</front>" in jats else 60000]
                    doi = r.get("doi") or ""
                    if not re.match(r"10\.\d+/2026\.", doi):
                        continue
                    hist = re.search(r"<history>.*?</history>", head, re.S)
                    abstract = abstract_xml(head)
                    if not hist or not abstract:
                        continue
                    dates = {k: iso(y, m, d) for k, y, m, d in jats_dates(hist.group(0)) if m and d}
                    if "accepted" not in dates:
                        continue
                    f.write(json.dumps({"id": f"{lane}:{doi}", "doi": doi, "version": r.get("version"), "title": r.get("title") or "", "date": dates["accepted"], "history": dates, "license_code": r.get("license_code") or folder, "license_url": r.get("license_url"), "abstract": abstract, "deposit": month}) + "\n")
                    n += 1
            print(lane, folder, month, "pool", n, flush=True)


def extract_openalex():
    rng = random.Random(SEED)
    files = sorted((o for o in listing(f"{ROOT}/openalex/") if o["key"].endswith(".parquet") and o["size"] > 3_000_000), key=lambda o: o["key"])
    rng.shuffle(files)
    columns = ["id", "doi", "title", "publication_date", "language", "type", "venue", "publisher", "oa_status", "oa_license", "abstract", "is_retracted", "is_paratext", "created_date", "updated_date"]
    n, rows_read = 0, 0
    with open(out_pool("openalex"), "w", encoding="utf8") as f:
        for o in files[:36]:
            pf = pq.ParquetFile(RangeFile(ledger_tag("openalex"), o["key"], o["size"]))
            groups = list(range(pf.metadata.num_row_groups))
            rng.shuffle(groups)
            for g in groups[:2]:
                for r in pf.read_row_group(g, columns=columns).to_pylist():
                    rows_read += 1
                    if r["type"] not in ("article", "review") or not r["abstract"] or r["is_retracted"] or r["is_paratext"]:
                        continue
                    for k in ("publication_date", "created_date", "updated_date"):
                        r[k] = r[k].isoformat()[:10] if r[k] else None
                    f.write(json.dumps(r) + "\n")
                    n += 1
            print(o["key"].rsplit("/", 1)[1], "rows", rows_read, "pool", n, flush=True)
    print(json.dumps({"openalexRowsRead": rows_read, "openalexPool": n}))


def compose(lead, sents):
    """A self-contained record: who published what and when, then the abstract's opening and its results."""
    if not sents or sum(words(s) for s in sents) < 30:
        return None
    return abstract_pick(sents, lead)


def common_filters(title, text, counts):
    if BAD_TITLE.search(title):
        counts["title-type"] += 1
    elif words(title) > 45 or words(title) < 3:
        counts["title-length"] += 1
    elif PERSON_CASE.search(text):
        counts["individual-case"] += 1
    elif BOILERPLATE.search(text):
        counts["boilerplate"] += 1
    elif gibberish(text):
        counts["markup-or-code"] += 1
    else:
        return True
    return False


def title_key(title):
    return re.sub(r"[^a-z0-9]+", " ", html.unescape(title or "").lower()).strip()


def already_collected(skip=()):
    """Titles and DOIs in the science files collected before, so tonight's budget doesn't pay for the same paper twice. Europe PMC and DOAJ rows don't all carry a DOI, so titles count too."""
    seen = set()
    for name in sorted(os.listdir(OUT_DIR)):
        if not re.match(r"(europepmc|doaj|biorxiv|medrxiv|crossref)", name) or not name.endswith(".jsonl") or name.startswith(skip):
            continue
        with open(os.path.join(OUT_DIR, name), encoding="utf8") as f:
            for line in f:
                head = line[:1500]
                t = re.search(r'"title":\s*"((?:[^"\\\\]|\\\\.)*)"', head)
                if t:
                    seen.add(title_key(t.group(1)))
                d = re.search(r'10\.\d{4,9}/[^"\s,;]+', head)
                if d:
                    seen.add(d.group(0).rstrip(".").lower())
    return seen


def build_pmc():
    counts, pool = Counter(), []
    known = already_collected()
    for line in open(out_pool("pmc"), encoding="utf8"):
        c = json.loads(line)
        counts["candidates"] += 1
        title = clean_title(c["title"])
        if (c.get("doi") or "").lower() in known or title_key(title) in known:
            counts["already-collected"] += 1
            continue
        where = c["journal"] or "a journal"
        lead = f'The {"review" if "review" in c["article_type"] or "meta" in c["article_type"] else "paper"} "{title}" was published in {where} on {long_date(c["date"])}.'
        text = compose(lead, abstract_text(c["abstract"]))
        if not text:
            counts["no-usable-abstract"] += 1
            continue
        if not common_filters(title, text, counts):
            continue
        public = c["folder"] in PUBLIC
        pool.append({
            "id": c["id"], "source": "PubMed Central", "title": title, "url": f"https://{PERMIT_HOST}/articles/{c['pmcid']}/", "date": c["date"],
            "license": f"{c['license_code']} (PMC license_code for this article); credit the authors" if public else f"{c['license_code']} (PMC license_code for this article), training only",
            "visibility": "public" if public else "private", "text": text, "_english": looks_english(text),
        })
    finish("pmc", pool, counts)


def build_rxiv(lane):
    counts, pool = Counter(), []
    server = {"biorxiv": "bioRxiv", "medrxiv": "medRxiv"}[lane]
    # medrxiv.jsonl already holds nearly every medRxiv paper, so filtering on it would leave nothing; the report gives the overlap.
    known = already_collected(skip=("medrxiv",) if lane == "medrxiv" else ())
    overlap = already_collected() if lane == "medrxiv" else set()
    best = {}
    for line in open(out_pool(lane), encoding="utf8"):
        c = json.loads(line)
        counts["candidates"] += 1
        old = best.get(c["doi"])
        if not old or (c["date"] < old["date"]):
            best[c["doi"]] = c
    counts["distinct-dois"] = len(best)
    for c in best.values():
        if c["doi"].lower() in known or title_key(clean_title(c["title"])) in known:
            counts["already-collected"] += 1
            continue
        if not (START <= c["date"] <= END):
            counts["outside-window"] += 1
            continue
        # The DOI carries the submission date, so an approval date before it or months after it isn't trustworthy.
        stamp = re.search(r"/2026\.(\d\d)\.(\d\d)\.", c["doi"])
        submitted = f"2026-{stamp.group(1)}-{stamp.group(2)}" if stamp else None
        if not submitted or c["date"] < submitted:
            counts["date-before-doi"] += 1
            continue
        title = clean_title(c["title"])
        lead = f'The preprint "{title}" was posted to {server} on {long_date(c["date"])}.'
        text = compose(lead, abstract_text(c["abstract"]))
        if not text:
            counts["no-usable-abstract"] += 1
            continue
        if not common_filters(title, text, counts):
            continue
        code = c["license_code"]
        public = code in PUBLIC
        pool.append({
            "id": c["id"], "source": server, "title": title, "url": f"https://doi.org/{c['doi']}", "date": c["date"],
            "license": f"{code} (license block in this preprint's JATS); credit the authors" if public else f"{code} (license block in this preprint's JATS), training only",
            "visibility": "public" if public else "private", "text": text, "_english": True, "_overlap": c["doi"].lower() in overlap,
        })
    finish(lane, pool, counts)


def build_openalex():
    counts, pool = Counter(), []
    known = already_collected()
    venues = Counter()
    for line in open(out_pool("openalex"), encoding="utf8"):
        c = json.loads(line)
        counts["candidates"] += 1
        date, created = c["publication_date"], c["created_date"]
        venue = c.get("venue") or ""
        if not venue or SKIP_VENUE.search(venue) or SKIP_VENUE.search(c.get("publisher") or ""):
            counts["venue"] += 1
            continue
        if not date or not (START <= date <= END):
            counts["outside-window"] += 1
            continue
        if date.endswith("-01"):
            counts["first-of-month-date"] += 1
            continue
        if c.get("updated_date") and date > c["updated_date"]:
            counts["date-after-record-update"] += 1
            continue
        if not created or created < "2025-11-01":
            counts["record-older-than-window"] += 1
            continue
        # The record has to appear near the date: a work indexed long before its date was out earlier, or carries an issue date.
        if months_apart(created, date) > 2:
            counts["created-far-before-date"] += 1
            continue
        doi = (c.get("doi") or "").replace("https://doi.org/", "")
        if doi.lower() in known or title_key(clean_title(c["title"])) in known:
            counts["already-collected"] += 1
            continue
        if re.search(r"(?<!\d)(19\d\d|20[01]\d|202[0-4])(?!\d)", doi):
            counts["old-year-in-doi"] += 1
            continue
        title = clean_title(c["title"])
        kind = "review" if c["type"] == "review" else "paper"
        lead = f'The {kind} "{title}" was published in {strip_tags(venue)} on {long_date(date)}.'
        text = compose(lead, clean_sentences(strip_tags(c["abstract"])))
        if not text:
            counts["no-usable-abstract"] += 1
            continue
        if text.endswith("...") or text.endswith("…"):
            counts["truncated"] += 1
            continue
        if not common_filters(title, text, counts):
            continue
        venues[venue] += 1
        pool.append({
            "id": f"openalex:{c['id'].rsplit('/', 1)[1]}", "source": "OpenAlex", "title": title, "url": f"https://doi.org/{doi}" if doi else c["id"], "date": date,
            "license": "OpenAlex metadata is CC0; the abstract stays with its publisher" + (f" (best OA location says {c['oa_license']})" if c.get("oa_license") else "") + ", training only",
            "visibility": "private", "text": text, "_english": looks_english(text), "_venue": venue,
        })
    print("top venues in pool", venues.most_common(8))
    finish("openalex", pool, counts)


def months_apart(early, late):
    """How many months `late` is after `early`; zero or negative when it isn't."""
    return (int(late[:4]) - int(early[:4])) * 12 + int(late[5:7]) - int(early[5:7])


def finish(name, pool, counts):
    english = sum(1 for r in pool if r["_english"])
    picked = spread_sample(cap_venues(pool), TARGETS[name])
    if any("_overlap" in r for r in picked):
        print(json.dumps({"pickedAlsoInExistingFile": sum(1 for r in picked if r["_overlap"])}))
    print(json.dumps({"set": name, "filter": counts, "eligible": len(pool), "eligibleEnglish": english, "eligibleByMonth": dict(sorted(Counter(r["date"][:7] for r in pool).items()))}))
    write_set(name, picked)


def cap_venues(pool, cap=6):
    """No journal fills the sample: at most `cap` records from one venue, chosen with the fixed seed."""
    rng = random.Random(SEED)
    rows = list(pool)
    rng.shuffle(rows)
    seen, out = Counter(), []
    for r in rows:
        v = r.get("_venue")
        if v:
            seen[v] += 1
            if seen[v] > cap:
                continue
        out.append(r)
    return out


if __name__ == "__main__":
    step, name = sys.argv[1], sys.argv[2]
    if step == "extract":
        {"pmc": extract_pmc, "openalex": extract_openalex, "biorxiv": lambda: extract_rxiv("biorxiv"), "medrxiv": lambda: extract_rxiv("medrxiv")}[name]()
    else:
        {"pmc": build_pmc, "openalex": build_openalex, "biorxiv": lambda: build_rxiv("biorxiv"), "medrxiv": lambda: build_rxiv("medrxiv")}[name]()
