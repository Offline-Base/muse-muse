# Grading spot-check: 10 of the 24 cloud-graded essays

The plan's grading-quality number is a manual check: a teacher scores 10 essays against the rubric and compares with Glimmer. Glimmer's side is filled in below; **the Ethan columns are blank on purpose.** Every student, essay and detail here is invented (`eval/roster.json`, `demo/essays/`).

Source: the first-day grading run, `RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading_no_rules`, on Oct 27 at 05:52. Its report is `e2e_cloud_no_rules.md` as of commit 291b0eb (`git show 291b0eb:eval/reports/e2e_cloud_no_rules.md`); the file of that name in the tree has been rerun since and is a later run. Glimmer was `meta/muse-glimmer-30b` on OpenRouter, reasoning low, with each essay's names swapped for tags before the model saw it. "Run B" is the second grading run in the same command set, `tests/test_e2e.py::test_e2e_cloud_grading`, on the same 24 essays a minute later (report `e2e_cloud.md` as of the same commit, 05:53). Scores for all 24 essays in both runs: `raw/grading_spotcheck.jsonl` (scores only).

## How the 10 were picked

The 24 essays sorted by Glimmer's run A total (then by name), taking positions 1, 4, 6, 9, 11, 14, 16, 19, 21 and 24 (`round(i * 23 / 9)` for i = 0 to 9), so weak, middle and strong essays are all in the sample without hand picking.

## What is already measured

| Measure | Value |
|---|---|
| Glimmer's totals over all 24 essays | 8 to 16 of 16, mean 14 |
| Essays Glimmer gave 16 of 16 | 7 of 24 |
| Same total in run A and run B | 21 of 24 |
| Totals within 1 point between runs | 23 of 24 (largest gap 2) |
| Same score on a criterion between runs | 92 of 96 |
| Mean difference in total between runs | 0.17 points |

Recompute from the raw file (prints essays, same total, within 1, largest gap, mean gap, same criterion scores, lowest, highest and mean total, and how many got 16):

```
uv run python -c "import json; r=[json.loads(l) for l in open('eval/reports/raw/grading_spotcheck.jsonl')]; d=[abs(x['run_a']['total']-x['run_b']['total']) for x in r]; c=sum(x['run_a']['scores'][k]==x['run_b']['scores'][k] for x in r for k in x['run_a']['scores']); t=[x['run_a']['total'] for x in r]; print(len(r), sum(v==0 for v in d), sum(v<=1 for v in d), max(d), round(sum(d)/len(d),2), c, min(t), max(t), round(sum(t)/len(t),1), t.count(16))"
```

So Glimmer is consistent with itself. Whether it is right is what this page is for. A second Meta model's scores on the same 24 essays are in [grading_crosscheck.md](grading_crosscheck.md) (Muse Spark 1.3, a second opinion, not ground truth). Two things to look at: the totals cluster high (the essays were written to range from weak to strong, see `eval/DATASET.md`), and the rubric says feedback should not mention anything personal the student shared (family, health, home). The "Personal words" line under each essay is a plain keyword search of Glimmer's strengths, next step and feedback, not a judgment. These files stay on the device; only the scores and next steps went to Muse, tagged.

## Rubric at a glance

Full rubric: [demo/rubric.md](../../demo/rubric.md). Each criterion 1 to 4, total out of 16. A 3 meets the grade 4 standard; a 4 goes beyond it.

| Criterion | 4 | 3 | 2 | 1 |
|---|---|---|---|---|
| Ideas | Clear opinion kept throughout; every reason connects; answers the other side | Clear opinion, two or three supporting reasons; one may be thin | Opinion buried or changing; reasons listed, not explained | No clear opinion, or mostly off topic |
| Organization | Hook, one reason per paragraph, conclusion; varied transitions | Beginning, middle, end; simple transitions | Order jumps; ending missing; few transitions | Little or no structure |
| Evidence and details | Specific, well-chosen details, explained | Most reasons have a relevant detail | General or loosely related details | Few or no details |
| Conventions | Errors rare; sentences vary | A few errors on harder words | Frequent errors in common words; run-ons | Errors on most lines |

## Summary

| # | Essay | Glimmer total (run A) | Glimmer total (run B) | Ethan's total | Difference (Ethan minus Glimmer A) |
|---|---|---:|---:|---|---|
| 1 | [Quentin Beaumont](../../demo/essays/Quentin%20Beaumont.md) | 8 | 8 |  |  |
| 2 | [Maya Lindqvist](../../demo/essays/Maya%20Lindqvist.md) | 11 | 11 |  |  |
| 3 | [Santiago Villalobos](../../demo/essays/Santiago%20Villalobos.md) | 12 | 12 |  |  |
| 4 | [Yusuf Demir](../../demo/essays/Yusuf%20Demir.md) | 14 | 14 |  |  |
| 5 | [Farhan Siddiqui](../../demo/essays/Farhan%20Siddiqui.md) | 15 | 15 |  |  |
| 6 | [Maya Okafor](../../demo/essays/Maya%20Okafor.md) | 15 | 14 |  |  |
| 7 | [Valentina Ostrowski](../../demo/essays/Valentina%20Ostrowski.md) | 15 | 15 |  |  |
| 8 | [Esperanza Moreno-Baptiste](../../demo/essays/Esperanza%20Moreno-Baptiste.md) | 16 | 16 |  |  |
| 9 | [Keturah Mensah](../../demo/essays/Keturah%20Mensah.md) | 16 | 16 |  |  |
| 10 | [Zainab Haddad](../../demo/essays/Zainab%20Haddad.md) | 16 | 16 |  |  |

When the Ethan columns are filled in, report three numbers in `final.md`: criteria where Ethan and Glimmer agree exactly (of 40), essays whose totals are within 1 point (of 10), and the mean absolute difference in totals.

## 1. Quentin Beaumont

Essay: [demo/essays/Quentin Beaumont.md](../../demo/essays/Quentin%20Beaumont.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 2 | 2 |  |
| Organization | 2 | 2 |  |
| Evidence | 2 | 2 |  |
| Conventions | 2 | 2 |  |
| Total (of 16) | 8 | 8 |  |

**Strengths (Glimmer):** You have a clear yes opinion that stays consistent and you give several real examples from your own experience, like eating tomatoes with salt and your cousin’s garden.

**Next step (Glimmer):** Pick one reason per paragraph and explain how it supports your opinion.

**Feedback to the student (Glimmer):** You made your opinion clear from the start and you care about having a garden at school, which makes your writing easy to follow. I like the specific details you added, like pulling weeds with your cousin and eating tomatoes with salt, because they show your real experience. Keep those concrete examples and try using them to explain one reason at a time, so each paragraph has a clear point and a detail that proves it. You’re already thinking about what a garden needs, so building on that will make your next essay even stronger.

**Personal words in Glimmer's text:** cousin

**Ethan's notes:** 

## 2. Maya Lindqvist

Essay: [demo/essays/Maya Lindqvist.md](../../demo/essays/Maya%20Lindqvist.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 3 | 3 |  |
| Organization | 2 | 2 |  |
| Evidence | 3 | 3 |  |
| Conventions | 3 | 3 |  |
| Total (of 16) | 11 | 11 |  |

**Strengths (Glimmer):** You keep a clear opinion that our school should have a garden from start to finish, and you use vivid personal details like the colors of tulips and the sound of peas to make your reasons feel real.

**Next step (Glimmer):** Practice using clear transitions and one reason per paragraph to make the essay easier to follow.

**Feedback to the student (Glimmer):** This is a thoughtful opinion piece and your reasons are personal and caring, especially the idea that a garden could be calm for kids who can’t run at recess. I like how you picture the garden with specific details like tulips in red, yellow, and pink and a bench to sit on. To strengthen your next essay, try giving each reason its own paragraph and linking the paragraphs with words like First, Also, and In conclusion, so readers can follow your thinking even more easily. Great work keeping your voice and staying on topic.

**Personal words in Glimmer's text:** none found

**Ethan's notes:** 

## 3. Santiago Villalobos

Essay: [demo/essays/Santiago Villalobos.md](../../demo/essays/Santiago%20Villalobos.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 3 | 3 |  |
| Evidence | 3 | 3 |  |
| Conventions | 2 | 2 |  |
| Total (of 16) | 12 | 12 |  |

**Strengths (Glimmer):** You state a clear opinion right away and keep it throughout with three supporting reasons. You also acknowledge a counterargument and answer it with a practical solution.

**Next step (Glimmer):** Focus on spelling common words and using correct end marks so your strong ideas are easy to read.

**Feedback to the student (Glimmer):** This is a thoughtful opinion essay, and I can tell you really care about a school garden. Your reasons about growing food for salsa, helping the environment for bees and butterflies, and feeling happier outside are specific to you and they all connect back to your opinion. I especially like how you address the idea that a garden might be too hard to take care of and suggest a class rotation for watering. Keep building on that strength of answering the other side. For your next essay, try reading it aloud to catch spelling of common words and make sure each sentence ends with the right punctuation. Your ideas are strong and clear, and with a little polishing on conventions they will shine even more.

**Personal words in Glimmer's text:** none found

**Ethan's notes:** 

## 4. Yusuf Demir

Essay: [demo/essays/Yusuf Demir.md](../../demo/essays/Yusuf%20Demir.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 3 | 3 |  |
| Evidence | 4 | 4 |  |
| Conventions | 3 | 3 |  |
| Total (of 16) | 14 | 14 |  |

**Strengths (Glimmer):** You keep a clear opinion about a school garden throughout and you directly address a counterpoint, which makes your argument feel fair and complete. Your reasons are specific and personal, like connecting hunger at lunch to afternoon snacks and sharing your dad’s family growing food in Turkey.

**Next step (Glimmer):** Add a few clear transition words at the start of body paragraphs to make the flow easier to follow.

**Feedback to the student (Glimmer):** You have a strong, caring opinion and you support it with real examples that matter to you. I especially liked how you explained why a garden could help with hunger and how you used what you learned about bees to connect the garden to food production. Your counterpoint about kids who might not want to work is thoughtful and you answer it well. Keep using those specific details, and in your next essay try to open each reason with a clear transition like First, Second, or In addition so a reader can follow your ideas even more easily. Great work staying on topic and explaining your thinking.

**Personal words in Glimmer's text:** dad, family, hunger, lunch, turkey

**Ethan's notes:** 

## 5. Farhan Siddiqui

Essay: [demo/essays/Farhan Siddiqui.md](../../demo/essays/Farhan%20Siddiqui.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 3 | 3 |  |
| Evidence | 4 | 4 |  |
| Conventions | 4 | 4 |  |
| Total (of 16) | 15 | 15 |  |

**Strengths (Glimmer):** You keep your opinion clear from the first line to the conclusion and you thoughtfully address a counterargument about bees and allergies instead of ignoring it. Your reasons are supported with specific classroom and school examples, like learning seed-to-plant and improving the front lawn.

**Next step (Glimmer):** Add a stronger hook in your introduction and use varied transitions to make each body paragraph easier to follow.

**Feedback to the student (Glimmer):** This is a thoughtful and responsible opinion piece. You state right away that you want a garden but in a safe way, and you stick with that position the whole time. I especially liked how you answered the bee concern with real solutions, such as planting flowers that do not bring bees near the door and letting allergic students wear gloves and long sleeves. Your details, like seeing how a seed turns into a plant and making signs for each row, make your reasons convincing. Keep using those specific examples and keep addressing the other side as you did here. For your next essay, try opening with a hook and giving each reason its own clear paragraph with transitions like First, In addition, and In conclusion.

**Personal words in Glimmer's text:** allergic, allergies

**Ethan's notes:** 

## 6. Maya Okafor

Essay: [demo/essays/Maya Okafor.md](../../demo/essays/Maya%20Okafor.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 4 | 3 |  |
| Evidence | 4 | 4 |  |
| Conventions | 3 | 3 |  |
| Total (of 16) | 15 | 14 |  |

**Strengths (Glimmer):** You state a clear opinion right away and keep it consistent through all three reasons. You also acknowledge a counterargument and answer it directly.

**Next step (Glimmer):** Work on polishing punctuation around commas and dashes so sentences read smoothly.

**Feedback to the student (Glimmer):** This is a strong opinion essay because your reasons are specific and connected to your opinion. I especially liked the lima bean cups from third grade and the spinach story with your aunt, because those real examples show why a garden would matter to you. Your counterargument paragraph is thoughtful and shows real reasoning. Keep using personal examples like these and keep your clear structure. Nice work.

**Personal words in Glimmer's text:** aunt

**Ethan's notes:** 

## 7. Valentina Ostrowski

Essay: [demo/essays/Valentina Ostrowski.md](../../demo/essays/Valentina%20Ostrowski.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 3 | 3 |  |
| Evidence | 4 | 4 |  |
| Conventions | 4 | 4 |  |
| Total (of 16) | 15 | 15 |  |

**Strengths (Glimmer):** You keep a clear opinion throughout and directly answer a counterargument with a practical solution. Your reasons are supported with specific examples from class and life, like the water cycle lesson and growing basil on a windowsill.

**Next step (Glimmer):** Add a hook in the introduction to grab the reader before stating your opinion.

**Feedback to the student (Glimmer):** This is a strong opinion essay. You state right away that our school should have a garden and you stick with that idea in every paragraph. I especially liked how you explain each reason with a real example, like seeing water soak into soil instead of only drawing diagrams, and how you thought about kids who do not like soccer and would prefer digging and finding ladybugs. The counterargument about pests shows mature thinking, and your solution with a fence and marigolds is specific and convincing. Keep using those concrete details and keep answering the other side. With a more inviting opening sentence to hook the reader, your next essay will be even stronger.

**Personal words in Glimmer's text:** none found

**Ethan's notes:** 

## 8. Esperanza Moreno-Baptiste

Essay: [demo/essays/Esperanza Moreno-Baptiste.md](../../demo/essays/Esperanza%20Moreno-Baptiste.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 4 | 4 |  |
| Evidence | 4 | 4 |  |
| Conventions | 4 | 4 |  |
| Total (of 16) | 16 | 16 |  |

**Strengths (Glimmer):** You state a clear opinion up front and keep it steady through three well-connected reasons. The personal example about your abuela's garden on Fennel Street makes the argument vivid and specific.

**Next step (Glimmer):** Try opening with a hook sentence before stating the opinion to draw the reader in more quickly.

**Feedback to the student (Glimmer):** This is a strong opinion essay that stays focused and thoughtful from start to finish. I especially like how you connect each reason back to your opinion and use real details, like watching the butterfly video and your abuela donating vegetables in August, to show why a garden would help. Addressing the summer-break worry with planting lettuce and radishes and a watering schedule shows real problem-solving. Keep using specific examples and clear transitions like you did here, and your writing will continue to be persuasive and easy to follow.

**Personal words in Glimmer's text:** abuela, street

**Ethan's notes:** 

## 9. Keturah Mensah

Essay: [demo/essays/Keturah Mensah.md](../../demo/essays/Keturah%20Mensah.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 4 | 4 |  |
| Evidence | 4 | 4 |  |
| Conventions | 4 | 4 |  |
| Total (of 16) | 16 | 16 |  |

**Strengths (Glimmer):** You state a clear opinion right away and keep it through the whole essay. Your reasons are connected to that opinion with specific, vivid examples like pulling up a carrot and your grandmother growing okra.

**Next step (Glimmer):** Add a few more varied transitions between sentences to smooth the flow even more.

**Feedback to the student (Glimmer):** This is a strong opinion piece that is easy to follow and convincing. I love how you open with a picture of bright green beans and yellow squash, and then you give three clear reasons for a school garden. Your examples are specific and personal, from the class mixing up stems and roots to the idea of each class adopting a bed, and you thoughtfully answer the counterargument about losing interest. Keep using concrete details like these and explaining how they prove your point. You are writing with real voice and care.

**Personal words in Glimmer's text:** none found

**Ethan's notes:** 

## 10. Zainab Haddad

Essay: [demo/essays/Zainab Haddad.md](../../demo/essays/Zainab%20Haddad.md)

| Criterion | Glimmer (run A) | Glimmer (run B) | Ethan |
|---|---:|---:|---|
| Ideas | 4 | 4 |  |
| Organization | 4 | 4 |  |
| Evidence | 4 | 4 |  |
| Conventions | 4 | 4 |  |
| Total (of 16) | 16 | 16 |  |

**Strengths (Glimmer):** You keep a clear opinion about a school garden throughout and you answer the other side with a practical plan. Your reasons are each supported by vivid, specific examples like compost under a magnifying glass and making tabbouleh for a class party.

**Next step (Glimmer):** Strengthen the hook in your introduction so it grabs the reader right away.

**Feedback to the student (Glimmer):** Your opinion is clear from the first lines and you stick with it all the way to a strong conclusion. I especially like how each reason is explained with real details you can picture, like finding spiders, worms and ladybugs to study ecosystems and growing parsley and mint for tabbouleh. You also thought about what others might say and answered it by giving each class a job. Keep choosing specific examples like these and explaining how they prove your point, and your writing will stay persuasive and easy to follow.

**Personal words in Glimmer's text:** none found

**Ethan's notes:** 
