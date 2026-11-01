"""Summarise a tegrastats log against the THERMAL_TEST.md thresholds.

Usage:
    uv run python thermal_log.py logs/open_air.log --label open-air
    uv run python thermal_log.py logs/core.log --label core --baseline logs/open_air.log

Reads only temperatures, GPU clock and board power from the log. Prints one markdown row
per run plus PASS, WARN or FAIL with the reasons.
"""

from __future__ import annotations

import argparse
import re
import statistics
from collections.abc import Iterable
from pathlib import Path

PASS_TJ_C = 85.0  # at or below this for the whole hour: pass
FAIL_TJ_C = 95.0  # at or above this at any point: fail (software throttling starts near 99 C)
MAX_RISE_OVER_OPEN_AIR_C = 15.0  # enclosed run may be at most this much hotter than open air
THROTTLE_RATIO = 0.90  # busy GPU clock in the last 10 min below 90% of the first 5 min
MIN_MINUTES = 55.0

TEMP_RE = re.compile(r"\b([A-Za-z]\w*)@(-?\d+(?:\.\d+)?)C\b")
GPU_RE = re.compile(r"GR3D_FREQ (\d+)%@\[?(\d+)")
POWER_RE = re.compile(r"VDD_IN (\d+)mW")


def parse_line(line: str) -> dict | None:
    """One tegrastats sample: temperatures by zone, GPU load and clock, board power."""
    temps = {zone.lower(): float(value) for zone, value in TEMP_RE.findall(line)}
    if not temps:
        return None
    gpu = GPU_RE.search(line)
    power = POWER_RE.search(line)
    return {
        "temps": temps,
        "gpu_load": int(gpu.group(1)) if gpu else None,
        "gpu_mhz": int(gpu.group(2)) if gpu else None,
        "vdd_in_mw": int(power.group(1)) if power else None,
    }


def hottest(sample: dict) -> float:
    """The junction temperature when tegrastats reports it, else the hottest zone."""
    temps = sample["temps"]
    return temps.get("tj", max(temps.values()))


def summarize(lines: Iterable[str], interval_s: float = 1.0) -> dict:
    samples = [s for s in (parse_line(line) for line in lines) if s]
    if not samples:
        raise ValueError("no tegrastats samples found")
    per_min = 60.0 / interval_s
    tj = [hottest(s) for s in samples]
    busy = [(i, s["gpu_mhz"]) for i, s in enumerate(samples) if s["gpu_load"] is not None and s["gpu_load"] >= 50]
    first = [mhz for i, mhz in busy if i < 5 * per_min]
    last = [mhz for i, mhz in busy if i >= len(samples) - 10 * per_min]
    clock_ratio = statistics.median(last) / statistics.median(first) if first and last else None
    power = [s["vdd_in_mw"] for s in samples if s["vdd_in_mw"] is not None]
    zones = sorted({z for s in samples for z in s["temps"]})
    return {
        "samples": len(samples),
        "minutes": len(samples) / per_min,
        "max_tj_c": max(tj),
        "minutes_over_pass": sum(1 for t in tj if t > PASS_TJ_C) / per_min,
        "max_by_zone": {z: max(s["temps"][z] for s in samples if z in s["temps"]) for z in zones},
        "gpu_clock_ratio": clock_ratio,
        "mean_power_w": statistics.mean(power) / 1000 if power else None,
    }


def verdict(summary: dict, baseline: dict | None = None) -> tuple[str, list[str]]:
    fails, warns = [], []
    if summary["minutes"] < MIN_MINUTES:
        fails.append(f"only {summary['minutes']:.0f} min logged, need {MIN_MINUTES:.0f}")
    if summary["max_tj_c"] >= FAIL_TJ_C:
        fails.append(f"peak {summary['max_tj_c']:.1f} C is at or above {FAIL_TJ_C:.0f} C")
    elif summary["max_tj_c"] > PASS_TJ_C:
        warns.append(f"peak {summary['max_tj_c']:.1f} C is above {PASS_TJ_C:.0f} C")
    ratio = summary["gpu_clock_ratio"]
    if ratio is not None and ratio < THROTTLE_RATIO:
        fails.append(f"GPU clock fell to {ratio:.0%} of the first five minutes (throttling)")
    if baseline is not None:
        rise = summary["max_tj_c"] - baseline["max_tj_c"]
        if rise > MAX_RISE_OVER_OPEN_AIR_C:
            fails.append(f"{rise:.1f} C hotter than open air, limit {MAX_RISE_OVER_OPEN_AIR_C:.0f} C")
    if fails:
        return "FAIL", fails + warns
    return ("WARN", warns) if warns else ("PASS", [])


def row(label: str, summary: dict, result: str, reasons: list[str]) -> str:
    ratio = summary["gpu_clock_ratio"]
    power = summary["mean_power_w"]
    return (
        f"| {label} | {summary['minutes']:.0f} | {summary['max_tj_c']:.1f} | {summary['minutes_over_pass']:.1f} | "
        f"{'n/a' if ratio is None else f'{ratio:.0%}'} | {'n/a' if power is None else f'{power:.1f}'} | "
        f"{result} | {'; '.join(reasons) or 'none'} |"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("log", type=Path)
    ap.add_argument("--label", default=None)
    ap.add_argument("--baseline", type=Path, default=None, help="open-air log to compare against")
    ap.add_argument("--interval", type=float, default=1.0, help="tegrastats interval in seconds")
    args = ap.parse_args(argv)
    summary = summarize(args.log.read_text().splitlines(), args.interval)
    baseline = summarize(args.baseline.read_text().splitlines(), args.interval) if args.baseline else None
    result, reasons = verdict(summary, baseline)
    print("| run | minutes | peak tj C | minutes over 85 C | GPU clock, last 10 min vs first 5 | mean board W | result | reasons |")
    print("|---|---|---|---|---|---|---|---|")
    print(row(args.label or args.log.stem, summary, result, reasons))
    print()
    print("Peak by zone: " + ", ".join(f"{z} {t:.1f} C" for z, t in summary["max_by_zone"].items()))
    return 0 if result != "FAIL" else 1


if __name__ == "__main__":
    raise SystemExit(main())
