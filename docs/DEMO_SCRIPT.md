# Demo video script

About two and a half minutes, ending on measured results, because the startup track judges technical execution and whether it holds up in production. Scenes follow the build plan. Every number said or shown must come from [eval/reports/final.md](../eval/reports/final.md); do not round it into something the report does not say.

## Say which Glimmer graded

The plan's video has Glimmer grading on the device. As of Oct 27 every run so far used Glimmer on OpenRouter (development mode, invented data only). Before recording, pick one and say it on screen:

| If you record with | Caption for scenes 0:45 to 1:25 |
|---|---|
| `GLIMMER_BACKEND=llama_server` on the laptop (Q4_K_M) | "Muse Glimmer Q4_K_M grading on this laptop." |
| A Jetson with the laptop worker | "Jetson Orin Nano, 1-bit Glimmer, grading handed to the laptop's 4-bit Glimmer." |
| `GLIMMER_BACKEND=openrouter` (today's only tested mode) | "Development mode: Glimmer on OpenRouter, invented students only. On a real class it runs on the device." |

## Before recording

On the laptop, from the repo root, with `.env` set up as in the [README](../README.md) and Muse paired as in [MUSE_SETUP.md](MUSE_SETUP.md):

```sh
uv sync && uv run pytest -q                             # green before filming
# Fresh first day: keep relay.json, connector_token and tagmap.json so Muse stays paired.
mv ~/.base/base.db ~/.base/base.db.before-demo 2>/dev/null; rm -f ~/.base/router_rules.md; rm -rf ~/.base/output
uv run python -m base.light --test                      # only with the light plugged in and LIGHT_SERIAL set; Ctrl-C after one cycle
uv run python -m base                                   # terminal 1
uv run python -m base.connector.relay_client run        # terminal 2
```

On llama-server use `scripts/start.sh` instead of `python -m base` in terminal 1.

Open these in the browser before you start:

| Tab | URL | Shows |
|---|---|---|
| Approvals | `http://127.0.0.1:8787/` | the card Muse is waiting on, with Share it / Keep it here |
| History | `http://127.0.0.1:8787/history` | every decision, deletable |
| Dreaming | `http://127.0.0.1:8787/dreaming` | last night's numbers and the Dream now button |
| Device | `http://127.0.0.1:8787/device` | which Glimmer is running and the device state |
| Chart | `eval/reports/final/five_nights.png` | the five-night chart |

Have Finder open on `demo/essays` (the invented class) and on `~/.base/output` (empty).

The router decides each result on its own. On a first day with no learned rules it should ask about per-student grades, which gives the amber scene. If a rehearsal shares without asking, give it the one learned rule the e2e test uses (what a night writes after the teacher asked three times to keep being asked), then restart terminal 1:

```sh
uv run python -c "from base.config import load_settings; from base.dreaming import train; s = load_settings(); s.ensure_home(); s.paths.router_prompt.write_text(train.render_rules([train.Rule('per_student', ('grades', 'writing'), 'ask_user', count=3, total=3, source='user')], user_count=3, synthetic_count=0, day='2026-11-03'))"
```

If you use that rule, say "after a few days of her answers" in scene 1:05, not "on day one".

For scene 1:45, set up the two scheduled jobs from [MUSE_SETUP.md](MUSE_SETUP.md#6-the-two-scheduled-jobs) the day before, and let one night run. Screenshot the 8 AM message.

## Scenes

| Time | Scene | On screen | Do or say |
|---|---|---|---|
| 0:00 | The problem | Finder on `demo/essays`: 24 essays. Text: "24 essays she can't upload to any AI. Same for clinics and city casework." | "Muse can't touch the private, tedious work that's most ready for automation." |
| 0:15 | The ask | The Muse app, a new chat | Type: "Grade each essay in my essays folder against rubric.md and draft feedback for each student." |
| 0:30 | Muse plans | Muse's plan and its list_documents call, showing `[Student A]`, `[Student B]`... | "Muse plans the job with tags. It never sees a name." |
| 0:45 | The device works | The light (or plush) green; the Device tab showing working; terminal 1 quiet | "Every step that reads an essay runs on the device, with Muse Glimmer." Caption from the table above. |
| 1:05 | Her OK | The light pulses amber; the Approvals tab with the card: the exact tagged per-student table and the router's reason | Ask Muse "Is the grading done?" It says it is waiting for her OK. Press **Share it** (with remember ticked). The light flashes blue. |
| 1:25 | The result | Muse's answer with class results by tag; then Finder on `~/.base/output/<job id>/` with 24 `<Name> feedback.md` files; open one | "Muse got tags. The feedback with real names never left her laptop." |
| 1:45 | Dreaming | The 8 AM message from Muse (or the Dreaming tab after **Dream now**), then `eval/reports/final/five_nights.png` | Read the one-sentence morning message. Then the chart: approval requests per day and holdout agreement per night. Say only what the chart and final.md show (see the note below). |
| 2:10 | Why it matters | Text: "12% of consumers fully trust organizations with their identity data (Ping Identity, 2026). 77% worry about AI agents acting for them (Thales, 2026)." Then: "Schools. Healthcare. City agencies." | "These are the sectors that can't use Muse today." |
| 2:25 | Close | The leak line from final.md, as it stands when you record (see below). "Built on Muse and Muse Glimmer: Q4_K_M on a laptop, i1-IQ1_S on a Jetson Orin Nano." | "Personal superintelligence that can work on your private life." |

The plan had the approval card show a tagged class summary. The code shows the tagged per-student table, because grading results go out as per-student results (see docs/DECISIONS.md). The scene works the same way; just do not call it a summary.

## What the chart may and may not claim

Say what `eval/reports/final/nights.md` says, nothing more:

- Leaks, as of Oct 27: 0 in the 100-item run, the holdout, every night's holdout scoring and both grading jobs. One text on simulated day 5 was flagged by the eval's checker; it is a false positive (the verb "rose" matched the invented student Rose). Until the checker is fixed and the five nights are rerun, do not put "Leaks: 0 on every run" on screen. "0 leaks in 100 eval items and two 24-essay grading jobs" is accurate.
- The chart's own "Leaks: 0 on every night" line counts the holdout runs only.
- Approval requests per day and holdout accuracy per night are from a simulated teacher (`eval/user_policy.yaml`), not a real one.
- In the final run the gate kept no night's rules: approval requests went 11, 12, 9, 8, 10 and holdout agreement stayed at 75%. The honest line is "dreaming never made it less safe; on what the connector really sends, it has not learned much yet", not "it learns your rules". The tuning run's rising chart (`eval/reports/five_nights.png`) used hand labels and practice data labeled with the teacher's own policy; if you show it, caption it "upper bound, hand-labeled inputs".

## Fallbacks while filming

| If | Then |
|---|---|
| The Muse app will not take the connector | Film the same prompts in Muse Code (MUSE_SETUP.md, step 5) |
| The light or the plush is not ready | Film the Device tab's state instead, or the bare board with the plush beside it as a prop |
| The scheduled 8 AM message did not arrive | Press Dream now on the Dreaming tab, then ask Muse "How did the dreaming run go? One sentence with the numbers." |
| Grading is slow on the device | Grade a smaller folder and say how many essays on screen |
| Anything leaks in a rehearsal | Stop. Do not record. Fix it and rerun the eval first |

## Submission checklist

- [ ] Video uploaded, unlisted link tested in a private browser window
- [ ] README numbers match `eval/reports/final.md`
- [ ] docs/PRIOR_WORK.md checked against the Official Rules
- [ ] `uv run python -m scripts.secrets_scan --history --report eval/reports/secrets_scan.md` finds nothing
- [ ] Submitted by noon ET Nov 4, and the confirmation saved
