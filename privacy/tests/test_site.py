"""The public landing page in site/: what it promises about itself, and the data rules it shares with the repo.

The footer says the page loads nothing from other sites, vercel.json's CSP enforces that with no
'unsafe-inline', and the page is public, so every number on it must be invented in the repo's way.
"""

from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path

from base import guard

SITE = Path(__file__).resolve().parent.parent / "site"
TEXT_FILES = ("index.html", "site.js", "styles.css", "vercel.json", "favicon.svg", "art/grain.svg")


def text(name: str) -> str:
    return (SITE / name).read_text(encoding="utf-8")


class Loads(HTMLParser):
    """Every URL the page itself loads (scripts, styles, icons, images), plus inline code."""

    def __init__(self):
        super().__init__()
        self.urls: list[str] = []
        self.inline: list[str] = []
        self.styled: list[str] = []
        self._in_script = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "style" in a:
            self.styled.append(tag)
        if any(k.startswith("on") for k in a):
            self.inline.append(f"<{tag}> event handler")
        if tag == "script":
            self._in_script = "src" not in a
            if "src" in a:
                self.urls.append(a["src"])
        elif tag == "style":
            self.inline.append("<style>")
        elif tag == "link" and a.get("rel") in ("stylesheet", "icon", "preload", "manifest"):
            self.urls.append(a.get("href", ""))
        elif tag in ("img", "source", "iframe", "video", "audio", "embed"):
            self.urls.append(a.get("src", ""))

    def handle_data(self, data):
        if self._in_script and data.strip():
            self.inline.append("<script>")

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False


def test_page_loads_only_its_own_files():
    p = Loads()
    p.feed(text("index.html"))
    assert p.urls, "the parser found nothing to check"
    for url in p.urls:
        # relative paths, so the page works from Vercel, a local server or straight from the folder
        assert not re.match(r"[a-z][a-z0-9+.-]*:|/", url, re.IGNORECASE), url
        assert (SITE / url).is_file(), f"missing {url}"
    assert p.inline == [] and p.styled == []  # the CSP has no 'unsafe-inline'
    css = text("styles.css")
    assert "@import" not in css and not re.search(r"url\(\s*['\"]?(?:https?:)?//", css)
    assert not re.search(r"https?://|fetch\(|XMLHttpRequest|WebSocket\(", text("site.js"))


def test_csp_is_strict():
    headers = {
        h["key"]: h["value"] for rule in json.loads(text("vercel.json"))["headers"] for h in rule["headers"]
    }
    csp = headers["Content-Security-Policy"]
    assert "default-src 'none'" in csp and "script-src 'self'" in csp and "style-src 'self'" in csp
    assert "unsafe" not in csp and "http" not in csp


def test_no_em_dashes():
    for name in TEXT_FILES:
        assert "—" not in text(name), name


def test_disclaimers():
    page = text("index.html")
    assert "not made or endorsed by Meta" in page
    assert "loads nothing from other sites" in page
    assert "invented" in page


def test_every_number_on_the_page_is_invented():
    """Phones in 555-01xx, SSNs starting with 9, cards only the Visa test number, no relay address."""
    for name in ("index.html", "site.js"):
        body = text(name)
        for phone in re.findall(r"\b\d{3}-\d{4}\b", body):
            assert re.fullmatch(r"555-01\d\d", phone), (name, phone)
        for ssn in re.findall(r"\b\d{3}-\d{2}-\d{4}\b", body):
            assert ssn.startswith("9"), (name, ssn)
        for card in re.findall(r"\b(?:\d{4}[ -]?){3}\d{4}\b", body):
            assert re.sub(r"\D", "", card) == "4111111111111111", (name, card)
        assert "workers.dev" not in body and "@" not in re.sub(r"@media|@keyframes", "", body), name


def test_tags_on_the_page_are_real_guard_tags():
    found = set()
    for name in ("index.html", "site.js"):
        for t in re.findall(
            r"\[(?:Student|Teacher|Person|Phone|Email|SSN|Card|Code|ID|Address|DOB)\b[^\]]*\]", text(name)
        ):
            found.add(t)
    assert found and all(guard.TAG_RE.fullmatch(t) for t in found), sorted(
        t for t in found if not guard.TAG_RE.fullmatch(t)
    )
