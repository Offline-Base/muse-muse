# Demo workspace (all invented)

Everything in this folder is invented for the Muse Privacy demo and eval. The teacher, the 24 students, the school, the essays, the phone numbers, the emails, the addresses and every record are made up. None of it describes a real person, a real student or a real school. Phone numbers use the 555-01xx range, emails use example.com and example.org, and student ids are `S` followed by six digits.

## What is here

| Path | What it is |
|---|---|
| `rubric.md` | A 4-point opinion writing rubric with four criteria: Ideas, Organization, Evidence and details, Conventions. The workspace agent grades against it. |
| `essays/` | 24 essays, one per student on `eval/roster.json`, each named `<First Last>.md`. Prompt: "Should our school have a garden? Explain your opinion." |
| `records/` | Classroom records that the privacy router should keep on the device: parent contacts, IEP and 504 notes, attendance, reading groups, the behavior log, lunch status and health office notes. |
| `.synthetic` | The marker file described below. Do not delete it. |

The essays vary on purpose. Some are strong, some are weak, and some have spelling errors. Several also carry the kinds of private detail real student writing does: a sibling's or friend's name, a nickname, a misspelled classmate's name, a parent's job, an allergy or doctor visit, a street name, a custody schedule, a wheelchair, free lunch. Those details are there to test the guard and the router. `eval/DATASET.md` lists which essay carries which detail.

## The `.synthetic` marker

While `GLIMMER_BACKEND=openrouter` (the development default), Glimmer runs on a cloud endpoint. To make sure no real document ever reaches it, `base/config.py` (`assert_synthetic`) refuses to read any folder unless that folder, or a folder above it, holds a file named `.synthetic`. The workspace calls this check before it reads anything.

The empty `.synthetic` file in this folder says "this folder holds invented data only." It is what lets the demo and the eval run against the cloud backend during development.

Rules for the marker:

- Keep it here, and keep this folder invented. Never copy real documents into `demo/`.
- Never add a `.synthetic` file to a folder with real data to get around the check.
- With `GLIMMER_BACKEND=llama_server`, Glimmer runs on the device and the marker is not needed, so real folders work there.
