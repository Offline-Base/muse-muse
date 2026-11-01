# Chained builds

`CHAINED_BUILDS` lets one build run for many hours, so a product too big for one full build can still be finished. It needs `FULL_BUILDS`, and it's off by default. Off, nothing changes. Not yet run for real.

## When a build chains

Code decides at the brief step and saves `chained: true` on the brief. All of these must hold: the flag is on, the brief has more than 24 requirements (what 6 milestones of 4 hold), the builder is signed in and not banned, and the build wasn't started by a platform power. The writer may then give up to 200 requirements, and they split into up to 40 milestones.

## How it runs

| Part | What happens | Where |
|---|---|---|
| Plan | `chainRoundPlan`: a session's wall, a verify of 25 to 45 minutes, a round under what's left | `lib/pipeline/steps.ts` |
| Before each round | `chainNext` decides from the facts: run it, start a new session, or end the chain | `lib/chain/plan.ts` |
| Ending a session | `chainSaveStep` writes `CHAIN_STATE.md` and commits all work to the product's repo | `lib/pipeline/build-steps.ts` |
| Starting one | `chainReopenStep` revokes the build token, stops the sandbox, reopens it with a new token and a new Muse Code session id | `lib/pipeline/build-steps.ts` |
| First prompt | Says it has no memory, and to read brief.md, `CHAIN_STATE.md`, BUILD_NOTES.md and the git log first | `chainSessionPreface` |
| Final checks | A fresh session if this one can't hold them, then the usual checks, fix rounds, judge and shipping | `runChain` in `lib/pipeline/workflow.ts` |
| Sweep | Leaves a chain alone until its own limit plus 3 hours | `lib/pipeline/sweep.ts` |

## Limits

| Setting | Default | What it stops |
|---|---|---|
| `CHAINED_TOTAL_USD` | 60 | The whole build. $3 is kept for the final checks, and no fix round starts past it |
| `CHAINED_SESSION_USD` | 15 | One session's token. The gateway enforces it, including mid-round |
| `CHAINED_SESSION_MINUTES` | 85 | One session, held to 45 through 120 |
| `CHAINED_MAX_SESSIONS` | 12 | Sessions, held to 1 through 40 |
| `CHAINED_MAX_HOURS` | 24 | The whole chain, held to 3 through 72 |

Hitting the total, the session count or the hours skips the milestones left and checks what was built, which ships as partial. The owner's Stop ends the build at the next poll or between sessions.

## Known gaps

- `DAILY_SPEND_CAP_USD` still fails a chain at its next spend check rather than waiting for the next day. Its work stays in the repo, but nothing resumes it.
- A workflow that dies can't resume, and the sweep then fails the build.
- A session crossing midnight UTC gets a fresh daily count on its token, so the total can be passed by at most one session's budget before the next check.
- The judge sees at most 48 screenshots, so a brief over about 46 requirements can't have them all marked met.
- Platform calls (the judge, the scope check) don't pass through the session token, so they count only at the next check.

## What the first real run must check

Use made-up data, a Preview, and a low `CHAINED_TOTAL_USD`, with `CHAINED_SESSION_MINUTES=45` so rotations come quickly.

1. A brief over 24 requirements gets `chained: true`, and a smaller one doesn't.
2. `sandbox.stop()` followed straight away by reopening works, and the files, `node_modules` and git history survive.
3. A new `--session-id` on a later round starts cleanly on both `exec` and `serve`, since until now round 0 has always been the one that made a session.
4. The new session really reads `CHAIN_STATE.md` and carries on, rather than rewriting earlier milestones.
5. The sandbox's firewall and caps' `.env.local` come back after reopening, with the new token working and the old one refused.
6. `git add -A` commits nothing secret. `.env*.local` is ignored by the template.
7. The build passes 90 minutes, then 3 hours, without the sweep or any Vercel limit stopping it.
8. Verify's real length on a growing product. It holds every requirement so far, each round.
9. Spend: the session token stops Muse Code at its budget, the chain rotates after it, and the total ends the chain.
10. Stop during a round, during a verify, and between sessions.
11. The final checks, judge, deploy and refine all work after a chain, including round numbers past 10 in the build room and logs.
