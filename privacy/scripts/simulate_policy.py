"""Simulate a proposed policy before it is enforced: replay saved items through the real egress
under the current policy and under the proposed one, and report what changes. No model runs.

    uv run python -m scripts.simulate_policy --proposed eval/personas/relaxed_teacher/policy.yaml \\
        --set eval/fresh_200.jsonl
    uv run python -m scripts.simulate_policy --proposed NEW.yaml --current eval/user_policy.yaml \\
        --set eval/tasks.jsonl --out eval/reports/policy_sim/NEW_tasks.md

The idea follows Meta Engineering's PrivacyLib post (Oct 27, 2026): check a policy at the data
access boundary, and simulate it before release. Here the boundary is Egress.release, and each
item is released twice in one throwaway home, once per policy, so both runs share one tag map and
any difference comes from the policy. The model-free harness is scripts/replay_null_names.py's:
every call to the device model on 127.0.0.1:8083 gets a fixed fake reply (no names found, no
request labels), any other request fails, the repo's .env is not read, and routing is DEVICE_ONLY=1
in rules mode, so the router decides in code.

Each item gets an outcome per policy: allow (shared at once, tagged or as a summary), ask (held
for the user's OK) or block (kept on the device). Item by item the report lists every item whose
outcome, released text or reason code changed; "redacted differently" means both policies share
it but the text sent differs (a summary in place of the tagged text, say). The report holds ids,
outcomes, fixed reason codes and leak kinds, never an item's text.

Honest limits (docs/SIMULATE.md): request labels from the device model are empty here, so a rule
that waits on one (parents, third_party, full_text) only fires through the code floors; no
approval is answered; the compliance toggles are off; a sealed set is refused.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tempfile
from collections import Counter
from collections.abc import Iterable, Sequence
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from unittest import mock

from scripts.replay_null_names import CHECKER, SEALED, _off_device, _select, null_model

ROOT = Path(__file__).resolve().parent.parent
OUTCOME = {"shared": "allow", "waiting": "ask", "refused": "block"}
OUTCOME_ORDER = {"allow": 0, "ask": 1, "block": 2}


@dataclass
class Outcome:
    """What one policy did with one item. `sha` is a short hash of the text Muse got, never the text."""

    outcome: str
    decision: str
    code: str
    sha: str
    leak_kinds: list[str] = field(default_factory=list)


@dataclass
class ItemDiff:
    id: str
    current: Outcome
    proposed: Outcome
    expected: str = ""  # the item's hand label, when it has one (eval items do)

    @property
    def kind(self) -> str:
        """same, now_allowed, now_asks, now_blocked, redacted_differently or reason_changed."""
        a, b = self.current.outcome, self.proposed.outcome
        if a != b:
            return {"allow": "now_allowed", "ask": "now_asks", "block": "now_blocked"}[b]
        if self.current.sha != self.proposed.sha:
            return "redacted_differently" if a == "allow" else "reason_changed"
        if self.current.code != self.proposed.code or self.current.decision != self.proposed.decision:
            return "reason_changed"
        return "same"

    @property
    def direction(self) -> str:
        a, b = OUTCOME_ORDER[self.current.outcome], OUTCOME_ORDER[self.proposed.outcome]
        return "same" if a == b else ("stricter" if b > a else "looser")


KINDS = ("now_allowed", "now_asks", "now_blocked", "redacted_differently", "reason_changed", "same")


def _sha(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]


def _use(services, policy) -> None:
    """Point egress and the router at `policy` (both read it on every release)."""
    services.policy = policy
    router = getattr(services, "router", None)
    if router is not None:
        router.policy = policy


def outcome_of(services, released, item, roster_values) -> Outcome:
    from eval import run_eval

    rd = released.decision
    return Outcome(
        outcome=OUTCOME.get(released.status, released.status),
        decision=getattr(rd, "decision", "") or "",
        code=getattr(rd, "code", "") or "",
        sha=_sha(released.text),
        leak_kinds=run_eval.find_leaks(services, released.text or "", item, roster_values),
    )


def compare(services, items: Iterable[dict], current, proposed) -> list[ItemDiff]:
    """Release each item under `current`, then under `proposed`, in these services."""
    from eval import run_eval

    roster_values = run_eval._roster_values(getattr(services, "roster", None))
    out: list[ItemDiff] = []
    for item in items:
        got = []
        for policy in (current, proposed):
            _use(services, policy)
            released = run_eval.release_item(services, item)
            got.append(outcome_of(services, released, item, roster_values))
        out.append(ItemDiff(item["id"], got[0], got[1], str(item.get("expected") or "")))
    _use(services, current)
    return out


def simulate(items: list[dict], current_path: Path, proposed_path: Path) -> list[ItemDiff]:
    """compare() in a throwaway DEVICE_ONLY home with the null model of replay_null_names."""
    import respx

    from base import config
    from base.policy import UserPolicy
    from eval import run_eval

    current, proposed = UserPolicy.load(current_path), UserPolicy.load(proposed_path)
    with tempfile.TemporaryDirectory(prefix="base-policy-sim-") as tmp, ExitStack() as stack:
        stack.enter_context(mock.patch.object(config, "read_dotenv", lambda path: {}))
        settings = config.load_settings(
            {
                "BASE_HOME": str(Path(tmp) / "home"),
                "WORKSPACE_ROOT": tmp,
                "BASE_DEVICE": "laptop",
                "DEVICE_ONLY": "1",
                "PRIMARY_MODEL": "glimmer",
                "GLIMMER_BACKEND": "llama_server",
                # Muse Glimmer does every step on this device, so every step goes to the one faked server below.
                "ANSWER_URL": CHECKER,
                "ROUTER_URL": CHECKER,
                "CHECKER_URL": CHECKER,
                "LIGHT_SERIAL": "",
                "HEAVY_QUEUE": "0",
                "USER_POLICY": str(current_path),
            }
        )
        router = stack.enter_context(respx.mock(assert_all_called=False))
        router.route(url__startswith=CHECKER + "/").mock(side_effect=null_model)
        router.route().mock(side_effect=_off_device)
        services = run_eval.services_for(settings, Path(tmp) / "home")
        try:
            return compare(services, items, current, proposed)
        finally:
            services.close()


def totals(diffs: Sequence[ItemDiff]) -> dict[str, object]:
    kinds = Counter(d.kind for d in diffs)
    cur = Counter(d.current.outcome for d in diffs)
    new = Counter(d.proposed.outcome for d in diffs)
    return {
        "items": len(diffs),
        "changed": sum(1 for d in diffs if d.kind != "same"),
        "kinds": {k: kinds.get(k, 0) for k in KINDS},
        "looser": sum(1 for d in diffs if d.direction == "looser"),
        "stricter": sum(1 for d in diffs if d.direction == "stricter"),
        "current": {k: cur.get(k, 0) for k in OUTCOME_ORDER},
        "proposed": {k: new.get(k, 0) for k in OUTCOME_ORDER},
        "leaks_current": sum(1 for d in diffs if d.current.leak_kinds),
        "leaks_proposed": sum(1 for d in diffs if d.proposed.leak_kinds),
    }


def render(diffs: Sequence[ItemDiff], *, current: str, proposed: str, items: str, command: str) -> str:
    t = totals(diffs)
    k = t["kinds"]
    lines = [
        "# Policy simulation (Simulated, no model)",
        "",
        f"Current policy: `{current}`. Proposed policy: `{proposed}`. Items: `{items}`.",
        "",
        f"Command: `{command}`",
        "",
        "Every item went through the real egress (Egress.release) twice in one throwaway home, once per "
        "policy, with a fake device model that finds no names and gives no request labels "
        "(scripts/replay_null_names.py). Limits: docs/SIMULATE.md.",
        "",
        "## Totals",
        "",
        "| | Current | Proposed |",
        "|---|---|---|",
        *(f"| {o} | {t['current'][o]} | {t['proposed'][o]} |" for o in OUTCOME_ORDER),
        f"| items with a leak in what Muse got | {t['leaks_current']} | {t['leaks_proposed']} |",
        "",
        f"{t['changed']} of {t['items']} items change: {k['now_allowed']} now allowed, {k['now_asks']} now ask, "
        f"{k['now_blocked']} now blocked, {k['redacted_differently']} redacted differently, "
        f"{k['reason_changed']} with the same outcome for another reason. "
        f"{t['looser']} looser, {t['stricter']} stricter.",
        "",
    ]
    labeled = [d for d in diffs if d.direction == "looser" and d.expected in ("ask_user", "refuse")]
    if labeled:
        lines += [
            f"Of the {t['looser']} looser items, {len(labeled)} have a hand label of ask_user or refuse: results "
            "the eval's simulated teacher wanted to be asked about or kept, which would now go out at once.",
            "",
        ]
    sent = [d for d in diffs if d.kind not in ("same", "reason_changed")]
    lines += ["## Item by item: what Muse gets changes", ""]
    if not sent:
        lines += ["No item changes what Muse gets.", ""]
    else:
        lines += [
            "| Item | Change | Current | Proposed | Current code | Proposed code | Leak kinds (proposed) | Hand label |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for d in sent:
            lines.append(
                f"| {d.id} | {d.kind} | {d.current.outcome} ({d.current.decision}) | "
                f"{d.proposed.outcome} ({d.proposed.decision}) | {d.current.code or '-'} | {d.proposed.code or '-'} | "
                f"{','.join(d.proposed.leak_kinds) or '-'} | {d.expected or '-'} |"
            )
        lines.append("")
    reasons = [d for d in diffs if d.kind == "reason_changed"]
    if reasons:
        lines += [
            "## Item by item: same outcome, another reason",
            "",
            "| Current code | Proposed code | Outcome | Items |",
            "|---|---|---|---|",
        ]
        groups: dict[tuple[str, str, str], list[str]] = {}
        for d in reasons:
            key = (d.current.code or "-", d.proposed.code or "-", d.current.outcome)
            groups.setdefault(key, []).append(d.id)
        for (a, b, o), ids in groups.items():
            lines.append(f"| {a} | {b} | {o} | {', '.join(ids)} |")
        lines.append("")
    return "\n".join(lines)


def _shown(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return path.name


def default_out(proposed: Path, items: Path) -> Path:
    return ROOT / "eval" / "reports" / "policy_sim" / f"{proposed.parent.name}_{proposed.stem}__{items.stem}.md"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m scripts.simulate_policy", description=__doc__.splitlines()[0])
    p.add_argument("--proposed", required=True, type=Path, help="the policy file to simulate")
    p.add_argument("--current", type=Path, default=ROOT / "eval" / "user_policy.yaml", help="the policy enforced now")
    p.add_argument("--set", required=True, type=Path, help="JSONL file of saved items in the eval format")
    p.add_argument("--ids", help="comma-separated item ids (default: all)")
    p.add_argument("--out", type=Path, help="where to write the report (default: eval/reports/policy_sim/)")
    args = p.parse_args(argv)
    if args.set.name in SEALED:
        p.error(f"{args.set.name} is sealed or holds the sealed set's items; do not score it")
    from base.policy import PolicyError
    from eval import run_eval

    items = _select(run_eval.load_items(args.set), args.ids)
    try:
        diffs = simulate(items, args.current, args.proposed)
    except PolicyError as exc:
        p.error(str(exc))
    out = args.out or default_out(args.proposed, args.set)
    shown = ["--proposed", _shown(args.proposed), "--current", _shown(args.current), "--set", _shown(args.set)]
    shown += ["--ids", args.ids] if args.ids else []
    report = render(
        diffs, current=_shown(args.current), proposed=_shown(args.proposed), items=_shown(args.set),
        command="uv run python -m scripts.simulate_policy " + " ".join(shown),
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report)
    t = totals(diffs)
    print(f"{t['changed']} of {t['items']} items change ({t['looser']} looser, {t['stricter']} stricter). Report: {_shown(out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
