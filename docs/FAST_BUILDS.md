# Fast builds

`FAST_BUILDS=1` makes builds finish sooner. Off by default. With it off, prompts, plans and sandboxes are what they were.

## Complex builds only

- **One round.** A brief is marked `fast`, so `fullMilestones` gives one milestone: no strict verify between milestones.
- **Required way of working** (`lib/fast/fast.ts`, in brief.md's How you must work): a read-only scout splits the work by files, the main agent sets up shared parts and commits, then one writer per screen or feature in an isolated worktree, up to the agent capacity. Each finished writer merges at once. Each writer has a 10 minute deadline, and the main agent finishes a part that fails or runs over. Checks fan out per screen with a workflow. This is an instruction: nothing fails a build for skipping it.
- **Fix rounds recheck.** After a full check where only requirement tests failed, the next check is `next build` plus those tests alone (task `recheck`, no snapshot change). A pass or a timeout goes on to the full check. A failure goes to the next fix round if one fits, or else to the full check. Only `npm run verify` and the judge can pass a build, so the full check always runs before live. A chain doesn't use any of this.
- **The story** adds a line like "3 helpers are building your screens" when two or more writers run.

## Every build

The sandbox starts from the snapshot beside the brief (`warmSandbox`), with no install beyond the look's overlay, and is stopped if the brief refuses or the build fails before provisioning. The sandbox can't be renamed after the slug is known, so with the flag on a product's id is its build id and its sandbox is `product-fast-<8 hex>`.

The flag also turns on `MUSE_FULL`'s capacity setting and workflow skill, as `BUILD_RANGE` does.
