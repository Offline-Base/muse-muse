"""Scan the repo, and optionally its git history, for secrets, machine details and data-rule breaks.

    uv run python -m scripts.secrets_scan [--history] [--report eval/reports/secrets_scan.md]

Looks for API key shapes (OpenRouter, Anthropic, OpenAI, AWS, GitHub, Slack, Hugging Face, Modal,
private key blocks), a long value assigned to one of this project's secret names (META_API_KEY,
OPENROUTER_API_KEY, JETSON_LFM_API_KEY, CHECKER_API_KEY, HEAVY_TOKEN and the like), a Cloudflare
token next to a Cloudflare word, a 32-hex id in a wrangler config, a real value in .env.example,
IPv4 addresses other than loopback and the documentation ranges, home-network host names, and this
machine's user name. In the invented data (demo/, eval/, tests/fixtures/) it also checks the data
rules: phones use 555-01xx, emails use example.com, .org or .net, SSNs start with 9 or 000, and card
numbers are well-known test numbers. Tests elsewhere hold real-looking shapes on purpose, to test
the detectors, so the data rules skip them. Findings name the file, the line and the kind, never
the value. Exit 1 when anything is found.
"""

from __future__ import annotations

import argparse
import getpass
import ipaddress
import re
import subprocess
from pathlib import Path

from base.config import REPO_ROOT

KEYS = {
    "openrouter key": re.compile(r"\bsk-or-v1-[0-9a-f]{32,}"),
    "anthropic key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "openai key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{32,}"),
    "aws key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "github token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    "slack token": re.compile(r"\bxox[abpors]-[A-Za-z0-9-]{10,}"),
    "hugging face token": re.compile(r"\bhf_[A-Za-z0-9]{30,}"),
    "modal token id": re.compile(r"\bak-[A-Za-z0-9]{20,}"),
    "modal token secret": re.compile(r"\bas-[A-Za-z0-9]{20,}"),
    "private key": re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----"),
}
# Meta's key shape is not published, so these are found by the name a value is assigned to, in any
# style: NAME=value, NAME: value, "NAME": "value".
SECRET_NAMES = (
    "META_API_KEY", "OPENROUTER_API_KEY", "JETSON_LFM_API_KEY", "CHECKER_API_KEY", "LLAMA_API_KEY",
    "HEAVY_TOKEN", "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "HF_TOKEN",
)  # fmt: skip
ASSIGNED = re.compile(rf"\b({'|'.join(SECRET_NAMES)})['\"]?\s*[:=]\s*['\"]?([A-Za-z0-9_\-./+=~]+)")
SECRET_MIN = 16  # characters; the tests' stand-ins ("local-test-key") are shorter
PLACEHOLDER_WORDS = (
    "replace",
    "your",
    "example",
    "placeholder",
    "changeme",
    "xxxx",
    "dummy",
    "fake",
    "test",
    "local",
)
# A Cloudflare API token is 40 characters of letters, digits, _ and -. That alone also fits other
# strings, so it counts only on a line that says Cloudflare, CF_ or wrangler.
CLOUDFLARE_WORD = re.compile(r"cloudflare|\bCF_|wrangler", re.I)
CLOUDFLARE_TOKEN = re.compile(r"(?<![\w-])[A-Za-z0-9_-]{40}(?![\w-])")
HEX_ID = re.compile(r"(?<![0-9A-Fa-f])[0-9a-f]{32}(?![0-9A-Fa-f])")  # a KV namespace or account id
ENV_LINE = re.compile(r"^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=\s*(\S*)")
ENV_SECRET = re.compile(r"(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$")  # not ROUTER_MAX_TOKENS
TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_\-./+=~]+")
IPV4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
# Loopback, the wildcard, and the documentation ranges tests should use for invented addresses.
# A private-range host (a home network address) is flagged: that is what a real one looks like.
ALLOWED_NETS = [
    ipaddress.ip_network(n) for n in ("127.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")
]
ALLOWED_IPS = {"0.0.0.0", "255.255.255.255", "10.0.0.0", "172.16.0.0", "192.168.0.0"}  # range bases in CIDRs
HOSTS = re.compile(
    r"\b[\w-]+\.(?:local|lan|internal|ts\.net|home\.arpa)\b|\bngrok(?:-free)?\.(?:app|io)\b", re.I
)
SKIP_SUFFIXES = (".png", ".jpg", ".gif", ".stl", ".step", ".glb", ".pdf", ".db", ".gguf", ".woff2", ".ico")
SKIP_PARTS = ("node_modules", ".venv", ".wrangler")

# The data rules, for the invented data only.
DATA_DIRS = ("demo/", "eval/", "tests/fixtures/")
PHONE = re.compile(r"(?<![\w-])(?:\+?1[-. ]?)?(?:\(\d{3}\) ?|\d{3}[-. ])(\d{3})[-. ](\d{4})(?![\w-])")
EMAIL = re.compile(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)")
EXAMPLE_DOMAIN = re.compile(
    r"(?:[\w-]+\.)*example\.(?:com|org|net)|.+\.(?:test|example|invalid|localhost)", re.I
)
SSN = re.compile(r"(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])")
CARD = re.compile(r"(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])")
TEST_CARDS = {
    "4111111111111111", "4242424242424242", "4012888888881881", "4000056655665556", "4222222222222",
    "5555555555554444", "5105105105105100", "5200828282828210", "2223003122003222", "378282246310005",
    "371449635398431", "6011111111111117", "6011000990139424", "3056930009020004", "36227206271667",
    "3566002020360505", "6200000000000005",
}  # fmt: skip


def user_names() -> set[str]:
    """This machine's user name, which must never land in a file (short ones would match words)."""
    names = {getpass.getuser(), Path.home().name}
    return {n for n in names if n and len(n) >= 4 and n not in ("root", "runner", "user")}


def _placeholder(value: str) -> bool:
    low = value.lower()
    return (
        not value
        or re.fullmatch(r"[A-Z_]+", value) is not None  # a name such as REPLACE_WITH_OAUTH_KV_ID
        or value.startswith(("<", "$", "{", "#"))
        or any(w in low for w in PLACEHOLDER_WORDS)
    )


def _secret_value(value: str) -> bool:
    """Long, not a placeholder, and with a letter and a digit, the way generated keys look."""
    return (
        len(value) >= SECRET_MIN
        and not _placeholder(value)
        and re.search(r"\d", value) is not None
        and re.search(r"[A-Za-z]", value) is not None
    )


def scan_text(text: str, where: str, users: set[str], path: str = "") -> list[tuple[str, int, str]]:
    """Findings in one text. `path` (repo-relative) turns on the checks for wrangler configs and .env.example."""
    found = []
    name = path.rsplit("/", 1)[-1]
    wrangler = name.startswith("wrangler.")
    env_example = name == ".env.example"
    user_res = [re.compile(rf"(?<![A-Za-z0-9]){re.escape(u)}(?![A-Za-z0-9])", re.I) for u in users]
    for n, line in enumerate(text.splitlines(), 1):
        for kind, rx in KEYS.items():
            if rx.search(line):
                found.append((where, n, kind))
        for m in ASSIGNED.finditer(line):
            if _secret_value(m.group(2)):
                found.append((where, n, f"{m.group(1)} value"))
        if CLOUDFLARE_WORD.search(line) and any(_cloudflare_token(t) for t in CLOUDFLARE_TOKEN.findall(line)):
            found.append((where, n, "cloudflare token"))
        if wrangler and HEX_ID.search(line):
            found.append((where, n, "cloudflare id"))
        if env_example and _env_example_value(line):
            found.append((where, n, "env example value"))
        for ip in IPV4.findall(line):
            if _flag_ip(ip, line):
                found.append((where, n, "ip address"))
        if HOSTS.search(line):
            found.append((where, n, "host name"))
        if any(rx.search(line) for rx in user_res):
            found.append((where, n, "user name"))
    return found


def _cloudflare_token(token: str) -> bool:
    return re.fullmatch(r"[0-9a-f]+", token) is None and _secret_value(token)  # 40 hex is a commit id


def _env_example_value(line: str) -> bool:
    """A secret's line in .env.example that holds something other than a blank or a placeholder."""
    m = ENV_LINE.match(line)
    if not m or not ENV_SECRET.search(m.group(1)):
        return False
    value = m.group(2)
    return bool(TOKEN_SHAPE.fullmatch(value)) and not _placeholder(value)


def scan_data(text: str, where: str) -> list[tuple[str, int, str]]:
    """The data rules for invented data: test-only phones, emails, SSNs and cards."""
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        if any(m.group(1) != "555" or not m.group(2).startswith("01") for m in PHONE.finditer(line)):
            found.append((where, n, "phone outside 555-01xx"))
        if any(not EXAMPLE_DOMAIN.fullmatch(m.group(1)) for m in EMAIL.finditer(line)):
            found.append((where, n, "email outside example domains"))
        if any(not (m.group(1).startswith("9") or m.group(1) == "000") for m in SSN.finditer(line)):
            found.append((where, n, "ssn outside 9xx or 000"))
        for m in CARD.finditer(line):
            digits = re.sub(r"\D", "", m.group(0))
            if _luhn(digits) and digits not in TEST_CARDS:
                found.append((where, n, "card number not a test number"))
                break
    return found


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch) * (2 if i % 2 else 1)
        total += d - 9 if d > 9 else d
    return total % 10 == 0


def _flag_ip(ip: str, line: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False  # 999.1.1.1 is not an address
    if ip in ALLOWED_IPS or any(addr in net for net in ALLOWED_NETS):
        return False
    # four dotted numbers right after a version word or a dependency pin are a version
    return not re.search(rf"(?:v|version|==|>=|@)\s*{re.escape(ip)}", line, re.I)


def tracked_files(root: Path) -> list[Path]:
    out = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                         capture_output=True, check=True).stdout  # fmt: skip
    return [root / p for p in out.decode().split("\0") if p]


def scan_tree(root: Path, users: set[str]) -> list[tuple[str, int, str]]:
    found = []
    for path in tracked_files(root):
        rel = path.relative_to(root).as_posix()
        if (
            path.suffix.lower() in SKIP_SUFFIXES
            or any(part in SKIP_PARTS for part in path.parts)
            or not path.is_file()
        ):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        found += scan_text(text, rel, users, rel)
        if rel.startswith(DATA_DIRS):
            found += scan_data(text, rel)
    return found


def scan_history(root: Path, users: set[str]) -> list[tuple[str, int, str]]:
    """Every added line in every commit, with the file each one was added to. The data rules are
    for the current data only, so they do not run here. Only this folder's own
    changes: inside a bigger repo (privacy/ in Muse Muse), --relative leaves the host's files to the host."""
    log = subprocess.run(["git", "-C", str(root), "log", "-p", "--relative", "--all", "--no-color", "--format=commit %h"],
                         capture_output=True, check=True).stdout.decode("utf-8", "replace")  # fmt: skip
    found: list[tuple[str, int, str]] = []
    commit, path = "?", ""
    added: list[str] = []

    def flush() -> None:
        if added:
            where = f"history {commit} {path}".rstrip()
            found.extend((where, n, k) for _, n, k in scan_text("\n".join(added), "", users, path))
            added.clear()

    for line in log.splitlines():
        if line.startswith("commit "):
            flush()
            commit, path = line.split()[1], ""
        elif line.startswith("+++ "):
            flush()
            path = line[6:] if line.startswith("+++ b/") else ""
        elif line.startswith("+"):
            added.append(line[1:])
    flush()
    return found


def main(argv: list[str] | None = None, root: Path = REPO_ROOT) -> int:
    p = argparse.ArgumentParser(prog="python -m scripts.secrets_scan", description=__doc__.split("\n")[0])
    p.add_argument("--history", action="store_true", help="also scan every commit's added lines")
    p.add_argument("--report", type=Path, help="write a markdown report here")
    args = p.parse_args(argv)
    users = user_names()
    found = scan_tree(root, users) + (scan_history(root, users) if args.history else [])
    lines = [f"{where}:{n}: {kind}" for where, n, kind in found]
    print("\n".join(lines) if lines else "Nothing found.")
    if args.report:
        cmd = (
            "uv run python -m scripts.secrets_scan"
            + (" --history" if args.history else "")
            + f" --report {args.report}"
        )
        body = [
            "# Secrets scan", "", f"Command: `{cmd}`", "",
            "Checks every file git tracks or would add" + (", and every added line in git history" if args.history else "")
            + ", for API key shapes (Modal tokens included), long values assigned to this project's secret names "
            "(META_API_KEY, OPENROUTER_API_KEY, JETSON_LFM_API_KEY, CHECKER_API_KEY, HEAVY_TOKEN and others), "
            "Cloudflare tokens, 32-hex ids in wrangler configs, real values in .env.example, IPv4 addresses "
            "(other than loopback, the documentation ranges and the private ranges' base addresses), "
            "home-network host names and this machine's user name. In the invented data (demo/, eval/, "
            "tests/fixtures/, current files only) it also checks that phones use 555-01xx, emails use example "
            "domains, SSNs start with 9 or 000 and card numbers are test numbers. Findings give the place and "
            "the kind, never the value.",
            "", f"Findings: {len(found)}", "",
        ]  # fmt: skip
        body += [f"- {line}" for line in lines]
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text("\n".join(body) + "\n")
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
