"""Replay an eval set through the real egress with a name pass that finds no names. No model runs.

Written to explain the 10 leaks in eval/reports/device_only_fresh_200.md (Oct 30); the answer is in
eval/reports/device_only_fresh_200_leaks.md. Every call the device would make to LFM3-VL-2B on
127.0.0.1:8083 gets a fixed fake reply: the name pass always says "no names" (the worst a small
model can do) and the request labels are always empty. Everything else is the shipped path:
eval.run_eval scores each item through Egress.release in DEVICE_ONLY mode, with the eval roster and
the simulated teacher's policy, and checks the text an approval would release too.

    uv run python -m scripts.replay_null_names --set eval/fresh_200.jsonl
    uv run python -m scripts.replay_null_names --set eval/fresh_200.jsonl --no-name-shapes

`--no-name-shapes` turns off the device-only name-shape check (guard.Redaction.name_shapes), the
deterministic layer added after the Oct 30 run, so the replay shows what the device let through
when it relied on the model alone. The repo's .env is not read, and any request that is not to
the faked local model fails. The sealed set (eval/splits/fresh_200_c.jsonl) and the pool it is drawn
from (eval/synthetic.jsonl) are refused.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections.abc import Iterable
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import httpx

CHECKER = "http://127.0.0.1:8083/v1"
SEALED = ("fresh_200_c.jsonl", "synthetic.jsonl")


def _reply(content: str) -> httpx.Response:
    choice = {"message": {"content": content}, "finish_reason": "stop"}
    return httpx.Response(200, json={"model": "lfm3-vl-2b", "choices": [choice]})


def null_model(request: httpx.Request) -> httpx.Response:
    """LFM3-VL-2B's place: no names, no request labels, and a plain sentence for anything else."""
    body = json.loads(request.content)
    fmt = (body.get("response_format") or {}).get("json_schema") or {}
    props = (fmt.get("schema") or {}).get("properties", {})
    if fmt.get("name") == "route":
        return _reply(json.dumps({"decision": "ask_user", "reason": "Fixed reply."}))
    for key in ("names", "topics", "queries", "parts"):
        if key in props:
            return _reply(json.dumps({key: []}))
    if "answer" in props:
        return _reply(json.dumps({"answer": "Done."}))
    return _reply("The class did well overall.")


def _off_device(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("only the faked local model answers in this replay", request=request)


def replay(items: list[dict], *, name_shapes: bool = True, name: str = "replay_null_names"):
    """Score `items` in a throwaway home with the null model. Returns the eval.run_eval.EvalReport."""
    import respx

    from base import config
    from base.egress import Egress
    from eval import run_eval

    with tempfile.TemporaryDirectory(prefix="base-replay-") as tmp, ExitStack() as stack:
        stack.enter_context(mock.patch.object(config, "read_dotenv", lambda path: {}))
        if not name_shapes:  # the device before the name-shape check: tag everything, no shapes
            stack.enter_context(mock.patch.object(Egress, "_redaction_for", lambda self, sources: None))
        settings = config.load_settings(
            {
                "BASE_HOME": str(Path(tmp) / "home"),
                "WORKSPACE_ROOT": tmp,
                "BASE_DEVICE": "laptop",
                "DEVICE_ONLY": "1",
                "CHECKER_URL": CHECKER,
                "LIGHT_SERIAL": "",
                "HEAVY_QUEUE": "0",
            }
        )
        router = stack.enter_context(respx.mock(assert_all_called=False))
        router.route(url__startswith=CHECKER + "/").mock(side_effect=null_model)
        router.route().mock(side_effect=_off_device)
        return run_eval.evaluate(settings, items, name=name, command="scripts.replay_null_names")


def leaked_rows(report) -> list[dict]:
    return [r for r in report.rows if r.get("leaked")]


def describe(report, *, name_shapes: bool) -> list[str]:
    leaks = leaked_rows(report)
    after = [r for r in leaks if not r.get("leak_kinds") and r.get("leak_kinds_after_approval")]
    lines = [
        f"name shapes {'on' if name_shapes else 'off'}: {report.n} items, {len(leaks)} leaks "
        f"({len(leaks) - len(after)} in what Muse got at once, {len(after)} after a simulated approval), "
        f"{report.errors} errors, {report.fallbacks} fallbacks"
    ]
    for r in leaks:
        kinds = r.get("leak_kinds") or r.get("leak_kinds_after_approval") or []
        lines.append(f"  {r['id']}: {r['decision']}, {r['status']}, {','.join(kinds)}")
    return lines


def _select(items: Iterable[dict], ids: str | None) -> list[dict]:
    if not ids:
        return list(items)
    wanted = {i.strip() for i in ids.split(",") if i.strip()}
    return [i for i in items if i["id"] in wanted]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m scripts.replay_null_names", description=__doc__.splitlines()[0]
    )
    p.add_argument("--set", required=True, type=Path, help="JSONL file of eval items")
    p.add_argument("--ids", help="comma-separated item ids to replay (default: all)")
    p.add_argument("--no-name-shapes", action="store_true", help="turn off the device-only name-shape check")
    args = p.parse_args(argv)
    if args.set.name in SEALED:
        p.error(f"{args.set.name} is sealed or holds the sealed set's items; do not score it")
    from eval import run_eval

    items = _select(run_eval.load_items(args.set), args.ids)
    shapes = not args.no_name_shapes
    report = replay(items, name_shapes=shapes)
    print("\n".join(describe(report, name_shapes=shapes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
