# A simulated clinic front-desk coordinator (invented)

Simulated persona, invented data. This is not a person: it is a policy file (policy.yaml) plus seeded answering habits (persona.yaml, read by eval/persona.py). Its judgment comes from those files, nothing else.

The Brackenmoor Family Clinic is invented, and so is every patient. It is a clinic, not a school nurse's office (those records fall under FERPA). The HIPAA toggle is on. Clinic-level counts go out as a summary; each patient's visit notes and every referral letter wait for her OK; diagnoses, medications, insurance ids and contact details stay on the device. 10% of cards are answered after that night's dreaming.

What it tests: a non-school policy on the same router, the HIPAA toggle's extra tags and its hold on results about fewer than 10 people (two items are such counts, so the toggle refuses what the policy would share). Patients are not on the school roster, so the device tags them [Person N]; a [Patient A] label needs the roster's person_label field (SIM-12), which is not built.

Items: items.jsonl here, 80 invented items from seeded templates (`uv run python -m scripts.make_persona_items`), split by `uv run python -m scripts.relabel_for_persona --persona eval/personas/clinic_coordinator/persona.yaml --pool eval/personas/clinic_coordinator/items.jsonl --holdout-n 16 --unseen-n 16` into days.jsonl, holdout.jsonl and unseen.jsonl.

Run: see eval/reports/sim/PLAN.md for the pre-registered command, seeds and nights.
