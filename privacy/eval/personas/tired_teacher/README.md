# A simulated tired 4th-grade teacher (invented)

Simulated persona, invented data. This is not a person: it is a policy file (policy.yaml) plus seeded answering habits (persona.yaml, read by eval/persona.py). Its judgment comes from those files, nothing else.

The strict teacher's policy (policy.yaml is a copy of eval/user_policy.yaml) answered with noise: 10% of answers are the opposite of the policy, 30% of the time she forgets to tick "don't ask again", 20% of cards are answered after that night's dreaming, and 5% of remembered answers are deleted from the History page the next morning.

What it tests: that MIN_AGREEMENT and the gate hold under noisy answers, that late answers train the next night, and that a deleted answer leaves the next rebuild. Her answers differ from the labeling policy by design.

Items: eval/splits/sim_days.jsonl, sim_holdout.jsonl and sim_unseen.jsonl (the SIM-1 split, invented items written by Muse Spark), relabeled with this persona's policy by `uv run python -m scripts.relabel_for_persona --persona eval/personas/tired_teacher/persona.yaml` into days.jsonl, holdout.jsonl and unseen.jsonl here (sets.md has the counts).

Run: see eval/reports/sim/PLAN.md for the pre-registered command, seeds and nights.
