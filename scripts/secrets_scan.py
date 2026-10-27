"""Scan the repo, and optionally its git history, for secrets and machine details.

    uv run python -m scripts.secrets_scan [--history] [--report eval/reports/secrets_scan.md]

Looks for API key shapes (OpenRouter, Anthropic, OpenAI, AWS, GitHub, Slack, Hugging Face,
private key blocks), IPv4 addresses other than loopback and the private network ranges' base
addresses, home-network host names, and this machine's user name. Findings name the file, the line
and the kind, never the value. Exit 1 when anything is found.
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
    "private key": re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----"),
}
IPV4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
# Loopback, the wildcard, and the documentation ranges tests should use for invented addresses.
# A private-range host (a home network address) is flagged: that is what a real one looks like.
ALLOWED_NETS = [ipaddress.ip_network(n) for n in ("127.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
ALLOWED_IPS = {"0.0.0.0", "255.255.255.255", "10.0.0.0", "172.16.0.0", "192.168.0.0"}  # range bases in CIDRs
HOSTS = re.compile(r"\b[\w-]+\.(?:local|lan|internal|ts\.net|home\.arpa)\b|\bngrok(?:-free)?\.(?:app|io)\b", re.I)
SKIP_SUFFIXES = (".png", ".jpg", ".gif", ".stl", ".step", ".glb", ".pdf", ".db", ".gguf", ".woff2", ".ico")
SKIP_PARTS = ("node_modules", ".venv", ".wrangler")


def user_names() -> set[str]:
    """This machine's user name, which must never land in a file (short ones would match words)."""
    names = {getpass.getuser(), Path.home().name}
    return {n for n in names if n and len(n) >= 4 and n not in ("root", "runner", "user")}


def scan_text(text: str, where: str, users: set[str]) -> list[tuple[str, int, str]]:
    found = []
    user_res = [re.compile(rf"(?<![A-Za-z0-9]){re.escape(u)}(?![A-Za-z0-9])", re.I) for u in users]
    for n, line in enumerate(text.splitlines(), 1):
        for kind, rx in KEYS.items():
            if rx.search(line):
                found.append((where, n, kind))
        for ip in IPV4.findall(line):
            if _flag_ip(ip, line):
                found.append((where, n, "ip address"))
        if HOSTS.search(line):
            found.append((where, n, "host name"))
        if any(rx.search(line) for rx in user_res):
            found.append((where, n, "user name"))
    return found


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
        if path.suffix.lower() in SKIP_SUFFIXES or any(part in SKIP_PARTS for part in path.parts) or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        found += scan_text(text, rel, users)
    return found


def scan_history(root: Path, users: set[str]) -> list[tuple[str, int, str]]:
    """Every added line in every commit."""
    log = subprocess.run(["git", "-C", str(root), "log", "-p", "--all", "--no-color", "--format=commit %h"],
                         capture_output=True, check=True).stdout.decode("utf-8", "replace")  # fmt: skip
    found, commit = [], "?"
    added: list[str] = []
    for line in log.splitlines():
        if line.startswith("commit "):
            if added:
                found += [(f"history {commit}", n, k) for _, n, k in scan_text("\n".join(added), "", users)]
            commit, added = line.split()[1], []
        elif line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
    if added:
        found += [(f"history {commit}", n, k) for _, n, k in scan_text("\n".join(added), "", users)]
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
        cmd = "uv run python -m scripts.secrets_scan" + (" --history" if args.history else "") + f" --report {args.report}"
        body = [
            "# Secrets scan", "", f"Command: `{cmd}`", "",
            "Checks every file git tracks or would add" + (", and every added line in git history" if args.history else "")
            + ", for API key shapes, IPv4 addresses (other than loopback and the private ranges' base addresses), "
            "home-network host names and this machine's user name. Findings give the place and the kind, never the value.",
            "", f"Findings: {len(found)}", "",
        ]  # fmt: skip
        body += [f"- {line}" for line in lines]
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text("\n".join(body) + "\n")
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
