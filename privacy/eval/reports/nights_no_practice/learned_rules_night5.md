# Learned rules for the privacy router

Rebuilt from scratch on 2026-10-27 from 37 of your decisions.
Use the rule whose kind and topics match the result exactly. Your rules always win over practice defaults, and the safety floors still apply after any rule.
Words: share tagged = share_tagged, share a summary = share_summary, ask first = ask_user, refuse = refuse.
A topic rule (topic: X) holds for any kind of result with that topic when no rule matches its kind and topics exactly; when several fit, the strictest wins. The device picks the one rule that fits each result and shows it with the result.
Results with a never-share topic (custody, discipline, home_address, iep, immigration, lunch_status, medical, parent_contact) are always refused by the safety floor, so no rule lists them.

## Your rules

- Free-text answers (kind: free_text; topics: full_text, writing): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Per-student results (kind: per_student; topics: none): ask first. You wanted to be asked 4 of 4 times, so keep asking.
- Per-student results (kind: per_student; topics: grades, writing): share tagged. You approved 4 of 4 and said don't ask again.
- Document snippets (kind: snippet; topics: writing): share tagged. You approved 4 of 4 and said don't ask again.
- Per-student results (kind: per_student; topics: grades, third_party): ask first. You wanted to be asked 3 of 3 times, so keep asking.
- Free-text answers (kind: free_text; topics: parents): ask first. You wanted to be asked 2 of 2 times, so keep asking.
- Free-text answers (kind: free_text; topics: writing): share tagged. You approved 2 of 2 and said don't ask again.
- Per-student results (kind: per_student; topics: grades, parents): ask first. You wanted to be asked 2 of 2 times, so keep asking.
- Anything about full text (topic: full_text): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Anything about parents (topic: parents): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Anything about third party (topic: third_party): ask first. You wanted to be asked 6 of 6 times, so keep asking.
