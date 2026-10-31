"""Retrosheet 2026 schedule, GLEIF entities created in 2026, English Wikipedia clickstream, and SEC company facts."""
import collections, csv, datetime, gzip, io, json, os, random, re, sys, zipfile, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
from rangezip import S3File
c = common.s3()
SP = common.SP
which = sys.argv[1]
rnd = random.Random(common.SEED)

if which == "retrosheet":
    rows = json.load(open(os.path.join(SP, "retro.json")))
    TEAMS = dict(ANA="Los Angeles Angels", ARI="Arizona Diamondbacks", ATH="Athletics", ATL="Atlanta Braves", BAL="Baltimore Orioles", BOS="Boston Red Sox", CHA="Chicago White Sox", CHN="Chicago Cubs", CIN="Cincinnati Reds", CLE="Cleveland Guardians", COL="Colorado Rockies", DET="Detroit Tigers", HOU="Houston Astros", KCA="Kansas City Royals", LAN="Los Angeles Dodgers", MIA="Miami Marlins", MIL="Milwaukee Brewers", MIN="Minnesota Twins", NYA="New York Yankees", NYN="New York Mets", OAK="Athletics", PHI="Philadelphia Phillies", PIT="Pittsburgh Pirates", SDN="San Diego Padres", SEA="Seattle Mariners", SFN="San Francisco Giants", SLN="St. Louis Cardinals", TBA="Tampa Bay Rays", TEX="Texas Rangers", TOR="Toronto Blue Jays", WAS="Washington Nationals")
    by = collections.defaultdict(list)
    for r in rows[1:]:
        iso = f"{r[0][:4]}-{r[0][4:6]}-{r[0][6:8]}"
        by[iso[:7]].append((iso, r))
    recs = []
    for ym, games in sorted(by.items()):
        games.sort(key=lambda g: g[0])
        first = games[0][0]
        ds = [g for g in games if g[0] == first]
        match = ", ".join(f"{TEAMS.get(g[1][3], g[1][3])} at {TEAMS.get(g[1][6], g[1][6])}" for g in ds[:6])
        last = games[-1][0]
        text = f"Retrosheet's 2026 Major League Baseball schedule lists {len(games)} regular-season games in {common.month_name(first + '')}. The first date that month with games on the schedule was {common.long_date(first)}, with {len(ds)} game{'s' if len(ds) != 1 else ''}: {match}{' and others' if len(ds) > 6 else ''}. The last scheduled date that month was {common.long_date(last)}. This is the published schedule, not a record of results."
        recs.append(common.record(f"s3-retrosheet:{ym}", "Retrosheet", f"MLB schedule, {common.month_name(first)}", "https://www.retrosheet.org/schedule/", first, "The information used here was obtained free of charge from and is copyrighted by Retrosheet (www.retrosheet.org)", "public", text))
    common.write("retrosheet", recs, cap=30)

if which == "gleif":
    key = common.PREFIX + "gleif/2026-10-30/20261030-1600-gleif-goldencopy-lei2-golden-copy.csv.zip"
    head = common.get_range(c, key, 0, 200)
    n, m = int.from_bytes(head[26:28], "little"), int.from_bytes(head[28:30], "little")
    dec = zlib.decompressobj(-15)
    tail, cols, keep = b"", None, []
    got = rows = 0
    for piece in common.stream(c, key, 30 + n + m, 30 + n + m + 80_000_000):
        got += len(piece)
        buf = tail + dec.decompress(piece)
        i = buf.rfind(b"\n")
        lines, tail = buf[:i], buf[i + 1:]
        for row in csv.reader(io.StringIO(lines.decode("utf8", "replace"))):
            if cols is None:
                cols = {h: j for j, h in enumerate(row)}
                print([h for h in row if "Date" in h or "Category" in h or "Status" in h or h.endswith("LegalName") or "Jurisdiction" in h][:14])
                continue
            if len(row) < len(cols): continue
            rows += 1
            g = lambda h: row[cols[h]]
            cre = g("Entity.EntityCreationDate")[:10] if "Entity.EntityCreationDate" in cols else ""
            reg = g("Registration.InitialRegistrationDate")[:10]
            if common.in_window(cre) and common.in_window(reg) and g("Entity.EntityCategory") == "GENERAL" and g("Entity.EntityStatus") == "ACTIVE":
                keep.append(dict(lei=g("LEI"), name=g("Entity.LegalName"), jur=g("Entity.LegalJurisdiction"), cre=cre, reg=reg, city=g("Entity.LegalAddress.City"), country=g("Entity.LegalAddress.Country")))
    print("gleif got", got, "rows", rows, "kept", len(keep))
    SUFFIX = re.compile(r"\b(LLC|L\.L\.C\.|Inc\.?|INC\.?|Ltd\.?|LTD\.?|Limited|LIMITED|GmbH|AG|S\.?A\.?|SAS|S\.A\.S\.|B\.V\.|N\.V\.|PLC|plc|LP|L\.P\.|Corp\.?|Corporation|CORPORATION|SpA|S\.p\.A\.|S\.r\.l\.|SRL|Oy|AB|A/S|KG|Fund|Trust|Holdings|HOLDINGS)\b")
    recs = []
    for k in keep:
        if not SUFFIX.search(k["name"]) or not re.search(r"[A-Za-z]{3}", k["name"]): continue
        text = f"The legal entity {k['name']}, registered under {k['jur']} law with its legal address in {k['country']}, was created on {common.long_date(k['cre'])}, according to the Global LEI Foundation's golden copy. It received its Legal Entity Identifier {k['lei']} on {common.long_date(k['reg'])}, and its entity status was active as of October 30, 2026."
        recs.append(common.record(f"s3-gleif:{k['lei']}", "GLEIF", k["name"], f"https://search.gleif.org/#/record/{k['lei']}", k["cre"], "CC0 (GLEIF golden copy)", "public", text))
    print("usable", len(recs))
    common.write("gleif", recs, cap=20)

if which == "clickstream":
    ym = "2026-07"
    key = f"{common.PREFIX}clickstream/{ym}/clickstream-enwiki-{ym}.tsv.gz"
    dec = zlib.decompressobj(31)
    tail = b""
    search, ext = collections.Counter(), collections.Counter()
    pairs = collections.Counter()
    got = 0
    for piece in common.stream(c, key):
        got += len(piece)
        buf = tail + dec.decompress(piece)
        i = buf.rfind(b"\n")
        lines, tail = buf[:i], buf[i + 1:]
        for ln in lines.split(b"\n"):
            f = ln.split(b"\t")
            if len(f) != 4: continue
            n = int(f[3])
            if n < 1000: continue
            if f[0] == b"other-search": search[f[1]] += n
            elif f[0] == b"other-external": ext[f[1]] += n
            elif f[2] == b"link" and f[0] != b"Main_Page": pairs[(f[0], f[1])] += n
    print("got", got, len(search), len(pairs))
    BLOCK = re.compile(r"^(Main_Page|-|\.xxx|\.xyz|XXX.*|Pornhub|xHamster|XVideos|Killing_of.*|Kidnapping_of.*|Murder_of.*|Death_of.*|Disappearance_of.*|.*\(criminal\)|.*\bporn.*|Jeffrey_Epstein)$", re.I)
    name = lambda b: b.decode("utf8", "replace").replace("_", " ")
    ok = lambda b: not BLOCK.match(b.decode("utf8", "replace")) and ":" not in b.decode("utf8", "replace")
    tops = [(t, n) for t, n in search.most_common(400) if ok(t)]
    recs = []
    for i in range(10):
        chunk = tops[i * 12:(i + 1) * 12]
        items = ", ".join(f"{name(t)} ({n / 1e6:.2f} million)" for t, n in chunk)
        lead = f"The English Wikipedia articles readers reached most often from search engines in July 2026 were {items}." if i == 0 else f"Ranked {i * 12 + 1} to {i * 12 + 12} among English Wikipedia articles reached from search engines in July 2026 were {items}."
        recs.append(common.record(f"s3-clickstream:{ym}:search:{i}", "Wikimedia clickstream", f"English Wikipedia search arrivals, July 2026, ranks {i * 12 + 1} to {i * 12 + 12}", f"https://dumps.wikimedia.org/other/clickstream/{ym}/", "2026-07-31", "CC0 (Wikimedia clickstream dumps)", "public", f"{lead} Figures come from the Wikimedia clickstream for that month."))
    tp = [(p, n) for p, n in pairs.most_common(600) if ok(p[0]) and ok(p[1])]
    for i in range(10):
        chunk = tp[i * 8:(i + 1) * 8]
        items = ", ".join(f"from {name(a)} to {name(b)} ({n / 1e3:.0f} thousand clicks)" for (a, b), n in chunk)
        recs.append(common.record(f"s3-clickstream:{ym}:links:{i}", "Wikimedia clickstream", f"English Wikipedia most clicked links, July 2026, part {i + 1}", f"https://dumps.wikimedia.org/other/clickstream/{ym}/", "2026-07-31", "CC0 (Wikimedia clickstream dumps)", "public", f"Among the most followed links between English Wikipedia articles in July 2026 were {items}. Figures come from the Wikimedia clickstream for that month."))
    common.write("clickstream", recs, cap=20)

if which == "sec":
    tick = json.load(open(common.fetch(c, common.PREFIX + "sec/company_tickers.json", "sec")))
    z = zipfile.ZipFile(S3File(c, common.PREFIX + "sec/companyfacts.zip"))
    names = set(z.namelist())
    ALLOWED = {"10-K", "10-Q"}  # Never Forms 3, 4, 5 or 144: facts from any other form are not read.
    TAGS = [("revenue", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"]), ("net income", ["NetIncomeLoss"])]
    def usd(v):
        a = abs(v)
        s = f"${a / 1e9:.2f} billion" if a >= 1e9 else f"${a / 1e6:.1f} million"
        return f"-{s}" if v < 0 else s
    recs = []
    seen_form = collections.Counter()
    for i in range(60):
        t = tick.get(str(i))
        if not t: break
        fn = f"CIK{int(t['cik_str']):010d}.json"
        if fn not in names: continue
        facts = json.loads(z.read(fn))
        gaap = (facts.get("facts") or {}).get("us-gaap") or {}
        filings = collections.defaultdict(dict)
        for label, tags in TAGS:
            for tg in tags:
                for row in ((gaap.get(tg) or {}).get("units") or {}).get("USD", []):
                    if row.get("form") not in ALLOWED or not common.in_window(row.get("filed")): continue
                    seen_form[row["form"]] += 1
                    if row.get("frame") is None and row.get("fp") != "FY" and False: continue
                    start, end = row.get("start"), row.get("end")
                    if not start: continue
                    days = (int(end[:4]) - int(start[:4])) * 365 + (int(end[5:7]) - int(start[5:7])) * 30
                    want = 350 <= days <= 380 if row["fp"] == "FY" else 80 <= days <= 100
                    if not want: continue
                    # The period must be the one the filing reports on, not a prior-year comparison.
                    lag = (datetime.date.fromisoformat(row["filed"]) - datetime.date.fromisoformat(end)).days
                    if not 0 <= lag <= 120: continue
                    key = (row["filed"], row["form"], row["fp"], row["fy"])
                    cur = filings[key].get(label)
                    if not cur or end > cur["end"]:
                        filings[key][label] = row
        for (filed, form, fp, fy), v in filings.items():
            if "revenue" not in v: continue
            r = v["revenue"]
            period = f"the fiscal year ended {common.long_date(r['end'])}" if fp == "FY" else f"the quarter ended {common.long_date(r['end'])}"
            kind = "annual report" if form == "10-K" else "quarterly report"
            company = re.sub(r"\s*/[A-Z]{2,4}/?$", "", t["title"]).strip()
            text = f"On {common.long_date(filed)}, {company} (ticker {t['ticker']}) filed {'an' if form == '10-K' else 'a'} {kind} on Form {form} with the US Securities and Exchange Commission. It reported revenue of {usd(r['val'])} for {period}."
            if "net income" in v and v["net income"]["end"] == r["end"]:
                text += f" Net income for the same period was {usd(v['net income']['val'])}."
            text += " The figures come from the SEC's XBRL company facts data."
            recs.append(common.record(f"s3-sec:{t['cik_str']}:{filed}:{form}", "US Securities and Exchange Commission", f"{t['title']} {form}, filed {filed}", f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={t['cik_str']}", filed, "US government work, public domain (SEC EDGAR company facts)", "public", text))
    print("forms read", seen_form, "usable", len(recs))
    common.write("sec", recs, cap=20)
