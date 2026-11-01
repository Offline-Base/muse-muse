# Grading cross-check: Muse Spark 1.3 against Glimmer

Command: `uv run python -m scripts.grade_crosscheck`

Date: 2026-10-27 08:03. Spark: `muse-spark-1.3` through the Meta Model API, reasoning effort low. Glimmer: run A of `eval/reports/raw/grading_spotcheck.jsonl` (24 essays), the first-day cloud grading run, reasoning low. Both models got the same messages: the agent's grading prompt and schema, the teacher's instructions, the rubric and one essay, with roster names and identifiers swapped for tags. Every essay and student is invented (`demo/essays/`, `eval/roster.json`).

**Spark is a second opinion, not ground truth.** Two models agreeing does not make either one right, and a gap does not say which one is wrong. The teacher's spot-check in `grading_spotcheck.md` is still the grading-quality number; this page only says how much a second Meta model agrees with Glimmer until then.

## Agreement

| Measure | Spark against Glimmer | Glimmer run A against run B (same model twice) |
|---|---|---|
| Essays compared | 24 | 24 |
| Same total | 15 of 24 | 21 of 24 |
| Totals within 1 point | 23 of 24 | 23 of 24 |
| Same score on a criterion | 82 of 96 | 92 of 96 |
| Criterion scores within 1 point | 96 of 96 | 96 of 96 |
| Mean absolute difference in total (of 16) | 0.42 | 0.17 |
| Mean total, Spark minus Glimmer | 0.25 | |
| Essays Spark scored lower / higher / the same | 2 / 7 / 15 | |

Harsher grader: Glimmer, by 0.25 points per essay on average.

Mean difference per criterion, Spark minus Glimmer: ideas +0.00, organization +0.21, evidence -0.12, conventions +0.17.

## Per essay

| Essay | Glimmer total | Spark total | Spark minus Glimmer | Glimmer ideas / organization / evidence / conventions | Spark ideas / organization / evidence / conventions |
|---|---:|---:|---:|---|---|
| Abigail Thornbury | 16 | 16 | 0 | 4 / 4 / 4 / 4 | 4 / 4 / 4 / 4 |
| Benjamin Adeyemi | 15 | 15 | 0 | 4 / 3 / 4 / 4 | 4 / 3 / 4 / 4 |
| Camila Restrepo | 13 | 13 | 0 | 4 / 3 / 4 / 2 | 4 / 3 / 4 / 2 |
| Dashiell Kowalczyk | 11 | 10 | -1 | 3 / 2 / 3 / 3 | 2 / 3 / 2 / 3 |
| Esperanza Moreno-Baptiste | 16 | 16 | 0 | 4 / 4 / 4 / 4 | 4 / 4 / 4 / 4 |
| Farhan Siddiqui | 15 | 15 | 0 | 4 / 3 / 4 / 4 | 4 / 3 / 4 / 4 |
| Gideon Pakalnis | 10 | 11 | 1 | 3 / 2 / 3 / 2 | 3 / 3 / 3 / 2 |
| Hana Whitlock | 16 | 16 | 0 | 4 / 4 / 4 / 4 | 4 / 4 / 4 / 4 |
| Ikaika Kealoha | 15 | 15 | 0 | 4 / 3 / 4 / 4 | 4 / 3 / 4 / 4 |
| Jasper Ellingsworth | 15 | 14 | -1 | 4 / 3 / 4 / 4 | 4 / 3 / 3 / 4 |
| Keturah Mensah | 16 | 16 | 0 | 4 / 4 / 4 / 4 | 4 / 4 / 4 / 4 |
| Leopold Ferreira | 12 | 14 | 2 | 3 / 3 / 3 / 3 | 4 / 3 / 3 / 4 |
| Maya Lindqvist | 11 | 11 | 0 | 3 / 2 / 3 / 3 | 3 / 2 / 3 / 3 |
| Maya Okafor | 15 | 16 | 1 | 4 / 4 / 4 / 3 | 4 / 4 / 4 / 4 |
| Priyanka Raghunathan | 16 | 16 | 0 | 4 / 4 / 4 / 4 | 4 / 4 / 4 / 4 |
| Quentin Beaumont | 8 | 8 | 0 | 2 / 2 / 2 / 2 | 2 / 2 / 2 / 2 |
| Rose Hallaway | 15 | 16 | 1 | 4 / 3 / 4 / 4 | 4 / 4 / 4 / 4 |
| Santiago Villalobos | 12 | 12 | 0 | 4 / 3 / 3 / 2 | 4 / 3 / 3 / 2 |
| Tessa O'Callan | 16 | 16 | 0 | 4 / 4 / 4 / 4 | 4 / 4 / 4 / 4 |
| Ty Vo | 13 | 13 | 0 | 3 / 3 / 4 / 3 | 3 / 3 / 3 / 4 |
| Valentina Ostrowski | 15 | 16 | 1 | 4 / 3 / 4 / 4 | 4 / 4 / 4 / 4 |
| Wren Achterberg | 15 | 16 | 1 | 4 / 3 / 4 / 4 | 4 / 4 / 4 / 4 |
| Yusuf Demir | 14 | 15 | 1 | 4 / 3 / 4 / 3 | 4 / 3 / 4 / 4 |
| Zainab Haddad | 16 | 16 | 0 | 4 / 4 / 4 / 4 | 4 / 4 / 4 / 4 |

## Spark usage

From the response usage fields: 24 API calls (at most 30), 0 answered from the local cache, 32637 prompt and 22437 completion tokens, 18209 of them reasoning. Estimated $0.14 at $1.25 and $4.25 per million tokens (a third-party price list, as in `synthetic.md`; not Meta's own page).

Raw rows: raw/grading_crosscheck.jsonl next to this report (scores only, no feedback text).

## Reading (written by hand after the run)

- Spark agrees with Glimmer less than Glimmer agrees with itself: the same total on 15 of 24 essays against 21 of 24 between Glimmer's two runs, and the same criterion score on 82 of 96 against 92 of 96. No criterion score differs by more than one point, and only one total differs by two (Leopold Ferreira, 12 against 14).
- Glimmer is the slightly harsher grader (0.25 points per essay). Spark scored 7 essays higher and 2 lower, and gave 16 of 16 to 11 essays against Glimmer's 7. Both put the same essays at the bottom (Quentin Beaumont 8, then Gideon Pakalnis, Dashiell Kowalczyk and Maya Lindqvist at 10 or 11).
- Both are Meta Muse models reading the same prompt and rubric, so habits they share (such as clustering near the top of the scale, which `grading_spotcheck.md` already flags) agree by construction. This says nothing about whether either model's scores match a teacher's.
- Spend: Spark is billed by the Meta Model API, not OpenRouter; the OpenRouter key's usage did not change during the run. The $0.14 above is an estimate from the usage fields.
