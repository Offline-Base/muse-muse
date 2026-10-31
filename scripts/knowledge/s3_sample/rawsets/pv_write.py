"""Wikipedia pageviews: monthly top lists from whole months of the human-traffic dump, ten articles to a record."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
SP = common.SP
NS = re.compile(r"^(Special|Wikipedia|Portal|File|Talk|User|Help|Template|Category|Draft|Module|MediaWiki|Wikipedia_talk|User_talk|Image|WP)(:|_talk:)", re.I)
# Not real reader interest (bot-like spikes and adult-filter artefacts), or a page about a crime and its victims or a
# person convicted of or linked to one. Read from the three month lists before writing them down.
BLOCK = re.compile(r"^(Main_Page|-|\.xxx|\.xyz|XXX.*|XXXX.*|Pornhub|xHamster|XVideos|Neatsville,_Kentucky|Limonene|Microdata_\(HTML\)|JSON-LD|RDFa|Ansel_Adams|Marty_Reisman|Killing_of.*|Kidnapping_of.*|Melanie_McGuire|Jodi_Hildebrandt|John_Worboys|Mohamed_Atta|Murder_of.*|Death_of.*|Disappearance_of.*|.*\(criminal\)|Lizzie_Borden|Monster:_The_Lizzie_Borden_Story|Christa_Pike|Aileen_Wuornos|Ted_Kaczynski|Elizabeth_Smart|Ryan_Wedding|Jeffrey_Epstein|Ghislaine_Maxwell|Assassination_of_Charlie_Kirk|Tyler_Robinson.*|Luigi_Mangione|Diddy|Sean_Combs|.*\bporn.*|.*_\(pornographic.*)$", re.I)
END = {"2026-01": "2026-01-31", "2026-05": "2026-05-31", "2026-09": "2026-09-30"}
recs = []
for ym, end in END.items():
    d = json.load(open(os.path.join(SP, f"pv/{ym}.json")))
    assert d["complete"]
    tops = [(t, v) for t, v in d["top"] if not NS.match(t) and not BLOCK.match(t)]
    name = common.month_name(end)
    n_recs = 14 if ym != "2026-09" else 12
    for i in range(n_recs):
        chunk = tops[i * 10:(i + 1) * 10]
        items = ", ".join(f"{t.replace('_', ' ')} ({v / 1e6:.2f} million views)" for t, v in chunk)
        lead = f"The most viewed English Wikipedia articles in {name} were {items}." if i == 0 else f"Ranked {i * 10 + 1} to {i * 10 + 10} among English Wikipedia articles by views in {name} were {items}."
        text = f"{lead} These counts cover the whole month of {name}, human readers only, and leave out the main page, search pages and pages that drew obvious automated or adult-filter traffic."
        recs.append(common.record(f"s3-pageviews:{ym}:{i}", "Wikimedia pageviews", f"Most viewed English Wikipedia articles, {name}, ranks {i * 10 + 1} to {i * 10 + 10}", f"https://dumps.wikimedia.org/other/pageview_complete/monthly/{ym[:4]}/{ym}/", end, "CC0 (Wikimedia pageview dumps)", "public", text))
common.write("pageviews", recs, cap=40)
