"""Write the invented item pools for the two personas outside a school, from seeded templates.

    uv run python -m scripts.make_persona_items           # writes both pools
    uv run python -m scripts.make_persona_items --check   # re-builds them and compares, counts only

eval/personas/clinic_coordinator/items.jsonl: 80 items for an invented family clinic (front-desk
work under the HIPAA toggle), 20 per decision its policy wants. eval/personas/caseworker_cui/items.jsonl:
36 items for an invented city housing office whose federal grant agreement marks its case files
CUI; its policy refuses everything. No model call and no API: hand-written templates filled from
invented names with random.Random(SEED). Each item has the eval's shape, `expected` is the
persona policy's wants on the hand labels, and every value is fake: 555-01xx phones,
example.org emails, record numbers starting 000-. Patients and clients are off the school roster,
so the device tags them [Person N]. A few casework requests carry a phone number or a client's
name on purpose (`request_detail`), to show the private-detail note. Everything is simulated.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

from base.config import REPO_ROOT
from base.policy import UserPolicy
from base.types import DECISIONS

SEED = 20261031
PERSONAS = REPO_ROOT / "eval" / "personas"
CLINIC = PERSONAS / "clinic_coordinator"
CASEWORK = PERSONAS / "caseworker_cui"
NOTE = "Simulated, invented item."

PATIENTS = (
    "Orla Penhallow", "Bram Kittering", "Ilse Varnum", "Tobias Quarrie", "Nell Ashgrove", "Corin Dallimore",
    "Mabry Tolliver", "Esme Kettleby", "Lucan Brightwater", "Sully Marrowfield", "Arlo Fenwhistle",
    "Yara Castellane", "Wim Tarrant", "Delphine Okerlund", "Hester Gravelin", "Pim Abernathy",
)  # fmt: skip
CLIENTS = (
    "Gus Wetherell", "Mirela Stanchev", "Otis Brannagh", "Reena Kalloway", "Hollis Dunmere", "Ines Calderwood",
    "Joaquin Barrowclough", "Tilde Ravensworth",
)  # fmt: skip
DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")


def _phone(rng: random.Random) -> str:
    return f"555-01{rng.randrange(100):02d}"


def _record(rng: random.Random) -> str:
    """An invented record or case number in a 000- block no real system uses."""
    return f"000-{rng.randrange(10000, 99999)}"


# ----- the clinic: Brackenmoor Family Clinic (invented) -----

CLINIC_LISTS = (
    ("List the documents in the front desk folder.", ["weekly no-show log.md", "front desk schedule.md", "{p} intake form.md"]),
    ("What files are in the visits folder for this week?", ["{p} visit notes.md", "{q} visit notes.md", "waiting room survey.md"]),
    ("Show me the document titles in the forms folder.", ["new patient packet.md", "{p} consent form.md", "lobby sign-in sheet.md"]),
    ("List what is in the referrals folder.", ["{p} referral draft.md", "referral checklist.md", "{q} referral draft.md"]),
    ("Which documents are in the scheduling folder?", ["Saturday walk-in hours.md", "flu shot clinic plan.md", "holiday hours.md"]),
)  # fmt: skip
CLINIC_COUNTS = (
    ("How many visits did we have this week, as a count by day?",
     "This week the clinic had {a} scheduled visits and {b} walk-ins. {d1} was the busiest day and {d2} the quietest."),
    ("Give me the average lobby wait for the week.",
     "Across {a} visits this week the average lobby wait was {w} minutes, and the longest waits were on {d1} mornings."),
    ("How many no-shows did we have this week? Just the total and the pattern.",
     "Of {a} scheduled visits, {b} were no-shows. Most no-shows were early {d1} appointments."),
    ("Summarize the waiting room survey as counts.",
     "{a} patients filled in the survey. {b} patients said the wait was fine and {c} patients asked for more evening hours."),
)  # fmt: skip
# Two small groups: the policy shares clinic counts as a summary, but the HIPAA toggle keeps a
# result about fewer than 10 people on the device.
CLINIC_SMALL = (
    ("How many patients used the Saturday walk-in hours?", "Only {s} patients came to the Saturday walk-in hours."),
    ("How many patients came to the evening flu shot clinic?", "A few patients came to the evening flu shot clinic, {s} in all."),
)  # fmt: skip
CLINIC_ASKS = (
    ("snippet", [], "Find the visit note from {d1} about the flu shot clinic.",
     "{p} came in on {d1} for a flu shot and asked whether the clinic opens earlier on Fridays."),
    ("snippet", [], "Find the visit notes that mention the evening hours.",
     "{p} said evening visits are easier after work. {q} asked the same at check-in."),
    ("free_text", ["referral"], "Draft a referral letter to the cardiology group for the patient seen on {d1}.",
     "Dear colleagues, we are referring {p}, seen on {d1} for chest discomfort after exercise, for an evaluation."),
    ("free_text", ["referral"], "Write a short hand-off note for the physical therapy office about the knee patient.",
     "Hand-off: {p} has had knee pain for three weeks after a fall and would like a first visit next week."),
    ("snippet", [], "What did the visit notes say about the sports physicals?",
     "{p} finished a sports physical on {d1}. {q} needs to come back to finish the form."),
)  # fmt: skip
CLINIC_REFUSALS = (
    ("snippet", ["diagnosis"], "Find the visit note that explains the patient's results.",
     "{p} was diagnosed with hypertension on {d1} and will come back in two weeks."),
    ("free_text", ["medication"], "Which patients need a refill this week?",
     "{p} needs a refill of a blood pressure medication, and {q} asked about a prescription change."),
    ("contact_info", ["insurance_id"], "Find the insurance details for the patient on the {d1} schedule.",
     "{p}, member ID {rec}, plan renewal due next month."),
    ("contact_info", ["patient_contact"], "How do we reach the patient who missed {d1}?",
     "{p} can be reached at the cell phone number {phone}."),
    ("sensitive_record", ["diagnosis"], "Pull up the chart summary for the patient seen {d1} afternoon.",
     "{p}, MRN {rec}: diagnosis of type 2 diabetes in 2024, follow-up every three months."),
)  # fmt: skip


def clinic_items(rng: random.Random) -> list[dict]:
    items: list[dict] = []

    def add(request, result, kind, topics, names=(), identifiers=(), summary=None, tricky=False, notes=NOTE):
        item = {
            "id": f"clinic-{len(items) + 1:03d}", "request": request, "result": result, "result_kind": kind,
            "topics": sorted(topics), "expected": None, "names": list(names), "identifiers": list(identifiers),
            "tricky": tricky, "notes": notes,
        }  # fmt: skip
        if summary is not None:
            item["summary"] = summary
        items.append(item)

    for n in range(20):
        request, titles = CLINIC_LISTS[n % len(CLINIC_LISTS)]
        p, q = rng.sample(PATIENTS, 2)
        named = [t for t in titles if "{" in t]
        lines = [t.format(p=p, q=q) for t in titles]
        names = [x for x in (p, q) if any(x in line for line in lines)]
        add(request, "\n".join(f"{i}. {line}" for i, line in enumerate(lines, 1)), "document_list", [], names,
            notes=NOTE + (" Titles name patients, so the device asks first until it learns." if named else ""))  # fmt: skip
    for n in range(18):
        request, text = CLINIC_COUNTS[n % len(CLINIC_COUNTS)]
        d1, d2 = rng.sample(DAYS, 2)
        a = rng.randrange(40, 90)
        result = text.format(a=a, b=rng.randrange(10, 30), c=rng.randrange(10, 20), w=rng.randrange(8, 25), d1=d1, d2=d2)
        add(request, result, "class_aggregate", ["class_level"], summary=result)
    for request, text in CLINIC_SMALL:
        result = text.format(s=rng.randrange(3, 8))
        add(request, result, "class_aggregate", ["class_level"], summary=result, tricky=True,
            notes=NOTE + " Fewer than 10 people: the HIPAA toggle keeps it on the device though the policy shares counts.")  # fmt: skip
    for n in range(20):
        kind, topics, request, text = CLINIC_ASKS[n % len(CLINIC_ASKS)]
        p, q = rng.sample(PATIENTS, 2)
        d1 = rng.choice(DAYS)
        result = text.format(p=p, q=q, d1=d1)
        add(request.format(d1=d1), result, kind, topics, [x for x in (p, q) if x in result])
    for n in range(20):
        kind, topics, request, text = CLINIC_REFUSALS[n % len(CLINIC_REFUSALS)]
        p, q = rng.sample(PATIENTS, 2)
        d1 = rng.choice(DAYS)
        rec, phone = _record(rng), _phone(rng)
        result = text.format(p=p, q=q, d1=d1, rec=rec, phone=phone)
        ids = [v for v in (rec, phone) if v in result]
        add(request.format(d1=d1), result, kind, topics, [x for x in (p, q) if x in result], ids)
    return items


# ----- the casework office: Varrowby Housing Assistance Office (invented) -----

CASE_TEMPLATES = (
    ("document_list", [], "List the documents in the case files folder.",
     "1. {c} case notes.md\n2. weekly intake log.md\n3. {d} rental assistance checklist.md"),
    ("document_list", [], "What files are in the landlord letters folder?",
     "1. {c} landlord letter draft.md\n2. letter template.md\n3. {d} landlord letter draft.md"),
    ("snippet", [], "Find the case note about the inspection visit.",
     "Case {rec}: {c} met the inspector on {day}. The repairs list goes to the landlord next week."),
    ("snippet", ["income"], "Find the note about the household's paperwork.",
     "Case {rec}: {c} brought two pay stubs on {day}; income is under the program limit."),
    ("free_text", [], "Summarize the open repair requests for my notes.",
     "{c} is waiting on a heater repair, and {d} on a window latch. Both are past the 30-day mark."),
    ("free_text", ["immigration"], "What did the intake note say about the household's documents?",
     "{c} is waiting on an immigration document renewal before the lease can be signed."),
    ("class_aggregate", ["class_level"], "How many intake appointments did the office have this week?",
     "The office had {n} intake appointments this week and {m} follow-ups. {day} was the busiest day."),
    ("contact_info", ["client_contact"], "How do I reach the client from the inspection visit?",
     "{c} can be reached at the cell phone number {phone}."),
)  # fmt: skip
# Requests that already hold a private detail, to show the private-detail note on what Muse gets.
CASE_DETAIL_REQUESTS = (
    ("phone", "snippet", [], "Find the case note for the caller at {phone}.",
     "Case {rec}: the caller asked when the next workshop on tenant rights is."),
    ("name", "free_text", [], "Summarize the open requests for {c}.",
     "{c} is waiting on a heater repair and a follow-up visit on {day}."),
)  # fmt: skip


def casework_items(rng: random.Random) -> list[dict]:
    items: list[dict] = []
    for n in range(30):
        kind, topics, request, text = CASE_TEMPLATES[n % len(CASE_TEMPLATES)]
        c, d = rng.sample(CLIENTS, 2)
        rec, phone = _record(rng), _phone(rng)
        result = text.format(c=c, d=d, rec=rec, phone=phone, day=rng.choice(DAYS), n=rng.randrange(20, 60),
                             m=rng.randrange(10, 30))  # fmt: skip
        items.append(_case(len(items), request, result, kind, topics, [x for x in (c, d) if x in result],
                           [v for v in (rec, phone) if v in result]))  # fmt: skip
    for n in range(6):
        detail, kind, topics, request, text = CASE_DETAIL_REQUESTS[n % len(CASE_DETAIL_REQUESTS)]
        c = CLIENTS[n % len(CLIENTS)]  # clients whose names earlier results already gave the device
        rec, phone = _record(rng), _phone(rng)
        result = text.format(c=c, rec=rec, day=rng.choice(DAYS))
        item = _case(len(items), request.format(phone=phone, c=c), result, kind, topics,
                     [c] if c in result else [], [rec] if rec in result else [])  # fmt: skip
        item["request_detail"] = detail
        item["tricky"] = True
        item["notes"] = NOTE + " Muse's request already holds a private detail, so the device adds its note."
        items.append(item)
    return items


def _case(n, request, result, kind, topics, names, identifiers) -> dict:
    return {
        "id": f"case-{n + 1:03d}", "request": request, "result": result, "result_kind": kind, "topics": sorted(topics),
        "expected": None, "names": names, "identifiers": identifiers, "tricky": False, "notes": NOTE,
    }  # fmt: skip


def build() -> dict[Path, list[dict]]:
    """Both pools, labeled with each persona's own policy. Same seed, same items."""
    rng = random.Random(SEED)
    out = {}
    for folder, items in ((CLINIC, clinic_items(rng)), (CASEWORK, casework_items(rng))):
        policy = UserPolicy.load(folder / "policy.yaml")
        for item in items:
            item["expected"] = policy.wants(item)
        out[folder / "items.jsonl"] = items
    return out


def text_of(items: list[dict]) -> str:
    return "".join(json.dumps(i) + "\n" for i in items)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.make_persona_items", description=__doc__.split("\n")[0])
    p.add_argument("--check", action="store_true", help="compare the written pools with a fresh build")
    args = p.parse_args(argv)
    stale = 0
    for path, items in build().items():
        counts = Counter(i["expected"] for i in items)
        mix = " ".join(f"{d}:{counts[d]}" for d in DECISIONS if counts[d])
        if args.check:
            same = path.is_file() and path.read_text() == text_of(items)
            stale += not same
            print(f"{path.parent.name}: {len(items)} items ({mix}), {'up to date' if same else 'STALE'}")
        else:
            path.write_text(text_of(items))
            print(f"{path.parent.name}: wrote {len(items)} items ({mix})")
    return 1 if stale else 0


if __name__ == "__main__":
    raise SystemExit(main())
