# ROUTER_LOOSEN fixes on dev items

Invented items, labeled by the strict teacher's policy (eval/user_policy.yaml); no simulated user answers anything here. Run on Oct 31, 2026 at about 02:00 ET on commit 5e04a4f, before any persona study run, to choose which fixes the study and the shipped default use.

Each run, one at a time through the model-slot lock, with a fresh throwaway BASE_HOME and `ROUTER_LOOSEN=<fix>` (none, lists, result_words, class_of, all):

```
uv run python -m eval.run_eval --set eval/splits/sim_days.jsonl --limit 200 --name loosen_<fix>_sim_days200 \
    --out eval/reports/sim/fixes_dev --device-label "laptop (LFM3-VL-2B labels, policy decides, device only, ROUTER_LOOSEN=<fix>)"
uv run python -m scripts.ask_causes --raw eval/reports/sim/fixes_dev/raw/loosen_<fix>_sim_days200.jsonl \
    --set eval/splits/sim_days.jsonl --out eval/reports/sim/fixes_dev
```

The files were then moved to eval/reports/dev/loosen/, because eval/reports/sim/ holds only the persona study. Items: the first 200 of eval/splits/sim_days.jsonl, the simulation's free-to-read day items. Not the study's holdout or unseen sets, and not fresh_200_c. Device only: LFM3-VL-2B on this laptop labels the request and writes summaries; the policy decides; no learned rules.

| ROUTER_LOOSEN | Decision accuracy | Leaks | Approval requests | Needless asks | Missed asks | Refusals shared | Unsafe shares | Over-refusals | Fixed / broke vs none |
|---|---|---|---|---|---|---|---|---|---|
| none | 70.0% (140/200) | 0 | 84 | 47 | 3 | 0 | 3 | 2 | baseline |
| lists | 71.0% (142/200) | 0 | 85 | 47 | 3 | 0 | 3 | 0 | 2 / 0 |
| result_words | 81.0% (162/200) | 0 | 70 | 32 | 3 | 0 | 3 | 0 | 22 / 0 |
| class_of | 71.5% (143/200) | 0 | 85 | 47 | 3 | 0 | 3 | 0 | 3 / 0 |
| all | 79.5% (159/200) | 0 | 69 | 33 | 3 | 0 | 3 | 2 | 20 / 1 |

Fixed and broke count items whose decision changed against the none run and now match (or no longer match) the policy's wants. No fix turned an ask or a refusal into a share: the 3 unsafe shares are the same items in every run.

How to read it:
- result_words is the only fix whose effect is larger than the run-to-run noise of LFM's labels (1 to 3 items on these sets; the none run's 2 over-refusals are gone in three runs that change nothing about refusals). It cut needless asks from 47 to 32 with 22 items fixed and none broken (exact McNemar p about 5e-7).
- lists acts only when the user has taught a share rule for a document list's exact group, and these runs have no learned rules, so they cannot show its effect. The persona study, which learns rules over 10 nights, can.
- class_of changed 3 items, within the noise.
