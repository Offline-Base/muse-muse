# What this device keeps, and for how long

With the COPPA or GDPR toggle on, Muse Privacy deletes old results from this device. The default is 90 days. That number is our default, not a number from any law, and your organization may need a different one.

## What is deleted after 90 days

- Decisions, including the tagged text and the receipt. Results still waiting for your OK stay until you answer.
- Finished jobs and files in `BASE_HOME/output`.
- Text read from scanned images in `BASE_HOME/scans`.
- Tag map entries for people and details that are not on your roster and were last seen more than 90 days ago, with their tags. A value stays while a tag for it still works or sits in a result waiting for your OK.
- Image checks in `BASE_HOME/regions`: where the SAM 3.1 region finder found faces, signatures, ID cards and barcodes on a page (counts and boxes), and the covered copy of that page. These exist only with `SAM_ENABLED=1`.

The cleanup runs at most once an hour while results are being released.

## Tags that stopped working

Tags change every day (`TAG_ROTATION=daily`, the default). A tag stops working about a day and a half after its day ends or after it was last sent to Muse (`TAG_GRACE_HOURS`, 36 by default). Once it stops working it can never name anyone again, so it is deleted from the tag map within the hour, with no toggle needed, and once each time the app starts. Its code is never handed out again.

## What is kept

- **The tag map** (`BASE_HOME/tagmap.json`, readable only by your user). It holds real names and values next to their tags, so tags keep their meaning and known values keep getting caught.
  - Without a retention toggle, values stay, but old tags are still deleted as above.
  - With COPPA or GDPR on, values not on your roster are deleted as listed above.
  - People on your roster stay while they are on it. Once someone leaves the roster, their values go after 90 days like any other.
  - Deleting a value has a cost. Until then, a name the model check found once was caught in every later text with no model call, and the final leak check knew it. Afterwards the next text with that name depends on the model check and the name-shape check again, and the final check catches it only if one of them finds it.
- **Copies made by the version 2 upgrade** (`tagmap.json.v1-backup-<time>` and `base.db.v1-backup-<time>`, next to the originals, readable only by your user). They are made once, before the first start on version 2, and hold everything the old files held. Nothing deletes them on a schedule. Delete them yourself once the app runs well.
- **The audit table:** tool names, outcomes and timings only, with no content.
- **Learned rules** (`BASE_HOME/router_rules.md`): decisions about kinds of results, not about people.
- **Your documents.** They are yours, and this app never changes or deletes them.

## What this doesn't cover

Anything already sent to Muse. Meta's terms say deleting a message or an account may not delete Meta's copy, which is why only tagged results leave this device. A tag Muse kept stops working on this device after the grace window, but Muse's copy of the tagged text stays wherever Meta keeps it.
