"""Selects CC-NEWS passages for the Glimmer writers, on one AWS instance next to the data (instance role, no keys).

    python3 ccnews_select.py map BUCKET WORK         read every Parquet file, write filtered candidates
    python3 ccnews_select.py select BUCKET WORK      robots.txt per domain, pick, write SourceRecord JSONL to S3

Two sets, one passage of at most 210 words per record (lib/knowledge/sources.ts):
  s3-ccnews-ai-meta.jsonl   AI models, AI companies, chips, AI policy, Meta and its products. Up to 40,000, at most
                            200 per site, at most 2 per story (best-sourced first), spread by day.
  s3-ccnews-general.jsonl   major general news, up to 40,000, per-day quotas with more for September and October,
                            at most 50 per site per month, 1 per story, established outlets first.
Rules are news_common.judge() and late_ok(), plus the tighter ones below (wire and press copy by URL and format,
syndication across sites, evergreen pages, listicles, betting, templates, personal profiles, minors).
"""

import argparse
import collections
import concurrent.futures
import gzip
import hashlib
import json
import math
import multiprocessing
import os
import random
import re
import socket
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import news_common as C  # noqa: E402

PREFIX = "knowledge/news/ccnews"
OUT = "knowledge/corpus/ccnews-select"
OPTOUT_TABLE = "knowledge/news/ccnews-optout/domains.parquet"
SEED = 20261030
COLS = ["url", "domain", "title", "text", "language", "published", "date_source", "fetch_time", "words",
        "optout_noai_meta", "optout_tdm_meta", "optout_tdm_header", "optout_noai_header", "optout_usage_header"]
LANGS = {"en"} | C.FOREIGN_OK
FLAGS = ["optout_noai_meta", "optout_tdm_meta", "optout_tdm_header", "optout_noai_header"]
LICENSE = ("Article text under each publisher's copyright, extracted from Common Crawl CC-NEWS; Common Crawl terms of use "
           "apply. Private, training only.")

# ---------------------------------------------------------------- topic: AI, chips, Meta

AI_STRONG = re.compile(
    r"\bAI\b(?!\d)|\bA\.I\.|\b[Aa]rtificial [Ii]ntelligence\b|\b[Gg]enerative AI\b|\bGenAI\b|\b[Cc]hatbots?\b|\bLLMs?\b|"
    r"\b[Ll]arge [Ll]anguage [Mm]odels?\b|\b[Mm]achine [Ll]earning\b|\bOpenAI\b|\bChatGPT\b|\bGPT-\d|\bSam Altman\b|\bAnthropic\b|"
    r"\bClaude (?:AI|Opus|Sonnet|Haiku|Code)\b|\bDeepMind\b|\bGemini (?:AI|app|model|Ultra|Pro|Flash)\b|\bCopilot\b|\bxAI\b|\bGrok\b|"
    r"\bPerplexity\b|\bDeepSeek\b|\bQwen\b|\bMistral AI\b|\bHugging Face\b|\bMidjourney\b|\bStability AI\b|\bScale AI\b|"
    r"\bSuperintelligence\b|\bsuperintelligence\b|\bAGI\b|\bNvidia\b|\bNVIDIA\b|\bJensen Huang\b|\bTSMC\b|\b[Ss]emiconductors?\b|"
    r"\b[Cc]hipmakers?\b|\bAI chips?\b|\bGPUs?\b|\b[Dd]ata cent(?:er|re)s?\b|\bAI Act\b|"
    r"\bMeta\b(?!-)|\bMeta's\b|\bMark Zuckerberg\b|\bZuckerberg\b|\bInstagram\b|\bWhatsApp\b|\bFacebook\b|\bLlama \d|\bLlama\b(?= model)|"
    r"\bRay-Ban Meta\b|\bMeta Quest\b|\bReality Labs\b|\bMuse (?:Spark|Glimmer|Wonder)\b|\bThreads app\b")


STRICT_TEMPORAL = C.TEMPORAL
LOOSE_TEMPORAL = re.compile(C.TEMPORAL.pattern + r"|\b(?:new|newest|latest|recent(?:ly)?|now|upcoming|quarter|fiscal|launch\w*|unveil\w*|announc\w*|releas\w*)\b")


AI_FOREIGN = re.compile(
    r"\bIA\b|\bKI\b|\bИИ\b|[Ii]nteligencia [Aa]rtificial|[Ii]ntelligence [Aa]rtificielle|[Kk]ünstliche[nr]? Intelligenz|[Ii]ntelligenza [Aa]rtificiale|"
    r"[Ii]ntelig[êe]ncia [Aa]rtificial|[Kk]unstmatige [Ii]ntelligentie|[Ии]скусственн\w+ интеллект\w*|[Yy]apay [Zz]ek[aâ]|[Kk]ecerdasan [Bb]uatan|"
    r"[Ss]ztuczn\w+ [Ii]nteligencj\w+|الذكاء الاصطناعي|कृत्रिम बुद्धिमत्ता|[Ss]emiconductores|[Ss]emi-?conducteurs|Halbleiter|[Ss]emicondutores|"
    r"[Pp]olupro\w+|[Пп]олупроводник\w*|[Cc]entros? de datos|[Cc]entres? de données|Rechenzent\w+|[Cc]hatbot\w*")


def ai_hits(s, foreign=False):
    if not foreign:
        return len(AI_STRONG.findall(s))
    # Bare "Meta" is a Colombian department in Spanish and a word ("goal") in several languages: it doesn't count there.
    return sum(1 for m in AI_STRONG.finditer(s) if not m.group(0).startswith("Meta")) + len(AI_FOREIGN.findall(s)) + (
        len(re.findall(r"\bMeta (?:AI|Platforms|Quest)\b", s)))


# ---------------------------------------------------------------- tighter filters (after the reviewer's findings)

EXTRA_DOMAINS = {
    "ksl.com", "stacker.com", "theconversation.com", "kffhealthnews.org", "calmatters.org", "statepoint.net", "brandpoint.com",
    "familyfeatures.com", "newsusa.com", "patch.com", "dailymail.co.uk", "mirror.co.uk", "express.co.uk", "thesun.co.uk",
    "the-sun.com", "dailystar.co.uk", "nypost.com", "pagesix.com", "tmz.com", "radaronline.com", "hollywoodlife.com",
    "benzinga.com", "fool.com", "zacks.com", "seekingalpha.com", "gurufocus.com", "nasdaq.com", "247wallst.com", "investorplace.com",
    "thestreet.com", "insidermonkey.com", "simplywall.st", "etfdailynews.com", "watchlistnews.com", "thelincolnianonline.com",
    "dailypolitical.com", "thecerbatgem.com", "wkrb13.com", "tradingeconomics.com", "fxstreet.com", "forexlive.com",
    "newsbreak.com", "ground.news", "flipboard.com", "inkl.com", "allsides.com", "newsnow.co.uk", "biztoc.com", "techmeme.com",
    "jdsupra.com", "lexology.com", "zerohedge.com", "exclusivepress.net", "openpr.com", "einpresswire.com", "whatech.com",
    "executivebiz.com", "govconwire.com", "perishablenews.com", "ncnonline.net", "globalbankingandfinance.com", "it-online.co.za",
    "newsanyway.com", "mybigplunge.com", "destinationcrm.com", "wam.ae", "lokmattimes.com", "devdiscourse.com", "digitalmarketreports.com",
    "thesheffieldpress.com", "awesomeagents.ai", "thecooldown.com", "barchart.com", "mondaq.com", "finnewsnetwork.com.au", "briefly.co.za",
    "newsx.com", "latestly.com", "menafn.com", "zawya.com", "aninews.in", "ptinews.com", "uniindia.com", "ians.in", "natlawreview.com",
    "swissinfo.ch", "perthnow.com.au", "thewest.com.au", "fool.ca", "fool.co.uk", "fool.com.au", "xtb.com", "fxempire.com", "ig.com",
    "marketresearch.com", "researchandmarkets.com", "giiresearch.com", "industryarc.com", "coherentmarketinsights.com", "openpr.com", "issuewire.com", "send2press.com", "24-7pressrelease.com", "marketwatch.com",
}
WIRE_PATH = re.compile(
    r"/(?:ap|apnews|ap-news|associated-press|ap-wire|reuters|afp|wires?|newswires?|npr|npr-news|nprnews|business-?wire|"
    r"globe-?newswire|pr-?newswire|press-?releases?|pressroom|news-?releases?|syndicated|syndication|stacker|brandpoint|"
    r"statepoint|sponsored|paid-post|partner-content|native|pr|ein-presswire|accesswire|cision)(?:[/-]|$)", re.I)
# Reuters' feed as other sites carry it ('SINGAPORE, Oct 29 :' or 'LONDON, Oct 29 (Reuters) -') and AP-style caps datelines.
FEED_DATELINE = re.compile(r"^[A-Z][A-Za-z.'\- ]{1,40}(?:, [A-Z][A-Za-z.'\- ]{1,30})?,? (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\s*(?:\([^)]{1,30}\)\s*)?[:\-–—]")
CAPS_DATELINE = re.compile(r"^[A-Z][A-Z.'\- ]{2,30}(?:, [A-Z][A-Za-z.'\- ]{2,30})?\s*(?:\([^)]{1,30}\)\s*)?[—–:-]\s")
# Big newsrooms whose own staff file under datelines; on every other site a caps dateline is treated as likely wire copy.
OWN_DATELINES = {"washingtonpost.com", "wsj.com", "ft.com", "theguardian.com", "politico.com", "cnn.com", "csmonitor.com", "latimes.com", "bostonglobe.com"}
# Found reading the first AI set: press-release copy, state-agency wire, viral posts by private people.
PR_COPY = re.compile(
    r"\((?:NYSE|NASDAQ|Nasdaq|NSE|BSE|TSX|TSXV|LSE|AIM|ASX|OTC\w*|AMEX|NYSE American|Euronext|SIX|HKEX|SGX|JSE|KRX|TWSE)\s*:\s*[A-Z0-9.]+|"
    r"\[India\]|\bBook your spot\b|\bRegister (?:now|today|here)\b|\btoday (?:introduced|launched|unveiled|released|unveils|introduces|launches)\b|"
    r"\bsuccessfully hosted\b|\bhas announced (?:a|an|the|its) (?:strategic|new|expanded|partnership)\b|\bis proud to\b|\b(?:thrilled|excited|delighted) to (?:announce|partner|share)\b|"
    r"\((?:WAM|ANI|PTI|IANS|UNI|SPA|KUNA|QNA|BNA|APP|NNA|ONA|MENA|IRNA|Bernama|Antara|Yonhap|Kyodo|TASS|Sputnik|Petra|SUNA|PNA|IINA|AzerTAc|Trend|Kazinform|UzA|BSS|NAN|KNA|VNA|TAP|MAP|APS|ENA|Xinhua|AA|Agencies)\)|"
    r"\bNews Agency\b|\bnews agency (?:reports|said|reported)\b|\bwent viral\b|\bviral (?:post|video|clip)\b|\bmaking rounds\b|\bnetizens\b|"
    r"\((?:Bloomberg|Reuters|AP|AFP|AAP|dpa|Kyodo|Jiji|Yonhap|ANSA|EFE)\)|\bBloomberg News\b|\bAAP\b|Australian Associated Press|\bZelenskiy\b|"
    r"\bresults today\b|\bpractice times\b|\blive results\b|\bLinkedIn post\b|\bemotional (?:post|note|farewell)\b|\bpenned (?:a|an)\b|\bheartbreaking\b|\bheartwarming\b|\bMzansi\b|\blearners?\b",
    re.I)
PR_DATELINE = re.compile(r"^[A-Z]{3,}[A-Z .'-]*(?:,? (?:and|&) [A-Z]{3,}[A-Z .'-]*)?, (?:[A-Z][a-z]+\.?|[A-Z]{2})(?:,| \d)")
MARKET_SPAM = re.compile(r"\bCAGR\b|\bforecast period\b|\bmarket (?:size|share|report|research|analysis|outlook|growth|trends|insights|is projected|was valued)\b|\bkey (?:players|vendors)\b", re.I)
EXTRA_TEXT = re.compile(
    r"\bStacker\b|\bAssociated Press\b|\bAP reported\b|\bNPR\b|\bnpr\.org\b|\bwire service\b|contributed to this report|"
    r"\bThe Conversation\b|\brepublished\b|\bThis (?:story|article) (?:was|is) (?:originally )?(?:published|produced|republished|written)\b|"
    r"\boriginally (?:appeared|published|ran) (?:on|in|at)\b|\bTribune (?:Content Agency|News Service)\b|\bKFF Health News\b|"
    r"\bCalMatters\b|\bStatePoint\b|\bBrandpoint\b|\bFamily Features\b|\bNewsUSA\b|\bsponsored by\b|\bpaid for by\b|"
    r"\bnot (?:investment|financial) advice\b|\bsportsbooks?\b|\bparlays?\b|\bbest bets?\b|\bmoneyline\b|\bover/under\b|"
    r"\bpoint spread\b|\bodds (?:of|to win|are|on)\b|\bpromo\b|\bcoupon\b|\baffiliate\b|\bcommission (?:on|from) (?:purchases|sales)\b|"
    r"\bGoFundMe\b|\bvigil\b|\bmemorial service\b|\blaid to rest\b|\bpassed away\b|\bdied peacefully\b|\bloving memory\b|"
    r"\bgrand(?:mother|father|ma|pa|daughter|son)\b|\bneighbou?rs? (?:said|say)\b|\bfamily (?:said|says)\b|\bfriends (?:said|say)\b|"
    r"\bannounces? (?:the )?(?:launch|availability|appointment|partnership|winners)\b|\b(?:is|are) pleased to announce\b|"
    r"\bannounced today\b|\bannounces today\b|\bLearn more at\b|\bVisit (?:us|our website)\b|\bAbout (?:the )?[A-Z][\w&.]+(?: [A-Z][\w&.]+)?:",
    re.I)
EXTRA_TITLE = re.compile(
    r"^\d{1,3} (?!years?\b|days?\b|months?\b|weeks?\b|hours?\b|percent\b|million\b|billion\b|trillion\b|people\b|killed\b|dead\b|countries\b|states\b)|"
    r"\b(?:top|best) \d{1,3}\b|\branked\b|\brankings?\b|\bodds\b|\bpicks?\b|\bpredictions?\b|\bparlay\b|\bbest bets?\b|\bspread\b|\bprops\b|"
    r"\bpromo\b|\bcoupon\b|\bon sale\b|\b\d+% off\b|\bdiscount\b|\bgift guide\b|\bbuying guide\b|\bdeal alert\b|\bdeals? of the\b|"
    r"\bstock market today\b|\bstocks? to (?:buy|watch)\b|\bmortgage rates?\b|\bCD rates?\b|\bgold (?:rate|price)\b|\bprice today\b|"
    r"\btoday's (?:deals|wordle|connections|strands|quordle|weather)\b|\bweather\b|\bhoroscope\b|\bquiz\b|\bpuzzle\b|\banswers?\b|\bhints?\b|"
    r"^meet\b|\bmeet the\b|\bspotlight\b|\bprofile\b|\bQ&A\b|\bhonor roll\b|\bdean'?s list\b|\bgraduat\w+\b|\beagle scout\b|\bbirthday\b|"
    r"\banniversary\b|\bwedding\b|\bengage(?:d|ment)\b|\bof the (?:week|month|year)\b|\bobituar\w*\b|\bin memoriam\b|\bcelebrates? (?:life|\d+)\b|"
    r"\bwhat to know\b|\beverything (?:you need to|to) know\b|\bexplained\b|\bguide to\b|\btips\b|\bhow (?:to|do|does|can)\b|\bwhy you should\b|"
    r"\breview:|\breview$|\bhands-on\b|\bfirst look\b|\bvs\.?\b|\bversus\b|\bnewsletter\b|\bpodcast\b|\bepisode\b|\bwatch\b|^live\b|\blive updates\b|"
    r"\brecap\b|\bhighlights\b|\bschedule\b|\bwhere to\b|\bteen\b|\bstudents? of\b|\bstock (?:forecast|outlook)\b|\bshould you buy\b|\bbuy (?:or|now)\b",
    re.I)
MINOR = re.compile(r"\b(?:teen(?:ager)?s?|toddlers?|infants?|bab(?:y|ies)|juveniles?|minors?|schoolchildren|school(?:boy|girl)s?|\d{1,2}-month-old|"
                   r"high school (?:senior|junior|sophomore|freshman|student|athlete|team|football|basketball|soccer|baseball|softball|volleyball|wrestling)|"
                   r"(?:senior|junior|sophomore|freshman) (?:at|from))\b", re.I)
HARM = re.compile(r"\b(?:died|dies|death|killed|injur\w+|hurt|abus\w+|bull(?:y|ied|ying)|harass\w+|missing|found|hospital\w*|police|charged|court|lawsuit|sued|trial|judge|suicide|self-harm)\b", re.I)
PUBLIC_POLICY = re.compile(r"\b(?:law|bill|legislat\w+|regulat\w+|policy|policies|ban|rules?|attorneys general|states|Congress|Senate|Parliament|Commission|FTC|minister|government|lawmakers)\b", re.I)
FRESH_WEEKDAY = re.compile(r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|today|yesterday|this week|last week)\b")
MAJOR_TOPIC = re.compile(
    r"\b(?:President|Prime Minister|Minister|Senate|Congress|Parliament|election|elections|vote|voters|referendum|ceasefire|war|troops|"
    r"missiles?|airstrikes?|sanctions|tariffs?|inflation|interest rates?|central bank|Federal Reserve|economy|GDP|recession|unemployment|"
    r"Supreme Court|government|shutdown|budget|treaty|summit|NATO|United Nations|European Union|climate|earthquake|hurricane|typhoon|"
    r"wildfire|floods?|pandemic|outbreak|vaccine|World Cup|Olympics|championship|launch(?:ed)?|NASA|spacecraft|record)\b")

TIER_NEWS = {
    "bbc.co.uk", "bbc.com", "theguardian.com", "cnn.com", "washingtonpost.com", "wsj.com", "ft.com", "economist.com", "cnbc.com",
    "abcnews.go.com", "cbsnews.com", "usatoday.com", "latimes.com", "politico.com", "politico.eu", "axios.com", "thehill.com", "time.com",
    "newsweek.com", "forbes.com", "businessinsider.com", "fortune.com", "theatlantic.com", "newyorker.com", "vox.com", "semafor.com",
    "propublica.org", "pbs.org", "voanews.com", "csmonitor.com", "independent.co.uk", "telegraph.co.uk", "thetimes.co.uk", "thetimes.com",
    "standard.co.uk", "news.sky.com", "skynews.com", "itv.com", "channel4.com", "aljazeera.com", "france24.com", "euronews.com", "rfi.fr",
    "lemonde.fr", "scmp.com", "japantimes.co.jp", "nikkei.com", "straitstimes.com", "channelnewsasia.com", "hindustantimes.com",
    "thehindu.com", "indianexpress.com", "timesofindia.indiatimes.com", "ndtv.com", "livemint.com", "economictimes.indiatimes.com",
    "business-standard.com", "abc.net.au", "smh.com.au", "theage.com.au", "theaustralian.com.au", "sbs.com.au", "nzherald.co.nz",
    "rnz.co.nz", "stuff.co.nz", "cbc.ca", "globalnews.ca", "theglobeandmail.com", "thestar.com", "ctvnews.ca", "nationalpost.com",
    "irishtimes.com", "rte.ie", "independent.ie", "koreaherald.com", "koreatimes.co.kr", "koreajoongangdaily.joins.com", "arabnews.com",
    "thenationalnews.com", "timesofisrael.com", "haaretz.com", "jpost.com", "dawn.com", "gulfnews.com", "khaleejtimes.com", "news24.com",
    "dailymaverick.co.za", "premiumtimesng.com", "punchng.com", "nation.africa", "kyivindependent.com", "themoscowtimes.com", "barrons.com",
    "bostonglobe.com", "chicagotribune.com", "sfchronicle.com", "seattletimes.com", "miamiherald.com", "dallasnews.com",
    "houstonchronicle.com", "startribune.com", "ajc.com", "denverpost.com", "newsday.com", "inquirer.com", "tampabay.com", "oregonlive.com",
    "azcentral.com", "sacbee.com", "mercurynews.com", "statnews.com", "science.org", "nature.com", "scientificamerican.com",
    "newscientist.com", "theweek.com", "slate.com", "salon.com", "motherjones.com", "nationalreview.com", "washingtonexaminer.com",
    "rollcall.com", "govexec.com", "defensenews.com", "foreignpolicy.com", "thediplomat.com",
    "bangkokpost.com", "inquirer.net", "rappler.com", "thestar.com.my", "jakartaglobe.id", "taipeitimes.com", "focustaiwan.tw",
    "vnexpress.net", "scroll.in", "thewire.in", "deccanherald.com", "fastcompany.com",
    "qz.com", "upi.com",
}
TIER_TECH = {
    "theverge.com", "techcrunch.com", "arstechnica.com", "wired.com", "engadget.com", "zdnet.com", "venturebeat.com", "theregister.com",
    "technologyreview.com", "cnet.com", "tomshardware.com", "theinformation.com", "siliconangle.com", "datacenterdynamics.com",
    "eetimes.com", "gizmodo.com", "mashable.com", "pcmag.com", "techradar.com", "tomsguide.com", "geekwire.com", "techspot.com",
    "digitaltrends.com", "9to5mac.com", "9to5google.com", "macrumors.com", "androidauthority.com", "androidcentral.com",
    "windowscentral.com", "neowin.net", "semianalysis.com", "servethehome.com", "digitimes.com", "nextplatform.com", "hpcwire.com",
    "computerworld.com", "infoworld.com", "networkworld.com", "cio.com", "techtarget.com", "crn.com", "restofworld.org", "404media.co",
    "platformer.news", "theneurondaily.com", "aibusiness.com", "the-decoder.com", "marktechpost.com", "analyticsindiamag.com",
    "fiercewireless.com", "lightreading.com", "uploadvr.com", "roadtovr.com", "socialmediatoday.com", "adweek.com", "digiday.com",
    "theverge.com", "axios.com", "semafor.com", "cnbc.com", "ft.com", "wsj.com", "fortune.com", "businessinsider.com",
}


def _parent(domain):
    parts = domain.split(".")
    keep = 3 if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "ac", "gov", "edu", "ne", "or", "go"} else 2
    return ".".join(parts[-keep:])


def tier(domain, volume, ai):
    if C.listed(domain, TIER_TECH if ai else set()) or C.listed(domain, TIER_NEWS):
        return 3
    return 2 if volume >= 3000 else 1


def fresh(url, text, iso):
    """Evergreen pages and recycled ones don't say when they are: the URL, '2026', the day itself or a weekday must."""
    if C.url_date(url) or "2026" in text[:4000] or FRESH_WEEKDAY.search(text[:3000]):
        return True
    return C.text_mentions_date(text[:4000], C.day(iso))


def extra_drop(c, full_text, foreign=False):
    """The tighter rules. Returns the reason, or None to keep. A caps dateline is only marked: prepare() drops it off top outlets."""
    host, title, passage = c["domain"], c["title"], c["text"]
    if C.listed(host, EXTRA_DOMAINS):
        return "x_domain"
    if WIRE_PATH.search(urllib.parse.urlsplit(c["url"]).path):
        return "x_wire_path"
    if FEED_DATELINE.match(passage):
        return "x_feed_dateline"
    if CAPS_DATELINE.match(passage) or PR_DATELINE.match(passage):
        c["caps"] = 1
    probe = f"{title}\n{passage}"
    if EXTRA_TEXT.search(probe) or EXTRA_TEXT.search(full_text[-1500:]):
        return "x_text"
    if not foreign and EXTRA_TITLE.search(title):
        return "x_title"
    if MARKET_SPAM.search(probe):
        return "x_market_report"
    if PR_COPY.search(probe):
        return "x_pr_agency_viral"
    if MINOR.search(probe) and (HARM.search(probe) or not PUBLIC_POLICY.search(probe)):
        return "x_minor"
    if not fresh(c["url"], full_text, c["date"]):
        return "x_evergreen"
    return None


# ---------------------------------------------------------------- map

_FS = None
_BUCKET = None


def _init(bucket):
    global _FS, _BUCKET
    import pyarrow.fs
    _FS = pyarrow.fs.S3FileSystem(region="us-east-1")
    _BUCKET = bucket


def map_file(key):
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    st_ai, st_gen, vol = collections.Counter(), collections.Counter(), collections.Counter()
    ai, gen = [], []
    tried, kept = collections.Counter(), collections.Counter()
    try:
        with _FS.open_input_file(f"{_BUCKET}/{key}") as f:
            pf = pq.ParquetFile(f)
            for rg in range(pf.metadata.num_row_groups):
                t = pf.read_row_group(rg, columns=COLS)
                st_gen["rows_read"] += t.num_rows
                vol.update(t.column("domain").to_pylist())
                pub = pc.utf8_slice_codeunits(pc.fill_null(t["published"], ""), 0, 10)
                m = pc.and_(pc.is_in(t["language"], value_set=pa.array(sorted(LANGS))), pc.is_in(t["date_source"], value_set=pa.array(["article:published_time", "json-ld"])))
                m = pc.and_(m, pc.and_(pc.greater_equal(pub, C.FIRST), pc.less_equal(pub, C.LAST)))
                m = pc.and_(m, pc.greater_equal(pc.fill_null(t["words"], 0), C.MIN_SOURCE_WORDS))
                for k in FLAGS:
                    m = pc.and_(m, pc.invert(pc.fill_null(t[k], False)))
                m = pc.and_(m, pc.equal(pc.fill_null(t["optout_usage_header"], ""), ""))
                m = pc.fill_null(m, False)
                t = t.filter(m)
                st_gen["prefilter_kept"] += t.num_rows
                for row in t.to_pylist():
                    url, title, text = row["url"] or "", row["title"] or "", row["text"] or ""
                    host = C.domain_of(url)
                    if not host or C.listed(host) or C.NONNEWS_DOMAIN.search(host) or C.listed(host, C.LATE_DOMAINS) or C.listed(host, EXTRA_DOMAINS):
                        st_gen["domain_out"] += 1
                        continue
                    lang = row["language"]
                    foreign = lang != "en"
                    th, bh = ai_hits(title, foreign), ai_hits(text, foreign)
                    is_ai = (th >= 1 and bh >= 2) or bh >= 3
                    if foreign and not is_ai:
                        continue
                    if not is_ai:
                        s = _parent(host)
                        if kept[s] >= 1 or tried[s] >= 4:
                            continue
                        tried[s] += 1
                    st = st_ai if is_ai else st_gen
                    # AI rows: product and policy news often has no day word in its lead; fresh() still has to see the date.
                    C.TEMPORAL = LOOSE_TEMPORAL if is_ai else STRICT_TEMPORAL
                    got = C.judge(url=url, title=title, full_text=text, language=lang, source_words=row["words"], stats=st,
                                  published=row["published"], crawl=row["fetch_time"], needs_proof=False)
                    if not got:
                        continue
                    t2, passage, iso = got
                    c = {"url": url, "domain": host, "title": t2, "date": iso, "text": passage, "language": lang}
                    if not C.late_ok(c):
                        st["late_filter"] += 1
                        continue
                    why = extra_drop(c, text, foreign)
                    if why:
                        st[why] += 1
                        continue
                    c["sw"] = row["words"]
                    if is_ai:
                        if ai_hits(t2, foreign) < 1 and ai_hits(passage, foreign) < 2:
                            st["ai_passage_off_topic"] += 1
                            continue
                        c["ai"] = bh
                        ai.append(c)
                    else:
                        c["major"] = 1 if MAJOR_TOPIC.search(f"{t2}\n{passage}") else 0
                        kept[_parent(host)] += 1
                        gen.append(c)
                    st["kept"] += 1
    except Exception as err:  # noqa: BLE001
        st_gen["file_error"] += 1
        print("error", key, repr(err)[:200], flush=True)
    return key, ai, gen, st_ai, st_gen, vol


def list_keys(bucket):
    import boto3
    s3 = boto3.client("s3", region_name="us-east-1")
    keys = []
    for m in range(1, 11):
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"{PREFIX}/2026-{m:02d}/"):
            keys += [o["Key"] for o in page.get("Contents", []) if o["Key"].endswith(".parquet")]
    return keys


def put(bucket, path, key):
    import boto3
    boto3.client("s3", region_name="us-east-1").upload_file(path, bucket, key)


def cmd_map(a):
    os.makedirs(a.work, exist_ok=True)
    keys = list_keys(a.bucket)
    random.Random(SEED).shuffle(keys)
    if a.limit:
        keys = keys[: a.limit]
    print(len(keys), "files", flush=True)
    st_ai, st_gen, vol = collections.Counter(), collections.Counter(), collections.Counter()
    n_ai = n_gen = 0
    started, last = time.time(), 0
    with gzip.open(f"{a.work}/ai.jsonl.gz", "wt") as fa, gzip.open(f"{a.work}/gen.jsonl.gz", "wt") as fg, \
            multiprocessing.get_context("fork").Pool(a.procs, initializer=_init, initargs=(a.bucket,), maxtasksperchild=50) as pool:
        for i, (key, ai, gen, sa, sg, v) in enumerate(pool.imap_unordered(map_file, keys, chunksize=1)):
            if a.stop_at and time.time() > a.stop_at:
                print("stop time reached after", i, "files: keeping what is done", flush=True)
                st_gen["files_skipped_at_stop"] = len(keys) - i
                pool.terminate()
                break
            for c in ai:
                fa.write(json.dumps(c, ensure_ascii=False) + "\n")
            for c in gen:
                fg.write(json.dumps(c, ensure_ascii=False) + "\n")
            n_ai += len(ai)
            n_gen += len(gen)
            st_ai.update(sa)
            st_gen.update(sg)
            vol.update(v)
            if time.time() - last > 60 or i == len(keys) - 1:
                last = time.time()
                status = {"files_done": i + 1, "files": len(keys), "ai": n_ai, "gen": n_gen, "minutes": round((time.time() - started) / 60, 1),
                          "rows_read": st_gen["rows_read"], "prefilter_kept": st_gen["prefilter_kept"]}
                print(json.dumps(status), flush=True)
                json.dump(status, open(f"{a.work}/progress.json", "w"))
                try:
                    put(a.bucket, f"{a.work}/progress.json", f"{OUT}/_status/map-progress.json")
                except Exception as err:  # noqa: BLE001
                    print("status upload failed", err, flush=True)
    json.dump({"ai": st_ai, "general": st_gen, "candidates": {"ai": n_ai, "general": n_gen}}, open(f"{a.work}/map-stats.json", "w"), indent=1)
    json.dump(dict(vol), open(f"{a.work}/volume.json", "w"))
    for name in ("map-stats.json", "volume.json", "ai.jsonl.gz", "gen.jsonl.gz"):
        put(a.bucket, f"{a.work}/{name}", f"{OUT}/work/{name}")
    print("map done", n_ai, n_gen, round((time.time() - started) / 60, 1), "minutes", flush=True)


# ---------------------------------------------------------------- select

def norm_key(text, n=30):
    return hashlib.sha1(" ".join(re.sub(r"[^\w\s]", " ", text.lower()).split()[:n]).encode()).hexdigest()


STOP = set("the a an and or of to in on for with at by from as is are was were be been it its this that these those after before over "
           "into about amid says said say new will would could can may might has have had not no but than more most first year years "
           "what why how when who which their his her they them our your you we us he she".split())


def title_words(t):
    return {w for w in re.findall(r"[a-z0-9']+", t.lower()) if len(w) > 2 and w not in STOP}


def bands(ws):
    """Six MinHash values in three bands of two: titles sharing about half their words usually share a band."""
    if not ws:
        return []
    hs = []
    for seed in range(6):
        hs.append(min(int(hashlib.md5(f"{seed}:{w}".encode()).hexdigest()[:12], 16) for w in ws))
    return [(b, hs[2 * b], hs[2 * b + 1]) for b in range(3)]


class Robots:
    def __init__(self, path, table=None):
        import select_news as S  # compile_rules, path_blocked
        self.S, self.path, self.rows, self.compiled = S, path, {}, {}
        if table:
            self.rows.update(table)
        if os.path.exists(path):
            for line in open(path):
                r = json.loads(line)
                self.rows[r["domain"]] = r

    def check(self, domains, threads=160):
        import ccnews_optout as optout
        optout.TIMEOUT, optout.READ_SECONDS = 6, 6
        socket.setdefaulttimeout(8)
        todo = [d for d in dict.fromkeys(domains) if d not in self.rows]
        if not todo:
            return
        groups = collections.defaultdict(list)
        for d in todo:
            groups[_parent(d)].append(d)  # one connection per host: a parent's domains go in turn
        print(time.strftime("%H:%M:%S"), "robots: checking", len(todo), "domains in", len(groups), "groups", flush=True)

        def work(g):
            out = []
            for d in g:
                try:
                    out.append(optout.check(d, 0))
                except Exception as err:  # noqa: BLE001
                    out.append({"domain": d, "excluded": True, "excluded_reasons": "robots-unreachable:" + repr(err)[:80], "robots_txt": None})
            return out

        with concurrent.futures.ThreadPoolExecutor(threads) as pool, open(self.path, "a") as f:
            for rows in pool.map(work, list(groups.values())):
                for r in rows:
                    keep = {k: r.get(k) for k in ("domain", "robots_status", "partial_block_agents", "excluded", "excluded_reasons", "robots_txt", "tdmrep_reserved", "fetched_at")}
                    self.rows[r["domain"]] = keep
                    f.write(json.dumps(keep) + "\n")
        print(time.strftime("%H:%M:%S"), "robots: cache", len(self.rows), "excluded", sum(1 for r in self.rows.values() if r["excluded"]), flush=True)

    def ok(self, c):
        r = self.rows.get(c["domain"])
        if r is None or r["excluded"]:
            return False
        if not r.get("partial_block_agents") and not r.get("robots_txt"):
            return True
        d = c["domain"]
        if d not in self.compiled:
            self.compiled[d] = self.S.compile_rules(r.get("robots_txt"))
        return not self.S.path_blocked(self.compiled[d], urllib.parse.urlsplit(c["url"]).path or "/")


def load(path):
    with gzip.open(path, "rt") as f:
        return [json.loads(line) for line in f]


def syndicated(rows):
    """Passages or titles found on three or more sites are wire, press or syndicated copy that slipped past the credit rules."""
    by_text, by_title = collections.defaultdict(set), collections.defaultdict(set)
    for c in rows:
        by_text[norm_key(c["text"])].add(_parent(c["domain"]))
        by_title[" ".join(sorted(title_words(c["title"])))].add(_parent(c["domain"]))
    return {k for k, v in by_text.items() if len(v) >= 3}, {k for k, v in by_title.items() if len(v) >= 3}


def post_pass(rows, ai, stats):
    """The rules from reading the second sets (ccnews_post.py), boilerplate sentences out, then at most 210 words."""
    import ccnews_finish
    import ccnews_post
    out = []
    for c in rows:
        text = ccnews_finish.fit(C.no_em_dash(ccnews_post.clean_text(c["text"])).replace("\u2014", ", "))
        if not text:
            stats["p_short"] += 1
            continue
        c["text"], c["title"] = text, C.no_em_dash(c["title"])
        why = ccnews_post.post_drop(c, ai, ai_hits)
        if why:
            stats[why] += 1
            continue
        out.append(c)
    return out


def prepare(rows, vol, ai):
    rng = random.Random(SEED + (1 if ai else 2))
    out, stats, seen_url, seen_text = [], collections.Counter(), set(), set()
    rows = post_pass(rows, ai, stats)
    texts, titles = syndicated(rows)
    for c in rows:
        tk = " ".join(sorted(title_words(c["title"])))
        nk = norm_key(c["text"])
        if nk in texts or (tk and tk in titles):
            stats["syndicated"] += 1
            continue
        if c["url"] in seen_url or nk in seen_text:
            stats["duplicate"] += 1
            continue
        tr = tier(c["domain"], vol.get(c["domain"], 0), ai)
        if c.get("caps") and not C.listed(c["domain"], OWN_DATELINES):
            stats["caps_dateline"] += 1
            continue
        seen_url.add(c["url"])
        seen_text.add(nk)
        c["tier"] = tr
        c["score"] = (0 if c.get("language", "en") == "en" else -100) + tr * 10 + (min(c.get("ai", 0), 12) / 3 if ai else 3 * c.get("major", 0)) + min(c.get("sw") or 0, 2000) / 1000 + rng.random()
        out.append(c)
    return out, stats


def domain_order(rows):
    weight = collections.Counter()
    for c in rows:
        weight[c["domain"]] += c["tier"]
    return [d for d, _ in weight.most_common()]


class Stories:
    def __init__(self):
        self.band = {}
        self.count = collections.Counter()
        self.next = 0

    def story(self, c):
        d = C.day(c["date"]).toordinal()
        bs = bands(title_words(c["title"]))
        for b in bs:
            for dd in (d, d - 1, d + 1):
                s = self.band.get((dd, b))
                if s is not None:
                    return s, bs, d
        self.next += 1
        return self.next, bs, d

    def add(self, s, bs, d):
        for b in bs:
            self.band.setdefault((d, b), s)
        self.count[s] += 1


def to_record(c, name):
    return {"id": C.rec_id(name, c["url"]), "source": f"{c['domain']} via CC-NEWS", "title": C.no_em_dash(c["title"]), "url": c["url"],
            "date": c["date"], "license": LICENSE, "visibility": "private", "text": C.no_em_dash(c["text"])}


def write_set(a, name, chosen, extra):
    path = f"{a.work}/{name}.jsonl"
    with open(path, "w") as f:
        for c in sorted(chosen, key=lambda r: (r["date"], r["url"])):
            f.write(json.dumps(to_record(c, name), ensure_ascii=False) + "\n")
    report = {"records": len(chosen), "by_month": dict(sorted(collections.Counter(c["date"][:7] for c in chosen).items())),
              "sites": len({_parent(c["domain"]) for c in chosen}), "languages": dict(collections.Counter(c.get("language", "en") for c in chosen)), "top_domains": collections.Counter(c["domain"] for c in chosen).most_common(60),
              "by_tier": dict(collections.Counter(c["tier"] for c in chosen)), **extra}
    json.dump(report, open(f"{a.work}/{name}.report.json", "w"), indent=1)
    put(a.bucket, path, f"{OUT}/{name}.jsonl")
    put(a.bucket, f"{a.work}/{name}.report.json", f"{OUT}/{name}.report.json")
    print(time.strftime("%H:%M:%S"), name, json.dumps({k: v for k, v in report.items() if k != "top_domains"}), flush=True)


def select_ai(a, robots, vol):
    rows, stats = prepare(load(f"{a.work}/ai.jsonl.gz"), vol, True)
    print("ai candidates after prepare", len(rows), dict(stats), flush=True)
    order = domain_order(rows)
    robots.check(order[: a.ai_domains])
    allowed = [c for c in rows if robots.ok(c)]
    print("ai allowed by robots", len(allowed), flush=True)
    by_day = collections.defaultdict(list)
    for c in allowed:
        by_day[c["date"]].append(c)
    stories, per_site, chosen = Stories(), collections.Counter(), []
    for day in by_day:
        by_day[day].sort(key=lambda c: -c["score"])
    ptr = {d: 0 for d in by_day}
    live = sorted(by_day)
    while len(chosen) < a.ai_max and live:
        nxt = []
        for d in live:
            lst = by_day[d]
            while ptr[d] < len(lst):
                c = lst[ptr[d]]
                ptr[d] += 1
                s = _parent(c["domain"])
                if per_site[s] >= 200:
                    continue
                sid, bs, o = stories.story(c)
                if stories.count[sid] >= 2:
                    continue
                stories.add(sid, bs, o)
                per_site[s] += 1
                chosen.append(c)
                break
            if ptr[d] < len(lst):
                nxt.append(d)
            if len(chosen) >= a.ai_max:
                break
        live = nxt
    write_set(a, "s3-ccnews-ai-meta", chosen, {"candidates_after_prepare": len(rows), "allowed_by_robots": len(allowed), "prepare_drops": dict(stats)})
    return {c["url"] for c in chosen} | {c["text"] for c in chosen}


def month_targets(total):
    w = {f"2026-{m:02d}": 1.0 for m in range(1, 9)}
    w["2026-09"] = w["2026-10"] = 2.15
    s = sum(w.values())
    return {m: int(total * v / s) for m, v in w.items()}


def select_general(a, robots, vol, ai_urls):
    rows, stats = prepare(load(f"{a.work}/gen.jsonl.gz"), vol, False)
    rows = [c for c in rows if c["url"] not in ai_urls and c["text"] not in ai_urls]
    print("general candidates after prepare", len(rows), dict(stats), flush=True)
    order = domain_order(rows)
    robots.check(order[: a.gen_domains])
    allowed = [c for c in rows if robots.ok(c)]
    print("general allowed by robots", len(allowed), flush=True)
    targets = month_targets(a.gen_max)
    by_day = collections.defaultdict(list)
    for c in allowed:
        by_day[c["date"]].append(c)
    for d in by_day:
        by_day[d].sort(key=lambda c: -c["score"])
    stories, per_site_month, chosen, taken = Stories(), collections.Counter(), [], set()
    for month, target in targets.items():
        days = sorted(d for d in by_day if d.startswith(month))
        if not days:
            continue
        per_day = math.ceil(target / len(days))
        got = 0
        for rnd in (0, 1):
            for d in days:
                n = 0
                for c in by_day[d]:
                    if got >= target or (rnd == 0 and n >= per_day):
                        break
                    if c["url"] in taken:
                        continue
                    s = (_parent(c["domain"]), month)
                    if per_site_month[s] >= 50:
                        continue
                    sid, bs, o = stories.story(c)
                    if stories.count[sid] >= 1:
                        continue
                    stories.add(sid, bs, o)
                    per_site_month[s] += 1
                    taken.add(c["url"])
                    chosen.append(c)
                    n += 1
                    got += 1
    write_set(a, "s3-ccnews-general", chosen, {"candidates_after_prepare": len(rows), "allowed_by_robots": len(allowed), "month_targets": targets, "prepare_drops": dict(stats)})


def cmd_select(a):
    vol = json.load(open(f"{a.work}/volume.json"))
    table = None
    try:
        import pyarrow.fs
        import pyarrow.parquet as pq
        fs = pyarrow.fs.S3FileSystem(region="us-east-1")
        with fs.open_input_file(f"{a.bucket}/{OPTOUT_TABLE}") as f:
            t = pq.ParquetFile(f).read(columns=["domain", "robots_status", "partial_block_agents", "excluded", "excluded_reasons", "robots_txt"])
            table = {r["domain"]: r for r in t.to_pylist()}
        print("opt-out table found", len(table), flush=True)
    except Exception as err:  # noqa: BLE001
        print("no opt-out table, checking robots.txt per domain:", repr(err)[:120], flush=True)
    if not os.path.exists(f"{a.work}/robots.jsonl"):
        try:
            import boto3
            boto3.client("s3", region_name="us-east-1").download_file(a.bucket, f"{OUT}/work/robots.jsonl", f"{a.work}/robots.jsonl")
            print("robots cache from S3", flush=True)
        except Exception as err:  # noqa: BLE001
            print("no robots cache in S3:", repr(err)[:100], flush=True)
    robots = Robots(f"{a.work}/robots.jsonl", table)
    ai_urls = set()
    if a.which in ("both", "ai"):
        ai_urls = select_ai(a, robots, vol)
        put(a.bucket, f"{a.work}/robots.jsonl", f"{OUT}/work/robots.jsonl")
    if a.which in ("both", "general"):
        if not ai_urls and os.path.exists(f"{a.work}/s3-ccnews-ai-meta.jsonl"):
            ai_urls = {x for l in open(f"{a.work}/s3-ccnews-ai-meta.jsonl") for x in (json.loads(l)["url"], json.loads(l)["text"])}
        select_general(a, robots, vol, ai_urls)
        put(a.bucket, f"{a.work}/robots.jsonl", f"{OUT}/work/robots.jsonl")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["map", "select"])
    p.add_argument("bucket")
    p.add_argument("work")
    p.add_argument("--procs", type=int, default=os.cpu_count())
    p.add_argument("--limit", type=int)
    p.add_argument("--stop-at", type=float, help="epoch seconds: map stops taking files then")
    p.add_argument("--which", default="both", choices=["both", "ai", "general"])
    p.add_argument("--ai-max", type=int, default=40000)
    p.add_argument("--gen-max", type=int, default=40000)
    p.add_argument("--ai-domains", type=int, default=9000)
    p.add_argument("--gen-domains", type=int, default=14000)
    a = p.parse_args()
    {"map": cmd_map, "select": cmd_select}[a.cmd](a)


if __name__ == "__main__":
    main()
