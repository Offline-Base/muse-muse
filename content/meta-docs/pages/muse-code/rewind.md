# Rewind a conversation {#rewind-a-conversation}

Return to an earlier message when you want to take the conversation in a different direction. Rewind creates a retained conversation branch and restores the selected message as an unsent draft.

## Rewind to a message {#rewind}

Once the current turn has finished, open the rewind picker in either of two ways:

- Run the `/rewind` command.
- Press `Esc` twice in quick succession from an empty composer. The first `Esc` shows **Esc again to rewind**.

Then work through the picker:

1. Select a previous message with `Up` and `Down`. You can also use `Ctrl+P`, `Ctrl+N`, `Home`, and `End`.
2. Press `Enter` to open the action screen.
3. Review any warnings, leave **Rewind conversation** selected, and press `Enter` again.
4. Edit the restored message in the new branch, then submit it when you're ready.

Press `Esc` to leave the message picker. From the action screen, `Esc` returns to the picker. You can also select **Never mind** to cancel.

> Both entry points require the idle main conversation. The double-`Esc` gesture also needs an empty composer: an `Esc` that interrupts a running turn, closes another surface, or acts on a draft does not start the gesture.

## Understand the new branch {#branch}

Suppose the original conversation contains three inputs:

```text
A → B → C
```

If you rewind to `B`, Muse Code creates a child session with the context before `B`:

```text
Branch context: A
Composer draft: B
```

The selected input is not submitted automatically. You can revise it before you continue.

The source session keeps `A → B → C` and remains available through `/resume`. The child is also a normal retained session, so you can resume it later or rewind it again. Muse Code displays a divider when it moves your terminal into the branch:

```text
• You're continuing from this point in a new conversation
```

The earlier scrollback above that divider remains visible for orientation. Only the history before the selected input enters the child model's context.

## Keep workspace changes separate {#workspace}

Rewind changes conversation history only. It does not restore, revert, or delete workspace files.

Any shell commands, subagents, workflows, approvals, or deliveries that still belong to the source session continue there. The action screen warns you when Muse Code detects active background work. The new branch does not receive those live task handles.

Review the working copy before you continue if the discarded conversation turns changed files. Restore code separately with your source-control tools when needed.

## Read rewind availability {#availability}

The picker labels each prior input:

- **Exact**: Muse Code can recreate the branch and restore the selected input without known loss.
- **Review required**: Muse Code can create the branch, but part of the selected input is unavailable. The action screen describes the missing attachment or skill. Replace or remove any missing-content marker before you submit the restored draft.
- **Blocked**: Muse Code cannot prove that the branch would preserve valid history. Select the row to read the reason. Pressing `Enter` does not continue from a blocked row.

Some inputs do not appear as rewind targets. Rewind uses complete top-level turn boundaries. Mid-turn steering, pending queued input, local slash commands, and active turns are not separate rewind points.

Muse Code can also block a point when:

- The point is older than retained history.
- The conversation contains Goal history that cannot cross the selected boundary.
- A required attachment in the retained prefix is unavailable.
- The retained tool history cannot be replayed safely.
- The original input or plugin binding cannot be reconstructed safely.

Older sessions can contain messages that predate rewind support. Muse Code identifies those messages in the picker or explains that the conversation has no supported rewind points.

## Know the session requirements {#requirements}

Rewind is available only in interactive terminal sessions with session logging enabled. It is unavailable in sessions started with `muse --no-session-log`.

Open the picker with the `/rewind` command, or with the double-`Esc` gesture from an empty composer. Either way, the main conversation must be idle.

## Next steps {#next-steps}

- Learn how to resume and fork retained sessions in [working with the agent](https://dev.meta.ai/docs/muse-code/interactive#sessions).
- Manage source-session work through [background tasks](https://dev.meta.ai/docs/muse-code/interactive#tasks).
- Coordinate independent branches with [session messaging](https://dev.meta.ai/docs/muse-code/session-messaging).
