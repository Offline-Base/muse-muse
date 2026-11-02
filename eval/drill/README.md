# Cold-room drill set (Simulated)

Invented cold-room log windows for the edge drill, written by `scripts/dev/drill-bench.py` from a fixed seed. No model wrote any row, so the set is rights-clean. Every room, site, reading and record number is made up. Nothing here is about a real freezer or a real store, and nothing here is food-safety advice: the actions only point to the site's own people and procedure.

## What one item is

A window of 10 to 12 readings, 5 minutes apart: record number, time, setpoint, controller reading, independent probe reading, door, defrost, power and cloud status. The answer is one JSON object:

```
{"status": "normal|watch|alert", "trust_controller": true|false, "likely_cause": "...", "actions": ["..."], "escalate": true|false}
```

Causes, spread evenly: `none`, `door_open`, `defrost_stuck`, `setpoint_changed` (pushed to 10, 25, 40 or 50 C), `controller_probe_mismatch` (most often a controller that holds steady while the probe climbs), `probe_dropout`, `power_gap` (missing readings around a power loss) and `cloud_down`. A cloud outage can also sit on top of another cause. Normal windows include decoys: one reading with the door open, or a short defrost.

The rules and the action ids are in the system line (`SYSTEM` in the script), so a base model and a tuned one get the same instructions.

## Files

| File | In git | What |
|---|---|---|
| `sealed.jsonl` | yes | 100 held-out items, sha256 `52b23493d1f832aebf717829469091ded8029b77fc82b517544746c94346f3dd`. Two log layouts and four setpoints and room names that training never uses. A file with any other hash is not this set |
| `demo-spoofed-controller.csv` | yes | For filming: the controller reads -18.0 or -18.1 the whole time while the probe climbs to +9.4, with the cloud down at the end. Answer: `controller_probe_mismatch`, don't trust the controller |
| `demo-calm-cloud-down.csv` | yes | For filming: a calm room whose cloud link drops. Answer: `cloud_down`, normal |
| `train.jsonl` | no | 900 rows of `{messages}` (system, user, assistant): the format `train_model` and `scripts/dev/tune-harness.ts` read. sha256 `0fb64c3cb5058d54811c2134dc4c6cd67b656c681a8d0075406b9532e1f26238` |
| `folder/` | no | The same 900 rows as `{prompt, answer}`, 100 to a file, for a TUNE_FOLDER drop. The folder scan keeps all 900 and drops none (checked by `scripts/dev/drill-bench.test.ts`) |
| `dev.jsonl` | no | 50 kept-aside rows of `{prompt, reference}`, in the training layouts, for a pilot. sha256 `90653359d9ec97340421f29a317c71165429248a6c18363ba16817274f512915` |

Make the ones not in git with:

```
python3 scripts/dev/drill-bench.py make --out eval/drill
```

The same seed gives the same bytes. No sealed prompt is in training, and no two prompts anywhere are near-duplicates by the dataset split's own rule (lib/train/logic.ts, word overlap 0.7), so the platform won't drop rows.

## Scoring

```
python3 scripts/dev/drill-bench.py ask --heldout eval/drill/sealed.jsonl --url <OpenAI-compatible base ending in /v1> --model <id> --label "<row name>" --out answers.jsonl
python3 scripts/dev/drill-bench.py score --heldout eval/drill/sealed.jsonl --answers answers.jsonl
```

`ask` runs at temperature 0. `--schema` sends `response_format` json_schema, `--header "Name: value"` adds a header, and a bearer key, if one is needed, is read from the variable named by `--key-env` (default `DRILL_API_KEY`) and never printed. Only send this made-up data; the text goes wherever `--url` points. So far `ask` has only been run against a local fake in the tests.

Every field is graded by code: status, trust_controller, likely_cause and escalate must match exactly (a string "false" is not false), and actions must be the same set, in any order, with the overlap also reported. An item is all right only when all five match.

**The hard rule:** when the controller and the probe differ by more than 3.0 C on any reading, `trust_controller` must be false. Every answer that trusts the controller there, or gives no answer, is counted as a violation on its own line. The rule passes only at 0.

Limits, stated up front: the right answer follows from written rules, so a few lines of code get 100%. The set measures whether a small model applies those rules to logs it hasn't seen, not judgment. For scale, answering "normal" every time scores 13% all right and breaks the hard rule on all 12 mismatch items. No model has been scored on this set yet.
