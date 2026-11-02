#!/usr/bin/env python3
"""
A cold-room watch drill: Simulated log windows to one JSON verdict, scored by code with no judge model.

  python3 scripts/dev/drill-bench.py make [--out eval/drill] [--seed 1104]
      writes train.jsonl (900 rows of {messages}, for train_model and the tune harness), folder/ (the same 900 rows as
      {prompt, answer} files for a TUNE_FOLDER drop), dev.jsonl (50 kept-aside rows of {prompt, reference}, for a pilot),
      sealed.jsonl (100 held-out rows of {id, case, prompt, reference, truth, ...}) and the two filming CSVs.
  python3 scripts/dev/drill-bench.py ask --heldout eval/drill/sealed.jsonl --url http://127.0.0.1:8080/v1 --model <id> --out answers.jsonl
      asks any OpenAI-compatible endpoint at temperature 0, saves every answer, then prints the score.
  python3 scripts/dev/drill-bench.py score --heldout eval/drill/sealed.jsonl --answers answers.jsonl
      grades each field. `--reference` scores the right answers themselves (always 100%).

Everything is invented from a seed by this file, never by a model, so the rows are rights-clean. Every window is a
Simulated room with made-up readings; nothing here is about a real freezer, and the actions defer to the site's own
procedure. Training uses two layouts and the held-out set two others, so a tuned model is scored on log shapes it never
saw. Text sent with `ask` goes wherever --url points, so only this made-up data belongs in it.

The hard rule: when the controller and the independent probe differ by more than the threshold, trust_controller must be
false. Any answer that trusts the controller there is a violation, reported on its own and never averaged away.
"""
import argparse
import csv
import hashlib
import io
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request

SEED = 1104
THRESHOLD_C = 3.0
STEP_MIN = 5
WINDOW = 12  # the filming windows; drawn windows hold 10 to 12 readings
TRAIN_N, DEV_N, SEALED_N = 900, 50, 100
FOLDER_ROWS_PER_FILE = 100
# sha256 of sealed.jsonl as `make` writes it with the defaults. A file with any other hash is not the sealed set.
SEALED_SHA256 = "52b23493d1f832aebf717829469091ded8029b77fc82b517544746c94346f3dd"

STATUSES = ("normal", "watch", "alert")
CAUSES = ("none", "door_open", "defrost_stuck", "setpoint_changed", "controller_probe_mismatch", "probe_dropout", "power_gap", "cloud_down")
FIELDS = ("status", "trust_controller", "likely_cause", "actions", "escalate")
ACTIONS = {
    "keep_watching": "Keep watching the log.",
    "keep_local_log": "Keep the log on site until the cloud link is back.",
    "check_door": "Check that the door is shut.",
    "check_independent_probe": "Check the independent probe's reading in person.",
    "check_power_records": "Check the site's power records for the gap.",
    "check_setpoint_record": "Check the setpoint against the site's own record of changes.",
    "report_to_site_security": "Report the controller to the site's IT or security contact.",
    "call_refrigeration_technician": "Call the refrigeration technician.",
    "follow_site_procedure_for_stock": "Follow the store's own procedure for the stock.",
}
# The verdict for each cause. keep_local_log is added whenever the last reading shows the cloud down.
VERDICT = {
    "none": ("normal", True, False, ["keep_watching"]),
    "cloud_down": ("normal", True, False, ["keep_local_log", "keep_watching"]),
    "door_open": ("watch", True, False, ["check_door", "check_independent_probe"]),
    "probe_dropout": ("watch", False, False, ["check_independent_probe", "keep_watching"]),
    "power_gap": ("watch", True, False, ["check_power_records", "check_independent_probe", "follow_site_procedure_for_stock"]),
    "defrost_stuck": ("alert", True, True, ["call_refrigeration_technician", "check_independent_probe", "follow_site_procedure_for_stock"]),
    "setpoint_changed": ("alert", False, True, ["check_setpoint_record", "report_to_site_security", "call_refrigeration_technician", "follow_site_procedure_for_stock"]),
    "controller_probe_mismatch": ("alert", False, True, ["check_independent_probe", "report_to_site_security", "call_refrigeration_technician", "follow_site_procedure_for_stock"]),
}
SYSTEM = (
    "You watch a Simulated cold room's log. Read the window and answer with one JSON object and nothing else, with exactly these keys: "
    "status (normal, watch or alert), trust_controller (true or false), likely_cause (one of: " + ", ".join(CAUSES) + "), "
    "actions (a list of action ids), escalate (true or false). "
    "Apply the first rule that fits. "
    f"1) The controller and the independent probe differ by more than {THRESHOLD_C:.1f} C on any reading: controller_probe_mismatch, alert, never trust the controller, escalate. "
    "2) The setpoint changes inside the window: setpoint_changed, alert, don't trust the controller, escalate. "
    "3) Defrost is on for 8 or more readings in a row: defrost_stuck, alert, escalate. "
    "4) The door is open for 3 or more readings in a row: door_open, watch. "
    f"5) The power is lost and the next reading comes {15 + STEP_MIN} or more minutes after the one before: power_gap, watch. "
    "6) The probe reads none on the last 3 or more readings: probe_dropout, watch, don't trust the controller, since nothing checks it. "
    "7) The cloud is down on the last reading: cloud_down, normal. "
    "8) Otherwise none, normal. "
    "trust_controller is true only when the probe is reporting and agrees, and the setpoint has not changed. "
    "Actions by cause: none [keep_watching]; cloud_down [keep_local_log, keep_watching]; door_open [check_door, check_independent_probe]; "
    "probe_dropout [check_independent_probe, keep_watching]; power_gap [check_power_records, check_independent_probe, follow_site_procedure_for_stock]; "
    "defrost_stuck [call_refrigeration_technician, check_independent_probe, follow_site_procedure_for_stock]; "
    "setpoint_changed [check_setpoint_record, report_to_site_security, call_refrigeration_technician, follow_site_procedure_for_stock]; "
    "controller_probe_mismatch [check_independent_probe, report_to_site_security, call_refrigeration_technician, follow_site_procedure_for_stock]. "
    "Add keep_local_log to any other cause when the cloud is down on the last reading. Never give temperatures or food-safety rules as advice."
)
ANSWER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": list(FIELDS),
    "properties": {
        "status": {"type": "string", "enum": list(STATUSES)},
        "trust_controller": {"type": "boolean"},
        "likely_cause": {"type": "string", "enum": list(CAUSES)},
        "actions": {"type": "array", "items": {"type": "string", "enum": list(ACTIONS)}},
        "escalate": {"type": "boolean"},
    },
}
TRAIN_SETPOINTS = (-18.0, -20.0, 3.0, 4.0)
SEALED_SETPOINTS = (-22.0, -15.0, 2.0, 5.0)
TRAIN_ROOMS = ("Simulated Room A", "Simulated Room B", "Simulated Freezer 1", "Simulated Chiller 2")
SEALED_ROOMS = ("Simulated Walk-in North", "Simulated Room K", "Simulated Freezer 7", "Simulated Chiller East")
# Invented words for each window's header, so no two windows read as near-duplicates to the dataset's split
# (lib/train/logic.ts isNearDuplicate), which would otherwise drop most of them.
SITE_A = "Amberly Brindle Calder Dunmore Elmstead Farrow Glenhurst Harlow Ivybridge Juniper Kestrel Larkfield Marrow Northcote Oakhollow Penrith Quillan Rookwood Saltash Thornbury Upton Vexley Westmere Yarrow Zennor Ashcombe Birchley Cobbold Dovecote Ferncliff".split()
SITE_B = "Market Depot Yard Exchange Wharf Arcade Crossing Square Hall Commons Row Terrace Lane Corner Point Gate".split()
LOGGERS = ("night lead", "stock clerk", "duty manager", "receiving clerk", "weekend supervisor", "early shift lead", "late shift lead", "facilities desk", "store lead", "relief manager", "dairy lead", "frozen aisle lead")
COLUMNS = ("record", "time", "setpoint_c", "controller_c", "probe_c", "door", "defrost", "power", "cloud")


def clock(minutes):
    minutes %= 24 * 60
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def r1(x):
    return round(x + 0.0, 1)


def invent(rng, case, setpoints, rooms):
    """One Simulated window: a list of readings and the facts the verdict is computed from."""
    setpoint = rng.choice(setpoints)
    offset = rng.uniform(-1.2, 1.2)  # the probe sits a little off the controller, always inside the threshold
    start = rng.randrange(0, 24 * 60)
    W = rng.randint(10, 12)
    record = rng.randint(10000, 99999)  # the logger's record numbers, which also keep windows from reading as near-duplicates
    rows = []
    for i in range(W):
        c = setpoint + rng.uniform(-0.4, 0.4)
        rows.append({"record": record + i, "t": start + i * STEP_MIN, "setpoint": setpoint, "controller": c, "probe": c + offset + rng.uniform(-0.2, 0.2), "door": "shut", "defrost": "off", "power": "on", "cloud": "up"})
    variant = ""
    if case in ("none", "cloud_down") and rng.random() < 0.5:
        # Decoys that stay normal: one reading with the door open, or a short defrost.
        if rng.random() < 0.5:
            rows[rng.randrange(1, W - 1)]["door"] = "open"
            variant = "door_blip"
        else:
            at = rng.randrange(1, W - 5)
            for k in range(at, at + rng.randint(2, 4)):
                rows[k]["defrost"] = "on"
                rows[k]["controller"] += 1.0
                rows[k]["probe"] += 1.0
            variant = "short_defrost"
    if case == "door_open":
        n = rng.randint(3, 6)
        at = rng.randrange(1, W - n + 1)
        for j, k in enumerate(range(at, at + n)):
            rows[k]["door"] = "open"
            for key in ("controller", "probe"):
                rows[k][key] += 0.8 * (j + 1)
    elif case == "defrost_stuck":
        n = rng.randint(8, W - 1)
        for j, k in enumerate(range(W - n, W)):
            rows[k]["defrost"] = "on"
            for key in ("controller", "probe"):
                rows[k][key] += 0.9 * (j + 1)
    elif case == "setpoint_changed":
        at = rng.randrange(3, W - 3)
        new = rng.choice((10.0, 25.0, 40.0, 50.0))
        variant = f"to_{int(new)}"
        for j, k in enumerate(range(at, W)):
            rows[k]["setpoint"] = new
            for key in ("controller", "probe"):
                rows[k][key] += 1.1 * (j + 1)
    elif case == "controller_probe_mismatch":
        at = rng.randrange(2, W - 4)
        if rng.random() < 0.7:
            variant = "controller_flat_probe_rising"  # a spoofed controller: steady at its setpoint while the room warms
            for j, k in enumerate(range(at, W)):
                rows[k]["controller"] = setpoint + rng.uniform(-0.1, 0.1)
                rows[k]["probe"] = setpoint + offset + 1.5 * (j + 1) + 2.5
        else:
            variant = "controller_high_probe_steady"
            for j, k in enumerate(range(at, W)):
                rows[k]["controller"] += 1.5 * (j + 1) + 2.5
    elif case == "probe_dropout":
        n = rng.randint(3, 6)
        for k in range(W - n, W):
            rows[k]["probe"] = None
    elif case == "power_gap":
        at = rng.randrange(3, W - 3)
        missing = rng.randint(3, 8)
        rows[at - 1]["power"] = "lost"
        for k in range(at, W):
            rows[k]["t"] += missing * STEP_MIN
            for key in ("controller", "probe"):
                rows[k][key] += 0.3 * missing
        rows[at]["power"] = "restored"
        variant = f"gap_{(missing + 1) * STEP_MIN}m"
    cloud_overlay = case == "cloud_down" or (case != "none" and rng.random() < 0.2)
    if cloud_overlay:
        for k in range(W - rng.randint(1, 5), W):
            rows[k]["cloud"] = "down"
    for row in rows:
        row["controller"] = r1(row["controller"])
        row["probe"] = None if row["probe"] is None else r1(row["probe"])
    tags = {
        "site": f"{rng.choice(SITE_A)} {rng.choice(SITE_B)}",
        "logger": rng.choice(LOGGERS),
        "controller_tag": f"{rng.choice('BCDFGHKMNRTVXZ')}{rng.choice('BCDFGHKMNRTVXZ')}-{rng.randint(100, 999)}",
        "probe_tag": f"P{rng.randint(1000, 9999)}",
    }
    return {"room": rng.choice(rooms), "rows": rows, "case": case, "variant": variant, **tags}


def facts(rows):
    """What the log shows, computed from the rows alone."""
    def longest(key, value):
        best = run = 0
        for r in rows:
            run = run + 1 if r[key] == value else 0
            best = max(best, run)
        return best

    gap = max((b["t"] - a["t"] for a, b in zip(rows, rows[1:])), default=0)
    tail_none = 0
    for r in reversed(rows):
        if r["probe"] is not None:
            break
        tail_none += 1
    return {
        "disagree": any(r["probe"] is not None and abs(r["controller"] - r["probe"]) > THRESHOLD_C for r in rows),
        "setpoint_changed": len({r["setpoint"] for r in rows}) > 1,
        "defrost_run": longest("defrost", "on"),
        "door_run": longest("door", "open"),
        "gap_min": gap,
        "power_lost": any(r["power"] == "lost" for r in rows),
        "probe_tail_none": tail_none,
        "cloud_down_last": rows[-1]["cloud"] == "down",
    }


def cause_of(f):
    if f["disagree"]:
        return "controller_probe_mismatch"
    if f["setpoint_changed"]:
        return "setpoint_changed"
    if f["defrost_run"] >= 8:
        return "defrost_stuck"
    if f["door_run"] >= 3:
        return "door_open"
    if f["gap_min"] >= 15 + STEP_MIN and f["power_lost"]:
        return "power_gap"
    if f["probe_tail_none"] >= 3:
        return "probe_dropout"
    if f["cloud_down_last"]:
        return "cloud_down"
    return "none"


def truth_of(rows):
    """The right answer, by the same rules the system line states."""
    f = facts(rows)
    cause = cause_of(f)
    status, trust, escalate, actions = VERDICT[cause]
    actions = list(actions)
    if f["cloud_down_last"] and "keep_local_log" not in actions:
        actions.append("keep_local_log")
    return {"status": status, "trust_controller": trust, "likely_cause": cause, "actions": actions, "escalate": escalate}, f


def cell(v):
    return "none" if v is None else f"{v:.1f}" if isinstance(v, float) else str(v)


def values(r):
    return {"record": str(r["record"]), "time": clock(r["t"]), "setpoint_c": cell(r["setpoint"]), "controller_c": cell(r["controller"]), "probe_c": cell(r["probe"]), "door": r["door"], "defrost": r["defrost"], "power": r["power"], "cloud": r["cloud"]}


def header(w):
    return (
        f"Simulated cold-room log, invented data. {w['room']} at the Simulated {w['site']} site, logged by the {w['logger']}. "
        f"Controller {w['controller_tag']}, independent probe {w['probe_tag']}. Readings every {STEP_MIN} minutes. Disagreement threshold {THRESHOLD_C:.1f} C."
    )


def layout_table(w):
    cells = [values(r) for r in w["rows"]]
    width = {c: max([len(c)] + [len(v[c]) for v in cells]) for c in COLUMNS}
    lines = [header(w), " ".join(c.rjust(width[c]) for c in COLUMNS)]
    lines += [" ".join(v[c].rjust(width[c]) for c in COLUMNS) for v in cells]
    return "\n".join(lines)


def layout_csv(w):
    out = io.StringIO()
    wr = csv.writer(out, lineterminator="\n")
    wr.writerow(COLUMNS)
    for r in w["rows"]:
        wr.writerow([values(r)[c] for c in COLUMNS])
    return header(w) + "\n" + out.getvalue().rstrip("\n")


def layout_kv(w):
    lines = [header(w)]
    for r in w["rows"]:
        v = values(r)
        lines.append(f"#{v['record']} [{v['time']}] setpoint={v['setpoint_c']} controller={v['controller_c']} probe={v['probe_c']} door={v['door']} defrost={v['defrost']} power={v['power']} cloud={v['cloud']}")
    return "\n".join(lines)


REORDERED = ("time", "probe_c", "controller_c", "setpoint_c", "cloud", "power", "defrost", "door", "record")


def layout_reordered(w):
    lines = [header(w), " | ".join(REORDERED)]
    lines += [" | ".join(values(r)[c] for c in REORDERED) for r in w["rows"]]
    return "\n".join(lines)


TRAIN_LAYOUTS = (layout_table, layout_csv)
SEALED_LAYOUTS = (layout_kv, layout_reordered)


def dumps(obj):
    return json.dumps(obj, separators=(",", ":"))


def prompt_words(text):
    """lib/train/logic.ts promptWords, for this file's ASCII text."""
    return set(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def near_duplicate(a, b):
    """lib/train/logic.ts isNearDuplicate: word sets sharing at least 0.7 (Jaccard). The dataset split drops those."""
    shared = len(a & b)
    return shared / (len(a) + len(b) - shared) >= 0.7


def windows(rng, n, setpoints, rooms, layouts, seen):
    """n windows spread evenly over the causes, none a near-duplicate of `seen` or of each other, with layout and truth."""
    out = []
    i = 0
    while len(out) < n:
        case = CAUSES[len(out) % len(CAUSES)]
        w = invent(rng, case, setpoints, rooms)
        truth, f = truth_of(w["rows"])
        layout = layouts[i % len(layouts)]
        i += 1
        text = layout(w)
        words = prompt_words(text)
        if truth["likely_cause"] != case or any(near_duplicate(words, other) for other in seen):
            continue  # a draw that tipped into another rule, or a near-repeat: draw again so the split stays even
        seen.append(words)
        out.append({"case": case, "variant": w["variant"], "layout": layout.__name__, "text": text, "truth": truth, "facts": f, "rows": w["rows"]})
    return out


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


# The two filming windows, fixed by hand rather than drawn, so a retake shows the same log.
def demo_windows():
    calm = []
    for i in range(WINDOW):
        c = -18.0 + (0.2 if i % 3 == 0 else -0.1 if i % 3 == 1 else 0.0)
        calm.append({"record": 40112 + i, "t": 14 * 60 + i * STEP_MIN, "setpoint": -18.0, "controller": r1(c), "probe": r1(c - 0.4), "door": "shut", "defrost": "off", "power": "on", "cloud": "down" if i >= 8 else "up"})
    spoof = []
    for i in range(WINDOW):
        probe = -18.3 if i < 4 else r1(-18.3 + 3.4 * (i - 3))
        spoof.append({"record": 71830 + i, "t": 2 * 60 + i * STEP_MIN, "setpoint": -18.0, "controller": -18.0 if i % 2 == 0 else -18.1, "probe": min(probe, 9.0) if i < WINDOW - 1 else 9.4, "door": "shut", "defrost": "off", "power": "on", "cloud": "down" if i >= 9 else "up"})
    return {"demo-calm-cloud-down.csv": calm, "demo-spoofed-controller.csv": spoof}


def write_demo(path, rows):
    with open(path, "w", encoding="utf8", newline="") as f:
        wr = csv.writer(f, lineterminator="\n")
        wr.writerow(("source",) + COLUMNS)
        for r in rows:
            v = values(r)
            wr.writerow(["Simulated"] + [v[c] for c in COLUMNS])


def make(out, seed):
    os.makedirs(out, exist_ok=True)
    seen = []
    sealed = windows(random.Random(f"{seed}-sealed"), SEALED_N, SEALED_SETPOINTS, SEALED_ROOMS, SEALED_LAYOUTS, seen)
    train = windows(random.Random(f"{seed}-train"), TRAIN_N + DEV_N, TRAIN_SETPOINTS, TRAIN_ROOMS, TRAIN_LAYOUTS, seen)
    random.Random(f"{seed}-shuffle").shuffle(train)
    dev, train = train[:DEV_N], train[DEV_N:]
    write_jsonl(os.path.join(out, "train.jsonl"), [{"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": w["text"]}, {"role": "assistant", "content": dumps(w["truth"])}]} for w in train])
    write_jsonl(os.path.join(out, "dev.jsonl"), [{"prompt": w["text"], "reference": dumps(w["truth"])} for w in dev])
    write_jsonl(
        os.path.join(out, "sealed.jsonl"),
        [{"id": f"drill-{i:03d}", "case": w["case"], "variant": w["variant"], "layout": w["layout"], "simulated": True, "prompt": w["text"], "reference": dumps(w["truth"]), "truth": w["truth"], "disagree": w["facts"]["disagree"]} for i, w in enumerate(sealed)],
    )
    # The same training rows as a folder drop (TUNE_FOLDER): {prompt, answer} with no system line, in files well under
    # the folder reader's 200,000 characters a file (lib/train/tune/folder.ts FOLDER_LIMITS).
    folder = os.path.join(out, "folder")
    os.makedirs(folder, exist_ok=True)
    for k in range(0, len(train), FOLDER_ROWS_PER_FILE):
        write_jsonl(os.path.join(folder, f"cold-room-drill-{k // FOLDER_ROWS_PER_FILE + 1:02d}.jsonl"), [{"prompt": w["text"], "answer": dumps(w["truth"])} for w in train[k : k + FOLDER_ROWS_PER_FILE]])
    for name, rows in demo_windows().items():
        write_demo(os.path.join(out, name), rows)
    print(f"wrote {len(train)} training, {len(dev)} kept-aside and {len(sealed)} sealed Simulated windows to {out}")
    for name in ("train.jsonl", "dev.jsonl", "sealed.jsonl"):
        print(f"  {name} sha256 {sha256(os.path.join(out, name))}")


def parse_answer(text):
    """The first JSON object in an answer, after any thinking or fence. None when there isn't one."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    start = text.find("{")
    while start != -1:
        depth = 0
        for end in range(start, len(text)):
            if text[end] == "{":
                depth += 1
            elif text[end] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        found = json.loads(text[start : end + 1])
                        return found if isinstance(found, dict) else None
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None


def field_right(field, got, want):
    if field in ("trust_controller", "escalate"):
        return got is want
    if field == "actions":
        return isinstance(got, list) and all(isinstance(a, str) for a in got) and set(got) == set(want)
    return isinstance(got, str) and got.strip().lower() == want


def jaccard(got, want):
    got = set(a for a in got if isinstance(a, str)) if isinstance(got, list) else set()
    union = got | set(want)
    return len(got & set(want)) / len(union) if union else 1.0


def score(rows):
    """rows: sealed rows, each with "answer" (dict or None) and optional "seconds", "completion_tokens"."""
    n = len(rows) or 1
    fields = {f: 0 for f in FIELDS}
    valid = all_right = 0
    jac = 0.0
    hard_rows = hard_violations = 0
    by_case = {}
    for r in rows:
        answer = r.get("answer")
        truth = r["truth"]
        ok = isinstance(answer, dict)
        valid += ok
        right = [f for f in FIELDS if ok and field_right(f, answer.get(f), truth[f])]
        for f in right:
            fields[f] += 1
        jac += jaccard(answer.get("actions") if ok else None, truth["actions"])
        violated = False
        if r["disagree"]:
            hard_rows += 1
            violated = not ok or answer.get("trust_controller") is not False
            hard_violations += violated
        passed = len(right) == len(FIELDS) and not violated
        all_right += passed
        case = by_case.setdefault(r["case"], {"items": 0, "all_right": 0})
        case["items"] += 1
        case["all_right"] += passed
    seconds = [r["seconds"] for r in rows if r.get("seconds") is not None]
    tokens = sum(r.get("completion_tokens") or 0 for r in rows)
    return {
        "items": len(rows),
        "simulated": True,
        "valid_json": round(valid / n, 3),
        "all_right": round(all_right / n, 3),
        "per_field": {f: round(fields[f] / n, 3) for f in FIELDS},
        "actions_jaccard": round(jac / n, 3),
        "hard_rule": {"rule": "trust_controller is false whenever controller and probe disagree beyond the threshold", "rows": hard_rows, "violations": hard_violations, "passed": hard_violations == 0},
        "by_case": {c: {**v, "rate": round(v["all_right"] / v["items"], 3)} for c, v in sorted(by_case.items())},
        "median_seconds": round(sorted(seconds)[len(seconds) // 2], 2) if seconds else None,
        "tokens_per_second": round(tokens / sum(seconds), 1) if seconds and sum(seconds) else None,
    }


def read_jsonl(path):
    with open(path, encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def seal_note(path):
    got = sha256(path)
    if os.path.basename(path) == "sealed.jsonl" and got != SEALED_SHA256:
        return f"note: {path} sha256 {got} is not the sealed set's {SEALED_SHA256}"
    return None


def ask_one(url, model, text, headers, max_tokens, schema, timeout):
    body = {"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}], "temperature": 0, "max_tokens": max_tokens, "stream": False}
    if schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "drill_verdict", "strict": True, "schema": ANSWER_SCHEMA}}
    req = urllib.request.Request(url + "/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers})
    start = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as res:
        data = json.load(res)
    choice = data["choices"][0]
    return {"raw": choice["message"].get("content") or "", "finish": choice.get("finish_reason"), "seconds": time.time() - start, "completion_tokens": (data.get("usage") or {}).get("completion_tokens")}


def ask(args):
    url = args.url.rstrip("/")
    headers = {}
    key = os.environ.get(args.key_env) if args.key_env else None
    if key:
        headers["Authorization"] = f"Bearer {key}"
    for h in args.header or []:
        name, _, value = h.partition(":")
        headers[name.strip()] = value.strip()
    held = read_jsonl(args.heldout)[: args.limit or None]
    rows = []
    for item in held:
        try:
            got = ask_one(url, args.model, item["prompt"], headers, args.max_tokens, args.schema, args.timeout)
        except (urllib.error.URLError, TimeoutError, OSError, KeyError, IndexError, ValueError) as err:
            got = {"raw": "", "finish": f"error: {type(err).__name__} {getattr(err, 'code', '')}".strip(), "seconds": None, "completion_tokens": None}
        rows.append({"id": item["id"], **got, "answer": parse_answer(got["raw"])})
        print(item["id"], got["finish"], got["seconds"] and round(got["seconds"], 2), flush=True)
    write_jsonl(args.out, rows)
    report = {"model": args.model, "label": args.label or args.model, **graded(held, rows), "errors": sum(1 for r in rows if str(r["finish"]).startswith("error")), "cut_off": sum(1 for r in rows if r["finish"] == "length")}
    note = seal_note(args.heldout)
    if note:
        report["note"] = note
    print(json.dumps(report, indent=1))
    return report


def graded(held, answers):
    by_id = {a["id"]: a for a in answers}
    rows = [{**h, **{k: v for k, v in by_id.get(h["id"], {}).items() if k in ("answer", "seconds", "completion_tokens")}} for h in held]
    for r in rows:
        r.setdefault("answer", None)
    return score(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Simulated cold-room drill: make, ask, score")
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("make")
    m.add_argument("--out", default="eval/drill")
    m.add_argument("--seed", type=int, default=SEED)
    a = sub.add_parser("ask")
    a.add_argument("--heldout", required=True)
    a.add_argument("--url", required=True, help="an OpenAI-compatible base, ending in /v1")
    a.add_argument("--model", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--label", help="how the report names this row, e.g. 'Llama 3.2 3B base'")
    a.add_argument("--key-env", default="DRILL_API_KEY", help="the environment variable holding a bearer key, if the endpoint needs one")
    a.add_argument("--header", action="append", help="an extra header, 'Name: value'")
    a.add_argument("--schema", action="store_true", help="send response_format json_schema")
    a.add_argument("--max-tokens", type=int, default=200)
    a.add_argument("--timeout", type=float, default=180)
    a.add_argument("--limit", type=int, default=0)
    s = sub.add_parser("score")
    s.add_argument("--heldout", required=True)
    s.add_argument("--answers")
    s.add_argument("--reference", action="store_true", help="score the right answers themselves")
    args = parser.parse_args(argv)
    if args.command == "make":
        make(args.out, args.seed)
    elif args.command == "ask":
        ask(args)
    else:
        held = read_jsonl(args.heldout)
        if args.reference:
            answers = [{"id": h["id"], "answer": h["truth"]} for h in held]
        elif args.answers:
            answers = read_jsonl(args.answers)
        else:
            parser.error("score needs --answers or --reference")
        report = graded(held, answers)
        note = seal_note(args.heldout)
        if note:
            report["note"] = note
        print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
