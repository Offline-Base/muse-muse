"""Pure helpers for the SAM 3.1 tune worker (worker.py, build_sets.py, score_sets.py, sbs_draw.py). Standard library
only, no torch, no numpy, so the laptop tests (tests/) can run them. Offline Base, Nov 2026.

Box forms: "xywh" is COCO's [x, y, width, height]; "xyxy" is SAM's [x0, y0, x1, y1]. Every count here is at score 0.5
or more, as the Nov 3 test (docs/log/bench/2026-11-03/distract/) counted; AP is pycocotools over every detection from
0.05 and lives in score_sets.py.
"""
import hashlib
import os
import re
import statistics
from urllib.parse import urlsplit

WORD_RE = re.compile(r"^[a-z]{2,24}$")
GENERIC_RE = re.compile(r"^[a-z][a-z ]{1,23}$")
HI = 0.5          # a box counts at this score or more
IOU_HIT = 0.5     # a box is on the object at this IoU or more
AP_FROM = 0.05    # detections kept for AP

# Guards before claiming a run (plan section 4, U4).
MIN_FREE_MEM_MB = 5632   # 5.5 GB: the trainer held about 5.2 GB on Nov 3
MIN_FREE_DISK_MB = 300
GLIMMER_DIR = "/opt/glimmer-train"

# COCO val2017 license ids a training bear may come from: 4 CC BY, 5 CC BY-SA, 7 no known copyright restrictions,
# 8 United States Government Work. A side-by-side on screen may show only CC BY and CC BY-SA, with a credit.
TRAIN_LICENSE_IDS = frozenset({4, 5, 7, 8})
SHOWABLE_LICENSES = frozenset({"Attribution License", "Attribution-ShareAlike License"})
SHORT_LICENSE = {"Attribution License": "CC BY 2.0", "Attribution-ShareAlike License": "CC BY-SA 2.0"}

SETTINGS = ("meta_word", "meta_generic", "meta_toy", "prior_word", "tuned_word", "tuned_generic")


# ---------- words ----------

def word_problem(word):
    return None if isinstance(word, str) and WORD_RE.match(word) else "the name has to be 2 to 24 lowercase letters"


def generic_problem(generic):
    if not isinstance(generic, str) or not GENERIC_RE.match(generic) or generic != generic.strip() or "  " in generic:
        return "the everyday word has to be 2 to 24 lowercase letters or single spaces"
    return None


# ---------- boxes ----------

def xyxy_to_xywh(b):
    return [b[0], b[1], b[2] - b[0], b[3] - b[1]]


def iou_xywh(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def overlaps(box, others, pad=4):
    """True when the xywh box comes within `pad` px of any of the others (the Nov 3 paste rule)."""
    x, y, w, h = box
    return any(x < bx + bw + pad and bx - pad < x + w and y < by + bh + pad and by - pad < y + h
               for bx, by, bw, bh in others)


def paste_height(bear_heights, img_h):
    """The pasted object's height: the median bear's, held between 12% and 45% of the photo (Nov 3)."""
    ht = statistics.median(bear_heights) if bear_heights else 0.25 * img_h
    return min(max(ht, 0.12 * img_h), 0.45 * img_h)


def place_box(rng, img_w, img_h, obj_w, obj_h, avoid, target_h, tries=600, shrinks=8):
    """Where to paste an obj_w x obj_h cutout scaled to about target_h px tall, touching no `avoid` box. Shrinks by 15%
    up to `shrinks` times when there is no room. Returns ([x, y, w, h], scale) or (None, scale)."""
    s = target_h / obj_h
    for _ in range(shrinks):
        nw, nh = max(8, int(obj_w * s)), max(8, int(obj_h * s))
        if nw < img_w and nh < img_h:
            for _ in range(tries):
                px, py = rng.randint(0, img_w - nw), rng.randint(0, img_h - nh)
                if not overlaps((px, py, nw, nh), avoid):
                    return [px, py, nw, nh], s
        s *= 0.85
    return None, s


# ---------- seeds ----------

def seed_key(seed, item_id):
    return hashlib.sha256(f"{seed}:{item_id}".encode()).hexdigest()


def seeded_order(ids, seed):
    """The ids in a fixed order for this seed (sha256 of "<seed>:<id>"), the same on any Python."""
    return sorted(ids, key=lambda i: seed_key(seed, i))


def split_by_seed(ids, seed, held):
    """(train, held) by seed: the first `held` ids in seeded order are held out. Each list keeps the input order."""
    held_ids = set(seeded_order(ids, seed)[:held])
    return [i for i in ids if i not in held_ids], [i for i in ids if i in held_ids]


# ---------- scoring one look ----------

def score_b_image(dets, xbox):
    """One set-B look (the object pasted at xbox, xywh). `dets` are {"box": xywh, "score"} at any score.
    found: a box at 0.5 or more on the object (IoU 0.5). top: the highest box at 0.5 or more is on the object.
    only: found, and it is the only box at 0.5 or more. other: boxes at 0.5 or more left after the first one on the
    object (score.py's count). best_x / best_other: the best score of any box on / off the object, 0.0 when none."""
    hi = sorted((d for d in dets if d["score"] >= HI), key=lambda d: -d["score"])
    hit = False
    other = 0
    for d in hi:
        if not hit and iou_xywh(d["box"], xbox) >= IOU_HIT:
            hit = True
            continue
        other += 1
    on = [d["score"] for d in dets if iou_xywh(d["box"], xbox) >= IOU_HIT]
    off = [d["score"] for d in dets if iou_xywh(d["box"], xbox) < IOU_HIT]
    return {"found": int(hit), "top": int(bool(hi) and iou_xywh(hi[0]["box"], xbox) >= IOU_HIT),
            "only": int(hit and len(hi) == 1), "other": other,
            "best_x": max(on) if on else 0.0, "best_other": max(off) if off else 0.0}


def score_a_image(dets):
    n = sum(1 for d in dets if d["score"] >= HI)
    return {"fired": int(n > 0), "boxes": n}


def score_h_image(dets, gt_boxes):
    """A held-out photo of the person's own object: found when a box at 0.5 or more lands on any of its boxes."""
    hit = any(d["score"] >= HI and any(iou_xywh(d["box"], g) >= IOU_HIT for g in gt_boxes) for d in dets)
    return {"found": int(hit)}


def _median(xs):
    return round(statistics.median(xs), 3) if xs else None


def summarize(b_rows, a_rows, h_rows=None, ap=None):
    """One column (SamSettingScore) from per-image rows of score_b_image, score_a_image and score_h_image.
    `ap` is {"B": (ap, ap50), "H": ap} from pycocotools, or None in tests."""
    ap = ap or {}
    bap, bap50 = ap.get("B", (0.0, 0.0))
    out = {
        "B": {"n": len(b_rows), "found": sum(r["found"] for r in b_rows), "top": sum(r["top"] for r in b_rows),
              "only": sum(r["only"] for r in b_rows), "otherBoxes": sum(r["other"] for r in b_rows),
              "ap": round(max(bap, 0.0), 3), "ap50": round(max(bap50, 0.0), 3)},
        "A": {"n": len(a_rows), "firedPhotos": sum(r["fired"] for r in a_rows), "boxes": sum(r["boxes"] for r in a_rows)},
        "medianScore": _median([r["best_x"] for r in b_rows]),
        "medianBestOther": _median([r["best_other"] for r in b_rows]),
    }
    if h_rows:
        out["H"] = {"n": len(h_rows), "found": sum(r["found"] for r in h_rows), "ap": round(max(ap.get("H", 0.0), 0.0), 3)}
    return out


# ---------- pictures ----------

def showable(item):
    """May this eval photo be put on screen? COCO photos (source "coco") only under CC BY or CC BY-SA, so one whose
    license is missing never is; the person's own and Muse Image photos (no license) always."""
    lic = item.get("license")
    if item.get("source") == "coco":
        return lic in SHOWABLE_LICENSES
    return lic is None or lic in SHOWABLE_LICENSES


def short_license(lic):
    """The license as the report shows it: "CC BY 2.0" for COCO's "Attribution License", None for none."""
    return SHORT_LICENSE.get(lic, lic) if lic else None


def credit_for(item, pasted):
    """The credit line under a picture, or None for the person's own or Muse Image photos."""
    if item.get("license") is None:
        return None
    lic = SHORT_LICENSE.get(item["license"], item["license"])
    src = item.get("flickr_url") or item.get("coco_url") or ""
    tail = f", {item['word'].capitalize()} pasted in" if pasted and item.get("word") else ""
    return f"COCO val2017 {item.get('coco_id')} ({lic}, {src}){tail}."[:300]


def pick_images(b_tuned, b_generic, a_tuned, items_b, items_a):
    """Up to three side-by-sides, one per rule, on showable photos, never the same photo twice.
    b_tuned / b_generic: {image id: score_b_image row}, a_tuned: {image id: score_a_image row};
    items_b / items_a: {image id: eval item} (for the license).
    tuned_top: the tune ranks the object first, preferring "only it", then where the generic word boxed the most.
    generic_top: Meta's generic word ranks it first and the tune doesn't, else where the generic word's lead over its
    best other box is widest (an honest picture for Meta). tuned_false_fire: a photo with no object where the tune
    boxed the most. Returns [(rule, "A" or "B", image id)]."""
    out, used = [], set()
    ok_b = [i for i in sorted(b_tuned) if i in items_b and showable(items_b[i])]
    ok_a = [i for i in sorted(a_tuned) if i in items_a and showable(items_a[i])]
    tt = [i for i in ok_b if b_tuned[i]["top"]]
    tt.sort(key=lambda i: (-b_tuned[i]["only"], -(b_generic.get(i, {}).get("other", 0)), i))
    if tt:
        out.append(("tuned_top", "B", tt[0])); used.add(("B", tt[0]))
    gt = [i for i in ok_b if ("B", i) not in used and b_generic.get(i, {}).get("top")]
    gt.sort(key=lambda i: (b_tuned[i]["top"],
                           -(b_generic[i]["best_x"] - b_generic[i]["best_other"]), i))
    if gt:
        out.append(("generic_top", "B", gt[0])); used.add(("B", gt[0]))
    ff = [i for i in ok_a if a_tuned[i]["boxes"] > 0]
    ff.sort(key=lambda i: (-a_tuned[i]["boxes"], i))
    if ff:
        out.append(("tuned_false_fire", "A", ff[0]))
    return out


# ---------- board guards and housekeeping ----------

def guard_problem(free_mem_mb, free_disk_mb, glimmer_running):
    """Why the board must not claim a run now, or None."""
    if glimmer_running:
        return f"a {GLIMMER_DIR} process is running"
    if free_mem_mb < MIN_FREE_MEM_MB:
        return f"only {free_mem_mb} MB free memory (needs {MIN_FREE_MEM_MB})"
    if free_disk_mb < MIN_FREE_DISK_MB:
        return f"only {free_disk_mb} MB free disk (needs {MIN_FREE_DISK_MB})"
    return None


def mem_available_mb(meminfo_text):
    m = re.search(r"^MemAvailable:\s+(\d+)\s+kB", meminfo_text, re.M)
    return int(m.group(1)) // 1024 if m else 0


def glimmer_in(cmdlines):
    """True when any process command line (NUL-separated, as /proc/<pid>/cmdline) mentions /opt/glimmer-train."""
    return any(GLIMMER_DIR in c.replace("\0", " ") for c in cmdlines)


def deltas_to_delete(deltas, keep=2, protect=()):
    """Which of [(path, mtime)] to delete so at most `keep` remain, newest kept; `protect` paths (muse31's delta and
    the run in hand) are never deleted and don't count."""
    rest = sorted((d for d in deltas if d[0] not in set(protect)), key=lambda d: -d[1])
    return [p for p, _ in rest[keep:]]


def url_allowed(url, mm_url, blob_suffix=".public.blob.vercel-storage.com"):
    """Run photos may come only from the Muse Muse site's own host or the public Blob host, over https (plain http
    only when MM_URL itself is http, as in the tests)."""
    try:
        u, m = urlsplit(url), urlsplit(mm_url)
    except ValueError:
        return False
    if not u.hostname or u.username or u.password:
        return False
    if u.hostname == m.hostname and u.port == m.port:
        return u.scheme == m.scheme
    return u.scheme == "https" and u.port in (None, 443) and u.hostname.endswith(blob_suffix) \
        and u.hostname != blob_suffix.lstrip(".")


TRAIN_STEP_RE = re.compile(r"\[(\d+)\]\[\s*(\d+)\s*/\s*(\d+)\]")


def train_step(line, epochs):
    """(step, steps) from a trainer log line like "Train Epoch: [2][ 40/200]", or None. Unconfirmed against the pinned
    trainer's exact format: the worker also reports the line as is."""
    m = TRAIN_STEP_RE.search(line)
    if not m:
        return None
    ep, i, n = (int(g) for g in m.groups())
    if n <= 0:
        return None
    return ep * n + i, epochs * n


def free_disk_mb(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize // 2**20
