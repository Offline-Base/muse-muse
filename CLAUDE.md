@AGENTS.md

# Muse Muse

Offline Base's entry in the Meta Global AI Developer Hackathon: startup track, theme Build for Your World (owner, Nov 4), by Ethan and Hussam. Due Nov 4, 2026, 9 PM ET; Ethan submits by noon ET.

## Read first

| For | Read |
|---|---|
| Where things stand: open PRs, what waits on the owner, fleet changes, gotchas | docs/HANDOFF.md |
| Anything said in public: submission, video, posts, page copy | docs/MESSAGING.md, then the marks in docs/STORY.md and docs/PROVE_RESULTS.md |
| The submission text and form answers | docs/SUBMISSION.md |
| The video script and shot list | docs/VIDEO.md |
| The edge track: units and their status, owner decisions O1 to O8, Hussam's asks H1 to H5, when each edge claim may be said | docs/EDGE_PLAN.md |
| Training-data rights: who wrote each set, Meta's terms, what may be published | docs/DATA_RIGHTS.md |
| What happened and why: every merge, review, fix, measurement, spend and decision | docs/BUILD_LOG.md |
| Training, tune runs, the Make chat | docs/TRAINING.md |
| Redoing Meta's 30 lessons on /learn: batches, shared builds and tunes, costs, run steps, how a card moves from planned to run | docs/LEARN_PLAN.md |
| The knowledge run (r30b), quantizing, one-bit files | docs/KNOWLEDGE_RUN_LOG.md |
| Boards, offline use, the fleet | docs/OFFLINE.md, docs/JETSON_TODO.md, docs/BOARD_LOOP.md, docs/DRIVE_EXPORT.md, docs/GADGETS.md |
| Spikes | docs/SPIKES.md and docs/spikes/ |
| Muse Privacy (`privacy/`, kept out of the site) | privacy/CLAUDE.md, privacy/README.md, privacy/docs/BUILD_LOG.md |
| Meta's own docs, offline copy | content/meta-docs/pages/ |

## Rules on every task

- Log as you go in docs/BUILD_LOG.md (Muse Privacy work in privacy/docs/BUILD_LOG.md), with screenshots in docs/log/shots/<date>/. Update docs/HANDOFF.md when a fact in it changes.
- Before writing a claim, check it against docs/MESSAGING.md and the story marks. Say "is built so" for anything that hasn't run.
- Run tests only for the code you touched: `npx tsx --experimental-test-module-mocks --test <files>`. #65 fixed the unit tests main failed on Nov 2 (docs/HANDOFF.md, Gotchas).
- Test builds and examples use `TEST_MODEL` (muse-spark-1.3-contributor) with made-up data, never muse-spark-1.3 standard. Real products run on Muse Wonder.
- No em dashes in anything a user or judge reads.
- Never print, copy or reuse keys or tokens. Don't read `.env.local`, and never `vercel env pull` over it.
- Work in a worktree under ~/mm-wt, not the main checkout at ~/muse-muse. No PRs for your own work (owner, Nov 2 night): fetch the latest main first, run the tests for what you touched, then commit and push straight to main. A push to main deploys production. Hussam's PRs stay his to merge.
- Hussam owns the gadgets, `muse-device` and the boards. Don't change them without him.
- Reach the Jetsons only through the fleet control plane, never SSH from the laptop. Keep jetson-05 out of experiments.
- Never run Muse Glimmer on this laptop. Keep to about 3 heavy jobs at once and 6 GB of free disk.
