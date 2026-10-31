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

Tags change every day (`TAG_ROTATION=daily`, the default). A tag stops working about a day and a half after its day ends (`TAG_GRACE_HOURS`, 36 by default), however often it is sent to Muse. Once it stops working it can never name anyone again, so it is deleted from the tag map within the hour, with no toggle needed, and once each time the app starts. Its code is never handed out again.

## What is kept

- **The tag map** (`BASE_HOME/tagmap.json`, readable only by your user). It holds real names and values next to their tags, so tags keep their meaning and known values keep getting caught.
  - Without a retention toggle, values stay, but old tags are still deleted as above.
  - With COPPA or GDPR on, values not on your roster are deleted as listed above.
  - People on your roster stay while they are on it. Once someone leaves the roster, their values go after 90 days like any other.
  - Deleting a value has a cost. Until then, a name the model check found once was caught in every later text with no model call, and the final leak check knew it. Afterwards the next text with that name depends on the model check and the name-shape check again, and the final check catches it only if one of them finds it.
- **Copies made by the version 2 upgrade** (`tagmap.json.v1-backup-<time>` and `base.db.v1-backup-<time>`, next to the originals, readable only by your user). They are made once, before the first start on version 2, and hold everything the old files held. A base.db copy is written under a `.v1-copying-` name and renamed only once it is complete, so a copy that fails partway (a full disk, a kill) leaves nothing that looks like a backup, and the next start copies again; an empty copy an older start left behind does not count. base.db is also copied once before this version first adds its columns (`audit.via`, `jobs.sources`), when no copy is there yet, even if the tag map was already version 2. Nothing deletes them on a schedule. Delete them yourself once the app runs well.
- **Rolling back is not restoring these copies.** To turn daily tags off, set `TAG_ROTATION=off` on this version and keep the version 2 `tagmap.json`: every tag Muse holds then keeps its one value. Put `tagmap.json.v1-backup-*` back only if Muse never saw a tag from version 2. That copy holds the old counters, so the next start would hand codes Muse already holds, such as `[Person 3]`, to different people, and a later request with that tag would restore the wrong person. The older code (the ethan/device-only-build branch) cannot read a version 2 tag map: it will not start (its log ends with "the tag map file is unreadable"), so the app stays down until the version 1 file is back.
- **The audit table:** tool names, outcomes and timings only, with no content.
- **Learned rules** (`BASE_HOME/router_rules.md`): decisions about kinds of results, not about people.
- **Your documents.** They are yours, and this app never changes or deletes them.

## What this doesn't cover

Anything already sent to Muse. Meta's terms say deleting a message or an account may not delete Meta's copy, which is why only tagged results leave this device. A tag Muse kept stops working on this device after the grace window, but Muse's copy of the tagged text stays wherever Meta keeps it.
