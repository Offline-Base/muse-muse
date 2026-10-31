"""Statuses-only report of Muse sessions, from the device's audit and decision tables.

    uv run python -m scripts.muse_session_report --since 2026-10-31T09:00 --until 2026-10-31T12:00 \
        [--label session_2026-10-31] [--home PATH] [--relay-log PATH] [--out DIR]

Opens BASE_HOME/base.db read-only (sqlite mode=ro) and counts BASE_HOME/logs/relay.log status
codes, then writes eval/reports/muse_app/<label>.md (default label: session_<date of --since>) with
the command at the top. Times are the device's local time; a time with no zone is local too.

It reads only labels, timings and the decision columns status, topics and blocked, and prints
only labels from the audit table (tool, outcome, relay or local, the MCP client label) and counts.
It never reads request, tagged_text, released_text, raw_result, sources or receipt text: whether a
request carried a purpose is counted inside SQLite, and topics and blocked reasons are only
compared, never printed. relay.log lines are only matched for "-> NNN".
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import sqlite3
import statistics
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from base.config import REPO_ROOT, load_settings

OUT_DIR = REPO_ROOT / "eval" / "reports" / "muse_app"
LABEL = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
STATUS = re.compile(r"-> (\d{3})\b")
LOG_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
REASK_SECONDS = 15 * 60
PURPOSE_TOOLS = ("search_documents", "ask_device")  # the tools whose request gets a "Purpose:" line
DREAM_TOOLS = ("run_dreaming", "dreaming_report")


def label(value: object) -> str:
    """An audit value as printed: a plain label, or 'unlabeled' for anything else."""
    return value if isinstance(value, str) and LABEL.match(value) else "unlabeled"


def via(value: object) -> str:
    return value if value in ("relay", "local") else "unlabeled"


def connect_ro(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def json_list(value: object) -> set[str]:
    try:
        items = json.loads(value) if isinstance(value, str) and value else []
    except ValueError:
        return set()
    return {str(i) for i in items} if isinstance(items, list) else set()


def p50(values: list[int]) -> int:
    return int(statistics.median(values)) if values else 0


def hhmm(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def read_audit(conn: sqlite3.Connection, since: float, until: float) -> list[dict]:
    cols = columns(conn, "audit")
    if not cols:
        return []
    via_col = "via" if "via" in cols else "'local' AS via"
    rows = conn.execute(
        f"SELECT ts, tool, outcome, ms, {via_col} FROM audit WHERE ts >= ? AND ts < ? ORDER BY ts", (since, until)
    ).fetchall()
    return [dict(r) for r in rows]


def read_decisions(conn: sqlite3.Connection, since: float, until: float) -> list[dict]:
    """Decision rows in the window: ids, times, status and the topic and blocked lists. No text."""
    if not columns(conn, "decisions"):
        return []
    rows = conn.execute(
        "SELECT id, ts, status, router_decision, user_decision, decided_at, decided_by, topics, blocked "
        "FROM decisions WHERE ts >= ? AND ts < ? AND deleted = 0 ORDER BY ts",
        (since, until),
    ).fetchall()
    out = []
    for r in rows:
        row = dict(r)
        row["topics"], row["blocked"] = json_list(row["topics"]), json_list(row["blocked"])
        out.append(row)
    return out


def purpose_counts(conn: sqlite3.Connection, since: float, until: float) -> tuple[int, int]:
    """(requests with a purpose, all search and ask requests), counted in SQLite so no text is read."""
    if not columns(conn, "decisions"):
        return 0, 0
    marks = ", ".join("?" for _ in PURPOSE_TOOLS)
    row = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(instr(COALESCE(request, ''), char(10) || 'Purpose:') > 0), 0) "
        f"FROM decisions WHERE ts >= ? AND ts < ? AND tool IN ({marks})",
        (since, until, *PURPOSE_TOOLS),
    ).fetchone()
    return int(row[1]), int(row[0])


def is_refusal(row: dict) -> bool:
    return row["status"] == "denied" or (row["status"] == "auto" and row["router_decision"] == "refuse")


def reasks(decisions: list[dict]) -> tuple[int, int, int, int]:
    """(refusals, refusals that had something to match, refusals asked again, re-ask rows).

    A re-ask is a later decision row within REASK_SECONDS that shares a topic or a blocked reason.
    """
    refusals = [d for d in decisions if is_refusal(d)]
    matchable = followed = rows = 0
    for r in refusals:
        if not (r["topics"] or r["blocked"]):
            continue
        matchable += 1
        later = [
            d for d in decisions
            if d["id"] != r["id"] and r["ts"] < d["ts"] <= r["ts"] + REASK_SECONDS
            and (d["topics"] & r["topics"] or d["blocked"] & r["blocked"])
        ]  # fmt: skip
        followed += bool(later)
        rows += len(later)
    return len(refusals), matchable, followed, rows


def pickups(decisions: list[dict], audit_rows: list[dict]) -> tuple[int, int, list[float]]:
    """(answered by the user, of those later read by a get_result, minutes until that get_result)."""
    answered = [d for d in decisions if d["status"] in ("approved", "denied") and d["decided_at"]]
    gets = [a["ts"] for a in audit_rows if a["tool"] == "get_result"]
    minutes = []
    for d in answered:
        after = [ts for ts in gets if ts >= d["decided_at"]]
        if after:
            minutes.append((min(after) - d["decided_at"]) / 60)
    return len(answered), len(minutes), minutes


def relay_codes(path: Path | None, since: float, until: float) -> Counter | None:
    """Status codes of the relay client's forwarded requests in the window, or None with no log."""
    if path is None or not path.is_file():
        return None
    codes: Counter = Counter()
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            stamp, code = LOG_TIME.match(line), STATUS.search(line)
            if not (stamp and code):
                continue
            ts = datetime.strptime(stamp.group(1), "%Y-%m-%d %H:%M:%S").timestamp()
            if since <= ts < until:
                codes[code.group(1)] += 1
    return codes


def render(command: str, since: datetime, until: datetime, audit_rows, decisions, purpose, codes) -> list[str]:
    calls = [a for a in audit_rows if a["tool"] != "initialize"]
    lines = [
        f"# Muse session report, {since:%Y-%m-%d %H:%M} to {until:%Y-%m-%d %H:%M}",
        "",
        f"Command: `{command}`",
        "",
        "Statuses, timings and counts only, from the device's audit and decision tables. No request, "
        "result or document text is read or shown.",
        "",
        "## Calls by tool and outcome",
        "",
    ]
    groups: dict[tuple[str, str], list[int]] = {}
    for a in calls:
        groups.setdefault((label(a["tool"]), label(a["outcome"])), []).append(int(a["ms"] or 0))
    if groups:
        lines += ["| Tool | Outcome | Calls | p50 ms | Max ms |", "|---|---|---|---|---|"]
        for (tool, outcome), ms in sorted(groups.items()):
            lines.append(f"| {tool} | {outcome} | {len(ms)} | {p50(ms)} | {max(ms)} |")
    else:
        lines.append("No calls in this window.")

    vias = Counter(via(a["via"]) for a in calls)
    clients = Counter(label(a["outcome"]) for a in audit_rows if a["tool"] == "initialize")
    lines += ["", "## Relay or local", ""]
    lines.append(f"- Through the relay: {vias['relay']}. Local: {vias['local']}.")
    if vias["unlabeled"]:
        lines.append(f"- Unlabeled: {vias['unlabeled']}.")
    lines.append("- Rows written before the relay label existed count as local.")
    if clients:
        lines.append("- MCP clients (initialize): " + ", ".join(f"{c} {n}" for c, n in sorted(clients.items())) + ".")
    else:
        lines.append("- No initialize calls recorded.")

    filled, asked = purpose
    lines += ["", "## Purpose", "", f"- search_documents and ask_device requests with a purpose: {filled} of {asked}."]

    answered, picked, minutes = pickups(decisions, audit_rows)
    approved = sum(1 for d in decisions if d["status"] == "approved")
    denied = sum(1 for d in decisions if d["status"] == "denied")
    pending = sum(1 for d in decisions if d["status"] == "pending")
    auto = sum(1 for d in decisions if d["decided_by"] == "auto_approve")
    lines += ["", "## Approvals", ""]
    lines.append(f"- Results that asked the user: {approved + denied + pending} ({approved} shared, {denied} kept, {pending} still waiting).")
    if auto:
        lines.append(f"- Of the shared ones, answered by Always approve: {auto}.")
    if answered:
        median = f", median {statistics.median(minutes):.1f} min after the answer" if minutes else ""
        lines.append(f"- Answered results Muse read again with get_result: {picked} of {answered}{median}.")

    refused, matchable, followed, rows = reasks(decisions)
    lines += ["", "## Refusals and re-asks", ""]
    lines.append(f"- Results kept on the device (router refused or user kept): {refused}.")
    lines.append(
        f"- Asked again within 15 min with a shared topic or blocked reason: {followed} of {matchable} "
        f"refusals that had one ({rows} later requests)."
    )

    dreams = [a for a in audit_rows if a["tool"] in DREAM_TOOLS]
    lines += ["", "## Dreaming calls", ""]
    if dreams:
        lines += [f"- {hhmm(a['ts'])} {a['tool']} {label(a['outcome'])} ({via(a['via'])})" for a in dreams]
    else:
        lines.append("- None.")

    lines += ["", "## Relay client log", ""]
    if codes is None:
        lines.append("- No relay.log found.")
    elif codes:
        lines.append("- Forwarded requests by status: " + ", ".join(f"{c} {n}" for c, n in sorted(codes.items())) + ".")
    else:
        lines.append("- No forwarded requests in this window.")
    return lines


def parse_time(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError("use an ISO time like 2026-10-31T09:00") from None


def shown_command(argv: list[str]) -> str:
    """The command line with any path argument replaced, so no home path reaches the report."""
    out, hide = [], False
    for arg in argv:
        if hide:
            out.append("PATH")
            hide = False
            continue
        key, eq, _ = arg.partition("=")
        if key in ("--home", "--relay-log", "--out"):
            if eq:
                out.append(f"{key}=PATH")
            else:
                out.append(arg)
                hide = True
            continue
        out.append(arg)
    return "uv run python -m scripts.muse_session_report " + shlex.join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--since", type=parse_time, required=True)
    ap.add_argument("--until", type=parse_time, required=True)
    ap.add_argument("--label", default=None, help="report name (default session_<date of --since>)")
    ap.add_argument("--home", type=Path, default=None, help="BASE_HOME to read (default: from settings)")
    ap.add_argument("--relay-log", type=Path, default=None, help="default: <home>/logs/relay.log")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args(argv)
    name = args.label or f"session_{args.since:%Y-%m-%d}"
    if not LABEL.match(name.replace("-", "_")):
        ap.error("--label must be a short name of letters, digits, - and _")
    home = args.home or load_settings().home
    db = home / "base.db"
    if not db.is_file():
        print("No base.db in that home.", file=sys.stderr)
        return 1
    since, until = args.since.timestamp(), args.until.timestamp()
    conn = connect_ro(db)
    try:
        audit_rows = read_audit(conn, since, until)
        decisions = read_decisions(conn, since, until)
        purpose = purpose_counts(conn, since, until)
    finally:
        conn.close()
    codes = relay_codes(args.relay_log or home / "logs" / "relay.log", since, until)
    command = shown_command(argv if argv is not None else sys.argv[1:])
    lines = render(command, args.since, args.until, audit_rows, decisions, purpose, codes)
    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / f"{name}.md"
    path.write_text("\n".join(lines) + "\n")
    print(f"Wrote {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
