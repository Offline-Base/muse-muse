# A simulated strict 4th-grade teacher (invented)

Simulated persona, invented data. This is not a person: it is a policy file (policy.yaml) plus seeded answering habits (persona.yaml, read by eval/persona.py). Its judgment comes from those files, nothing else.

The reference run. Its policy.yaml is a byte-for-byte copy of eval/user_policy.yaml (a test keeps them equal), and it answers every card exactly as that policy's on_ask says: no slips, no late answers.

What it tests: whether dreaming removes unneeded asks for the policy every other eval number uses, with 0 leaks, 0 missed asks and 0 refusals shared. Every other persona is compared with this one.

Items: eval/splits/sim_days.jsonl, sim_holdout.jsonl and sim_unseen.jsonl (the SIM-1 split, invented items written by Muse Spark), relabeled with this persona's policy by `uv run python -m scripts.relabel_for_persona --persona eval/personas/strict_teacher/persona.yaml` into days.jsonl, holdout.jsonl and unseen.jsonl here (sets.md has the counts).

Run: see eval/reports/sim/PLAN.md for the pre-registered command, seeds and nights.
