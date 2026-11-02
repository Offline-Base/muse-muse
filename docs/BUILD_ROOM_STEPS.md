# The build room's steps feed (BUILD_ROOM_STEPS)

Owner's design, Nov 1: one-bullet, very simple summaries of what Muse Code is doing, a little summary for each 3 steps with a cute comment, and the actual stuff on the right. Off by default, and with it off the room is as it was (`plan-art-flag-off.test.tsx` holds it to the same bytes).

## What the person sees

- **Wide room:** two columns. Left, the person's message, the Muse Code status and the feed. Right, the plan, the checklist, the preview, the demo, the shipped result and the check lines.
- **Show details** opens the existing steps panel with the raw steps and Sources. With it open there's less room, so the columns become tabs.
- **Phone or narrow room:** tabs, Steps first, then The build. The panel's sheet still opens from Show details.
- **Finished builds** keep the feed as their history.

## Where the lines come from

`lib/steps-feed/facts.ts` works the steps out of the build's events, in the browser and on the server alike. Each step has a stable id and its own plain words, so:

- A step exists only because an event does. The model can't add one.
- With no model at all, or when it fails, the feed reads fine.
- A line never carries a path, a tool name or agent prose. Page names come from a route folder, lower case letters and hyphens only, with words such as `env`, `token` and `admin` dropped.

`lib/steps-feed/words.ts` asks Contributor to reword finished steps by id, and to write a recap and a comment per three. It sends only the plain words and the tone, never the person's text. Replies go through `cleanWords`: too long, technical, private, a success claim the facts don't make, or a named thing the facts don't name, and that line stays plain. Dashes become commas. A running step and the build's ending are never reworded.

## Cost and safety

- `lib/pipeline/steps-feed-step.ts` runs beside the build, started from Muse Code's polling at most once a minute, one at a time, and once more before cleanup. The workflow never waits for it, and it never throws or retries.
- 15 s time box, at least 3 finished steps a batch, at most 40 batches a build, and the daily spend cap applies. Usage goes in the usage table and in the build's costs as "Step summaries".
- A call cut off by its time box records no usage, since its reply never came. At Contributor's prices that is a small fraction of a cent.

## Limits

- Words land on a batch, so a step can show its plain line for a minute or more. Steps during the checks are worded at the next Muse Code poll or the last call.
- The last call can land after the stream closes. Then the plain line shows until the page is reloaded.
- The room has no file list today, so "files" on the right is still the Sources tab and the Build details menu.
