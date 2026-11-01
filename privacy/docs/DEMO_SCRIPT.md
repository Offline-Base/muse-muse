# Demo video script

About two and a half minutes, and never over three: other participants report a 3-minute limit, so confirm it in the signed-in participant guide. Every project is scored on Impact 30%, Use of Meta AI Tooling 25%, Demo 25% (which names "the quality of the demo video") and Technical Depth & Execution 20% ([RUBRIC.md](RUBRIC.md)). Demo (25%) covers the live demo and the video together, and the video is most of what judges see, so it has to show who this helps and what Meta's models do here, not only the measured results it ends on. Scenes follow the build plan. Every number said or shown must come from [eval/reports/final.md](../eval/reports/final.md); do not round it into something the report does not say. The only exceptions are the two survey figures in scene 2:10, which are other people's numbers (see the note under the scenes).

## Say which model ran

As of Oct 30 the device runs Liquid's LFM3-VL-2B for every step (`DEVICE_ONLY=1`), and the user's policy makes the sharing decision. Older sections of this script mention Glimmer: use the first row unless Glimmer is running on the device. Pick one and say it on screen:

| If you record with | Caption for scenes 0:45 to 1:25 |
|---|---|
| `DEVICE_ONLY=1` (today's setup) | "Liquid's LFM3-VL-2B on this laptop. No model is reached off this device." |
| `GLIMMER_BACKEND=llama_server` on the laptop (Q4_K_M) | "Muse Glimmer Q4_K_M grading on this laptop." |
| A Jetson with the laptop worker | "Jetson Orin Nano, 1-bit Glimmer, grading handed to the laptop's 4-bit Glimmer." |
| `GLIMMER_BACKEND=openrouter` (today's only tested mode) | "Development mode: Glimmer on OpenRouter, invented students only. On a real class it runs on the device." |

## The privacy scene (add it to the video)

1. On Controls, turn on FERPA, and point out that the Always approve and opt-out controls are now locked.
2. In Muse, ask for something with a place, a date and an organization. Show the tags that come back.
3. Ask for something about three students. Show it kept on the device, with the plain reason.
4. Open History, then Receipt: what was removed, the checks, "On this device only".
5. Say the limits out loud: Muse sees whatever you type into it, which is what Prepare a question is for, and a toggle does not make anyone compliant.

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
| 0:00 | The problem | Finder on `demo/essays`: 24 essays. Text: "24 essays, a student's name in every one. Same for clinics and city casework." | "Muse could read these essays, but only by copying them, names and all, into its cloud computer." |
| 0:15 | The ask | The Muse app, a new chat | Type: "Grade each essay in my essays folder against rubric.md and draft feedback for each student." |
| 0:30 | Muse plans | Muse's plan and its list_documents call, showing `[Student A]`, `[Student B]`... | "Muse plans the job with tags. In this run every name it gets is a tag." |
| 0:45 | The device works | The light (or plush) green; the Device tab showing working; terminal 1 quiet | With llama_server: "Every step that reads an essay runs on this laptop, with Muse Glimmer." With OpenRouter: "Every step that reads an essay runs with Muse Glimmer, here on OpenRouter with invented students; on a real class it runs on the device." Caption from the table above. |
| 1:05 | Her OK | The light pulses amber; the Approvals tab with the card: Muse's request, the exact tagged per-student table and the router's reason | Ask Muse "Is the grading done?" It says it is waiting for her OK. Press **Share it** (with remember ticked). The light flashes blue. |
| 1:25 | The result | Muse's answer with class results by tag; then Finder on `~/.base/output/<job id>/` with 24 `<Name> feedback.md` files; open one | "Muse got tags. The feedback files with real names were written only on her laptop." |
| 1:45 | Dreaming | The 8 AM message from Muse (or the Dreaming tab after **Dream now**), then `eval/reports/final/five_nights.png` with the caption "Simulated teacher, invented items." | Read the one-sentence morning message. Then the chart: approval requests per day and holdout agreement per night. Say only what the chart and final.md show (see the note below). |
| 2:10 | Why it matters | Text: "12% of consumers fully trust organizations with their identity data (Ping Identity, 2026). 77% worry about AI agents acting for them (Thales, 2026)." Then: "Schools. Healthcare. City agencies." | "These are the places where records have to stay with whoever holds them. Muse Privacy lets Muse help without taking them." If Ethan has a teacher's quote and a minutes-saved estimate (HANDOFF row 18), use them here instead of the survey figures. |
| 2:25 | Close | The leak line from final.md, as it stands when you record (see below). "Built on Muse and Muse Glimmer", then the Glimmer that actually graded in this video, from the caption table above. Name the Jetson's i1-IQ1_S only if it ran before recording. | "Personal superintelligence that can work on your private life." |

The two survey figures in scene 2:10 are not measured here and are not in eval/reports. They come from Ping Identity's 2026 consumer survey (12% of consumers fully trust organizations to manage their identity data) and Thales's 2026 Digital Trust Index (77% uneasy about AI agents acting on their behalf; [cpl.thalesgroup.com/digital-trust-index](https://cpl.thalesgroup.com/digital-trust-index)). They were checked only against press coverage on Oct 27. Before recording, open each published report, confirm the number and its wording, and put the Ping Identity link here.

The plan had the approval card show a tagged class summary. The code shows the tagged per-student table, because grading results go out as per-student results (see docs/DECISIONS.md). The scene works the same way; just do not call it a summary.

The card now also shows what the device read in Muse's request, as chips in the policy's words: "For a student's family", "For someone outside the class", "Whole text", "Asks who a tag is" or "Class-level question". The grading request has none of these, so the 1:05 card shows no chip; do not promise one there. To show a chip, film MUSE_SETUP.md test step 4 ("Find a student quote about the school garden for the family newsletter.") as an extra cut: its card shows "For a student's family". A card whose result would go out as a summary says "What would leave this device: a summary, not the full result" above the text.

## What the chart may and may not claim

Say what `eval/reports/final/nights.md` and `eval/reports/final.md` say, nothing more. Everything on the chart comes from a simulated teacher (`eval/user_policy.yaml`) answering invented items, not a real one; say so in the caption.

May say:

- "Over five simulated days, approval requests fell from 10 a day to 6." Each day had 5 items she wanted to be asked about, so the unneeded requests went 5, 4, 2, 1, 1.
- "The nightly gate kept all five nights, and agreement on the 20 held-out items went from 75% to 90%." Add that the gate selects on those items, so this is an upper bound.
- "On 100 practice items it never saw, agreement went from 72% to 81%, with 28 approval requests instead of 53." This is the more honest learning number, so prefer it if you say only one.
- Leaks: "0 leaks in this round's measured runs: 100 eval items, the holdout, five simulated days, 100 practice items it never saw, and two 24-essay grading jobs." The chart's leak line says the same for the holdout, the days and the unseen test.

May not say:

- "It never leaks" or "it can't leak". Every run in the final round had 0 leaks, but the round before had one: an approved snippet kept an invented name that is not on the roster, because the guard tagged only the exact name Glimmer's name pass returned. The guard now tags every word of such a name, but a name the pass misses entirely would still go out on an approved card.
- "It never shares what she would keep." On day 2 of the simulation a learned rule shared t085, a discipline note her policy refuses, tagged and with no card, and the night-5 rules did the same on the 100 eval items. The leak count does not see this, because its names were tagged.
- "It learns your rules", "90% accurate" or "88% accurate" without the simulated teacher and the caveats: the holdout's 90% is an upper bound, and the night-5 rules' 88% on the 100 eval items is in-sample.
- "It only gets more careful." On the unseen test it asked less than she wanted on 8 of 25 items (ask first 100% to 68%), because two approvals taught a broad rule for snippets. Those went out tagged, so they are not leaks, but the claim would be false.
- That night 3 got worse. Its dip from 90% to 85% is the same rules scoring lower on a re-run, not new rules doing worse.

The first final run's chart, where the gate kept no rules, is in `eval/reports/before_fixes/final/five_nights.png`; the tuning run's rising chart (`eval/reports/five_nights.png`) used hand labels and practice data labeled with the teacher's own policy. Do not show either as the result.

## Fallbacks while filming

| If | Then |
|---|---|
| The Muse app will not take the connector | Film the same prompts in Muse Code (MUSE_SETUP.md, step 5) |
| The light or the plush is not ready | Film the Device tab's state instead, or the bare board with the plush beside it as a prop |
| The scheduled 8 AM message did not arrive | Press Dream now on the Dreaming tab, then ask Muse "How did the dreaming run go? One sentence with the numbers." |
| Grading is slow on the device | Grade a smaller folder and say how many essays on screen |
| A search answers with a job id instead of snippets | That is the device waiting for her OK or still checking. Press **Share it** if a card is up, then ask Muse "Check that search again." so it calls get_result with the id |
| The newsletter search shares without a card | Muse left out who the snippets are for. Ask again with "for the family newsletter" in the prompt, or skip the chip cut |
| The approval card shows a name you did not expect | Press **Keep it here** and do not record that take. Note the document; it is the name pass missing a name that is not on the roster |
| Anything leaks in a rehearsal | Stop. Do not record. Fix it and rerun the eval first |

## Submission checklist

- [ ] Video under 3:00, uploaded, unlisted link tested in a private browser window
- [ ] Track and entity confirmed, sole ownership checked, and the Official Rules accepted in the portal if it asks (HANDOFF rows 14 to 16)
- [ ] Repo pushed without the local `relay/wrangler.jsonc` edit, public unless the participant guide says otherwise, link tested logged out
- [ ] Every portal field filled in; the first line says it is a privacy connector for private-data work, not a chatbot
- [ ] README numbers match `eval/reports/final.md`
- [ ] docs/PRIOR_WORK.md checked against the Official Rules
- [ ] `uv run python -m scripts.secrets_scan --history --report eval/reports/secrets_scan.md` finds nothing
- [ ] Submitted by noon ET Nov 4, and the confirmation saved
- [ ] The device and the relay client kept running through Nov 9 (judging Nov 4 to 8, live finals Nov 9), with this video as the fallback if the device is offline
