# Building with Muse Code {#building-with-muse-code}

Build durable, auditable agents with Muse Code — the harness building blocks for safety, recovery, and orchestration. Part of the [Cookbook](https://dev.meta.ai/docs/cookbook).

- [Audit and resume agent sessions](https://dev.meta.ai/docs/cookbook/audit-agent-sessions): Replay any session exactly as it ran from an append-only event log, show who authorized each action, then kill the run mid-task and resume with no duplicate side effects.
- [Deterministic replay in CI](https://dev.meta.ai/docs/cookbook/deterministic-replay): Turn recorded events into a golden fixture and replay its model-context projection as a merge-blocking CI check.
- [Staged approvals](https://dev.meta.ai/docs/cookbook/staged-approvals): Split a compound shell command into stages so safe ones auto-resolve while risky ones hold for review.
- [Contained execution](https://dev.meta.ai/docs/cookbook/contained-execution): Run every command in an OS sandbox that refuses to proceed unless containment is proven live.
- [Immutable guardrails](https://dev.meta.ai/docs/cookbook/immutable-guardrails): The agent can't rewrite its own rules: guardrail edits stop for review and a shell write to the same path fails read-only at the sandbox.
- [Subagent fanout](https://dev.meta.ai/docs/cookbook/subagent-fanout): Fan one job out to parallel subagents, each in its own isolated git worktree.
- [Goal tracking](https://dev.meta.ai/docs/cookbook/goal-tracking): Pin an objective once and the harness audits the work against acceptance checks before the goal can close.
- [Bundled skills](https://dev.meta.ai/docs/cookbook/bundled-skills): Drive the built-in /plan, /grilling, /grill-with-docs, and /taste skills to plan, pressure-test, and build.
- [Loop and cron](https://dev.meta.ai/docs/cookbook/loop-and-cron): Schedule recurring or one-time agent work in natural language, then view, change, or cancel it from the same chat.
- [Side chats](https://dev.meta.ai/docs/cookbook/side-chats): Branch off the main thread for a side conversation that never enters the main history.
