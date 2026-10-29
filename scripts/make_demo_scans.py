"""Draw the invented field trip forms in demo/forms/ as scan-like PNG images.

    uv run python -m scripts.make_demo_scans            # writes demo/forms/*.png

Every person, number and form here is invented. The guardians match demo/records/parent_contacts.md;
the SSN uses the 900 range and the card is the well-known Visa test number, as CLAUDE.md requires.
The pages are tilted a little and speckled so the local vision model reads them like real scans.
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "demo" / "forms"

TITLE = "Room 14 Field Trip Permission Form"
TRIP = "Riverbend Farm, Thursday Nov 12 (invented)"

FORMS = [
    {
        "file": "Dashiell Kowalczyk field trip form.png",
        "angle": 0.9,
        "fields": [
            ("Student", "Dashiell Kowalczyk"),
            ("Guardian", "Agnieszka Kowalczyk (mother)"),
            ("Guardian phone", "555-0109"),
            ("Date of birth", "DOB 1/22/2017"),
            ("SSN", "900-12-3456"),
            ("Trip fee ($8)", "Card 4111 1111 1111 1111"),
            ("Allergies or medical needs", "none"),
            ("Guardian signature", ""),
        ],
        "note": "Signature line left blank.",
    },
    {
        "file": "Abigail Thornbury field trip form.png",
        "angle": -0.6,
        "fields": [
            ("Student", "Abigail Thornbury"),
            ("Guardian", "Margaret Thornbury (mother)"),
            ("Guardian phone", "555-0101"),
            ("Trip fee ($8)", "paid by check"),
            ("Allergies or medical needs", "none"),
            ("Guardian signature", "Margaret Thornbury"),
        ],
        "note": "",
    },
    {
        "file": "Benjamin Adeyemi field trip form.png",
        "angle": 0.4,
        "fields": [
            ("Student", "Benjamin Adeyemi"),
            ("Guardian", "Tunde Adeyemi (father)"),
            ("Guardian phone", "555-0104"),
            ("Trip fee ($8)", "paid in cash"),
            ("Allergies or medical needs", "none"),
            ("Guardian signature", "Tunde Adeyemi"),
        ],
        "note": "",
    },
]

W, H, DPI = 8.5, 11.0, 110


def draw(form: dict, out: Path, seed: int) -> None:
    rng = random.Random(seed)
    fig = Figure(figsize=(W, H), dpi=DPI, facecolor="#f4f1e8")
    FigureCanvasAgg(fig)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis("off")
    angle = math.radians(form["angle"])
    cx, cy = W / 2, H / 2

    def rot(x: float, y: float) -> tuple[float, float]:
        dx, dy = x - cx, y - cy
        return cx + dx * math.cos(angle) - dy * math.sin(angle), cy + dx * math.sin(angle) + dy * math.cos(angle)

    def text(x: float, y: float, s: str, **kw) -> None:
        px, py = rot(x, y)
        ax.text(px, py, s, rotation=form["angle"], rotation_mode="anchor", color=kw.pop("color", "#2a2a2a"), **kw)

    def line(x0: float, y0: float, x1: float, y1: float, **kw) -> None:
        (ax0, ay0), (ax1, ay1) = rot(x0, y0), rot(x1, y1)
        ax.plot([ax0, ax1], [ay0, ay1], color=kw.pop("color", "#3a3a3a"), linewidth=kw.pop("lw", 0.9))

    text(0.9, 10.1, TITLE, fontsize=18, fontweight="bold", family="serif")
    text(0.9, 9.7, TRIP, fontsize=12, family="serif")
    line(0.9, 9.5, 7.6, 9.5, lw=1.4)
    y = 8.9
    for label, value in form["fields"]:
        text(0.9, y, f"{label}:", fontsize=12, family="serif")
        line(3.4, y - 0.08, 7.6, y - 0.08, lw=0.7)
        if value:
            text(3.5, y, value, fontsize=13, family="sans-serif", fontstyle="italic", color="#1d2b6b")
        y -= 0.75
    if form["note"]:
        text(0.9, y - 0.2, f"Office note: {form['note']}", fontsize=10, family="serif", color="#555555")
    text(0.9, 0.8, "Return to Room 14 by Monday. This form and everyone on it are invented.", fontsize=9, family="serif")
    # Scanner speckle: light gray dots, deterministic per form.
    xs = [rng.uniform(0, W) for _ in range(900)]
    ys = [rng.uniform(0, H) for _ in range(900)]
    ax.scatter(xs, ys, s=0.6, color="#9a9a9a", alpha=0.35, linewidths=0)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=DPI, facecolor=fig.get_facecolor())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    for i, form in enumerate(FORMS):
        path = args.out / form["file"]
        draw(form, path, seed=14 + i)
        print(f"wrote {path.relative_to(REPO) if path.is_relative_to(REPO) else path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
