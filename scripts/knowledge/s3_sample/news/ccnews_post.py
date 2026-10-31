"""Rules added after reading the second ccnews-select sets (60 of each). Used by ccnews_select.prepare() before
picking and by ccnews_finish.py, so both apply the same tests.

post_drop(c, ai) returns the reason a candidate goes, or None. clean_text() takes out in-text boilerplate sentences.
"""

import re

import news_common as C

POST_DOMAINS = {
    "ibtimes.co.uk", "ibtimes.com.au", "ibtimes.com", "ibtimes.sg", "ibtimes.co.in", "upworthy.com", "unilad.com", "ladbible.com",
    "findarticles.com", "scitechdaily.com", "phys.org", "eurekalert.org", "sciencedaily.com", "medicalxpress.com", "techxplore.com",
    "jambroadcasting.com", "greatreporter.com", "boredpanda.com", "msn.com", "inkl.com", "head-topics.com", "newsbreak.com",
}
OWN_DATELINES = {"washingtonpost.com", "wsj.com", "ft.com", "theguardian.com", "politico.com", "cnn.com", "csmonitor.com", "latimes.com", "bostonglobe.com"}
MON = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
DATELINES = [
    re.compile(rf"^{MON} \d{{1,2}}\s*[:\-–]"),  # Reuters feed as channelnewsasia carries it: 'Sept 28 :', 'March 12 -'
    re.compile(rf"^[A-Z][A-Za-z.'\- ]{{1,40}}(?:, [A-Z][A-Za-z.'\- ]{{1,30}})?,? {MON} \d{{1,2}}\s*(?:\([^)]{{1,30}}\)\s*)?[:\-–—]"),
    re.compile(r"^[A-Z][A-Z.'\- ]{2,30}(?:, [A-Z][A-Za-z.'\- ]{2,30})?\s*(?:\([^)]{1,30}\)\s*)?[—–:-]\s"),
    re.compile(r"^[A-Z]{3,}[A-Z .'-]*(?:,? (?:and|&) [A-Z]{3,}[A-Z .'-]*)?, (?:[A-Z][a-z]+\.?|[A-Z]{2})(?:,| \d)"),
    re.compile(r"^\([A-Z][A-Z .,'-]{2,40}\)"),  # ABC News Radio copy: '(WASHINGTON) --'
    re.compile(r"^[A-Z][\w.'/-]*(?: [A-Z][\w.'/-]*){0,3} [\(\[][A-Z][\w .'-]{1,30}[\)\]](?:,? [^:]{0,30})?\s*:"),  # 'Evian (France):', 'Hyderabad [India], Oct 7:'
]
POST_TEXT = re.compile(
    r"[™®]|\b(?:anunció hoy|anuncia hoy|anunciou hoje|anuncia hoje|a annoncé aujourd'hui|annonce aujourd'hui|a dévoilé aujourd'hui|"
    r"dévoile aujourd'hui|annuncia oggi|ha annunciato oggi|gab heute bekannt|kündigte heute an|ogłosiła dziś|bugün duyurdu|объявила сегодня)\b|"
    r"\bprep (?:football|basketball|soccer|baseball|sports|roundup)\b|\bHigh (?:School )?(?:football|basketball|soccer|baseball|softball|volleyball|wrestling) (?:team|squad|program)\b|"
    r"\bvarsity\b|\bHigh School (?:Association|Athletic)\b|\bGHSA\b|\bUIL\b|\bCIF\b|\bClass (?:10|12|X|XII)\b|\bboard exams?\b|\bgunmen\b|"
    r"\bANI\b|\bPTI\b|\bIANS\b|\(US local time\)|РИА «Новости»|РИА Новости|\bТАСС\b|Интерфакс|\bRIA Novosti\b|"
    r"\((?:NYSE|NASDAQ|Nasdaq|NSE|BSE|TSX|ASX|OTC)[^)]{0,20}\)|\balleged shooting\b|\byounger (?:brother|sister)\b|\belder (?:brother|sister)\b|\bnephew\b|\bniece\b|\bcousin\b",
    re.I)
POST_TITLE = re.compile(rf"^{MON} \d{{1,2}}:|\bLocal News For\b|\bRound-?up\b|\bshare price\b|\bstock price\b|\bcheck (?:price|details|list)\b|\bAt \d{1,2},", re.I)
BOILER_SENT = re.compile(
    r"\b(?:Also Read|Read More|Read also|ALSO READ|Also read|Leia também|Lee también|Lire aussi|Leggi anche|Lesen Sie auch|Czytaj też)\b|"
    r"^(?:Publicado em|Última atualização|Actualizado|Publicado el|Mis à jour|Publié le|Aggiornato|Veröffentlicht|Aktualisiert)\b")
SOCIAL_MENTION = re.compile(
    r"\b(?:on|via|to|through|in an?|his|her|their|its|the|an?) (?:Instagram|Facebook|WhatsApp)\b|"
    r"\b(?:Instagram|Facebook|WhatsApp) (?:posts?|pages?|accounts?|story|stories|videos?|live|groups?|messages?|handles?|profiles?)\b")


def clean_text(text):
    """Drops whole sentences that are site boilerplate ('Also Read: ...', 'Publicado em ...')."""
    paras = []
    for p in text.split("\n\n"):
        kept = [s for s in C.sentences(p) if not BOILER_SENT.search(s)]
        if kept:
            paras.append(" ".join(kept))
    return "\n\n".join(paras)


def topical(title, text, ai_hits):
    """AI and Meta set: passing mentions of a post on Instagram or Facebook don't count toward the topic."""
    foreign = not C.looks_english(text)
    th = ai_hits(title, foreign) - len(SOCIAL_MENTION.findall(title))
    ph = ai_hits(text, foreign) - len(SOCIAL_MENTION.findall(text))
    return th >= 1 or ph >= 2


def post_drop(c, ai=False, ai_hits=None):
    host = c["domain"]
    if C.listed(host, POST_DOMAINS):
        return "p_domain"
    if not C.listed(host, OWN_DATELINES):
        for p in c["text"].split("\n\n")[:3]:
            if any(rx.match(p.strip()) for rx in DATELINES):
                return "p_dateline"
    probe = f"{c['title']}\n{c['text']}"
    if POST_TEXT.search(probe):
        return "p_text"
    if POST_TITLE.search(c["title"]):
        return "p_title"
    if ai and ai_hits and not topical(c["title"], c["text"], ai_hits):
        return "p_off_topic"
    return None
