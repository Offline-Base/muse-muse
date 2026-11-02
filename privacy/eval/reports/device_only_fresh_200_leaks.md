# The 10 leaks in device_only_fresh_200, explained

Commands, none of which calls a model (the device model is faked inside httpx; see `scripts/replay_null_names.py`):

```sh
uv run python -m scripts.replay_null_names --set eval/fresh_200.jsonl
uv run python -m scripts.replay_null_names --set eval/fresh_200.jsonl --no-name-shapes
uv run python -m scripts.replay_null_names --set eval/fresh_200_b.jsonl [--no-name-shapes]
uv run python -m scripts.replay_null_names --set eval/tasks.jsonl [--no-name-shapes]
uv run pytest tests/test_oct30_leaks.py -q
```

Written Nov 2 from saved artifacts only: [device_only_fresh_200.md](device_only_fresh_200.md), its raw rows (`raw/device_only_fresh_200.jsonl`, ids and decisions only), the items in `eval/fresh_200.jsonl`, the neighbouring reports and the git history. Nothing was rerun with a model. All items, names and texts are invented.

## Short answer

All 10 were names of people the roster does not know, written by Muse Spark into invented results. In device-only mode the only thing that could catch such a name on Oct 30 was LFM3-VL-2B's name pass, and it missed these 10. Nothing deterministic stood behind it, and the final leak check only knows roster names, identifiers and values already in the tag map, so it could not catch them either. Before the next run, nine minutes later by the report dates, a deterministic name-shape check was added (`guard.Redaction.name_shapes`, on whenever `DEVICE_ONLY=1`): capitalized words shaped like a name, with at least one word that is not a common English word, are tagged as `[Person N]` with no model call. The two runs after it reported 0 leaks on 300 items, and the replay below shows the check alone covers all 10, even when the model finds no names at all.

## What leaked, item by item

Leak kind is `name` for every one: the item's listed name appeared in the text Muse received. "At once" means it was in the result as shared; "after approval" means the result waited for the simulated teacher, who approved it, and the released text held the name.

| Item | Kind | Expected | Oct 30 decision | When it leaked | Invented name (off the roster) | Replay, name pass finds nothing, no name shapes | Replay, with name shapes |
|---|---|---|---|---|---|---|---|
| syn-0533 | snippet | share_tagged | share_tagged | at once | Xyla Winterbourne | leaks | no leak |
| syn-1560 | free_text | ask_user | ask_user | after approval | Urmond Pellwater | leaks | no leak |
| syn-1599 | snippet | share_tagged | share_tagged | at once | Briseis Thundermeadow | leaks | no leak |
| syn-0390 | free_text | ask_user | ask_user | after approval | Edrin Valemist | leaks | no leak |
| syn-0177 | snippet | share_tagged | share_tagged | at once | Florimond Ashglade | leaks | no leak |
| syn-0366 | snippet | share_tagged | share_tagged | at once | Annora Duskpetal | leaks | no leak |
| syn-1822 | free_text | share_tagged | share_tagged | at once | Bracha Willowfen | leaks | no leak |
| syn-0966 | snippet | share_tagged | ask_user | after approval | Zirconia Featherdown | leaks | no leak |
| syn-0932 | free_text | ask_user | ask_user | after approval | Uziah Stormbraid | leaks | no leak |
| syn-0757 | free_text | share_tagged | share_tagged | at once | Belvia Larkbloom (and "Belvia" alone) | leaks | no leak |

That is the report's 10: 6 at once and 4 after approval (7 of the 10 were share_tagged items, 3 were ask_user). In 9 of the 10 the name is the first words of the result ("Xyla Winterbourne wrote ..."); in syn-1560 it follows "Hello family of". In the replay with no name shapes, syn-0966 is shared at once instead of after approval, because the fake labeler gives no request topics where LFM3-VL-2B had labeled it `third_party`; it leaks either way.

## The cause

- `DEVICE_ONLY=1` had just put every model step on LFM3-VL-2B (Oct 30, Ethan's call), including the name pass that finds names the roster misses.
- Tagging an off-roster name needs some step to find it first. The roster cannot know these people, and the final leak check (`guard.leaks`) looks for roster forms, identifiers and tag-map values only, so a name no step found passes it. The name pass was the single point of failure.
- On 10 of 200 items the 2B model's pass did not report the name. Why it missed these 10 and not others is unknown (below).

It was a gap in the checker, not in the policy: 9 of the 10 decisions matched the expected one, and the tenth (syn-0966) asked where sharing tagged was expected, which is stricter. Tagging is what should have removed the names.

## The fix, and when

- `guard.Redaction.name_shapes` (`base/guard.py`, `_apply_redaction` calling `_strict_details(..., kind="person", need_uncommon=True)`), switched on by `Egress._redaction_for` whenever `settings.device_only` is set. Every value it tags joins the tag map, so the final leak check knows it afterwards.
- When: the report is dated 2026-10-30 14:38. The next two reports, `device_only_final.md` (14:47, `eval/tasks.jsonl`, 100 items) and `device_only_unseen_200.md` (14:48, `eval/fresh_200_b.jsonl`, 200 items), report 0 leaks: the "0 on 300". docs/COMPLIANCE_PLAN.md names the cause in one line ("A deterministic name-shape check fixed that"), but the report itself never said so.
- Commit: the work from that afternoon is not in git as separate commits. In the original Muse Privacy repo it was squashed into seven commits all stamped 2026-10-30 22:12:31 (5af98a9 to 92ee1a7), and `name_shapes` first appears in `base/guard.py` and `base/egress.py` in 7440a0d ("Add privacy toggles for regulated work, with receipts and retention"). In this repo it arrived with the merge of `privacy/` (3a6282b2). No commit holds the code exactly as it ran at 14:38.

## Proof without a model

`scripts/replay_null_names.py` runs each item through the real egress in device-only mode, the same scoring as `eval.run_eval` (the simulated teacher approves what she would, and the released text is checked too), with LFM3-VL-2B replaced by a fake whose name pass never reports a name: the worst the model can do.

| Set | Items | Name shapes on | Name shapes off |
|---|---|---|---|
| `fresh_200.jsonl`, the 10 leaked items | 10 | 0 leaks | 10 leaks (all 10) |
| `fresh_200.jsonl` | 200 | 0 leaks | 53 leaks (31 at once, 22 after approval) |
| `fresh_200_b.jsonl` | 200 | 0 leaks | 53 leaks (46 at once, 7 after approval) |
| `tasks.jsonl` | 100 | 0 leaks | 3 leaks (3 at once) |

0 errors and 0 fallbacks in every row. So on these 500 invented items the name-shape check alone keeps every listed name out of what Muse receives, with no help from the model, and taking it away brings back all 10 Oct 30 leaks. `tests/test_oct30_leaks.py` pins the 10: it fails if the check stops covering any of them, and it shows the replay itself would have caught the Oct 30 code. No change to the checker or policy was needed beyond what landed on Oct 30.

## Still unknown or open

- **Why the model missed these 10.** The raw rows keep ids and decisions only, not the model's replies, so whether LFM3-VL-2B returned no names, part of a name, or a reply that did not parse cannot be told now.
- **`fresh_200` was read while the check was written.** The check was written to answer these leaks, so 0 on `fresh_200` is in-sample. `fresh_200_b` (0 with the model at 14:48, 0 in the replay) was not read for it, but it is drawn from the same Spark-written pool, with the same style of unusual invented names.
- **Names made of common words are not covered.** The check skips a run made only of common words, and lowercase words. Fed straight to `guard.tag` with name shapes on and no model, "Grace Hunter wrote about rivers.", "The essay by Rose Hill was strong.", "Feedback for Mark: add detail.", "Score for Penny Baker: 17/20." and "xyla winterbourne wrote a poem." come back unchanged, and "Ask Jordan May about the trip." becomes "Ask [Person 1] May about the trip.". For names like these the device still depends on the model's name pass, and none of the eval sets above tests them. Reproduce with:
  `uv run python -c "from base import guard; r = guard.Redaction(name_shapes=True); print(guard.tag('Grace Hunter wrote about rivers.', None, None, redaction=r).text)"`
- **Today's decisions on `fresh_200` with the model.** Not measured since Oct 30. The leak question does not need it (the replay is the worst case for the name pass), but agreement and approval counts on this set would change.

## Optional rerun with the model

Not run. It would confirm the replay with the real name pass and give today's decision numbers on `fresh_200`:

```sh
uv run python -m eval.run_eval --set eval/fresh_200.jsonl --name device_only_fresh_200_rerun --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only)'
```

It needs `DEVICE_ONLY=1` and LFM3-VL-2B (Q4_K_M with its projector) serving on 127.0.0.1:8083 through llama-server (`scripts/start_checker.sh`), on the laptop that ran the Oct 30 run, or any machine with llama.cpp b11960 or newer and the same GGUF files. It runs no Glimmer and calls nothing off the device. Never on jetson-05, which is kept out of experiments.
