"""Charts for the README and video, in the docs/UI_STYLE.md palette.

    uv run python -m scripts.charts [--reports eval/reports] [--theme light|dark]

five_nights.png: approval requests per day (bars) above agreement with the teacher after each
night (line), with leaks noted on every night. speed.png: the tables in eval/reports/*_speed.md.
Two measures never share one axis; each gets its own panel.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

from matplotlib import font_manager, rc_context
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure
from matplotlib.lines import Line2D

from eval.run_eval import REPORTS_DIR, display_path

PALETTES = {
    "light": {
        "bg": "#FFFFFF", "border": "#E3E6EB", "text": "#1C1E21", "text-2": "#65676B",
        "chart-1": "#7B8CF0", "chart-2": "#F2B880", "accent": "#1D63ED", "ok": "#2E9E5B", "danger": "#D93025",
    },
    "dark": {
        "bg": "#0F1115", "border": "#2A2F38", "text": "#E8EAED", "text-2": "#A0A6B0",
        "chart-1": "#8E9DF5", "chart-2": "#F5C597", "accent": "#4C8DFF", "ok": "#46C07A", "danger": "#F07167",
    },
}  # fmt: skip
SERIES = ("chart-1", "chart-2", "accent")  # fixed order, never cycled
FONTS = ("Inter", "Helvetica Neue", "Arial", "DejaVu Sans")
SPEED_COLUMNS = (
    re.compile(r"tok(en)?s?\s*/\s*s|tokens per second", re.I),
    re.compile(r"latency|\bms\b|seconds|\btime\b|\(s\)", re.I),
)


# ----- five nights -----


def read_nights(path: str | Path) -> list[dict]:
    with Path(path).open(newline="") as f:
        return list(csv.DictReader(f))


def five_nights_chart(rows: list[dict], out: str | Path, theme: str = "light") -> Path:
    pal = PALETTES[theme]
    nights = [int(r["night"]) for r in rows]
    days = [(int(r["night"]), int(float(r["approval_requests"]))) for r in rows if r["approval_requests"] != ""]
    agreement = [float(r["agreement"]) * 100 for r in rows]
    leaks = [int(float(r["leaks"])) for r in rows]
    with rc_context(_rc(pal)):
        fig = Figure(figsize=(8, 6.4), dpi=200, facecolor=pal["bg"])
        FigureCanvasAgg(fig)
        top, bottom = fig.subplots(2, 1, gridspec_kw={"hspace": 0.45})
        xlim = (min(nights) - 0.5, max(nights) + 0.5) if nights else (-0.5, 0.5)

        xs, ys = zip(*days, strict=True) if days else ((), ())
        top.bar(xs, ys, width=0.56, color=pal["chart-2"], zorder=2)
        for x, y in days:
            top.annotate(str(y), (x, y), xytext=(0, 4), textcoords="offset points", ha="center",
                         color=pal["text"], fontsize=11)  # fmt: skip
        top.set_ylim(0, max(ys or (1,)) * 1.25)
        _panel(top, pal, "Approval requests per day")
        top.set_xticks(list(xs), [f"Day {x}" for x in xs])
        top.set_xlim(*xlim)

        bottom.plot(nights, agreement, color=pal["chart-1"], linewidth=2, marker="o", markersize=8,
                    markeredgecolor=pal["bg"], markeredgewidth=2, zorder=3)  # fmt: skip
        for i in {0, len(nights) - 1}:
            bottom.annotate(f"{agreement[i]:.0f}%", (nights[i], agreement[i]), xytext=(0, 8),
                            textcoords="offset points", ha="center", color=pal["text"], fontsize=11)  # fmt: skip
        bottom.set_ylim(0, 112)
        bottom.set_yticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
        _panel(bottom, pal, "Agreement with the teacher after each night (holdout items)")
        bottom.set_xticks(nights, [f"Night {n}" for n in nights])
        bottom.set_xlim(*xlim)

        bad = [(n, k) for n, k in zip(nights, leaks, strict=True) if k]
        note = "Leaks: 0 on every night" if not bad else "Leaks: " + ", ".join(f"{k} on night {n}" for n, k in bad)
        fig.legend(
            handles=[Line2D([], [], linestyle="", marker="o", markersize=7, color=pal["danger" if bad else "ok"])],
            labels=[note], loc="lower left", bbox_to_anchor=(0.06, 0.0), frameon=False,
            labelcolor=pal["text-2"], fontsize=11,
        )  # fmt: skip
        count = max(nights) if nights else 0
        fig.text(0.06, 0.975, f"{_count_word(count)} nights of dreaming", fontsize=16, fontweight="bold",
                 color=pal["text"], va="top")  # fmt: skip
        fig.text(0.06, 0.935, "The simulated teacher answers each request; each night the router learns from it.",
                 fontsize=11, color=pal["text-2"], va="top")  # fmt: skip
        fig.subplots_adjust(left=0.08, right=0.97, top=0.84, bottom=0.12)
        return _save(fig, out, pal)


# ----- speed -----


def parse_tables(text: str) -> list[list[list[str]]]:
    """Markdown tables in `text`, each a list of rows of cells, separator rows dropped."""
    tables, current = [], []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("|") and s.endswith("|") and len(s) > 1:
            cells = [c.strip() for c in s[1:-1].split("|")]
            if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                current.append(cells)
        elif current:
            tables.append(current)
            current = []
    if current:
        tables.append(current)
    return tables


def read_speed(reports_dir: str | Path) -> list[tuple[str, str, list[tuple[str, float]]]]:
    """(series name, metric header, [(row label, value)]) for each *_speed.md file."""
    out = []
    for path in sorted(Path(reports_dir).glob("*_speed.md")):
        for table in parse_tables(path.read_text()):
            found = _speed_series(table)
            if found:
                out.append((path.stem.removesuffix("_speed").replace("_", " ").capitalize(), *found))
                break
    return out


def speed_chart(series: list[tuple[str, str, list[tuple[str, float]]]], out: str | Path, theme: str = "light"):
    pal = PALETTES[theme]
    series = series[: len(SERIES)]
    labels = list(dict.fromkeys(label for _, _, rows in series for label, _ in rows))
    height = 0.8 / len(series)
    with rc_context(_rc(pal)):
        fig = Figure(figsize=(8, 1.2 + 0.55 * len(labels) * len(series)), dpi=200, facecolor=pal["bg"])
        FigureCanvasAgg(fig)
        ax = fig.subplots()
        top_value = max(v for _, _, rows in series for _, v in rows) or 1
        for i, (name, _, rows) in enumerate(series):
            values = dict(rows)
            ys = [j + (i - (len(series) - 1) / 2) * height for j in range(len(labels))]
            vals = [values.get(label, 0.0) for label in labels]
            ax.barh(ys, vals, height=height * 0.85, color=pal[SERIES[i]], zorder=2, label=name)
            for y, v, label in zip(ys, vals, labels, strict=True):
                if label in values:
                    ax.annotate(_num(v), (v, y), xytext=(4, 0), textcoords="offset points", va="center",
                                color=pal["text"], fontsize=10)  # fmt: skip
        ax.set_yticks(range(len(labels)), labels)
        ax.invert_yaxis()
        ax.set_xlim(0, top_value * 1.18)
        _panel(ax, pal, series[0][1], grid_axis="x")
        handles = [Line2D([], [], linestyle="", marker="o", markersize=8, color=pal[SERIES[i]])
                   for i in range(len(series))]  # fmt: skip
        fig.legend(handles, [s[0] for s in series], loc="lower center", ncol=len(series), frameon=False,
                   labelcolor=pal["text-2"], fontsize=11)  # fmt: skip
        fig.text(0.02, 0.98, "Speed on each device", fontsize=16, fontweight="bold", color=pal["text"], va="top")
        fig.tight_layout(rect=(0, 0.08, 1, 0.92))
        return _save(fig, out, pal)


# ----- CLI -----


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m scripts.charts", description="Draw the report charts.")
    p.add_argument("--reports", type=Path, default=REPORTS_DIR, help="folder with nights.csv and *_speed.md")
    p.add_argument("--out", type=Path, help="folder for the PNGs (default: --reports)")
    p.add_argument("--theme", choices=sorted(PALETTES), default="light")
    args = p.parse_args(sys.argv[1:] if argv is None else argv)
    out = args.out or args.reports
    out.mkdir(parents=True, exist_ok=True)

    nights_csv = args.reports / "nights.csv"
    if nights_csv.is_file():
        print(f"Wrote {display_path(five_nights_chart(read_nights(nights_csv), out / 'five_nights.png', args.theme))}")
    else:
        print("No nights.csv yet; run python -m scripts.simulate_nights first.")
    series = read_speed(args.reports)
    if series:
        print(f"Wrote {display_path(speed_chart(series, out / 'speed.png', args.theme))}")
    else:
        print("No *_speed.md tables found; skipped speed.png.")
    return 0


# ----- helpers -----


def _speed_series(table: list[list[str]]) -> tuple[str, list[tuple[str, float]]] | None:
    if len(table) < 2:
        return None
    header = table[0]
    for pattern in SPEED_COLUMNS:
        col = next((i for i, h in enumerate(header) if i > 0 and pattern.search(h)), None)
        if col is None:
            continue
        rows = [(r[0], v) for r in table[1:] if len(r) > col and (v := _value(r[col])) is not None]
        if rows:
            return header[col], rows
    return None


def _value(cell: str) -> float | None:
    m = re.search(r"-?\d+(?:\.\d+)?", cell.replace(",", ""))
    return float(m.group()) if m else None


def _count_word(n: int) -> str:
    words = ("Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten")
    return words[n] if 0 <= n < len(words) else str(n)


def _num(v: float) -> str:
    return f"{v:.0f}" if v >= 100 else f"{v:.1f}"


def _font() -> str:
    names = {f.name for f in font_manager.fontManager.ttflist}
    return next((f for f in FONTS if f in names), "DejaVu Sans")


def _rc(pal: dict) -> dict:
    return {
        "font.family": _font(),
        "font.size": 12,
        "axes.facecolor": pal["bg"],
        "axes.edgecolor": pal["border"],
        "axes.labelcolor": pal["text-2"],
        "xtick.color": pal["text-2"],
        "ytick.color": pal["text-2"],
        "xtick.labelsize": 12,
        "ytick.labelsize": 12,
        "text.color": pal["text"],
    }


def _panel(ax, pal: dict, title: str, grid_axis: str = "y") -> None:
    ax.set_title(title, loc="left", fontsize=13, fontweight="bold", color=pal["text"], pad=10)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(pal["border"])
    ax.grid(axis=grid_axis, color=pal["border"], linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.tick_params(length=0)


def _save(fig: Figure, out: str | Path, pal: dict) -> Path:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, facecolor=pal["bg"])
    return out


if __name__ == "__main__":
    raise SystemExit(main())
