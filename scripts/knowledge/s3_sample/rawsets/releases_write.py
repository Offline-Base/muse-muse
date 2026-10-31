"""MusicBrainz release groups and festivals, Open Library editions: real 2026 dates and named creators only."""
import collections, json, os, random, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
SP = common.SP
which = sys.argv[1]
rnd = random.Random(common.SEED)

def join_list(xs):
    xs = [x for x in xs if x]
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1] if xs else ""

if which == "musicbrainz":
    recs, stats = [], collections.Counter()
    for l in list(open(os.path.join(SP, "mb/rg.jsonl"))) + list(open(os.path.join(SP, "mb/rg2.jsonl"))):
        try: g = json.loads(l)
        except Exception: stats["json"] += 1; continue
        date = g.get("first-release-date") or ""
        if not common.in_window(date): stats["date"] += 1; continue
        ptype = g.get("primary-type")
        if ptype not in ("Album", "EP", "Single"): stats["type"] += 1; continue
        if g.get("secondary-types"): stats["secondary"] += 1; continue
        votes = (g.get("rating") or {}).get("votes-count") or 0
        tags = sorted(g.get("tags") or [], key=lambda t: -(t.get("count") or 0))
        NOT_GENRE = re.compile(r"\.\w\w|on cover|\d|\[|/|review|magazine|favou?rite|owned|wishlist", re.I)
        genres = [t["name"] for t in (g.get("genres") or [])][:5] or [t["name"] for t in tags if (t.get("count") or 0) > 0 and not NOT_GENRE.search(t["name"])][:5]
        # Notability stands in for: someone rated it or tagged it, and the artist has tags of its own.
        credit = g.get("artist-credit") or []
        artists = [a.get("artist") or {} for a in credit]
        if not artists or any(a.get("name") in ("Various Artists", "[unknown]", "[anonymous]") for a in artists): stats["artist"] += 1; continue
        art_tags = sum(len(a.get("tags") or []) for a in artists)
        if not (votes >= 2 or (genres and art_tags >= 3) or (votes >= 1 and art_tags >= 3)): stats["notable"] += 1; continue
        title = g.get("title", "").strip()
        who = "".join((a.get("name") or "") + (a.get("joinphrase") or "") for a in credit).strip()
        a0 = artists[0]
        desc = []
        if a0.get("type"): desc.append(a0["type"].lower())
        if a0.get("disambiguation"): desc.append(a0["disambiguation"])
        if a0.get("area") and a0["area"].get("name"): desc.append(f"from {a0['area']['name']}")
        kind = {"Album": "album", "EP": "EP", "Single": "single"}[ptype]
        text = f'{who} released the {kind} "{title}" on {common.long_date(date)}, the first release date listed for it in the MusicBrainz database.'
        if desc: text += f" MusicBrainz describes {a0.get('name')} as: {', '.join(desc)}."
        if genres: text += f" Genres and tags listed for the {kind}: {join_list(genres)}."
        if votes: text += f" {votes} MusicBrainz user{'s' if votes != 1 else ''} had rated it by October 2026."
        at = [t["name"] for t in sorted(a0.get("tags") or [], key=lambda t: -(t.get("count") or 0)) if not NOT_GENRE.search(t["name"])][:4]
        if at: text += f" Tags listed for the artist: {join_list(at)}."
        if common.wc(text) < 40: stats["short"] += 1; continue
        recs.append(common.record(f"s3-musicbrainz:rg:{g['id']}", "MusicBrainz", f"{who}, {title}", f"https://musicbrainz.org/release-group/{g['id']}", date, "MusicBrainz: core data CC0, tags and ratings CC BY-NC-SA 3.0", "private", text))
    print("release groups usable", len(recs), stats)
    ev, st2 = [], collections.Counter()
    for l in open(os.path.join(SP, "mb/ev.jsonl")):
        try: e = json.loads(l)
        except Exception: continue
        ls = e.get("life-span") or {}
        date = ls.get("begin") or ""
        if not common.in_window(date): st2["date"] += 1; continue
        if e.get("type") != "Festival" or e.get("cancelled"): st2["type"] += 1; continue
        name = e.get("name", "")
        yrs = re.findall(r"\b(19\d\d|20\d\d)\b", name)
        if yrs and "2026" not in yrs: st2["year_conflict"] += 1; continue
        place, area, acts = None, None, []
        for r in e.get("relations") or []:
            if r.get("target-type") == "place" and r.get("place"): place = r["place"].get("name")
            elif r.get("target-type") == "area" and r.get("area"): area = r["area"].get("name")
            elif r.get("target-type") == "artist" and r.get("artist"): acts.append(r["artist"].get("name"))
        acts = [a for a in dict.fromkeys(acts) if a and a != "[unknown]"]
        if not (place or area) or len(acts) < 3: st2["thin"] += 1; continue
        where = " in ".join(x for x in (place, area) if x)
        end = ls.get("end")
        span = f"from {common.long_date(date)} to {common.long_date(end)}" if end and re.fullmatch(r"\d{4}-\d\d-\d\d", end) and end != date else f"on {common.long_date(date)}"
        text = f"The music festival {name} took place {span} at {where}, according to the MusicBrainz database. Acts listed for it include {join_list(acts[:12])}."
        if common.wc(text) < 40: st2["short"] += 1; continue
        ev.append(common.record(f"s3-musicbrainz:ev:{e['id']}", "MusicBrainz", name, f"https://musicbrainz.org/event/{e['id']}", date, "MusicBrainz: core data CC0", "private", text))
    print("festivals usable", len(ev), st2)
    rnd.shuffle(ev)
    common.write("musicbrainz", common.spread(recs, min(80, len(recs))) + ev[:100 - min(80, len(recs))], cap=100)

if which == "openlibrary":
    MON = "|".join(common.MONTHS)
    ABB = {m[:3]: i + 1 for i, m in enumerate(common.MONTHS)}
    def pdate(s):
        m = re.fullmatch(rf"({MON}) (\d{{1,2}}),? 2026", s)
        if m: return f"2026-{common.MONTH_NUM[m.group(1)]:02d}-{int(m.group(2)):02d}"
        m = re.fullmatch(r"([A-Z][a-z]{2})\.? (\d{1,2}),? 2026", s)
        if m and m.group(1) in ABB: return f"2026-{ABB[m.group(1)]:02d}-{int(m.group(2)):02d}"
        m = re.fullmatch(rf"(\d{{1,2}}) ({MON}),? 2026", s)
        if m: return f"2026-{common.MONTH_NUM[m.group(2)]:02d}-{int(m.group(1)):02d}"
        m = re.fullmatch(r"2026-(\d\d)-(\d\d)", s)
        if m: return s
        m = re.fullmatch(r"(\d\d)/(\d\d)/2026", s)
        if m and int(m.group(1)) > 12: return f"2026-{m.group(2)}-{m.group(1)}"
        return None
    recs, stats = [], collections.Counter()
    for l in open(os.path.join(SP, "ol/ed.jsonl")):
        try: b = json.loads(l)
        except Exception: continue
        date = pdate((b.get("publish_date") or "").strip())
        if not common.in_window(date, "2026-09-30"): stats["date"] += 1; continue  # the dump is dated September 30
        who = (b.get("by_statement") or "").strip().rstrip(".")
        contrib = [c.get("name") for c in (b.get("contributors") or []) if isinstance(c, dict) and c.get("name")]
        if not who and contrib: who = join_list(list(dict.fromkeys(contrib))[:3])
        if not who or re.search(r"[@\d]{3}", who) or len(who) > 120: stats["no_creator"] += 1; continue
        pubs = b.get("publishers") or []
        if not pubs or not b.get("title"): stats["no_pub"] += 1; continue
        title = b["title"].strip()
        if b.get("subtitle"): title = f"{title}: {b['subtitle'].strip()}"
        by = re.sub(r"^(by|By|BY)\s+", "", who)
        text = f'The book "{title}" by {by} was published by {pubs[0]} on {common.long_date(date)}, according to the Open Library catalogue.'
        extra = []
        if b.get("number_of_pages"): extra.append(f"The edition runs to {b['number_of_pages']} pages.")
        if b.get("physical_format"): extra.append(f"Its format is {b['physical_format'].lower()}.")
        subs = [s for s in (b.get("subjects") or []) if isinstance(s, str)][:6]
        if subs: extra.append(f"Subjects listed for it: {join_list(subs)}.")
        lang = [l.get("key", "").split("/")[-1] for l in (b.get("languages") or []) if isinstance(l, dict)]
        if lang: extra.append(f"Language code: {lang[0]}.")
        d = b.get("description")
        d = d.get("value") if isinstance(d, dict) else d
        if isinstance(d, str):
            dc = common.cut(re.sub(r"\s+", " ", d.replace("*", "")), 120)
            if dc: extra.append(f"Description: {dc}")
        text = " ".join([text] + extra)
        if common.wc(text) < 40: stats["short"] += 1; continue
        recs.append(common.record(f"s3-openlibrary:{b['key'].split('/')[-1]}", "Open Library", title[:160], f"https://openlibrary.org{b['key']}", date, "CC0 (Open Library data dumps)", "public", text))
    print("usable", len(recs), stats)
    common.write("openlibrary", recs, cap=100)
