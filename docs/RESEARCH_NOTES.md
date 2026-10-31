# Research notes, Oct 31

What was worth keeping from an outside research report, written without access to this repo. Each item below was checked against the code on Oct 31, and "read" means the source page itself was opened that day. Anything marked "report only" must be opened before it is quoted. Nothing here has been built yet.

## Worth doing

### Changes no decision (can happen while the study is frozen)

| What | Why | Where |
|---|---|---|
| Add one blocked request to the video | The script shows a share and an approval, and never shows the device saying no. That refusal is the product's clearest moment | docs/DEMO_SCRIPT.md |
| Show three panes in one scene: the local source, the text sent to Muse, the local result | The card and History tab already show what would leave, with a fingerprint of the outgoing text (`egress.py`). No single view puts the three side by side. Feed it from the real outgoing text, never a rebuilt copy | base/ui_app.py, video |
| Open on one teacher and one finished file. Move clinics and city casework to the end | Impact is 30%, and a judge should know who it helps within 15 seconds | README, video 0:00 |
| Say what "0 leaks" measures, next to what it does not | It means no roster name or identifier was found in released text. It does not cover a summary that identifies someone by description (RED-F8, high, open), or the 2 missed asks. Say both in the same breath | README, video close |
| Replace the Ping and Thales figures with the Gallup teacher figures below | They are about teachers, and the sources are primary. The current two are about consumers and were checked only against press coverage | DEMO_SCRIPT scene 2:10 |
| Rewrite the script for what runs today | It still says Muse Glimmer grades the essays. The shipped setup is LFM3-VL-2B | DEMO_SCRIPT scenes 0:45, 2:25 |
| Add a one-page district review sheet: data flow, subprocessors, retention, deletion, local storage, known limits | Answers "could people really use this" under Impact. Most of it already exists in THREAT_MODEL and RETENTION | New doc, linked from the submission |
| State that dreaming builds rules, not a model | See the connector rules below | README, MUSE_SETUP |
| Name Meta's own "Local agent that asks first" recipe as the nearest baseline, and claim only the specific combination measured here | Glimmer runs locally and reaches Spark only after approval, so "first private agent" is unsafe to say. Listed in the cookbook; the recipe page itself has not been read | PRIOR_WORK, submission |
| Rehearse the failure path: a disconnect mid-job, then one resume. Label any fallback as a recorded run | The finals are live, and a silent replay would be dishonest | DEMO_SCRIPT |

### Changes decisions (restarts the study)

These close known attacks in docs/THREAT_MODEL.md. They cover 31 of the 47 xfailed cases.

| Finding | Cases | Severity |
|---|---|---|
| RED-F8, a summary singling out one student by description | 1 | High |
| RED-F3a, picking out one student by description | 16 | Medium |
| RED-F3b, asking for a parent's contact details | 11 | Medium |
| RED-F6b, a student's initials in a document | 1 | Medium |
| RED-F5c, under FERPA, a small group named only in the request | 1 | Medium |
| RED-F10a, Cyrillic look-alikes hiding a name. NFKC does not fold these; use the Unicode confusables data (UTS #39) on a separate detection view, with spans mapped back to the original | 1 | See THREAT_MODEL |

Also add as a written gap: subtraction across overlapping groups. The left-out floor catches explicit wording ("excluding [Student C]"). Two releases over groups that differ by one person are not tracked, because no release history exists. Document it now and build it after the event.

## Rules read Oct 31

Muse connector guidelines (platform.muse.ai/docs) and terms (platform.muse.ai/terms, effective Sep 18, 2026):

- User data shared through a connector must not be used for model training (guidelines 4.2). The invented fine-tune data is outside this. Real connector interactions must never become training examples. Dreaming fits inside "improve the connector" as long as it stays symbolic rules on the device; whether that reading holds is a question for legal review, not settled here.
- Sensitive writes need approval on every use and cannot be set to Always allow (3.3). A local card supplements Muse's approval and never replaces it. An approved result here releases the stored text, so an approval is already tied to the exact words.
- A tool that both reads and writes counts as a write (3.2). Directory listing needs read and write classifications and side effects in the documentation (5.4). Marking in the portal is "coming soon" (5.6). Directory review is a separate process and is not a deadline dependency.

Event page (dev.meta.ai/events/global-hackathon): Indie is "For individual builders and students"; Startup is "For teams and founders building a real product". The page does not state a video length or a repository rule for submissions. Those still rest on participant reports (docs/RUBRIC.md).

## Figures

Read:

| Figure | Who and when | Say | Do not say |
|---|---|---|---|
| 18% of teachers report any formal AI guidance, 48% informal only, 34% none | Gallup and Walton, 2,069 U.S. public K-12 teachers, Feb 9 to Mar 2, 2026, published May 26, 2026 | "Only 18% of teachers report formal guidance on AI" | That teachers are uploading student data. This does not measure that |
| 59% used AI in 2025-26. 64% of users say it gave more time for what matters most (13% a lot, 51% somewhat) | Gallup and The Mattering Institute, 1,952 K-12 educators including paraprofessionals, Jul 28 to Aug 14, 2026, published Oct 14, 2026 | "Most educators surveyed used AI, and most users said it freed time" | That Muse Privacy saves this time. It is perceived, not timed, and not about this product |

Report only: CoSN 2026 (nearly 80% report AI guidelines, 55% require vendor safety information); DOJ, Nov 13, 2025 (a school-software case threatening data on more than 60 million students and 10 million teachers; not an AI breach); OECD TALIS 2024 (4.6 hours a week marking, 3 hours administration, lower-secondary, international).

No verified number exists for how many teachers put identifiable student records into unapproved AI tools. Do not build one from the figures above.

Calculated from our own counts, Oct 31. On `fresh_200_b`, 165 of 200 has a 95% Wilson interval of 76.6% to 87.1%. Zero detected leaks in 200 items has a one-sided 95% upper bound of about 1.49%, if items were independent, which invented sets are not. Neither bounds real-world risk.

## When the tuned Glimmer lands

Not before; this is a test design only. Run on identical items with the same policy, prompt, schema and decoding settings:

1. Current LFM labeler.
2. Base Glimmer at the final quantization.
3. Tuned Glimmer at the same quantization.
4. A higher-precision Glimmer reference, only if disk allows. Otherwise say it was not run.

This separates fine-tuning from quantization. No general result says privacy labeling survives low-bit compression, so only this file's numbers count. Measure label confusion, invalid output, unsafe releases, needless asks, cold load, p50 and p95 end to end, peak memory and file size. Stop if there is no local load and usable schema in 90 minutes, or no repeatable demo in 4 to 6 hours. A fallback to LFM must show in the UI, the logs and the video. Disk has 14 GB free, so Meta's 16.8 GB and 19.7 GB files do not fit, and a roughly 6 GB file leaves little working room.

## Left out, and why

- **Labels only, the model never decides:** already measured and shipped. Policy with LFM labels scores 81.5%, and LFM deciding scores 43.0%.
- **Bind approvals to exact bytes:** mostly done. The stored text is what is released, and its fingerprint is recorded. Expiry and policy version are not worth adding this week.
- **Keep all exact class statistics on the device:** would remove the demo's class results. The floors and the FERPA toggle stay; the subtraction gap is written down instead.
- **GLiNER2, Presidio, CaMeL port, conformal risk control, AQLM, formal linkage study:** real ideas, wrong week. They bring new dependencies or research-sized work.
- **Muse Image, Voice Transcribe, Wonder, a new cloud path:** adding products to raise the count, with no gain to the privacy story.
- **New fresh test set of 60 to 100 items:** `fresh_200_c` and the templated set are already held out for this.
- **A 7 by 10 by 3 study design and its caveats:** the plan is already stricter, reading each persona across all three seeds. The wording to keep: "simulated nights", never "users".
- **Veil and Second Seat:** the report could not find them, so there is nothing to compare against.
