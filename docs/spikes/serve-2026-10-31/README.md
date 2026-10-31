# Serve test, Oct 31, 2026

Real test builds of Muse Code at full strength (`MUSE_ENGINE=serve`, `MUSE_FULL=1`) on real Vercel Sandboxes with real Meta
calls, driven from a local dev server. Branch `tg-serve-test`. Muse Code 1.4.14, the Oct 28 builder snapshot (no new snapshot
was needed). All builds on muse-wonder-1.0. Nothing published.

## The call

**Serve plus MUSE_FULL works, but don't make today's settings the default yet.** After the three fixes below, every check
passed. On the same muse with the same judge result, it cost 2.4 times as much and took 1.8 times as long as exec. Most of the
gap is reminder agents that almost never say anything.

1. Before flipping the default, turn off `scope-reminder` and decide on `skill-reminder` (`REMINDER_IDS` in
   `lib/sandbox/muse-config.ts`). Over these four builds scope ran 173 times and delivered 0 reminders, and skill ran 148 times
   and delivered 4. Together they were 34% of build A's Muse Code spend.
2. Run one build on a Vercel preview. The build MCP server can't be reached from a local run, so it is the one part of
   MUSE_FULL nothing here touched.
3. Then flip it. Bridge, live room, steering, Stop, resume, accounting and cost lines all held up on real builds.

One sample per engine, and the two briefs came out differently (the serve build's brief added a receipt photo check), so treat
2.4x as a rough figure.

## Results

| Build | Setup | Outcome | Time | Muse Code round | Recorded cost | Main calls | Reminder calls | Subagent calls | Judge |
|---|---|---|---|---|---|---|---|---|---|
| A: bill splitter, one image | serve + full | live, 0 fix rounds | 511 s | 371 s | $4.75 | 58, $2.34 | 106, $2.02 | 6, $0.27 | pass |
| A2: change on A, one queued note | serve + full | live, 0 fix rounds | 344 s | 252 s | $3.87 | 34, $1.73 | 71, $2.09 | 0 | pass |
| B: unit converter, one steer, injected failure | serve + full | live, 1 fix round | 820 s | 371 s + 303 s | $6.76 | 82, $3.00 | 151, $3.35* | 5, $0.32 | pass after the fix |
| C: dice roller, stopped at about 2 min | serve + full | failed, "Stopped by you." | 141 s | 126 s | $1.62 | 20, $0.88 | 34, $0.69 | 0 | not reached |
| X: bill splitter, same note and image | flags off, exec | live, 0 fix rounds | 288 s | 183 s | $2.00 | 28, $1.23 | 27, $0.68 | 0 | pass |

*B's fix round ran its 29 reminder calls on muse-spark-1.3 (see Bug 3) but they were charged at Wonder prices, $1.30 where the
real cost was about $0.44. Exec's 27 reminder calls are on Wonder here because of Bug 2's fix. On Spark 1.3 they cost about a
third of that.

Spend for this unit: $19.83 of $25, line by line in `spend.md`.

## Bugs found and fixed

1. **Serve never ran.** `muse serve` refuses `session/start` for anything but a UUIDv7 ("invalid session/start sessionId:
   expected UUIDv7"), and builds minted a v4. Every serve round would have fallen back to exec with only a build room notice.
   New builds now mint a v7 (`newSessionId`). Exec takes it too, and each engine resumes the other's sessions whatever the id's
   version (`phase-2.txt`), so products built before this still refine.
2. **Every Wonder build calls muse-spark-1.3, on exec too.** Meta's catalog gives muse-wonder-1.0
   `background_agent_model: "muse-spark-1.3"`, so all reminder agents run there, on production as well, against the rule that
   this platform never uses that model. It also made the books wrong: reminders were priced at Wonder. A settings catalog row
   (`backgroundModelSetting`) now names the round's own model, on both engines. This raises the real cost of a flags-off build:
   X's reminders were $0.68, about $0.22 on Spark 1.3. It's the one change here to flags-off behavior, and the owner may prefer
   another answer (Spark Contributor can't do it: on serve a contributor id here turns back into muse-spark-1.3).
3. **The row only held in a sandbox's first serve round.** A `muse serve` that finds its copy of the catalog
   (`~/.local/share/muse/model-catalog`) skips the row, so round 2 on went back to Spark 1.3. The bridge's prepare step now
   deletes the copy (`phase-1i.txt`). Found on build B: its fix round made 29 real reminder calls on muse-spark-1.3, about $0.44,
   before this fix went in. Those are the only real calls to that model in this test: every later serve round, A2 included, ran
   entirely on Wonder.

## The checklist

**1. Real host (throwaway sandboxes, `phase-*.txt`).**
- `tools.web_search.mode="off"` **works**. The main agent's tool list drops both `web_search` and `web_fetch` (31 to 29 tools,
  from a PreLLMCall hook with model calls answered 403), and a real Wonder turn said "NO WEB TOOL". An unknown value or key
  refuses the start.
- Serve offers neither `image_generation` nor `work_status`, which exec has. The firewall blocks image calls from Muse Code on a
  public platform anyway, so this costs nothing today.
- `session/read` **works**, with the shape the bridge reads: `session.status`, `session.activeTurnId`, and `lastTurn` with
  `terminal`, `turnId`, `error`, `reason`. While a turn runs it says `running` with the turn's id.
- `view/page` **works**, with the shape the bridge reads: `events` of `{method, params}`, cursors in `params.viewCursor`,
  `nextCursor` null at the end, and nothing past the last cursor. A real `view/gap` never came up, so `fillGap` was exercised by
  calling the same method, not by a real hole in the stream.

**2. A small real build.** A went start to finish on serve. The room showed tools, edits, reasoning, reminders, hooks, goal,
todos and subagents in 22 events over 6 minutes. Condenser state between polls stayed tiny: the largest whole poll result was
3.9 KB, against limits of 256 KB of open items and 32 announced keys. Costs land when a round ends, as on exec, so a running round's
spend isn't visible to the spend cap.

**3. A fix round.** B: a type error written into the product between the round and verify (no product code changed). Verify
failed, `fix-1.md` went out, the session resumed, the goal was set again and met, verify passed, the judge passed.

**4. A refinement.** A2: `session/resume` ok, `goal/set` ok, the change was made, and checks and judge passed. Open: the goal it
gets is the build's ("Build X as brief.md describes"), not the change, so the goal observer doesn't check the change. It passed
anyway.

**5. Owner controls, all through the real route.**
- Steer (B, mid-turn): `turn/steer` accepted, and the Copy result button it asked for was in the code, the test and the notes.
- Queue (A2): queued, then ran as its own turn after the first.
- Goal edit (C): the goal text changed live.
- Interrupt (C): the turn ended in about 1 s. The goal went to paused, and a note then started a new turn. The goal stays paused
  after that, which reads a little oddly.
- Stop (C): `failed`, "Stopped by you.", 8 s after the click, with charges kept and no sandbox work left.
- Question: none can come while the bridge passes `--disable-request-user-input`. On a throwaway bridge with it off, Muse Code
  asked, a 76 s wait passed the 60 s session check without ending the turn, the mailbox answer went through, and the file had the
  answer (`phase-4.txt`). Before turning it on: a question nobody answers holds the round until its 25-minute cap.
- With flags off, the control route answers 503 `steering_off`.

**6. Accounting.** Session log run ids **match** the turn ids, in every parent record of every serve round, so serve is charged
from the session logs and the host-tally fallback never ran. An independent recount of every log matched the recorded amounts to
the cent (A: $4.634 for its first round). Reminder records in child logs are exact copies of parent records, so dropping them is
right. The main agent's calls also match `session/tokenUsage` exactly, and Muse Code's own `cost.usd` on it matches our pricing
($3.002 on B). Meta has no usage API (`/v1/usage` and its neighbors answer 404), so the closest check against Meta is that all
these token counts are the ones its responses reported.

**7. Exec with flags off.** X above: live and judged a pass, so flags-off still works.

## What reminders really did

| Reminder | Runs (A, A2, B, C) | Delivered | Cost on A's first round |
|---|---|---|---|
| scope | 173 | 0 | $0.76 |
| skill | 148 | 4 | $0.84 |
| todo | 35 | 8 | $0.18 |
| goal | 5 | 0 | $0.20 |
| verify | 5 | 0 | $0.05 |

On a small change (A2) reminders cost more than the main agent: $2.09 of $3.87.

## Also seen, not changed

- The first reviewer subagent on A passed its whole instructions as its role and failed with `runtime_turn_task_lost`, at no cost.
  Muse Code then retried with a short role. The room's label for it is the tail of that text, cut at the last slash.
- "How it was built" shows raw first lines of tool results (`{`, `<read-skill-result ...>`) on both engines, as its test expects.
- Turbopack refuses a worktree's symlinked `node_modules`, so this ran on `next dev --webpack`.
- Goal, workflow and subagent commands still have no UI, as `docs/MUSE_CODE_FULL.md` says. Workflows and worktree writers never
  came up on these small muses, so neither was exercised.

## Files

`run-probe.ts` and `phase-*.sh` run the throwaway probes, `msp-host-probe.mjs` is their protocol client, and `phase-*.txt` are the
outputs worth keeping. `drive.mts` drives a build on the local platform, `tally.ts` reads a running round's spend, and `peek.ts`
copies its logs out. All sandboxes were deleted after the test.
