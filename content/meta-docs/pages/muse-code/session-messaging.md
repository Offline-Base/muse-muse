# Coordinate sessions with messages {#coordinate-sessions-with-messages}

Send a bounded piece of context from one live Muse Code session to another. Each session keeps its own transcript, workspace, permissions, and active task while the agents coordinate locally.

## Run sessions in parallel {#parallel-sessions}

Open a separate terminal for each independent stream of work. Start each session in the project and give it a name that describes its responsibility.

Session names use a case-insensitive, user-wide namespace. Choose a fresh suffix for repeated examples. The examples below use `482731`; replace it with your own unique value.

### First terminal {#first-terminal}

```bash
cd /path/to/your/project
muse
```

```text
/name implementation-482731
```

### Second terminal {#second-terminal}

```bash
cd /path/to/your/project
muse
```

```text
/name api-review-482731
```

Each process creates an independent session with its own transcript, context, task state, and approvals. This separation works well when one agent implements while another investigates, reviews, or monitors a dependency.

Sessions started in the same directory share the same working copy. Use that setup when the additional sessions are read-only. If more than one session will edit files, give each writer its own Git worktree:

```bash
cd /path/to/your/project
muse -w
```

The bare `-w` option creates a Muse Code-managed worktree from `HEAD` for that session. Review and integrate each session's changes through your normal source-control workflow.

## Send your first message {#first-message}

With both sessions running, give the receiving session a stable name if you haven't already:

```text
/name api-review-482731
```

In the sending session, ask Muse Code to discover its peers and send the message:

```text
List my peer sessions, then send api-review-482731 this message:
Please review the authentication changes in my current branch and report any blocking issue.
```

Muse Code uses the session's exact canonical name or full session UUID. Asking it to list peers first avoids sending to a stale or mistyped target.

The receiving session may ask its user to approve the sender. After acceptance, the message appears in the recipient's timeline and reaches the model according to the requested delivery behavior.

## Name a session {#names}

Run `/name` to show the current session name. Run `/name <name>` to change it:

```text
/name frontend-migration-482731
```

A session name can use ASCII uppercase letters. Muse Code normalizes them to lowercase before validation. After normalization, the name must:

- Contain 3-32 ASCII characters.
- Start with a lowercase letter.
- Use lowercase letters, digits, and single hyphens.
- Avoid a trailing hyphen or consecutive hyphens.

For example, `/name API-Review-482731` is stored as `api-review-482731`. The names `all`, `self`, and `current` are reserved. An ordinary retained interactive session receives an automatic name when you don't set one. A session started with `muse --no-session-log` has no retained name and cannot participate in peer messaging.

Names are unique across your Muse Code sessions, not only within one workspace. Renaming a retained session leaves its previous names reserved to that session. Another session cannot claim one of those tombstoned names, although the original session can reclaim it.

Use names that describe ownership or purpose, such as `api-review-482731`, `frontend-migration-482731`, or `release-check-482731`.

## Choose delivery behavior {#delivery}

The default message steers the recipient's active turn when possible. You can ask for a different delivery behavior in plain language:

- **Steer the active turn**: add the message to the recipient's current work at its next safe model step.
- **Queue for the next turn**: leave the active turn unchanged and deliver the message when the next turn starts.
- **Notify only**: show and record the message without adding it to the recipient model's context.

Examples:

```text
Send api-review-482731 the test failure now so it can account for it in the active review.
```

```text
Queue this for implementation-482731's next turn: the API field is named account_id.
```

```text
Notify api-review-482731 that the build passed. Don't add the notification to its model context.
```

The sender can also request that a session stay idle, wake when idle, or wake at a safe point. Muse Code defaults to waking the recipient when it is idle.

## Approve a peer {#approval}

An unverified or non-matching sender may produce an approval prompt in the receiving session. The prompt shows the sender name, session ID, workspace, and message preview. It also shows a delivery effect when the sender requests a non-default delivery or wake policy.

Choose one response:

- **Allow once**: accept this message only.
- **Reject once**: reject this message only.
- **Allow for this session**: accept later messages from this peer until either session restarts.
- **Block for this session**: reject later messages from this peer until either session restarts.

Pending approval requests expire after 30 minutes. After expiry, the same admission enters a 30-minute retry cooldown; attempts during that period return a `retry later` outcome. A sender may stop waiting before the first window closes, so check the receiving session when delivery remains unconfirmed.

## Understand the trust boundary {#trust}

Muse Code treats a peer message as unverified agent-provided data. A message cannot:

- Approve a tool call.
- Grant user consent.
- Change permissions or configuration.
- Present itself as direct user input.

The receiving model gets the sender's identity and a fixed instruction to treat the message body as data. Keep authorization decisions in the receiving session with its user.

Use session messages for coordination, status, evidence, and review requests. Don't use them to transfer secrets or to assume that another session executed a command.

## Use effective coordination patterns {#patterns}

### Request a review {#request-a-review}

```text
Ask api-review-482731 to inspect commit abc123 for authentication regressions.
Request file and line references in the reply.
```

### Hand off a discovered constraint {#hand-off-a-discovered-constraint}

```text
Send implementation-482731 this finding for its active turn:
The compatibility layer requires schema version 3 until the mobile rollout completes.
```

### Coordinate completion {#coordinate-completion}

```text
Tell api-review-482731 that my migration is ready. Ask it to run its release checklist
and message this session with the result.
```

Replies are explicit messages. Include the sending session's name when you want the peer to report back to a specific session.

## Know the current scope {#scope}

Session messaging connects eligible interactive sessions for the same user account on the same macOS or Linux machine. It is currently unavailable on Windows. Headless, `--no-session-log`, and other launch-ineligible surfaces don't appear in the peer list. It does not provide cross-user or cross-machine transport.

Messages contain plain text and can use up to 8,192 bytes. Self-messaging is rejected, and duplicate message IDs are deduplicated.

Session messaging provides coordination rather than shared state. A message doesn't merge transcripts, files, permissions, or task ownership between sessions.

## Turn session messaging on or off {#configure}

The local session-messaging preference is on by default. Availability also depends on the session-messaging rollout gate. When the feature is available, open `/settings` and find **Tools > Session messaging** to turn it off or back on. A preference change applies on the next Muse Code launch.

## Next steps {#next-steps}

- Learn how to start, resume, fork, and name sessions in [working with the agent](https://dev.meta.ai/docs/muse-code/interactive#sessions).
- Run coordinated child agents inside one session with [workflows](https://dev.meta.ai/docs/muse-code/workflows).
- Review approval and sandbox boundaries in [permissions and safety](https://dev.meta.ai/docs/muse-code/permissions).
