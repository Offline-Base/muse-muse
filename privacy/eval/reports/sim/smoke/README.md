# Pipeline smoke (simulated, invented items): not a study result

One night of the simulated privacy_officer persona (FERPA and COPPA toggles on, cards never answered), with 10 day items from eval/tasks.jsonl and the 20 eval/holdout.jsonl items, on LFM3-VL-2B running on this laptop with a throwaway BASE_HOME. It ran once after eval/reports/sim/PLAN.md was written, to check that the persona, its toggles in every scoring home, the ledger of what Muse got and the receipt audit work end to end with the real local model. Each command is at the top of its report in privacy_officer/.

It is not one of the study's runs: the items are the development set, not the persona's own sets, and one night with a persona that never answers cannot show learning. What it showed about the pipeline:

- The run took 34 seconds, about 14 seconds a night with a 20-item gate, much less than the plan's estimate.
- Receipt mismatches: 0 (privacy_officer/receipts.md).
- The same rules scored 60.0% and 65.0% on the same 20 holdout items in two scorings of one run (night 0 and the gate's current rules), with no rule learned in between: the local model's labels vary from run to run by about one item in 20. The plan's primary number is paired on the unseen set for this reason.
- With these toggles, the night-0 holdout already had 2 missed asks and 1 refusal shared, before any learning.
- In an earlier try of this smoke, the name check reported common phrases ("garden essay", "organization") as names after texts holding them had been shared. The receipt audit now counts those apart (Shared texts with a word the name check reported only later) instead of as mismatches.
