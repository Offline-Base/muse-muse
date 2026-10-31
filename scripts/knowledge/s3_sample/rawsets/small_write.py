"""ForecastBench resolutions and the Retrosheet 2026 schedule."""
import collections, csv, glob, io, json, os, random, re, sys, zipfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
from rangezip import S3File
c = common.s3()
SP = common.SP
which = sys.argv[1]

if which == "forecastbench":
    lst = c.list_objects_v2(Bucket=common.BUCKET, Prefix=common.PREFIX + "forecastbench/datasets/question_sets/2026", MaxKeys=1000)["Contents"]
    qs = {}
    for o in lst:
        if o["Key"].endswith("-llm.json"):
            for q in json.load(open(common.fetch(c, o["Key"], "fb")))["questions"]:
                if q["source"] in ("polymarket", "infer", "manifold"):
                    qs[q["id"]] = q
    lst = c.list_objects_v2(Bucket=common.BUCKET, Prefix=common.PREFIX + "forecastbench/datasets/resolution_sets/2026", MaxKeys=1000)["Contents"]
    res = {}
    for o in lst:
        for r in json.load(open(common.fetch(c, o["Key"], "fb")))["resolutions"]:
            if r["source"] in ("polymarket", "infer") and r["resolved"] and r["resolved_to"] in (0.0, 1.0) and r["id"] in qs:
                res[r["id"]] = r  # the latest set wins
    print("resolved polymarket and infer questions with text", len(res))
    NEVER = re.compile(r"metaculus|yahoo|\bfred\b|federal reserve economic data", re.I)
    NOISE = re.compile(r"up or down|\bO/U\b|spread|\bvs\.?\b|price of|\$\d|reach \$|above \$|below \$|temperature|tweets?\b|say\b|mention\b|bitcoin|ethereum|solana|xrp\b", re.I)
    PRIVATE = re.compile(r"\b(arrest\w*|murder\w*|convicted|sentenced|charged|victim\w*|trial)\b", re.I)
    recs = []
    for i, r in res.items():
        q = qs[i]
        date = r["resolution_date"]
        if not common.in_window(date): continue
        text_all = " ".join(str(q.get(k, "")) for k in ("question", "background", "resolution_criteria"))
        if NEVER.search(text_all) or NOISE.search(q["question"]) or PRIVATE.search(text_all): continue
        if "{" in q["question"]: continue
        bg = re.sub(r"<[^>]+>", " ", q.get("background") or "")
        bg = re.sub(r"https?://\S+", "", bg)
        bg = re.sub(r"\s+", " ", bg).strip()
        outcome = "Yes" if r["resolved_to"] == 1.0 else "No"
        host = {"polymarket": "Polymarket prediction market", "infer": "RAND Forecasting Initiative question"}[r["source"]]
        lead = f'The {host} "{q["question"].strip()}" resolved {outcome} as of {common.long_date(date)}, according to the ForecastBench resolution set.'
        extra = common.cut(bg, 200 - common.wc(lead)) if bg else ""
        text = f"{lead} Background from the question: {extra}" if extra else lead
        recs.append(common.record(f"s3-forecastbench:{i[:24]}", "ForecastBench", q["question"].strip()[:160], "https://www.forecastbench.org/", date, "CC BY-SA 4.0 (ForecastBench datasets); question wording comes from the named market or forecasting site", "private", text))
    common.write("forecastbench", recs, cap=30)

if which == "retrosheet":
    z = zipfile.ZipFile(S3File(c, common.PREFIX + "retrosheet/alldata.zip"))
    rows = list(csv.reader(io.TextIOWrapper(z.open("schedules/2026schedule.csv"), "utf8", "replace")))
    print(rows[0], rows[1], len(rows))
    head = [h.strip().lower() for h in rows[0]]
    json.dump(rows, open(os.path.join(SP, "retro.json"), "w"))
