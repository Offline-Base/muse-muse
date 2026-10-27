# Learned rules for the privacy router

Rebuilt from scratch on 2026-10-27 from 38 of your decisions.
The device shows each result with the rule that fits it best: the rule whose kind and topics match it exactly. An ask first or refuse rule also holds for every result of its kind that has all of its topics, with or without more (topics: none covers the whole kind), so a closer rule never loosens it; when the device shows such a rule too, it is the stricter one: follow it. Your rules always win over practice defaults, and the safety floors still apply after any rule.
Words: share tagged = share_tagged, share a summary = share_summary, ask first = ask_user, refuse = refuse.
A topic rule (topic: X) holds for any kind of result with that topic, even when another rule matches its kind and topics; when several fit, the strictest wins. The device shows a topic rule as the best fit when no rule matches exactly.
Results with a never-share topic (custody, discipline, home_address, iep, immigration, lunch_status, medical, parent_contact) in their own text are always refused by the safety floor. One named only in Muse's request (the Blocked line then says none) is asked about instead, unless a refuse rule here holds for it.

## Your rules

- Free-text answers (kind: free_text; topics: full_text): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Free-text answers (kind: free_text; topics: parents): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Per-student results (kind: per_student; topics: grades, writing): share tagged. You approved 3 of 3 and said don't ask again.
- Free-text answers (kind: free_text; topics: third_party): ask first. You wanted to be asked 2 of 2 times, so keep asking.
- Per-student results (kind: per_student; topics: grades, third_party, writing): ask first. You wanted to be asked 2 of 2 times, so keep asking.
- Document snippets (kind: snippet; topics: none): share tagged. You approved 2 of 2 and said don't ask again.
- Document snippets (kind: snippet; topics: full_text): share tagged. You approved 2 of 2 and said don't ask again.
- Anything about parents (topic: parents): ask first. You wanted to be asked 7 of 7 times, so keep asking.
- Anything about third party (topic: third_party): ask first. You wanted to be asked 6 of 6 times, so keep asking.
