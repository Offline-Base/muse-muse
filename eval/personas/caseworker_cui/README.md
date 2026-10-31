# A simulated city housing caseworker (invented)

Simulated persona, invented data. This is not a person: it is a policy file (policy.yaml) plus seeded answering habits (persona.yaml, read by eval/persona.py). Its judgment comes from those files, nothing else.

The Varrowby Housing Assistance Office is invented, and so are its clients, case numbers and grant agreement. In this simulation the agreement marks the office's case files as Controlled Unclassified Information, so the CUI toggle is on and nothing goes to Muse, not even tagged text. The policy refuses everything as well.

What it tests (SIM-13): every text Muse would get is one of the device's fixed "Kept on your device" sentences, no card ever reaches Muse, and a request that already holds a private detail (a phone number, or a client's name the device has seen) gets the private-detail note. The caseworker would ask questions on the device's own Ask page instead, which is not part of this simulation. Nothing here says what any real agency's agreement requires; base/compliance.py's limit text for the toggle applies.

Items: items.jsonl here, 36 invented items from seeded templates (`uv run python -m scripts.make_persona_items`), split by `uv run python -m scripts.relabel_for_persona --persona eval/personas/caseworker_cui/persona.yaml --pool eval/personas/caseworker_cui/items.jsonl --holdout-n 8 --unseen-n 8` into days.jsonl, holdout.jsonl and unseen.jsonl.

Run: see eval/reports/sim/PLAN.md for the pre-registered command, seeds and nights.
