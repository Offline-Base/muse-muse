"""Draw 24 invented page images with ground-truth boxes for the SAM region checks.

    uv run python -m scripts.make_sam_pages            # writes eval/sam_pages/*.png and truth.json

Every person, number, school and clinic here is invented. Faces are simple geometric cartoons
(never photos), signatures are drawn pen strokes or slanted text, every ID card and badge carries
SAMPLE, and numbers follow CLAUDE.md: 555-01xx phones, example.com and example.org emails, SSNs in
the 900 range and the Visa test card. Each page is drawn upright, region by region on its own
layer, then tilted a little like a scan. A region's box is the bounding box of its own layer after
the same tilt, so the boxes follow the drawing exactly. Seeds are fixed: a rerun writes the same
bytes. Pillow comes with matplotlib, and the fonts are the DejaVu files matplotlib ships.

truth.json lists, per page: file, split (dev or test), layout, width, height, regions
[{kind, box: [x1, y1, x2, y2]}] (pixels, x2 and y2 exclusive) and signature_names (names a reader
could make out of a drawn signature; a scribble has none).
"""

from __future__ import annotations

import argparse
import functools
import json
import random
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib
from PIL import Image, ImageChops, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "eval" / "sam_pages"
COMMAND = "uv run python -m scripts.make_sam_pages"
KINDS = ("face", "signature", "id_card", "barcode")
SEED = 3101

W, H = 850, 1100  # 8.5 x 11 in at 100 DPI
PAPER = (244, 241, 232, 255)
INK = (42, 42, 42, 255)
PEN_BLUE = (29, 43, 107, 255)
PEN_BLACK = (24, 24, 28, 255)
SAMPLE_RED = (196, 30, 40, 120)
FONTS = Path(matplotlib.get_data_path()) / "fonts" / "ttf"

SKINS = [(255, 224, 189), (241, 194, 150), (224, 172, 105), (198, 134, 66), (141, 85, 36), (92, 58, 30)]
HAIRS = [(35, 25, 20), (90, 56, 37), (183, 128, 64), (230, 200, 120), (120, 120, 125), (160, 60, 40)]
SHIRTS = [(70, 110, 170), (200, 90, 80), (90, 150, 100), (220, 170, 60), (130, 90, 160)]
CARD_COLORS = [(36, 92, 140), (130, 40, 60), (40, 110, 80), (90, 70, 140)]


@functools.cache
def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


SERIF, SERIF_BOLD, SERIF_ITALIC = "DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSerif-Italic.ttf"
SANS, SANS_BOLD, SANS_OBLIQUE, MONO = "DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSansMono.ttf"


@dataclass
class Region:
    kind: str
    mask: Image.Image
    texts: list[str] = field(default_factory=list)


@dataclass
class Rendered:
    image: Image.Image
    regions: list[tuple[str, list[int], list[str]]]  # (kind, box, texts drawn inside that region)
    texts: list[str]  # every string printed or written on the page


class Pen:
    """Draws on one transparent layer; strings it writes are kept for the tests."""

    def __init__(self, page: Page, layer: Image.Image, region: Region | None):
        self.page, self.img, self.region = page, layer, region
        self.draw = ImageDraw.Draw(layer)

    def note(self, s: str) -> None:
        self.page.texts.append(s)
        if self.region is not None:
            self.region.texts.append(s)

    def text(self, xy: tuple[int, int], s: str, name: str = SERIF, size: int = 18, fill=INK) -> None:
        self.draw.text(xy, s, font=font(name, size), fill=fill, anchor="ls")
        self.note(s)

    def tile(self, tile: Image.Image, xy: tuple[int, int]) -> None:
        self.img.alpha_composite(tile, xy)


class Page:
    def __init__(self, seed: int):
        self.rng = random.Random(seed)
        self.img = Image.new("RGBA", (W, H), PAPER)
        self.regions: list[Region] = []
        self.texts: list[str] = []

    def region(self, kind: str) -> Region:
        assert kind in KINDS
        r = Region(kind, Image.new("L", (W, H), 0))
        self.regions.append(r)
        return r

    @contextmanager
    def layer(self, region: Region | None = None):
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        yield Pen(self, layer, region)
        self.img = Image.alpha_composite(self.img, layer)
        if region is not None:
            region.mask = ImageChops.lighter(region.mask, layer.getchannel("A"))

    def finish(self, angle: float) -> Rendered:
        img = self.img.convert("RGB").rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=PAPER[:3])
        draw = ImageDraw.Draw(img)
        for _ in range(700):  # scanner speckle, after the tilt so it is never part of a region
            x, y = self.rng.randrange(W), self.rng.randrange(H)
            g = self.rng.randrange(150, 200)
            draw.point((x, y), fill=(g, g, g))
        regions = []
        for r in self.regions:
            mask = r.mask.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=0)
            box = mask.point(lambda v: 255 if v >= 16 else 0).getbbox()
            assert box is not None, f"empty {r.kind} region"
            regions.append((r.kind, list(box), list(r.texts)))
        return Rendered(img, regions, list(self.texts))


# -- drawn pieces --------------------------------------------------------------------------------


def bezier(p0, p1, p2, p3, n: int = 24) -> list[tuple[float, float]]:
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return pts


def signature_name(pen: Pen, x: int, base: int, name: str, size: int = 34, ink=PEN_BLUE) -> None:
    """A name in slanted italic with a pen flourish under it, its baseline near `base`."""
    rng = pen.page.rng
    f = font(SERIF_ITALIC, size)
    left, top, right, bottom = f.getbbox(name)
    tw, th, pad = right - left, bottom - top, 8
    shear = 0.28
    flat = Image.new("RGBA", (tw + 2 * pad + size // 2, th + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(flat)
    at = float(pad - left)
    for ch in name:  # one letter at a time, each a little off the line, like a hand
        d.text((round(at), round(pad - top + rng.uniform(-2.5, 2.5))), ch, font=f, fill=ink)
        at += f.getlength(ch) * rng.uniform(0.96, 1.04)
    sw = flat.width + int(shear * flat.height)
    slanted = flat.transform((sw, flat.height), Image.Transform.AFFINE,
                             (1, shear, -shear * flat.height, 0, 1, 0), resample=Image.Resampling.BICUBIC)
    tile = slanted.rotate(rng.uniform(-4, 4), resample=Image.Resampling.BICUBIC, expand=True)
    pen.tile(tile, (x, base - tile.height + pad + 4))
    y = base + 6
    end = x + tile.width - 10
    pen.draw.line(bezier((x + 4, y), (x + tw * 0.3, y + 10), (end - 40, y - 12), (end, y - 2)),
                  fill=ink, width=2, joint="curve")
    pen.note(name)


def signature_scribble(pen: Pen, x: int, base: int, width: int = 220, ink=PEN_BLACK) -> None:
    """Pen loops with no readable letters."""
    rng = pen.page.rng
    pts: list[tuple[float, float]] = []
    cx = x
    for _ in range(6):
        step = width / 6
        p0 = (cx, base - rng.uniform(0, 14))
        p3 = (cx + step, base - rng.uniform(0, 14))
        p1 = (cx + step * rng.uniform(0.6, 1.4), base - rng.uniform(35, 62))
        p2 = (cx - step * rng.uniform(0.0, 0.5), base + rng.uniform(-4, 10))
        pts.extend(bezier(p0, p1, p2, p3, 14))
        cx += step
    pen.draw.line(pts, fill=ink, width=2, joint="curve")
    pen.draw.line(bezier((x - 6, base + 8), (x + width * 0.3, base + 16), (x + width * 0.7, base - 2),
                         (x + width + 10, base + 4)), fill=ink, width=2, joint="curve")


def face(pen: Pen, cx: int, cy: int, r: int) -> None:
    """A clearly cartoon face: flat shapes, dot eyes, an arc smile."""
    rng, d = pen.page.rng, pen.draw
    skin, hair = rng.choice(SKINS), rng.choice(HAIRS)
    style = rng.choice(["short", "long", "bun", "curly", "none"])
    dark = (40, 30, 30)
    if style == "long":
        d.rounded_rectangle([cx - r * 1.12, cy - r * 1.05, cx + r * 1.12, cy + r * 1.15], radius=int(r * 0.6), fill=hair)
    d.ellipse([cx - r * 1.08, cy - r * 0.2, cx - r * 0.78, cy + r * 0.25], fill=skin, outline=dark)
    d.ellipse([cx + r * 0.78, cy - r * 0.2, cx + r * 1.08, cy + r * 0.25], fill=skin, outline=dark)
    d.ellipse([cx - r * 0.9, cy - r, cx + r * 0.9, cy + r * 1.05], fill=skin, outline=dark, width=2)
    if style in ("short", "long", "bun"):
        d.chord([cx - r * 0.95, cy - r * 1.12, cx + r * 0.95, cy + r * 0.25], 180, 360, fill=hair)
    if style == "bun":
        d.ellipse([cx - r * 0.35, cy - r * 1.55, cx + r * 0.35, cy - r * 0.85], fill=hair)
    if style == "curly":
        for i in range(7):
            ax = cx - r * 0.85 + i * r * 0.28
            d.ellipse([ax - r * 0.22, cy - r * 1.15, ax + r * 0.22, cy - r * 0.7], fill=hair)
    for side in (-1, 1):
        ex, ey = cx + side * r * 0.36, cy - r * 0.05
        d.ellipse([ex - r * 0.16, ey - r * 0.12, ex + r * 0.16, ey + r * 0.12], fill=(255, 255, 255), outline=dark)
        d.ellipse([ex - r * 0.07, ey - r * 0.07, ex + r * 0.07, ey + r * 0.07], fill=dark)
        d.line([ex - r * 0.18, ey - r * 0.25, ex + r * 0.16, ey - r * 0.3], fill=dark, width=2)
    d.line([cx, cy + r * 0.05, cx - r * 0.08, cy + r * 0.3, cx + r * 0.04, cy + r * 0.32], fill=dark, width=2)
    d.arc([cx - r * 0.4, cy + r * 0.2, cx + r * 0.4, cy + r * 0.7], 20, 160, fill=dark, width=3)
    if rng.random() < 0.3:  # glasses
        for side in (-1, 1):
            ex = cx + side * r * 0.36
            d.ellipse([ex - r * 0.26, cy - r * 0.25, ex + r * 0.26, cy + r * 0.17], outline=dark, width=2)
        d.line([cx - r * 0.1, cy - r * 0.05, cx + r * 0.1, cy - r * 0.05], fill=dark, width=2)


def shoulders(pen: Pen, cx: int, top: int, r: int, bottom: int) -> None:
    color = pen.page.rng.choice(SHIRTS)
    pen.draw.rounded_rectangle([cx - r * 1.5, top, cx + r * 1.5, bottom + r], radius=int(r * 0.7), fill=color)


def barcode(pen: Pen, x: int, y: int, height: int, caption: str, module: int = 2, bars: int = 34) -> None:
    rng = pen.page.rng
    pattern = [1, 1, 1] + [rng.randint(1, 4) for _ in range(bars * 2)] + [1, 1, 1]
    cx = x
    for i, width in enumerate(pattern):
        if i % 2 == 0:
            pen.draw.rectangle([cx, y, cx + width * module - 1, y + height - 1], fill=PEN_BLACK)
        cx += width * module
    pen.text((x, y + height + 16), caption, MONO, 14, PEN_BLACK)


def qr_block(pen: Pen, x: int, y: int, module: int = 4, n: int = 25) -> None:
    rng, d = pen.page.rng, pen.draw
    d.rectangle([x - module, y - module, x + (n + 1) * module - 1, y + (n + 1) * module - 1], fill=(255, 255, 255))
    for row in range(n):
        for col in range(n):
            if rng.random() < 0.5:
                d.rectangle([x + col * module, y + row * module, x + (col + 1) * module - 1,
                             y + (row + 1) * module - 1], fill=PEN_BLACK)
    for fx, fy in ((0, 0), (n - 7, 0), (0, n - 7)):
        for size, color in ((7, PEN_BLACK), (5, (255, 255, 255)), (3, PEN_BLACK)):
            off = (7 - size) // 2
            d.rectangle([x + (fx + off) * module, y + (fy + off) * module, x + (fx + off + size) * module - 1,
                         y + (fy + off + size) * module - 1], fill=color)


def stacked_code(pen: Pen, x: int, y: int, width: int, rows: int = 9, row_h: int = 7) -> None:
    """A PDF417-looking block: rows of random bars."""
    rng = pen.page.rng
    for row in range(rows):
        cx = x
        while cx < x + width - 8:
            w = rng.randint(1, 4) * 2
            if rng.random() < 0.55:
                pen.draw.rectangle([cx, y + row * row_h, min(cx + w, x + width) - 1, y + (row + 1) * row_h - 2],
                                   fill=PEN_BLACK)
            cx += w


def sample_mark(pen: Pen, box: tuple[int, int, int, int], size: int) -> None:
    """A diagonal translucent SAMPLE across a card, inside its box."""
    x1, y1, x2, y2 = box
    f = font(SANS_BOLD, size)
    left, top, right, bottom = f.getbbox("SAMPLE")
    flat = Image.new("RGBA", (right - left + 8, bottom - top + 8), (0, 0, 0, 0))
    ImageDraw.Draw(flat).text((4 - left, 4 - top), "SAMPLE", font=f, fill=SAMPLE_RED)
    tile = flat.rotate(22, resample=Image.Resampling.BICUBIC, expand=True)
    assert tile.width < x2 - x1 and tile.height < y2 - y1, "SAMPLE must fit inside the card"
    pen.tile(tile, ((x1 + x2 - tile.width) // 2, (y1 + y2 - tile.height) // 2))
    pen.note("SAMPLE")


def card_body(pen: Pen, box, color, header: str, sub: str) -> None:
    x1, y1, x2, y2 = box
    pen.draw.rounded_rectangle(box, radius=14, fill=(252, 252, 250), outline=(120, 120, 120), width=2)
    pen.draw.rounded_rectangle([x1, y1, x2, y1 + 62], radius=14, fill=color)
    pen.draw.rectangle([x1, y1 + 40, x2, y1 + 62], fill=color)
    pen.text((x1 + 18, y1 + 30), header, SANS_BOLD, 20, (255, 255, 255, 255))
    pen.text((x1 + 18, y1 + 54), sub, SANS, 15, (255, 255, 255, 255))


def photo_slot(card_pen: Pen, slot: tuple[int, int, int, int]) -> tuple[int, int, int]:
    """A photo slot on a card (part of the card). Returns where its face goes: (cx, cy, r)."""
    x1, y1, x2, y2 = slot
    card_pen.draw.rectangle(slot, fill=(206, 222, 236), outline=(140, 140, 140))
    cx, r = (x1 + x2) // 2, (x2 - x1) // 4
    cy = y1 + (y2 - y1) * 2 // 5
    shoulders(card_pen, cx, cy + int(r * 1.15), r, y2 - r - 2)
    card_pen.draw.rectangle(slot, outline=(140, 140, 140))
    return cx, cy, r


def add_face(page: Page, where: tuple[int, int, int]) -> None:
    """A face as its own region, drawn over whatever is already on the page."""
    with page.layer(page.region("face")) as pen:
        face(pen, *where)


def name_size(name: str, size: int) -> int:
    return size if len(name) <= 18 else size - 4


# -- page layouts -------------------------------------------------------------------------------


def form_header(pen: Pen, title: str, sub: str) -> None:
    pen.text((80, 90), title, SERIF_BOLD, 28)
    pen.text((80, 126), sub, SERIF, 17)
    pen.draw.line([80, 146, 770, 146], fill=INK, width=2)


def field_rows(pen: Pen, rows: list[tuple[str, str]], y: int = 200, step: int = 60, x_value: int = 340,
               x_end: int = 770) -> int:
    for label, value in rows:
        pen.text((80, y), f"{label}:", SERIF, 18)
        pen.draw.line([x_value - 10, y + 6, x_end, y + 6], fill=INK, width=1)
        if value:
            pen.text((x_value, y), value, SANS_OBLIQUE, 20, PEN_BLUE)
        y += step
    return y


def footer(pen: Pen, s: str) -> None:
    pen.text((80, 1040), s, SERIF, 13)


def signed_line(page: Page, pen: Pen, y: int, label: str, signature: dict | None, x: int = 350) -> None:
    pen.text((80, y), f"{label}:", SERIF, 18)
    pen.draw.line([x - 20, y + 6, 770, y + 6], fill=INK, width=1)
    if not signature:
        return
    with page.layer(page.region("signature")) as sig:
        if signature["style"] == "name":
            signature_name(sig, x, y, signature["name"], ink=signature.get("ink", PEN_BLUE))
        else:
            signature_scribble(sig, x + 10, y)


def field_trip(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        form_header(pen, "Room 14 Field Trip Permission Form", "Riverbend Farm, Thursday Nov 12 (invented)")
        y = field_rows(pen, spec["fields"])
        signed_line(page, pen, y + 20, "Guardian signature", spec.get("signature"))
        pen.text((80, y + 100), "Date:", SERIF, 18)
        pen.text((340, y + 100), "Nov 3", SANS_OBLIQUE, 20, PEN_BLUE)
        footer(pen, "Return to Room 14 by Monday. This form and everyone on it are invented.")


def student_ids(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        pen.text((80, 90), "Student ID cards, office copy", SERIF_BOLD, 26)
        pen.text((80, 124), "Quillmere Elementary, scanned for the class file (invented)", SERIF, 16)
    for i, student in enumerate(spec["students"]):
        x1, y1 = 120 + i * 40, 190 + i * 420
        box = (x1, y1, x1 + 560, y1 + 352)
        card = page.region("id_card")
        with page.layer(card) as pen:
            card_body(pen, box, CARD_COLORS[(spec["seed"] + i) % len(CARD_COLORS)], "QUILLMERE ELEMENTARY",
                      "Student ID  |  SAMPLE")
            where = photo_slot(pen, (x1 + 24, y1 + 86, x1 + 184, y1 + 286))
            pen.text((x1 + 210, y1 + 120), student["name"], SANS_BOLD, name_size(student["name"], 24))
            pen.text((x1 + 210, y1 + 154), f"Grade {student['grade']}  |  Room 14", SANS, 17)
            pen.text((x1 + 210, y1 + 184), f"ID {student['id']}", SANS, 17)
            pen.text((x1 + 210, y1 + 214), "Valid 2026-27", SANS, 15)
        add_face(page, where)
        with page.layer(page.region("barcode")) as pen:
            barcode(pen, x1 + 210, y1 + 238, 52, f"*{student['id']}*")
        with page.layer(card) as pen:
            sample_mark(pen, box, 84)
    with page.layer() as pen:
        footer(pen, "Copies for the office file only. Every card and person on this page is invented.")


def state_id(page: Page, spec: dict) -> None:
    person = spec["person"]
    with page.layer() as pen:
        pen.text((80, 90), spec["title"], SERIF_BOLD, 26)
        pen.text((80, 124), "Front and back, photocopied at the front desk (invented)", SERIF, 16)
    x1, y1 = 140, 190
    front = (x1, y1, x1 + 600, y1 + 378)
    card = page.region("id_card")
    with page.layer(card) as pen:
        card_body(pen, front, (60, 80, 110), "SAMPLE STATE  |  IDENTIFICATION CARD", "Not a real ID. Invented for tests.")
        where = photo_slot(pen, (x1 + 24, y1 + 86, x1 + 194, y1 + 300))
        pen.text((x1 + 220, y1 + 112), person["name"], SANS_BOLD, name_size(person["name"], 24))
        pen.text((x1 + 220, y1 + 144), person["dob"], SANS, 17)
        pen.text((x1 + 220, y1 + 172), person["address"], SANS, 17)
        pen.text((x1 + 220, y1 + 200), f"ID No. {person['number']}", SANS, 17)
        pen.text((x1 + 220, y1 + 236), "Signature", SANS, 12)
    add_face(page, where)
    with page.layer(page.region("signature")) as pen:
        signature_name(pen, x1 + 222, y1 + 300, person["signature"], size=30, ink=PEN_BLACK)
    with page.layer(card) as pen:
        sample_mark(pen, front, 96)
    back_y = y1 + 430
    back = (x1, back_y, x1 + 600, back_y + 378)
    card2 = page.region("id_card")
    with page.layer(card2) as pen:
        card_body(pen, back, (60, 80, 110), "SAMPLE STATE  |  BACK", "Invented card back")
        pen.text((x1 + 24, back_y + 104), "Restrictions: none", SANS, 16)
        pen.text((x1 + 24, back_y + 130), "Organ donor: no", SANS, 16)
    with page.layer(page.region("barcode")) as pen:
        stacked_code(pen, x1 + 24, back_y + 160, 552)
    with page.layer(card2) as pen:
        sample_mark(pen, back, 96)
    with page.layer() as pen:
        footer(pen, "Every name, number and card on this page is invented.")


def staff_badge(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        form_header(pen, "Staff Badge Replacement Request", "Quillmere Elementary front office (invented)")
        field_rows(pen, [("Staff member", spec["name"]), ("Room or department", spec["dept"]),
                         ("Reason", spec["reason"])], y=200)
        pen.text((80, 420), "Copy of the current badge:", SERIF, 18)
    x1, y1 = 260, 450
    box = (x1, y1, x1 + 330, y1 + 500)
    card = page.region("id_card")
    with page.layer(card) as pen:
        pen.draw.rounded_rectangle(box, radius=16, fill=(252, 252, 250), outline=(120, 120, 120), width=2)
        pen.draw.rounded_rectangle([x1 + 140, y1 + 14, x1 + 190, y1 + 26], radius=6, fill=(200, 200, 200))
        pen.draw.rectangle([x1, y1 + 40, x1 + 330, y1 + 92], fill=CARD_COLORS[spec["seed"] % len(CARD_COLORS)])
        pen.text((x1 + 22, y1 + 76), "STAFF  |  SAMPLE", SANS_BOLD, 22, (255, 255, 255, 255))
        where = photo_slot(pen, (x1 + 85, y1 + 110, x1 + 245, y1 + 300))
        pen.text((x1 + 22, y1 + 336), spec["name"], SANS_BOLD, 22)
        pen.text((x1 + 22, y1 + 364), spec["dept"], SANS, 16)
    add_face(page, where)
    with page.layer(page.region("barcode")) as pen:
        qr_block(pen, x1 + 22, y1 + 382, module=4, n=25)
    with page.layer(card) as pen:
        sample_mark(pen, box, 70)
    with page.layer() as pen:
        signed_line(page, pen, 1000, "Requested by", {"style": "scribble"})
        footer(pen, "Every name and badge on this page is invented.")


def clinic_intake(page: Page, spec: dict) -> None:
    p = spec["patient"]
    with page.layer() as pen:
        form_header(pen, "New Patient Intake", "Brightwater Family Clinic (invented)")
        y = field_rows(pen, [("Patient name", p["name"]), ("Date of birth", p["dob"]), ("Phone", p["phone"]),
                             ("Email", p["email"]), ("Reason for visit", p["reason"])], y=200, x_value=290,
                       x_end=575)
        where = photo_slot(pen, (600, 170, 770, 380))
        pen.text((604, 400), "Patient photo", SERIF, 13)
    add_face(page, where)
    with page.layer() as pen:
        signed_line(page, pen, y + 30, "Patient signature", {"style": "name", "name": p["signature"]}, x=320)
        pen.text((80, y + 110), "Insurance card (copy):", SERIF, 18)
    x1, y1 = 140, y + 140
    box = (x1, y1, x1 + 520, y1 + 300)
    card = page.region("id_card")
    with page.layer(card) as pen:
        card_body(pen, box, (40, 110, 110), "SAMPLE HEALTH PLAN", "Member card, invented")
        pen.text((x1 + 24, y1 + 104), p["name"], SANS_BOLD, 20)
        pen.text((x1 + 24, y1 + 134), f"Member {p['member']}", SANS, 16)
        pen.text((x1 + 24, y1 + 160), "Group EXAMPLE-01", SANS, 16)
    with page.layer(page.region("barcode")) as pen:
        barcode(pen, x1 + 24, y1 + 186, 50, p["member"], bars=30)
    with page.layer(card) as pen:
        sample_mark(pen, box, 80)
    with page.layer() as pen:
        footer(pen, "Every patient, number and card on this page is invented.")


def newsletter(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        form_header(pen, spec["title"], "Room 14, Quillmere Elementary (invented)")
        y = 190
        for line in spec["lines"]:
            pen.text((80, y), line, SERIF, 17)
            y += 28
        pen.draw.rectangle([110, 330, 740, 640], fill=(222, 234, 214), outline=INK, width=2)
        pen.draw.rectangle([110, 560, 740, 640], fill=(150, 120, 80))
    xs = [190 + i * (480 // max(1, len(spec["kids"]) - 1)) for i in range(len(spec["kids"]))]
    for x in xs:
        with page.layer() as pen:
            shoulders(pen, x, 480, 40, 600)
            pen.draw.rectangle([108, 641, 742, 700], fill=PAPER)
            pen.draw.rectangle([110, 330, 740, 640], outline=INK, width=2)
        with page.layer(page.region("face")) as pen:
            face(pen, x, 430, 42)
    with page.layer() as pen:
        pen.text((110, 668), spec["caption"], SERIF_ITALIC, 15)
        y = 730
        for line in spec["more"]:
            pen.text((80, y), line, SERIF, 17)
            y += 28
        pen.text((80, y + 30), "Thank you,", SERIF, 17)
    with page.layer(page.region("signature")) as pen:
        signature_name(pen, 90, y + 90, spec["signature"], size=30)
    with page.layer() as pen:
        pen.text((80, y + 130), "Room 14 teacher", SERIF, 15)
        footer(pen, "Drawn pictures only. Everyone in this newsletter is invented.")


def office_form(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        form_header(pen, spec["title"], spec["sub"])
        y = field_rows(pen, spec["fields"])
        signed_line(page, pen, y + 20, "Guardian signature", spec["signature"])
        pen.text((80, y + 110), spec["code_label"], SERIF, 18)
    with page.layer(page.region("barcode")) as pen:
        if spec["code"] == "qr":
            qr_block(pen, 340, y + 140, module=5, n=25)
        else:
            barcode(pen, 340, y + 140, 70, spec["code_caption"], module=3, bars=30)
    with page.layer() as pen:
        footer(pen, "Every name and number on this form is invented.")


def handout(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        form_header(pen, spec["title"], "Room 14 reading handout (invented)")
        y = 200
        for para in spec["paragraphs"]:
            for line in para:
                pen.text((80, y), line, SERIF, 18)
                y += 30
            y += 24


def bar_chart(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        form_header(pen, "Class Reading Minutes by Week", "Room 14 totals, invented numbers")
        x0, y0 = 140, 820
        pen.draw.line([x0, 220, x0, y0], fill=INK, width=2)
        pen.draw.line([x0, y0, 760, y0], fill=INK, width=2)
        for i, minutes in enumerate(spec["values"]):
            top = y0 - minutes // 4
            pen.draw.rectangle([x0 + 30 + i * 100, top, x0 + 100 + i * 100, y0 - 1], fill=CARD_COLORS[i % 4])
            pen.text((x0 + 40 + i * 100, y0 + 30), f"Wk {i + 1}", SANS, 15)
            pen.text((x0 + 36 + i * 100, top - 10), str(minutes), SANS, 15)
        for v in range(0, 2401, 600):
            pen.text((70, y0 - v // 4 + 5), str(v), SANS, 13)


def schedule(page: Page, spec: dict) -> None:
    with page.layer() as pen:
        form_header(pen, "Room 14 Weekly Schedule", "Fall term, invented")
        x0, y0, cw, rh = 80, 200, 128, 90
        for c, day in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri"]):
            pen.text((x0 + 90 + c * cw, y0 + 30), day, SANS_BOLD, 16)
        for r, (time, block) in enumerate(spec["rows"]):
            y = y0 + 50 + r * rh
            pen.draw.line([x0, y, 770, y], fill=INK, width=1)
            pen.text((x0, y + 40), time, SANS, 15)
            for c in range(5):
                words = block[c % len(block)].split(" ", 1)
                for k, word in enumerate(words):
                    pen.text((x0 + 90 + c * cw, y + 34 + k * 20), word, SANS, 14)


def shapes_sheet(page: Page, spec: dict) -> None:
    rng = page.rng
    with page.layer() as pen:
        form_header(pen, "Shapes Worksheet", "Count the circles, squares and triangles (invented)")
        for i in range(12):
            cx, cy = 150 + (i % 4) * 180, 300 + (i // 4) * 220
            kind = ["circle", "square", "triangle", "rings"][rng.randrange(4)]
            if kind == "circle":
                pen.draw.ellipse([cx - 55, cy - 55, cx + 55, cy + 55], outline=INK, width=3)
            elif kind == "square":
                pen.draw.rectangle([cx - 50, cy - 50, cx + 50, cy + 50], outline=INK, width=3)
            elif kind == "triangle":
                pen.draw.polygon([(cx, cy - 60), (cx - 55, cy + 45), (cx + 55, cy + 45)], outline=INK, width=3)
            else:
                for rr in (55, 35, 15):
                    pen.draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=INK, width=2)
        pen.text((80, 980), "How many circles did you count? ______", SERIF, 18)


LAYOUTS = {
    "field_trip": field_trip, "student_ids": student_ids, "state_id": state_id, "staff_badge": staff_badge,
    "clinic_intake": clinic_intake, "newsletter": newsletter, "office_form": office_form,
    "handout": handout, "bar_chart": bar_chart, "schedule": schedule, "shapes": shapes_sheet,
}


# -- the 24 pages --------------------------------------------------------------------------------


def trip(student: str, guardian: str, phone: str, signature: dict | None, extra=()) -> dict:
    fields = [("Student", student), ("Guardian", guardian), ("Guardian phone", phone), *extra,
              ("Allergies or medical needs", "none")]
    return {"layout": "field_trip", "fields": fields, "signature": signature}


PAGES: list[dict] = [
    # Field trip forms. Case (a): the signer is invented, appears nowhere else on the page and is not on
    # the roster. Case (b): a roster surname misspelled in the signature (one letter dropped).
    {"file": "p01_field_trip.png", "split": "dev", **trip(
        "Jasper Ellingsworth", "stepfather", "555-0161", {"style": "name", "name": "Thaddeus Wrenfield"},
        [("Trip fee ($8)", "paid in cash")])},
    {"file": "p02_field_trip.png", "split": "test", **trip(
        "Camila Restrepo", "aunt", "555-0162", {"style": "name", "name": "Marisol Quenneville"},
        [("Date of birth", "DOB 2/14/2017")])},
    {"file": "p03_field_trip.png", "split": "dev", **trip(
        "Dashiell Kowalczyk", "grandmother", "555-0163", {"style": "name", "name": "Halina Kowalcyk"},
        [("SSN", "900-41-7788")])},
    {"file": "p04_field_trip.png", "split": "test", **trip(
        "Priyanka Raghunathan", "father", "555-0164", {"style": "name", "name": "Rohan Ragunathan"},
        [("Trip fee ($8)", "Card 4111 1111 1111 1111")])},
    {"file": "p05_field_trip.png", "split": "dev", **trip(
        "Gideon Pakalnis", "mother", "555-0165", {"style": "scribble"})},
    {"file": "p06_field_trip.png", "split": "test", **trip(
        "Zainab Haddad", "father", "555-0166", None, [("Trip fee ($8)", "paid by check")])},
    # Student ID cards, two per page.
    {"file": "p07_student_ids.png", "split": "dev", "layout": "student_ids", "students": [
        {"name": "Abigail Thornbury", "grade": 4, "id": "S401127"},
        {"name": "Benjamin Adeyemi", "grade": 4, "id": "S401138"}]},
    {"file": "p08_student_ids.png", "split": "test", "layout": "student_ids", "students": [
        {"name": "Esperanza Moreno-Baptiste", "grade": 4, "id": "S401169"},
        {"name": "Farhan Siddiqui", "grade": 4, "id": "S401173"}]},
    {"file": "p09_student_ids.png", "split": "dev", "layout": "student_ids", "students": [
        {"name": "Ikaika Kealoha", "grade": 4, "id": "S401204"},
        {"name": "Keturah Mensah", "grade": 4, "id": "S401228"}]},
    {"file": "p10_student_ids.png", "split": "test", "layout": "student_ids", "students": [
        {"name": "Leopold Ferreira", "grade": 4, "id": "S401235"},
        {"name": "Maya Okafor", "grade": 4, "id": "S401242"}]},
    # State-style ID cards (front with photo and signature, back with a stacked code).
    {"file": "p11_state_id.png", "split": "dev", "layout": "state_id", "title": "Visitor sign-in, copy of ID",
     "person": {"name": "Imogen Starkweather", "dob": "DOB 03/14/1988", "address": "44 Sample Street, Exampleton",
                "number": "SAMPLE-0042", "signature": "Imogen Starkweather"}},
    {"file": "p12_state_id.png", "split": "test", "layout": "state_id", "title": "Volunteer check, copy of ID",
     "person": {"name": "Lucan Abernethy-Vos", "dob": "DOB 11/02/1979", "address": "9 Example Road, Sampleville",
                "number": "SAMPLE-0077", "signature": "Lucan Abernethy-Vos"}},
    # Staff badges.
    {"file": "p13_staff_badge.png", "split": "dev", "layout": "staff_badge", "name": "Celeste Fairbrook",
     "dept": "Room 14, Grade 4", "reason": "badge cracked"},
    {"file": "p14_staff_badge.png", "split": "test", "layout": "staff_badge", "name": "Orrin Pallister",
     "dept": "Facilities", "reason": "lost on the playground"},
    # Clinic intake (the non-education scene): photo slot, signature, insurance card.
    {"file": "p15_clinic_intake.png", "split": "dev", "layout": "clinic_intake", "patient": {
        "name": "Rosalind Tavener", "dob": "DOB 04/09/1986", "phone": "555-0142", "email": "r.tavener@example.org",
        "reason": "annual checkup", "member": "SMP-0042-7781", "signature": "Rosalind Tavener"}},
    {"file": "p16_clinic_intake.png", "split": "test", "layout": "clinic_intake", "patient": {
        "name": "Emeric Lindgaard", "dob": "DOB 07/21/1992", "phone": "555-0143", "email": "emeric.l@example.com",
        "reason": "sprained wrist", "member": "SMP-0091-3310", "signature": "Emeric Lindgaard"}},
    # Class newsletters with a drawn class photo and the teacher's signature.
    {"file": "p17_newsletter.png", "split": "dev", "layout": "newsletter", "title": "Room 14 News, November",
     "lines": ["Our garden beds are planted! Thank you to every family who helped.",
               "Below: garden day helpers with their first seedlings.", "Picture day is next Friday."],
     "kids": [1, 2, 3], "caption": "Garden day helpers (drawn picture)",
     "more": ["Please send a water bottle each day.", "Library books are due on Wednesdays."],
     "signature": "Celeste Fairbrook"},
    {"file": "p18_newsletter.png", "split": "test", "layout": "newsletter", "title": "Room 14 News, December",
     "lines": ["We finished our opinion essays about the school garden.",
               "Below: our reading buddies at the book swap.", "Winter break starts Dec 19."],
     "kids": [1, 2, 3, 4], "caption": "Book swap reading buddies (drawn picture)",
     "more": ["Warm coats, please: recess stays outside.", "Thank you for the book donations."],
     "signature": "C. Fairbrook"},
    # Office forms with a code.
    {"file": "p19_library_card.png", "split": "dev", "layout": "office_form", "title": "Library Card Application",
     "sub": "Quillmere Elementary library (invented)", "fields": [
         ("Student", "Hana Whitlock"), ("Grade", "4"), ("Guardian phone", "555-0133"),
         ("Guardian email", "whitlock.family@example.com")],
     "signature": {"style": "scribble"}, "code": "bar", "code_label": "Library card number:",
     "code_caption": "LIB-2914-0057"},
    {"file": "p20_bus_pass.png", "split": "test", "layout": "office_form", "title": "Bus Pass Request",
     "sub": "Quillmere Elementary transportation (invented)", "fields": [
         ("Student", "Yusuf Demir"), ("Grade", "4"), ("Guardian phone", "555-0147"), ("Bus", "Route 6")],
     "signature": {"style": "name", "name": "Selin Demir"}, "code": "qr", "code_label": "Scan at the bus door:"},
    # Negative pages: nothing to cover.
    {"file": "p21_handout.png", "split": "dev", "layout": "handout", "title": "Plant Parts", "paragraphs": [
        ["Roots hold a plant in the soil and drink water.", "Stems carry water up to the leaves."],
        ["Leaves use sunlight to make food for the plant.", "Flowers make seeds, and seeds grow new plants."],
        ["Draw a plant and label its roots, stem, leaves and flower."]]},
    {"file": "p22_bar_chart.png", "split": "test", "layout": "bar_chart", "values": [1200, 1650, 1420, 1980, 2210, 1760]},
    {"file": "p23_schedule.png", "split": "dev", "layout": "schedule", "rows": [
        ("8:30", ["Morning meeting"]), ("9:00", ["Reading", "Reading", "Library", "Reading", "Reading"]),
        ("10:15", ["Math"]), ("11:30", ["Lunch"]), ("12:15", ["Science", "Art", "Science", "Music", "Garden"]),
        ("1:30", ["Writing"]), ("2:30", ["PE", "Social studies", "PE", "Social studies", "Class meeting"])]},
    {"file": "p24_shapes.png", "split": "test", "layout": "shapes"},
]


def signature_names(spec: dict) -> list[str]:
    names = []
    sig = spec.get("signature")
    if isinstance(sig, dict) and sig.get("style") == "name":
        names.append(sig["name"])
    elif isinstance(sig, str):
        names.append(sig)
    for key in ("person", "patient"):
        if key in spec:
            names.append(spec[key]["signature"])
    return names


def render(index: int) -> Rendered:
    spec = PAGES[index]
    page = Page(SEED + index)
    LAYOUTS[spec["layout"]](page, {**spec, "seed": index})
    angle = round(page.rng.uniform(-1.2, 1.2), 2)
    return page.finish(angle)


def truth_row(index: int, rendered: Rendered) -> dict:
    spec = PAGES[index]
    return {
        "file": spec["file"],
        "split": spec["split"],
        "layout": spec["layout"],
        "width": rendered.image.width,
        "height": rendered.image.height,
        "regions": [{"kind": kind, "box": box} for kind, box, _ in rendered.regions],
        "signature_names": signature_names(spec),
    }


def write(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, spec in enumerate(PAGES):
        rendered = render(i)
        rendered.image.save(out / spec["file"], format="PNG")
        rows.append(truth_row(i, rendered))
    truth = {
        "command": COMMAND,
        "note": "Invented pages. Boxes are [x1, y1, x2, y2] in pixels, x2 and y2 exclusive.",
        "kinds": list(KINDS),
        "pages": rows,
    }
    head = json.dumps({k: v for k, v in truth.items() if k != "pages"})[:-1]
    pages = ",\n".join(" " + json.dumps(row) for row in rows)  # one page per line, easy to diff
    (out / "truth.json").write_text(f'{head}, "pages": [\n{pages}\n]}}\n', encoding="utf-8")
    (out / ".synthetic").write_text("", encoding="utf-8")
    return truth


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    truth = write(args.out)
    counts: dict[str, int] = {}
    for row in truth["pages"]:
        for region in row["regions"]:
            counts[region["kind"]] = counts.get(region["kind"], 0) + 1
    print(f"wrote {len(truth['pages'])} pages and truth.json to {args.out.name}/: "
          + ", ".join(f"{counts.get(k, 0)} {k}" for k in KINDS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
