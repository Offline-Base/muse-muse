"""Observe mode: watch a candidate policy beside the enforced one, and never enforce it.

Off unless OBSERVE_POLICY names a policy file, and that file must say `mode: observe`
(base/services.py refuses one that does not). For each result egress releases, observe works out
what the candidate would decide, in code with no model call, and appends one line to
BASE_HOME/observe.jsonl. The enforced policy's decision stands: nothing here returns a decision,
changes the result, or writes a decision row, so observe can only add log lines.

How the candidate's decision is worked out, all on the device:
- the candidate's never-share keywords are scanned in the result and in Muse's request again;
- its identifier_topics map the result's own identifier hits again;
- the request labels the device model gave for the enforced policy are reused as they are (no
  second model call), so a request topic only the candidate defines is never labeled;
- the router runs in rules mode (the policy and learned rules in code, then the floors) for both
  the enforced policy and the candidate, so the line compares two policies on the same path even
  when the enforced decision came from a model.

A line holds kinds, decisions and fixed codes only: never the result, the request, a tag or a value.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

from base import guard as guard_module
from base.router import Router
from base.types import STRICTNESS, RouteDecision, RouteInput, TagResult

log = logging.getLogger(__name__)

LOG_NAME = "observe.jsonl"
SHARED = ("share_tagged", "share_summary")


class _NoModel:
    """The candidate is never shown to a model."""

    def chat_json(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("observe mode never calls a model")


class RulesRouter(Router):
    """The router on its rules path whatever the device's routing mode is: no model call."""

    def mode(self, inp: RouteInput | None = None) -> str:
        return "rules"


def rules_decision(settings: Any, policy: Any, inp: RouteInput, rules_text: str = "") -> RouteDecision:
    """What `policy` decides for `inp` on the router's rules path, with these learned rules."""
    return RulesRouter(settings, _NoModel(), policy, rules_text=rules_text).decide(inp)


def candidate_input(
    candidate: Any,
    current: Any,
    *,
    neutral_text: str,
    raw_request: str,
    asked: TagResult,
    tagged: TagResult,
    job_topics: Sequence[str],
    asked_about: Sequence[str],
    result_kind: str,
    summary: str | None,
    strict: bool,
    scan: Callable[[str, Mapping], list[str]] | None = None,
) -> RouteInput:
    """The RouteInput egress would route under `candidate`, rebuilt from what the enforced release
    already found. Only the policy's own pieces change: never-share keywords, identifier topics and
    the never-share topics named in the request. Tags and hits are the enforced release's."""
    from base import egress  # egress imports this module; the reverse import waits for the call

    scan = scan or guard_module.blocked_topics
    own_kw = list(scan(neutral_text or "", candidate.never_share))
    # guard.tag gives one reason per never-share topic it finds (guard._reason), so the same here
    cand_tagged = replace(tagged, blocked=[guard_module._reason(t) for t in own_kw], topics=own_kw)
    current_kw = egress.request_keyword_topics(raw_request, asked.text, current.never_share, scan)
    labels = [t for t in asked_about if t not in current_kw]  # the device model's labels, reused
    cand_kw = egress.request_keyword_topics(raw_request, asked.text, candidate.never_share, scan)
    cand_about = list(dict.fromkeys([*cand_kw, *labels]))
    own = list(dict.fromkeys([*job_topics, *own_kw, *egress.identifier_topics(tagged.hits, candidate)]))
    inp = egress.route_input(asked, result_kind, cand_tagged, own, cand_about, candidate.never_share, summary)
    inp.strict = strict
    return inp


def change(before: str, after: str) -> str:
    """same, stricter or looser, by STRICTNESS."""
    if STRICTNESS[after] == STRICTNESS[before]:
        return "same"
    return "stricter" if STRICTNESS[after] > STRICTNESS[before] else "looser"


def line(
    *, tool: str, item_id: str | None, result_kind: str, enforced: RouteDecision, current: RouteDecision,
    candidate: RouteDecision, candidate_name: str,
) -> dict[str, Any]:
    """One observe line: kinds, decisions and fixed codes, never text."""
    return {
        "ts": int(time.time()),
        "tool": tool,
        "item_id": item_id,
        "result_kind": result_kind,
        "candidate": candidate_name,
        "enforced": enforced.decision,
        "enforced_code": getattr(enforced, "code", "") or "",
        "current_rules": current.decision,
        "current_code": getattr(current, "code", "") or "",
        "candidate_decision": candidate.decision,
        "candidate_code": getattr(candidate, "code", "") or "",
        "change": change(current.decision, candidate.decision),
        # the candidate keeps it on the device where the enforced decision let it out or asked
        "would_block": candidate.decision == "refuse" and enforced.decision != "refuse",
        # the candidate would let out what the enforced decision kept or asked about (not done here)
        "would_allow": candidate.decision in SHARED and enforced.decision not in SHARED,
        "path": "rules",
    }


def append(path: Path, row: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(dict(row), sort_keys=True) + "\n")


def log_path(settings: Any) -> Path | None:
    home = getattr(settings, "home", None)
    return Path(home) / LOG_NAME if home is not None else None


def read_log(path: str | Path) -> list[dict[str, Any]]:
    p = Path(path)
    if not p.is_file():
        return []
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]


def totals(rows: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Counts over observe lines: how many, how many the candidate decides differently, and how
    many it would block or allow that the enforced policy did not."""
    return {
        "lines": len(rows),
        "different": sum(1 for r in rows if r.get("change") != "same"),
        "stricter": sum(1 for r in rows if r.get("change") == "stricter"),
        "looser": sum(1 for r in rows if r.get("change") == "looser"),
        "would_block": sum(1 for r in rows if r.get("would_block")),
        "would_allow": sum(1 for r in rows if r.get("would_allow")),
    }
