# What this device keeps, and for how long

With the COPPA or GDPR toggle on, Muse Privacy deletes old results from this device. The default is 90 days. That number is our default, not a number from any law, and your organization may need a different one.

## What is deleted after 90 days

- Decisions, including the tagged text and the receipt. Results still waiting for your OK stay until you answer.
- Finished jobs and files in `BASE_HOME/output`.
- Text read from scanned images in `BASE_HOME/scans`.

The cleanup runs at most once an hour while results are being released.

## What is kept

- **The tag map** (`BASE_HOME/tagmap.json`, readable only by your user). It holds real names and values next to their tags, so tags keep their meaning and known values keep getting caught. It is not cleared on a schedule. This is a known gap.
- **The audit table:** tool names, outcomes and timings only, with no content.
- **Learned rules** (`BASE_HOME/router_rules.md`): decisions about kinds of results, not about people.
- **Your documents.** They are yours, and this app never changes or deletes them.

## What this doesn't cover

Anything already sent to Muse. Meta's terms say deleting a message or an account may not delete Meta's copy, which is why only tagged results leave this device.
