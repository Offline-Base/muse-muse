"""Discogs: releases with a full 2026 date from the tail of the releases dump, decoded by gz_mid.py.

Tag names and some values still hold unknown bytes (NUL). Tags are matched position by position with NUL allowed; a value
with even one NUL in it is dropped, so nothing guessed reaches the text. Track titles aren't used: their tags are too
blanked to place reliably.
"""
import collections, html, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common
SP = common.SP
b = open(os.path.join(SP, "dc/t1.xml"), "rb").read().decode("utf8", "replace")

def tol(word):
    return "".join(f"[{c}\\0]" for c in word)

T_TITLE = re.compile(r"</artists.?[<\0]" + tol("title") + r"[>\0]([^<\0]+)</")
T_NAME = re.compile(r"</id>" + r"[<\0]" + tol("name") + r"[>\0]([^<]+?)</")
T_LABEL = re.compile(tol("label") + r"[ \0]" + tol("name") + r'="([^"]+)"\s*' + tol("catno") + r'="([^"]*)"')
T_FORMAT = re.compile(tol("format") + r"[ \0]" + tol("name") + r'="([^"]+)"')
T_DESC = re.compile(tol("description") + r"[>\0]([^<]+)</")
T_GENRE = re.compile(r"<genre.([^<]+)</")
T_STYLE = re.compile(r"<style.([^<]+)</")
T_COUNTRY = re.compile(tol("country") + r"[>\0]([^<]+)</")

stats = collections.Counter()
recs = []
starts = [m.start() for m in re.finditer(r'<release id="\d+"', b)]
stats["starts"] = len(starts)
def clean(s):
    return html.unescape(s).strip()
def okv(s):
    return "\0" not in s and "�" not in s and bool(s.strip())
def join_list(xs):
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]
for a, z in zip(starts, starts[1:]):
    seg = b[a:z]
    m = re.search(r"<released>(2026-\d\d-\d\d)</released>", seg)
    if not m: stats["no_date"] += 1; continue
    date = m.group(1)
    if not common.in_window(date, "2026-09-30"): stats["window"] += 1; continue  # the dump is dated October 1
    rid = re.match(r'<release id="(\d+)"', seg).group(1)
    t = T_TITLE.search(seg)
    if not t or not okv(t.group(1)): stats["title"] += 1; continue
    art_end = seg.find("</artists")
    if art_end < 0: stats["artists"] += 1; continue
    names = T_NAME.findall(seg[:art_end])
    if not names or not all(okv(x) for x in names): stats["artists"] += 1; continue
    arts = [clean(re.sub(r" \(\d+\)$", "", x)) for x in names]
    arts = [x for x in arts if x and x != "Various"]
    if not arts: stats["artists"] += 1; continue
    lm = T_LABEL.search(seg)
    if not lm or not okv(lm.group(1)) or lm.group(1).lower().startswith("not on label"): stats["label"] += 1; continue
    label = clean(re.sub(r" \(\d+\)$", "", lm.group(1)))
    catno = clean(lm.group(2)) if okv(lm.group(2)) and lm.group(2).lower() != "none" else ""
    fm = T_FORMAT.search(seg)
    if not fm or not okv(fm.group(1)): stats["format"] += 1; continue
    fmt_end = re.search(tol("/formats"), seg)
    fmt_part = seg[fm.start():fmt_end.start()] if fmt_end else ""
    descs = [clean(x) for x in T_DESC.findall(fmt_part) if okv(x) and len(x) <= 24][:4]
    genres = [clean(x) for x in T_GENRE.findall(seg) if okv(x)][:3]
    styles = [clean(x) for x in T_STYLE.findall(seg) if okv(x)][:4]
    cm = T_COUNTRY.search(seg)
    country = clean(cm.group(1)) if cm and okv(cm.group(1)) else ""
    if not genres or not country: stats["genre_country"] += 1; continue
    title = clean(t.group(1))
    who = join_list(arts[:3])
    text = f'{who} released "{title}" on the {label} label on {common.long_date(date)}, according to the Discogs database.'
    if catno: text += f" Its catalogue number is {catno}."
    text += f" The release is in {clean(fm.group(1))} format" + (f" ({', '.join(descs)})" if descs else "") + f" and is listed for {country}."
    text += f" Discogs files it under {join_list(genres)}" + (f", with the style{'s' if len(styles) > 1 else ''} {join_list(styles)}." if styles else ".")
    if common.wc(text) < 40: stats["short"] += 1; continue
    rec = common.record(f"s3-discogs:{rid}", "Discogs", f"{who}, {title}"[:160], f"https://www.discogs.com/release/{rid}", date, "CC0 (Discogs monthly data dumps)", "public", text)
    # Notability stands in for: the main release of a master, or a physical release with a catalogue number.
    rec["_main"] = 'is_main_release="true"' in seg or (clean(fm.group(1)) != "File" and bool(catno))
    recs.append(rec)
print("usable", len(recs), stats, "main", sum(r["_main"] for r in recs))
main = [r for r in recs if r["_main"]]
pool = main if len(main) >= 300 else recs
for r in recs: r.pop("_main")
common.write("discogs", pool, cap=100)
