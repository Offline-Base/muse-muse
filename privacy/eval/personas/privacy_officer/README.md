# A simulated district privacy reviewer (invented)

Simulated persona, invented data. This is not a person: it is a policy file (policy.yaml) plus seeded answering habits (persona.yaml, read by eval/persona.py). Its judgment comes from those files, nothing else.

The FERPA and COPPA toggles are on, on a classroom device that runs the strict teacher's policy (policy.yaml is a copy of eval/user_policy.yaml). The reviewer never answers cards (ignore_p 1), so nothing is learned and the asks stay as they are.

What it produces: a checklist, not an opinion. scripts/audit_replay.py replays every receipt in the simulated home against what Muse got, and maps each control to the rule it relates to, with this run's counts. It has no persona voice, quotes or verdicts, and makes no finding about any law.

Items: eval/splits/sim_days.jsonl, sim_holdout.jsonl and sim_unseen.jsonl (the SIM-1 split, invented items written by Muse Spark), relabeled with this persona's policy by `uv run python -m scripts.relabel_for_persona --persona eval/personas/privacy_officer/persona.yaml` into days.jsonl, holdout.jsonl and unseen.jsonl here (sets.md has the counts).

Run: see eval/reports/sim/PLAN.md for the pre-registered command, seeds and nights.
