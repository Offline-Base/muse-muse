"""Filters shared by the news samplers: dates, wire copy, non-news pages, private people, and one-passage text."""

import collections
import datetime
import hashlib
import re
import urllib.parse

FIRST, LAST = "2026-01-04", "2026-10-29"
MAX_WORDS, MIN_WORDS, MIN_SOURCE_WORDS = 210, 40, 150
MAX_CRAWL_LAG_DAYS = 45

# ccnews.py NEVER and WIRE_DOMAINS, plus press-release services, the named cease-and-desist publishers in
# docs/knowledge-research/news.md, the sources the owner bars, and non-news sites found by the earlier review.
NEVER = {
    "stackexchange.com", "stackoverflow.com", "superuser.com", "serverfault.com", "askubuntu.com", "mathoverflow.net",
    "fred.stlouisfed.org", "stlouisfed.org", "imf.org", "themoviedb.org", "imdb.com", "sports-reference.com", "baseball-reference.com",
    "basketball-reference.com", "pro-football-reference.com", "hockey-reference.com", "fbref.com", "statsapi.mlb.com",
    "stats.nba.com", "api-web.nhle.com", "statsapi.web.nhl.com", "boxofficemojo.com", "openai.com", "reddit.com", "redd.it",
    "x.com", "twitter.com", "youtube.com", "youtu.be", "tiktok.com", "instagram.com", "facebook.com", "fb.com", "bsky.app",
    "binance.com", "coingecko.com", "yahoo.com", "yahoo.co.jp", "emdat.be", "jolpi.ca", "openf1.org", "aol.com",
    "statsbomb.com", "igdb.com", "manifold.markets", "metaculus.com", "polymarket.com", "kalshi.com",
    "legisquebec.gouv.qc.ca", "exa.ai", "mastodon.social", "wikipedia.org", "wikimedia.org",
    "apnews.com", "ap.org", "reuters.com", "afp.com", "dpa.com", "dpa-international.com", "dpa-news.com", "efe.com",
    "agenciaefe.es", "kyodonews.net", "kyodonews.jp", "xinhuanet.com", "xinhuanews.com", "news.cn", "xinhua.net", "tass.com", "tass.ru",
    "ria.ru", "interfax.ru", "ansa.it", "europapress.es", "aa.com.tr", "dw.com",
    "prnewswire.com", "prnewswire.co.uk", "businesswire.com", "globenewswire.com", "accesswire.com", "accessnewswire.com",
    "einpresswire.com", "einnews.com", "newsfilecorp.com", "prweb.com", "prlog.org", "openpr.com", "newswire.com", "newswire.ca", "pr.com",
    "finanzen.net", "finanzen.ch", "finanzen.at", "boerse-express.com", "wallstreet-online.de", "ariva.de", "boerse.de", "marketscreener.com", "marketbeat.com", "tickerreport.com", "americanbankingnews.com", "defenseworld.net", "stocktitan.net",
    "npr.org", "nytimes.com", "nbcnews.com", "nbc.com", "bloomberg.com", "foxnews.com", "foxbusiness.com",
    "quran.com", "wise.com", "nike.com", "mexc.com", "tes.com", "xe.com", "amazon.com", "ebay.com", "etsy.com", "walmart.com",
    "bitget.com", "kucoin.com", "bybit.com", "okx.com", "coinbase.com", "kraken.com", "gate.io", "htx.com", "tradingview.com", "investing.com",
    "pinterest.com", "linkedin.com", "medium.com", "substack.com", "blogspot.com", "wordpress.com", "tumblr.com", "quora.com", "github.com",
    "tripadvisor.com", "booking.com", "expedia.com", "zillow.com", "indeed.com", "glassdoor.com", "allrecipes.com", "law360.com",
    "gov", "gov.uk", "edu", "shopify.com", "apple.com", "google.com", "microsoft.com", "archive.org",
}
NONNEWS_DOMAIN = re.compile(r"(casino|betting|\bbet\d|slots?\b|poker|porn|xxx|coupon|promo|recipes?|horoscope|astrolog|lottery|lotto|shop|store|crypto|forex|loan|insurance|bible|quran|hadith|lyrics|jobs?\b|careers?\b|realty|realestate|travel|hotel)", re.I)
BAD_PATH = re.compile(
    r"/(tags?|category|categories|topics?|author|authors|search|forum|forums|wiki|docs?|help|support|jobs?|careers?|shop|store|product|products|"
    r"coupons?|promo|deals?|horoscopes?|astrology|lottery|lotto|recipes?|obituar\w*|classifieds?|events?|calendar|listings?|gallery|galleries|photos?|"
    r"videos?|podcasts?|press-releases?|pressreleases?|press-release|sponsored|advertorial|partner-content|paid-content|brand-?studio|sport-?betting|"
    r"betting|casino|weather|crime|courts?|police|obits|opinion|editorials?|letters|comment|commentary|blog|blogs)(/|$)", re.I)
BAD_TITLE = re.compile(
    r"^(how to|best |top \d|\d+ (best|ways|things|tips)|review:|watch:|listen:|quiz:|photos:|video:|opinion:|letter:|letters:|editorial:|horoscope|daily horoscope|wordle|connections hint|"
    r"nyt |sudoku|crossword|obituary)|horoscope|lottery|lotto results|promo code|bonus code|live stream|how to watch|where to watch|live updates|live blog|"
    r"\bAktie (News|aktuell)\b|Aktien?-?Analyse|Börse (aktuell|Frankfurt)|Horoskop|oroscopo|horóscopo|гороскоп|burç yorum|just a moment|page not found|404|access denied|log ?in\b|sign ?in\b|subscribe|price prediction|stock price|shares (sold|bought|acquired)|obituar",
    re.I)
NONNEWS_TEXT = re.compile(
    r"promo code|bonus code|free spins|online casino|sportsbook|betting odds|price prediction|price target|horoscope|lottery results|winning numbers|"
    r"continue reading|already have an account|already a subscriber|subscribe to read|sign up for|free trial|create an account|enable javascript|cookies? policy|"
    r"terms of service|privacy policy|add to cart|buy now|shop now|free shipping|customer reviews|in stock|sponsored content|advertorial|paid content|"
    r"this article (is|was) (sponsored|paid)|affiliate link|earn a commission|may earn|"
    r"acquired a new (position|stake)|institutional investors|hedge funds (and|have)|shares of the company|sold \d[\d,]* shares|insider (selling|sold|bought)|"
    r"\bForm (3|4|5|144)\b|SEC filing|earnings call transcript|moving average|"
    r"yahoo finance|metaculus|\bFRED\b|mostly (cloudy|sunny)|chance of (rain|showers)|high of \d|low of \d|kick-?off time|tv channel|how to watch|"
    r"\bAI[- ]generated\b|generated by (an )?AI|written by (an )?AI|ingredients:|preheat|tablespoons?|teaspoons?|"
    r"apply now|job description|salary range|square feet|bedrooms?\b|bathrooms?\b",
    re.I)
WIRE = re.compile(
    r"\((?:AP|Reuters|AFP|EFE|dpa|DPA|ANSA|Xinhua|Kyodo|TASS|PTI|IANS|ANI|UNI|Bernama|Yonhap)\)|\bAP Photo\b|Associated Press|\bAP\s*[-–—]\s|"
    r"[-–—]\s*(?:Reuters|AFP|AP|PTI|IANS|ANI|Xinhua|EFE|dpa|Yonhap|Bernama)\s*\.?\s*$|^\s*(?:Reuters|AFP)\s*[-–—:]|Thomson Reuters|\(Reporting by|\bEditing by\b|Agence France|"
    r"\bReuters\s*[-–—]|\bAFP\s*[-–—]|\bAFP/|/AFP\b|PR ?Newswire|Business ?Wire|Globe ?Newswire|ACCESS ?Newswire|Accesswire|EIN ?Presswire|Newsfile Corp|\bPRWeb\b|"
    r"for immediate release|press release distribut|this press release|\(press release\)|\bSOURCE [A-Z][\w ]+$|forward[- ]looking statements|"
    r"\bNPR\b|National Public Radio|Transcript provided by|, HOST:|\bBYLINE:|"
    r"Agencia EFE|\bEFE\b|Europa Press|\bANSA\b|Deutsche Presse|\bdpa\b|Agence Anadolu|Anadolu Agency|Xinhua|Kyodo|\bТАСС\b|РИА Новости|Интерфакс|"
    r"\bPTI\b|\bIANS\b|Press Trust of India",
    re.M)
TRANSCRIPT = re.compile(r"\b[A-Z][A-Z' -]{3,}: ")

PERSONAL = re.compile(
    "|".join([
        r"[\w.+-]+@[\w-]+\.[a-z]{2,}",
        r"\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b",
        r"\+\d[\d\s().-]{7,}\d",
        r"\bwhatsapp\b",
        r"\bfor (further|more) information,? (please )?contact\b",
        r"\b(media|press|investor)( relations)? (contacts?|inquiries)\b",
        r"\bproponent of this resolution\b",
        r"\blives (in .{1,40} )?with (his|her|their) (wife|husband|partner|family)\b",
        r"\bhas (two|three|four|five|six|\d) (daughters|sons|children)\b",
        r"\bAge: \d{2}\b",
        r"\b(his|her|their|my|our) (wife|husband|son|sons|daughter|daughters|children|kids|mother|father|parents|brother|sister|grandson|granddaughter|fianc\w+|girlfriend|boyfriend|spouse|widow)\b",
        r"\b[A-Z][\w'-]+ [A-Z][\w'-]+, (?:aged? )?\d{1,2}\b(?!,? ?\d{4})(?:,| of | from | who )",
        r"\baged \d{1,2}\b",
        r"\b\d{1,5} [A-Z][a-z]+ (Street|St\.|Avenue|Ave\.|Road|Rd\.|Lane|Ln\.|Drive|Dr\.|Boulevard|Blvd\.)",
    ]),
    re.I,
)
# Always out: the page is about an arrest, a case, or an accident, so anyone named may be a private person.
CRIME_CORE = re.compile(
    r"\b(arrest(ed|s|ing)?|charged with|faces? charges?|plead(ed|s)?|pled guilty|guilty|convicted|conviction|sentenced|jailed|imprisoned|indicted|indictment|murder\w*|homicide|stabb\w+|"
    r"shot dead|fatally|gunman|gunshot|manslaughter|sexual(ly)? (assault\w*|abus\w*)|rap(e|ed|ist)|robbery|robbed|burglar\w*|kidnap\w*|abduct\w*|fatal crash|car crash|crash(ed)? into|collision|"
    r"car accident|road accident|traffic accident|drown\w*|overdose\w*|coroner|medical examiner|obituar\w*|survived by|funeral|suspects?|defendants?|plaintiffs?|sheriff|deputies|"
    r"police (said|say|says|arrested|officers?|investigat\w+|are)|detectives?|in custody|on bail|parole|domestic violence|assault(ed|ing)?|missing (man|woman|person|teen|child|girl|boy)|"
    r"body was found|was found dead|died after|hit-and-run|hit by a|molest\w*|trafficking|fraud|embezzl\w+|scam\w*|inquest|mugged|bail)\b",
    re.I)
# Out unless the page is plainly about public affairs.
CRIME_CONTEXT = re.compile(
    r"\b(victims?|lawsuit|sued|suing|trial|jury|judge|prosecut\w+|court|was killed|were killed|killed in|injured in|hospitali[sz]ed|attorney for|lawyer for|accident|crash|tragedy|shooting|shot|police)\b",
    re.I)
PUBLIC_AFFAIRS = re.compile(
    r"\b(President|Prime Minister|Minister|Senator|Senate|Congress|Parliament|Supreme Court|Attorney General|Secretary of|White House|Pentagon|Kremlin|NATO|United Nations|European Union|"
    r"ceasefire|airstrikes?|missiles?|military|troops|Hamas|Hezbollah|Federal|antitrust|regulator|Commission)\b")
CRIME_FOREIGN = re.compile(
    r"detenid|asesin|homicid|acusad|condenad|juicio|accidente|víctima|apuñal|fallec|robo\b|violaci[óo]n|polic[ií]a|tribunal|choque|"
    r"arrêté|meurtre|accusé|condamné|procès|victime|mis en examen|décédé|gendarm|"
    r"festgenommen|\bMord|angeklagt|verurteilt|\bUnfall|\bOpfer|Polizei|Gericht|Prozess|tödlich|"
    r"arrestat|omicid|accusat|condannat|processo|incidente|vittima|polizia|carabinieri|tribunale|\bmorto\b|"
    r"\bpreso\b|assassin|julgamento|acidente|vítima|polícia|morreu|"
    r"aangehouden|\bmoord|verdachte|veroordeeld|ongeluk|slachtoffer|politie|rechtbank|"
    r"задержан|убийств|обвиня|осужд|\bсуд|ДТП|авари|жертв|полиц|погиб|"
    r"tutuklan|cinayet|sanık|mahkeme|\bkaza|kurban|\bpolis|öldü|gözaltı|"
    r"ditangkap|pembunuhan|terdakwa|divonis|sidang|kecelakaan|korban|polisi|tewas|"
    r"zatrzyman|zabójstw|oskarżon|skazan|\bsąd|wypad|ofiar|policj|"
    r"اعتقال|جريمة|قتل|متهم|محكمة|حادث|ضحية|الشرطة|إصابة|"
    r"गिरफ्तार|हत्या|आरोपी|अदालत|दुर्घटना|हादसा|पुलिस|मौत|कोर्ट",
    re.I)
FOREIGN_OK = {"es", "fr", "de", "it", "pt", "nl", "ru", "tr", "id", "pl", "ar", "hi"}
FOREIGN_NONNEWS = re.compile(r"horóscopo|horoscope|Horoskop|oroscopo|гороскоп|burç|lotería|Lotto|lotto|tragamonedas|apuestas|casino|Rezept|receta|recette|ricetta|receita", re.I)

BOILER = re.compile(
    r"^(subscribe|sign up|sign in|log ?in|read more|read also|also read|see also|related|follow us|follow |share |share:|tweet|email|print|advertisement|advert|ad\b|sponsored|"
    r"click here|tap here|download|join our|get the|copyright|©|all rights reserved|photo|image|credit|caption|source:|file photo|getty|updated|published|posted|last updated|by [A-Z]|"
    r"written by|edited by|reporting by|recommended|don't miss|watch|listen|comments?|leave a|contact|tags?:|categories:|home\b|menu\b|search\b|next\b|previous\b|more:|more from|"
    r"you may also|you might also|trending|top stories|latest news|sign-up|newsletter)",
    re.I)
TEMPORAL = re.compile(
    r"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|Jan\.|Feb\.|Aug\.|Sept?\.|Oct\.|today|yesterday|tonight|"
    r"this (week|month|year|morning|afternoon|evening)|last (week|month|year|night)|next (week|month|year)|earlier this|2026)\b")
NEWS_VERB = re.compile(
    r"\b(said|says|announced|announces|reported|according to|told|confirmed|signed|approved|launched|won|voted|released|issued|unveiled|rejected|agreed|passed|ruled|warned|opened|"
    r"appointed|elected|resigned|raised|cut|fell|rose|increased|decreased|struck|attacked|met|visited|banned|imposed|published|completed|scheduled|plans?|planned)\b")
ENGLISH_WORDS = {"the", "of", "and", "to", "in", "a", "is", "that", "for", "on", "with", "was", "as", "it", "by", "at", "from", "has", "said"}
DANGLING = re.compile(r"^(he|she|they|it|this|that|these|those|but|and|however|meanwhile|also|then|so|or|we|i|you|here|there)\b", re.I)
SENT_END = ".!?…।؟。"
ABBREV = re.compile(r"(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Gov|Sen|Rep|Gen|Col|Lt|Sgt|Capt|St|Mt|Jr|Sr|Inc|Ltd|Co|Corp|No|vs|etc|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|U\.S|U\.K|U\.N|D\.C|a\.m|p\.m|e\.g|i\.e|Hon|Pres|Rev|Sra|Sr|Dra|Art|Nr|Dr|bzw|ca)\.|\b[A-Z]\.)$")
SPLIT = re.compile(r"(?<=[.!?…।؟])[\"'”’»)]*\s+")
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MON3 = [m[:3] for m in MONTHS]
EXPL_DATE = re.compile(r"\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? (\d{1,2})(?:st|nd|rd|th)?,? (20\d\d)\b|\b(\d{1,2})(?:st|nd|rd|th)? (January|February|March|April|May|June|July|August|September|October|November|December),? (20\d\d)\b")
URL_DATE = re.compile(r"/(20\d\d)[/-](\d{1,2})[/-](\d{1,2})(?:[/-]|$)|[-_/](20\d\d)-(\d{2})-(\d{2})(?:[-_/.]|$)")
URL_YM = re.compile(r"/(20\d\d)/(\d{2})/")
SUFFIX = re.compile(r"\s+[|–—-]\s+([^|–—-]{2,40})$")


def domain_of(url):
    host = (urllib.parse.urlsplit(url).hostname or "").lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def listed(host, names=NEVER):
    parts = host.split(".")
    return any(".".join(parts[i:]) in names for i in range(len(parts)))


def words(s):
    return len(s.split())


def day(s):
    try:
        return datetime.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def url_date(url):
    m = URL_DATE.search(url)
    if not m:
        return None
    g = [x for x in m.groups() if x]
    try:
        return datetime.date(int(g[0]), int(g[1]), int(g[2]))
    except ValueError:
        return None


def text_mentions_date(text, d):
    """True if the text names this day: 'May 1', '1 May', 'Sept. 3'. A day-of-month without a month doesn't count."""
    name, short = MONTHS[d.month - 1], MON3[d.month - 1]
    names = f"{name}|{short}\\.?" + ("|Sept\\.?" if d.month == 9 else "")
    return bool(re.search(rf"\b(?:{names}) {d.day}\b|\b{d.day}(?:st|nd|rd|th)? (?:of )?(?:{name}|{short})\b", text)) or d.isoformat() in text


def date_check(published, crawl, url, text, needs_proof):
    """(iso day, reason it failed). `needs_proof`: the field may fall back to the crawl day, so a same-day date needs a URL or the text to say so."""
    d, c = day(published), day(crawl)
    if d is None or c is None:
        return None, "no_date"
    iso = d.isoformat()
    if not FIRST <= iso <= LAST:
        return None, "out_of_window"
    if d > c:
        return None, "after_fetch"
    if (c - d).days > MAX_CRAWL_LAG_DAYS:
        return None, "stale_crawl"
    u = url_date(url)
    if u and abs((u - d).days) > 2:
        return None, "url_date_mismatch"
    m = URL_YM.search(url)
    if m and not u and (int(m.group(1)), int(m.group(2))) != (d.year, d.month):
        return None, "url_date_mismatch"
    if needs_proof and d == c and not (u and abs((u - d).days) <= 1) and not text_mentions_date(text[:4000], d):
        return None, "same_day_unproven"
    years = {int(g[2] or g[5]) for g in EXPL_DATE.findall(text[:2500]) if (g[2] or g[5])}
    if years and max(years) < 2026:
        return None, "text_dates_old"
    return iso, None


def sentences(paragraph):
    out = []
    for part in SPLIT.split(paragraph):
        part = part.strip()
        if not part:
            continue
        if out and ABBREV.search(out[-1]):
            out[-1] += " " + part
        else:
            out.append(part)
    return out


def ends_sentence(s):
    s = s.rstrip("\"'”’»)]")
    return bool(s) and s[-1] in SENT_END and not s.endswith("...") and not s.endswith("…")


def fix_ws(s):
    return re.sub(r"[ \t ​]+", " ", s).strip()


def clean_lines(text, title):
    """Article body paragraphs only: every line that isn't a whole sentence (menus, headings, captions, bylines) goes."""
    norm_title = re.sub(r"\W+", " ", (title or "").lower()).strip()
    out = []
    for line in text.split("\n"):
        line = fix_ws(line)
        if not line or line[0] in "-*•·|#>":
            continue
        if BOILER.match(line) or "http" in line or "www." in line:
            continue
        low = re.sub(r"\W+", " ", line.lower()).strip()
        if norm_title and (low == norm_title or low in norm_title):
            continue
        if words(line) < 8 or not ends_sentence(line):
            continue
        out.append(line)
    return out


def one_passage(text, title):
    """The first MAX_WORDS words of body text, cut at a sentence end, or None. Paragraph breaks are kept."""
    paras, n = [], 0
    for line in clean_lines(text, title):
        kept = []
        for s in sentences(line):
            w = words(s)
            if n + w > MAX_WORDS:
                break
            if not ends_sentence(s):
                break
            kept.append(s)
            n += w
        else:
            if kept:
                paras.append(" ".join(kept))
            continue
        if kept:
            paras.append(" ".join(kept))
        break
    if n < MIN_WORDS:
        return None
    return re.sub(r"^[\s:;,.\-–—]+", "", "\n\n".join(paras))


def clean_title(title):
    t = fix_ws(title or "")
    for _ in range(2):
        m = SUFFIX.search(t)
        if m and words(t[: m.start()]) >= 4 and words(m.group(1)) <= 5:
            t = t[: m.start()].strip()
    return t


def looks_english(text):
    toks = re.findall(r"[a-z']+", text.lower())
    return len(toks) >= 30 and sum(1 for t in toks if t in ENGLISH_WORDS) / len(toks) >= 0.18


def garbage(text):
    letters = sum(ch.isalpha() for ch in text)
    if letters < 0.6 * len(text):
        return True
    if sum(ch.isdigit() for ch in text) > 0.12 * len(text):
        return True
    toks = text.split()
    if len(set(t.lower() for t in toks)) < 0.35 * len(toks):
        return True
    return sum(1 for s in sentences(text.replace("\n\n", " ")) if words(s) > 90) > 0


def judge(*, url, title, full_text, language, source_words, stats, published, crawl, needs_proof):
    """Applies every rule to one row. Returns (title, passage, iso day) or None, with the drop reason counted."""
    def no(reason):
        stats[reason] += 1
        return None

    stats["rows"] += 1
    host = domain_of(url)
    if not host or listed(host):
        return no("domain_never")
    if NONNEWS_DOMAIN.search(host):
        return no("domain_nonnews")
    path = urllib.parse.urlsplit(url).path
    if path in ("", "/") or BAD_PATH.search(path):
        return no("path_nonnews")
    title = clean_title(title)
    if words(title) < 4 or len(title) < 20 or title.isupper() or BAD_TITLE.search(title):
        return no("no_real_headline")
    if (source_words or 0) < MIN_SOURCE_WORDS or words(full_text) < MIN_SOURCE_WORDS:
        return no("short_source")
    if language != "en" and language not in FOREIGN_OK:
        return no("language_skipped")
    iso, why = date_check(published, crawl, url, full_text, needs_proof)
    if not iso:
        return no("date_" + why)
    if WIRE.search(full_text) or WIRE.search(title):
        return no("wire_or_pr_text")
    if len(TRANSCRIPT.findall(full_text[:1500])) >= 3:
        return no("transcript")
    passage = one_passage(full_text, title)
    if not passage:
        return no("no_clean_passage")
    if garbage(passage):
        return no("garbage")
    lead = passage.split()[0]
    if lead[0].islower() or DANGLING.match(passage):
        return no("not_standalone")
    probe = f"{title}\n{passage}"
    if PERSONAL.search(probe):
        return no("personal_detail")
    if NONNEWS_TEXT.search(probe):
        return no("nonnews_text")
    if language == "en":
        if not looks_english(passage):
            return no("not_english")
        if CRIME_CORE.search(probe):
            return no("crime_core")
        if CRIME_CONTEXT.search(probe) and not PUBLIC_AFFAIRS.search(probe):
            return no("crime_context")
        if not TEMPORAL.search(passage):
            return no("no_when")
        if not NEWS_VERB.search(passage):
            return no("no_news_verb")
    else:
        if looks_english(passage):
            return no("foreign_label_english")
        if CRIME_FOREIGN.search(probe) or CRIME_CORE.search(probe):
            return no("crime_foreign")
        if FOREIGN_NONNEWS.search(probe):
            return no("nonnews_foreign")
    stats["passed"] += 1
    return title, passage, iso


def rec_id(prefix, url):
    return f"{prefix}:{hashlib.sha1(url.encode()).hexdigest()[:16]}"


def new_stats():
    return collections.Counter()


# Added after reading candidates: pages the first pass let through. Applied in select_news.py, on the kept text.
LATE_DOMAINS = {"menafn.com", "zazoom.it", "boerse-social.com", "informaticien.be", "sportsnaut.com", "abna24.com", "newsbreak.com", "msn.com", "headtopics.com"}
LATE_TEXT = re.compile(
    r"\b(?:\d{1,3}|[A-Za-z]+)-year-old\b|\b(?:adoption|adopted|foster (?:care|child|home|family))\b|\(CNN\)|\(CNN Newsource\)|CNN Newsource|\bpatent pending\b|"
    r"select the newsletters|add your email|\bfantasy (?:football|baseball|basketball|hockey)\b|accused of|charges against|dropped charges|vandal\w*|"
    r"\d{1,3}-летн|\d{1,3} años\b|\d{1,3} anni\b|\d{1,3} anos\b|\d{1,3}-jährig|\d{1,3} ans\b|\d{1,3} yaşında|"
    r"imputad|imputar|fiscal[ií]a|\bdenunci|\bincendio|\bmadre\b|\bhij[oa]s?\b|\besposa\b|\bmarido\b|\bfigli[oa]\b|\bmoglie\b|\bfilh[oa]s?\b|\bmãe\b|\bSohn\b|\bTochter\b|\bEhefrau\b|\bEhemann\b|"
    r"\bmère\b|\bfils\b|\bfille\b|\bépouse\b|\bмать\b|\bматер|\bсын\b|\bсына\b|\bдочь\b|\bжена\b|\bмуж\b|\boğlu\b|\bkızı\b|\bannesi\b",
    re.I)
LATE_TITLE = re.compile(r"^(как |cómo |como |come |comment |wie |nasıl )|\bIntroduces\b|\btome \d|\bTracks of the Week\b|\bfantasy\b|\breceta\b|\bsleepers\b", re.I)


def late_ok(c):
    host = c["domain"]
    if listed(host, LATE_DOMAINS):
        return False
    return not (LATE_TEXT.search(c["text"]) or LATE_TEXT.search(c["title"]) or LATE_TITLE.search(c["title"]))


# Added after reading the first final sample: press-release copy, bots, digests, history pages, opinion, minors in school sport.
LATE_DOMAINS |= {"ratezip.com", "themarketsdaily.com", "primaryignition.com", "internetlaos.com", "westernjournal.com", "townhall.com", "inquisitr.com", "commondreams.org", "singularityhub.com"}
LATE2_TEXT = re.compile(
    r"\bReuters\b|\bAFP\b|\bAP\b|Newswire|Business Wire|press releases?\b|\bJiji Press\b|\bYonhap\b|\bBernama\b|\bAnadolu\b|Xinhua|"
    r"\btoday announced\b|[–-] [A-Z][a-z]+\.? \d{1,2}, 2026 [–-]|\bGet Free Report\b|52-week (low|high)|"
    r"\bstudent[- ]athlete\b|funded by the people|to donate by|brings over \w+ years|\bis a (senior )?(journalist|reporter|writer) (at|for|with)\b|"
    r"приготовить|рецепт|\bcómo llegar\b|pieza explicativa|editor.s note|this week.s awesome",
    re.I)
LATE2_TITLE = re.compile(r"^(?:%s) \d{1,2},? (?:1\d{3}|20[01]\d)\b|\bDigest\b|\bAwesome Tech Stories\b|\bof the week\b" % "|".join(MONTHS), re.I)
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
WEEKDAY_DATE = re.compile(r"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? (%s) (\d{1,2})(?:st|nd|rd|th)?\b(?:,? (20\d\d))?" % "|".join(MONTHS))
_late_ok_first = late_ok


def weekday_fits(text, published):
    """'Tuesday, January 10' must be a Tuesday in the page's year, or the page was recycled and its date can't be trusted."""
    year = int(published[:4])
    for name, month, d, y in WEEKDAY_DATE.findall(text):
        try:
            real = datetime.date(int(y or year), MONTHS.index(month) + 1, int(d))
        except ValueError:
            return False
        if WEEKDAYS[real.weekday()] != name:
            return False
    return True


def first_person(text):
    bare = re.sub(r"[\"“][^\"”]*[\"”]", " ", text)
    return len(re.findall(r"\bI\b|\b[Mm]y\b|\bme\b", bare)) >= 2


def late_ok(c):
    if not _late_ok_first(c):
        return False
    if LATE2_TEXT.search(c["text"]) or LATE2_TITLE.search(c["title"]):
        return False
    return weekday_fits(c["text"], c["date"]) and not first_person(c["text"])


def no_em_dash(s):
    return re.sub(r"\s*—\s*", ", ", s)
