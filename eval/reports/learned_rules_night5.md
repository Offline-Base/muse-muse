# Learned rules for the privacy router

Rebuilt from scratch on 2026-10-27 from 31 of your decisions and 2000 practice examples.
Use the rule whose kind and topics match the result exactly. Your rules always win over practice defaults, and the safety floors still apply after any rule.
Words: share tagged = share_tagged, share a summary = share_summary, ask first = ask_user, refuse = refuse.
A topic rule (topic: X) holds for any kind of result with that topic when no rule matches its kind and topics exactly; when several fit, the strictest wins. The device picks the one rule that fits each result and shows it with the result.
Results with a never-share topic (custody, discipline, home_address, iep, immigration, lunch_status, medical, parent_contact) are always refused by the safety floor, so no rule lists them.

## Your rules

- Free-text answers (kind: free_text; topics: full_text, writing): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Per-student results (kind: per_student; topics: none): ask first. You wanted to be asked 4 of 4 times, so keep asking.
- Per-student results (kind: per_student; topics: grades, third_party): ask first. You wanted to be asked 3 of 3 times, so keep asking.
- Free-text answers (kind: free_text; topics: parents): ask first. You wanted to be asked 2 of 2 times, so keep asking.
- Free-text answers (kind: free_text; topics: writing): share tagged. You approved 2 of 2 and said don't ask again.
- Per-student results (kind: per_student; topics: grades, parents): ask first. You wanted to be asked 2 of 2 times, so keep asking.
- Per-student results (kind: per_student; topics: grades, writing): share tagged. You approved 2 of 2 and said don't ask again.
- Document snippets (kind: snippet; topics: writing): share tagged. You approved 2 of 2 and said don't ask again.
- Anything about full text (topic: full_text): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Anything about parents (topic: parents): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Anything about third party (topic: third_party): ask first. You wanted to be asked 6 of 6 times, so keep asking.

## Practice defaults (only where you have not decided yet)

- Class-wide results (kind: class_aggregate; topics: grades): share a summary. 261 of 261 practice examples agree.
- Document snippets (kind: snippet; topics: none): ask first. 119 of 119 practice examples agree.
- Free-text answers (kind: free_text; topics: grades, writing): share tagged. 107 of 107 practice examples agree.
- Class-wide results (kind: class_aggregate; topics: grades, writing): share a summary. 103 of 103 practice examples agree.
- Document snippets (kind: snippet; topics: grades, writing): share tagged. 98 of 98 practice examples agree.
- Class-wide results (kind: class_aggregate; topics: none): share a summary. 97 of 97 practice examples agree.
- Per-student results (kind: per_student; topics: grades): share tagged. 62 of 62 practice examples agree.
- Document lists (kind: document_list; topics: none): share tagged. 58 of 58 practice examples agree.
- Class-wide results (kind: class_aggregate; topics: writing): share a summary. 39 of 39 practice examples agree.
- Document lists (kind: document_list; topics: writing): share tagged. 37 of 37 practice examples agree.
- Free-text answers (kind: free_text; topics: third_party): ask first. 31 of 31 practice examples agree.
- Document lists (kind: document_list; topics: grades): share tagged. 21 of 21 practice examples agree.
- Free-text answers (kind: free_text; topics: grades): share tagged. 17 of 17 practice examples agree.
- Document snippets (kind: snippet; topics: grades): share tagged. 15 of 15 practice examples agree.
- Free-text answers (kind: free_text; topics: deanonymize): refuse. 12 of 12 practice examples agree.
- Document snippets (kind: snippet; topics: third_party, writing): ask first. 12 of 12 practice examples agree.
- Free-text answers (kind: free_text; topics: parents, third_party): ask first. 10 of 10 practice examples agree.
- Document snippets (kind: snippet; topics: parents): ask first. 10 of 10 practice examples agree.
- Document lists (kind: document_list; topics: grades, writing): share tagged. 9 of 9 practice examples agree.
- Free-text answers (kind: free_text; topics: grades, third_party): ask first. 8 of 8 practice examples agree.
- Free-text answers (kind: free_text; topics: grades, parents): ask first. 6 of 6 practice examples agree.
- Document snippets (kind: snippet; topics: third_party): ask first. 6 of 6 practice examples agree.
- Free-text answers (kind: free_text; topics: deanonymize, reidentify): refuse. 5 of 5 practice examples agree.
- Free-text answers (kind: free_text; topics: parents, third_party, writing): ask first. 5 of 5 practice examples agree.
- Document snippets (kind: snippet; topics: grades, parents): ask first. 5 of 5 practice examples agree.
- Document snippets (kind: snippet; topics: grades, third_party): ask first. 5 of 5 practice examples agree.
- Free-text answers (kind: free_text; topics: full_text, third_party, writing): ask first. 4 of 4 practice examples agree.
- Per-student results (kind: per_student; topics: parents): ask first. 4 of 4 practice examples agree.
- Document snippets (kind: snippet; topics: parents, third_party): ask first. 4 of 4 practice examples agree.
- Document snippets (kind: snippet; topics: deanonymize): refuse. 3 of 3 practice examples agree.
- Free-text answers (kind: free_text; topics: full_text, grades, writing): ask first. 2 of 2 practice examples agree.
- Free-text answers (kind: free_text; topics: full_text, parents, writing): ask first. 2 of 2 practice examples agree.
- Free-text answers (kind: free_text; topics: grades, parents, writing): ask first. 2 of 2 practice examples agree.
- Per-student results (kind: per_student; topics: third_party): ask first. 2 of 2 practice examples agree.
- Document snippets (kind: snippet; topics: parents, writing): ask first. 2 of 2 practice examples agree.
- Anything about deanonymize (topic: deanonymize): refuse. 23 of 23 practice examples agree.
