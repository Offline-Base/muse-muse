"""The tegrastats summariser on invented log lines."""

from __future__ import annotations

import thermal_log

LINE = (
    "10-27-2026 14:00:01 RAM 3121/7620MB (lfb 2x4MB) SWAP 0/3810MB (cached 0MB) "
    "CPU [35%@1728,22%@1728,30%@1728,28%@1728,25%@1728,31%@1728] EMC_FREQ 18%@3199 "
    "GR3D_FREQ {load}%@[{mhz}] NVENC off NVDEC off VIC off APE 200 cpu@58.1C soc2@55.6C "
    "soc0@56.3C gpu@60.4C tj@{tj}C soc1@55.9C VDD_IN 18234mW/17010mW VDD_SOC 4012mW/3900mW"
)


def log(minutes: int, tj, mhz=1020, load=99) -> list[str]:
    """One sample per second; tj and mhz may be callables of the sample index."""
    out = []
    for i in range(minutes * 60):
        t = tj(i) if callable(tj) else tj
        m = mhz(i) if callable(mhz) else mhz
        out.append(LINE.format(load=load, mhz=m, tj=f"{t:.1f}"))
    return out


def test_parse_line_reads_temps_gpu_and_power():
    sample = thermal_log.parse_line(LINE.format(load=99, mhz=1020, tj="61.2"))
    assert sample["temps"]["tj"] == 61.2
    assert sample["temps"]["gpu"] == 60.4
    assert sample["gpu_load"] == 99 and sample["gpu_mhz"] == 1020
    assert sample["vdd_in_mw"] == 18234
    assert thermal_log.parse_line("no temps here") is None


def test_cool_hour_passes():
    summary = thermal_log.summarize(log(60, 70.0))
    assert round(summary["minutes"]) == 60
    assert thermal_log.verdict(summary) == ("PASS", [])


def test_hot_run_fails_and_warm_run_warns():
    assert thermal_log.verdict(thermal_log.summarize(log(60, 96.0)))[0] == "FAIL"
    assert thermal_log.verdict(thermal_log.summarize(log(60, 88.0)))[0] == "WARN"


def test_falling_gpu_clock_counts_as_throttling():
    summary = thermal_log.summarize(log(60, 80.0, mhz=lambda i: 1020 if i < 40 * 60 else 612))
    result, reasons = thermal_log.verdict(summary)
    assert result == "FAIL"
    assert any("throttling" in r for r in reasons)


def test_short_run_and_big_rise_over_open_air_fail():
    assert thermal_log.verdict(thermal_log.summarize(log(20, 60.0)))[0] == "FAIL"
    baseline = thermal_log.summarize(log(60, 60.0))
    enclosed = thermal_log.summarize(log(60, 80.0))
    result, reasons = thermal_log.verdict(enclosed, baseline)
    assert result == "FAIL" and any("open air" in r for r in reasons)


def test_cli_prints_a_markdown_row(tmp_path, capsys):
    path = tmp_path / "core.log"
    path.write_text("\n".join(log(60, 72.0)))
    assert thermal_log.main([str(path), "--label", "core"]) == 0
    out = capsys.readouterr().out
    assert "| core | 60 | 72.0 |" in out and "PASS" in out
