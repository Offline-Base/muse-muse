# A simulated relaxed 7th-grade ELA teacher (invented)

Simulated persona, invented data. This is not a person: it is a policy file (policy.yaml) plus seeded answering habits (persona.yaml, read by eval/persona.py). Its judgment comes from those files, nothing else.

Shares almost everything tagged and ticks "don't ask again". The never-share topics are still refused, and she wants to see every note meant for a family (approve, never remember). 3% of her answers are the opposite of her policy.

What it tests: a persona whose labels differ from the strict teacher's (the relabel count is in sets.md once written). Staff and full-text requests are shares for her, so dreaming may learn share rules the strict teacher never gets, while the router's outside-the-class floor still asks until she teaches one.

Items: eval/sim/days.jsonl, eval/sim/holdout.jsonl and eval/sim/unseen.jsonl (the SIM-1 split, invented items written by Muse Spark), relabeled with this persona's policy by `uv run python -m scripts.relabel_for_persona --persona eval/personas/{pid}/persona.yaml` into days.jsonl, holdout.jsonl and unseen.jsonl here. Until that split exists, the sets are not written.

Run: see eval/reports/sim/PLAN.md for the pre-registered command, seeds and nights.
