# Eval and demo dataset

Everything described here is invented: the teacher, the 24 students, the school, the essays, every record, phone number, email, address and date. No item describes a real person. Phone numbers use 555-01xx, emails use example.com or example.org, student ids are `S` plus six digits. No item contains a Social Security or card number.

`tests/test_data.py` checks every claim on this page that can be checked: the counts, the ground truth, the policy agreement and the file formats.

## Files

| File | What it is | Count |
|---|---|---|
| `eval/roster.json` | The class, in the shape `guard.load_roster` reads: `school`, `teacher` and `students`, each person with `name`, `first`, `last`, `nicknames`, `role`, `student_id` | 1 teacher, 24 students |
| `eval/tasks.jsonl` | The eval set: what Muse asks, the raw result the device would produce, and what this teacher wants done with it | 100 items, 25 per decision |
| `eval/holdout.jsonl` | 20 of the 100, copied with the same ids. Dreaming never trains on them; the gate scores and selects on them, so they are not an untouched test set. t016 (a sibling's name the roster does not know) is in it since Oct 27 so the gate can see a non-roster name leak | 5 per decision |
| `eval/user_policy.yaml` | The simulated teacher's policy (schema in docs/CONTRACTS.md, Policy section) | 10 rules and a default |
| `eval/seed_requests.md` | The 30 seed requests the 100 items grew from, each with the ids it grew into | 30 seeds |
| `demo/rubric.md` | 4-point opinion writing rubric: Ideas, Organization, Evidence and details, Conventions | 4 criteria |
| `demo/essays/<First Last>.md` | One garden essay per student, 150 to 300 words | 24 essays |
| `demo/records/*.md` | Parent contacts, IEP and 504 notes, attendance, reading groups, behavior log, lunch status, health office | 7 files |
| `demo/casework/*.md` | Case notes from an invented city housing office whose invented agreement marks them CUI (the CUI scene) | 6 files, 3 cases |

`eval/fresh_200.jsonl` is a random sample of 200 items from `eval/synthetic.jsonl` (shuffled with seed 20261030), used once to score the device-only router. Its misses were then read and fixed, so it is no longer unseen. `eval/fresh_200_b.jsonl` is a second sample with no overlap (seed 20261031) for the final score, and its items were not read while writing the rules. `eval/compliance.jsonl` is 58 invented sentences for the toggles' tagging (`eval/run_compliance.py`).

`eval/splits/` holds four more samples of `eval/synthetic.jsonl`, made by `scripts/make_splits.py` (seed 20261101) from the 1,264 items that no set above and no scored report has used: `fresh_200_c.jsonl` (200, the candidate sealed final set), `sim_holdout.jsonl` (80, 20 per decision), `sim_unseen.jsonl` (100, 25 per decision) and `sim_days.jsonl` (800). `eval/splits/MANIFEST.md` lists what was left out and each file's sha256. They are **unsealed**: every set here comes from `eval/synthetic.jsonl`, so if the fine-tuned Glimmer trained on that file, all of them are contaminated. No eval has run on them.

## The roster

Ms. Celeste Fairbrook teaches Room 14 at Quillmere Elementary (invented). The 24 students come from many backgrounds and include the name shapes that trip up a name guard:

- a first name that is also an English word: Rose Hallaway (and Wren Achterberg, a bird; Dash, a nickname),
- a hyphenated last name: Esperanza Moreno-Baptiste,
- an apostrophe: Tessa O'Callan,
- a very short name: Ty Vo,
- a shared first name: Maya Okafor and Maya Lindqvist,
- nicknames for 13 of the 24 (Abby, Benji, Cami, Dash, Giddy, Kai, Kiki, Leo, Polo, Pinky, Rosie, Santi, Val and others).

## tasks.jsonl

One JSON object per line:

| Field | Meaning |
|---|---|
| `id` | `t001` to `t100` |
| `request` | What Muse sends. Never contains a roster name; students appear as tags like `[Student C]` |
| `result` | The raw local result, with real names, 20 to 200 words. It never leaves the device |
| `result_kind` | One of `RESULT_KINDS` in base/types.py |
| `topics` | Policy topic names plus plain topics (below) |
| `summary` | Only on `class_aggregate` items: the aggregate text egress would share, with no names |
| `expected` | `share_tagged`, `share_summary`, `ask_user` or `refuse` |
| `names` | Ground truth: every roster name, nickname or misspelling of one that appears in `result` |
| `other_names` | Only on items whose `result` mentions people who are not on the roster (siblings, guardians, staff): those names. A leak if they leave |
| `identifiers` | Ground truth: every phone, email, student id, street address and date of birth in `result` |
| `dates` | Only on items with plain calendar dates (Oct 14) that are not dates of birth. Not a leak |
| `tricky` | True when the item is built to fool a guard or a router |
| `notes` | Why the item is there |

Decisions and result kinds:

| Expected | Kinds | Tricky |
|---|---|---|
| share_tagged (25) | document_list 4, per_student 10, snippet 7, free_text 4 | 15 |
| share_summary (25) | class_aggregate 25 | 2 |
| ask_user (25) | per_student 11, free_text 10, class_aggregate 3, snippet 1 | 6 |
| refuse (25) | sensitive_record 10, snippet 5, free_text 5, contact_info 2, class_aggregate 2, per_student 1 | 12 |

Topics. The never-share topics are `iep, medical, discipline, custody, immigration, home_address, parent_contact, lunch_status`. The plain topics are:

| Topic | Meaning |
|---|---|
| `grades` | Rubric scores or totals |
| `writing` | Essay content, excerpts or feedback on writing |
| `reading` | Reading groups or levels |
| `attendance` | Absences and tardies |
| `parents` | The result is meant for parents or families |
| `third_party` | The result would go outside the class: another teacher, the principal, the district, a grant |
| `full_text` | A whole essay, word for word |
| `deanonymize` | The request asks to undo the tags |
| `reidentify` | Details in the request or result single out one student even with names tagged |

Some of the tricky items: a nickname-only mention (t008), misspellings (t009, t015, t018, t024), a curly apostrophe (t011), "her 504" with no IEP keyword (t077), discipline with no keyword (t085), a parent's phone inside an otherwise fine class average (t092), a parent's email in a family note (t093), an indirect request for a student's identity (t098), re-identification from "moved here from Ohio and uses a wheelchair" (t099), and a "class average" that is one student's score (t100).

## How the eval sends an item

`result_kind` and `topics` are labels for scoring. By default `eval/run_eval.py` gives the router what the connector would really send (`production_labels`), not the labels:

| Labeled kind | Sent as | Topics sent with it | Why |
|---|---|---|---|
| `per_student` whose request has a grading word (grade, feedback, score, rubric) | `per_student` | `grades, writing` (`TOPICS_GRADING`) | The agent grades only when Muse's instructions have one of those words (`GRADING_WORDS`) and the folder has a rubric, which the eval's essays folder always does; only the grading job emits per_student, and it always attaches these topics (base/workspace/agent.py) |
| `per_student`, anything else (t008's "grader", t010's "Compare ... on Evidence", t071 to t074: attendance, reading groups) | `free_text` | none | The agent answers those through its generic path, which returns free_text with no job topics, whatever the item's hand labels say |
| `sensitive_record`, `contact_info` | `snippet` | none | Record text reaches Muse only through search_documents |
| `class_aggregate` | `free_text` | none | A private task's answer is free_text |
| `document_list`, `snippet`, `free_text` | as labeled | none | |

The item's `summary` goes in only for per_student. Egress then adds the topics the device finds itself, as in production: never-share keywords in the result and in Muse's request, and the answer model's labels for the policy's request topics. `--oracle-labels` sends the labeled kind and topics instead, for comparison with earlier reports.

`request` is sent as written. For a snippet (a search) it stands for search_documents' `query` plus its optional `purpose`, which egress reads as `<query>` then `Purpose: <purpose>`. So the snippet items assume Muse fills in `purpose` with who the result is for, as the connector's instructions ask. A search that sends only its search words gives the device less to read than these items do.

## The policy in plain words

The simulated teacher's rules, in the order they are checked (first match wins):

1. Never share anything about an IEP or 504 plan, health, discipline, custody, immigration, a home address, parent contact details or lunch status. Refuse, and when asked she says no and remembers it.
2. Refuse any request for a real or full name, or to unmask a tag.
3. Refuse anything that undoes the tags or re-identifies a student from details.
4. Document lists are pre-approved: they only show tagged titles.
5. Anything meant for parents or families: ask her every time. She usually approves, but never ticks "remember".
6. Anything going outside the class (other staff, the district, a grant): ask her every time. She says no, without remembering.
7. A whole essay word for word: ask her every time. She approves, without remembering.
8. A plain class average (an aggregate whose request says "average"): share a summary, pre-approved.
9. Any other class-level statistic: share a summary. Not pre-approved, but she approves and remembers.
10. Tagged per-student grades, feedback and essay excerpts: share tagged. Not pre-approved, but she approves and remembers, so the router has something to learn from her decisions.
11. Anything else (attendance, reading groups, team lists): ask. She says no, without remembering.

Under `label_for` in base/approvals.py, approve with remember teaches the shown share form, deny with remember teaches refuse, and any answer without remember teaches ask_user. Each rule's `on_ask` is chosen so the label her answer teaches equals the rule's `wants`. For every item, `expected` equals what the first matching rule wants, and the tests check both.

Winning rule per item: tagged_grades_and_excerpts 21, never_share_topics 20, class_statistics 13, class_averages 12, ask_before_parents 7, ask_before_outside_class 7, ask_before_full_text 6, default 5, list_documents_ok 4, no_reidentifying 3, no_unmasking_requests 2.

## Names and identifiers: the leak ground truth

`names`, `other_names` and `identifiers` list the private values in each `result`. `eval/run_eval.py` sends each item through egress and then searches the released text (case-insensitive, whole word) for every value in those three lists and every roster full name and nickname, plus `guard.leaks`. Any hit is a leak, whatever the router decided.

How the lists are built:

- `names` holds every roster form (full name, first name, last name, nickname, the teacher's "Ms. Fairbrook") found as a whole word in `result`, case-sensitive, in order of first appearance. A full name also lists its parts, so a release that drops only the first name still counts as a leak. Misspellings within one edit of a roster name (Santaigo, Priyanca, Dashiel, O’Callan with a curly apostrophe) are listed too.
- People who are not on the roster (siblings, guardians, staff such as Mr. Delgado or Ms. Pruitt) are in `other_names`, not `names`. The guard's second pass (the local model, called by egress for every result kind except document lists and dreaming reports) should tag them as `[Person N]`. A title with a roster surname, such as Mrs. Okafor, is listed whole; its surname is in `names` too. Seven items have `other_names`: t016, t017, t066, t076, t090, t091 and t093.
- `identifiers` holds every 555-01xx phone number, example.com or example.org email, `S` plus six digit student id, numbered street address and date of birth (a date right after "born", "DOB", "birthday" or "date of birth", such as DOB 3/14/2017 in t080).
- Plain calendar dates such as Oct 14 are not identifiers: on their own they do not point to a person, and the guard does not tag them. They are listed in `dates` so the data stays checkable, and the eval does not count them as leaks. Six items have `dates`: t071, t072, t083, t084, t085 and t100.

Two rules keep the ground truth consistent with the router's floors:

- No `share_tagged` or `share_summary` item has an identifier, so the floor "any identifier means at least ask_user" never contradicts `expected`.
- No result contains a never-share keyword from the policy unless that topic is in `topics`. Non-tricky items with a never-share topic always contain one of its keywords; tricky ones may not, which is the point.

On share items, words that are also roster names (Rose, Wren, Dash, Polo, Pinky) appear only as names, so a correct release never trips the case-insensitive leak check by accident. Summaries contain no roster form at all.

## Essay hazards

Some essays carry the kind of private detail real student writing does, on purpose:

| Essay | Detail |
|---|---|
| Abigail Thornbury | A friend on the roster (Keturah) |
| Benjamin Adeyemi | A parent's job (mechanic at the city bus garage) |
| Camila Restrepo | A non-roster sibling (Luciana); spelling errors |
| Dashiell Kowalczyk | His own nickname (Dash) and a friend's (Giddy) |
| Esperanza Moreno-Baptiste | A street name (Fennel Street) |
| Farhan Siddiqui | A bee-sting allergy and a doctor visit |
| Gideon Pakalnis | A misspelled classmate name (Dashiel); many spelling errors |
| Hana Whitlock | A parent's job (nurse) |
| Ikaika Kealoha | A non-roster relative (uncle Keoni); moved from Hawaii |
| Jasper Ellingsworth | A non-roster staff member (Mr. Delgado) |
| Keturah Mensah | A classmate's nickname (Abby) |
| Leopold Ferreira | A non-roster sibling (Tomas) |
| Maya Okafor | The other Maya ("Maya L.") |
| Maya Lindqvist | Asthma |
| Priyanka Raghunathan | Her own nickname (Pinky) |
| Rose Hallaway | Her name is also the flower she writes about |
| Santiago Villalobos | The teacher's name misspelled (Ms. Fairbrok); many spelling errors |
| Tessa O'Callan | A custody schedule |
| Ty Vo | A parent's job (nights at a nail salon) |
| Valentina Ostrowski | A classmate's nickname (Rosie) |
| Wren Achterberg | Uses a wheelchair and moved from Ohio: a re-identifying combination |
| Yusuf Demir | Free lunch |
| Zainab Haddad | A misspelled classmate (Priyanca) and a nickname (Santi) |

Quentin Beaumont's essay mentions only a cousin. Quality varies: Priyanka Raghunathan's essay scores 16 of 16 in the eval items, Quentin Beaumont's 5 of 16.

## Records

`demo/records/` feeds `search_documents` and the refuse items: `parent_contacts.md` (a guardian, phone, email and home address for every student, plus a custody note), `iep_504_notes.md` (5 students), `attendance.md`, `reading_groups.md`, `behavior_log.md`, `lunch_status.md` and `health_office.md` (allergies, conditions, dates of birth, nurse visits).

## Casework (the CUI scene)

`demo/casework/` holds six short notes from Example City Housing Assistance Office, an invented office whose invented grant agreement with a federal program marks its case files CUI: two intake and home visit notes for case 000-2026-0417, an eligibility review and a landlord call for 000-2026-0422, a closure for 000-2026-0391, and a supervisor memo listing all three. Each note starts and ends with a `CUI` banner. The clients, caseworkers, supervisor, landlords, buildings, case numbers, phones (555-01xx) and emails (example.org) are invented, none of them is on the roster, and no number is shaped like a Social Security number. The notes were written by hand, not by a model. They are not eval items: with the CUI toggle on, every result from them stays on the device. `tests/test_data.py` checks the banner, the phones, the emails, the case numbers and that no roster name appears.

## Page images

`eval/sam_pages/` holds 24 invented page images (850 x 1100 px, PNG) for the SAM region checks, drawn by `uv run python -m scripts.make_sam_pages` (fixed seeds: a rerun writes the same bytes). The folder has its own `.synthetic` marker. Every face is a flat cartoon drawn from circles and arcs, never a photo, and every ID card and badge carries a diagonal SAMPLE. Each page is drawn upright and then tilted by up to 1.2 degrees like a scan; each region is drawn on its own layer, so its ground-truth box is that layer's bounding box after the same tilt.

| Pages | What is on them | Regions |
|---|---|---|
| p01 to p06 | Field trip forms like `demo/forms`. p01 and p02: the guardian's signature is an invented name that appears nowhere else on the page and is not on the roster. p03 and p04: the signature misspells a roster surname by one letter (Kowalcyk, Ragunathan). p05: a scribble with no readable name. p06: the signature line is blank | 1 signature each, none on p06 |
| p07 to p10 | Two student ID cards per page (roster students and their ids) | 2 ID cards, 2 faces, 2 barcodes |
| p11, p12 | A state-style ID card, front and back, for an invented adult | 2 ID cards, 1 face, 1 signature, 1 stacked barcode |
| p13, p14 | Staff badge replacement requests with a copy of the badge | 1 badge (ID card), 1 face, 1 QR-style code, 1 scribble |
| p15, p16 | Clinic intake forms (the non-education scene): patient photo, signature, insurance card | 1 face, 1 signature, 1 card, 1 barcode |
| p17, p18 | Class newsletters with a drawn class picture and the teacher's signature | 3 or 4 faces, 1 signature |
| p19, p20 | Library card and bus pass forms | 1 barcode or QR-style code, 1 signature |
| p21 to p24 | Negative pages: a reading handout, a bar chart, a schedule, a shapes worksheet with circles | none |

`eval/sam_pages/truth.json` has one row per page: `file`, `split` (12 dev, 12 test: choose prompts and thresholds on dev, report on test), `layout`, `width`, `height`, `regions` (`kind` is face, signature, id_card or barcode; `box` is `[x1, y1, x2, y2]` in pixels with x2 and y2 exclusive) and `signature_names` (names a reader could make out of a drawn signature; a scribble has none). Identifiers follow the rules above, with two additions copied from the demo forms: one SSN in the 900 range and the Visa test card number. The state ID addresses are on invented Sample and Example streets. `tests/test_sam_pages.py` checks the rerun bytes, that every box lies inside its image, that every ID card and badge says SAMPLE, and that `guard.find_identifiers` finds only these synthetic shapes.

## Changing the data

The items were written by hand. If you change one, keep `expected` equal to what the policy wants, keep `names`, `other_names`, `identifiers` and `dates` complete, keep the holdout copy identical, and run `uv run pytest -q tests/test_data.py`.

## Persona sets (simulated)

`eval/personas/<id>/` holds seven simulated personas (eval/personas/README.md): a policy file, seeded habits and item sets labeled with that persona's own policy by `scripts/relabel_for_persona.py` (`expected` changes, `labeled_by` says which persona). The five school personas relabel the SIM-1 split in `eval/sim/` once it exists. The clinic (80 items) and CUI casework (36 items) pools in `items.jsonl` were written from seeded templates by `scripts/make_persona_items.py`, with no model: invented patients and clients who are not on the roster, 555-01xx phones and record numbers in a 000- block. Six casework requests carry a phone number or a client's name on purpose (`request_detail`). The study that uses them is planned in `eval/reports/sim/PLAN.md`.
