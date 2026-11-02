# Build range

`BUILD_RANGE=1` is for the complaint that builds look alike, stay small and don't use their agents. Off by default. With it off, prompts, schemas and products are byte for byte what they were (`lib/range/__tests__/range.test.ts`, `lib/brief/__tests__/flags-off.test.ts`).

It needs a builder snapshot with `template/targets/build-range`. A build fails at provision without it, rather than build with rules that fight its prompt. The flag turns on `MUSE_APP_LOOK` and `MUSE_FULL`'s settings itself.

## What changes with it on

**A design direction per brief.** The writer must fill `direction`: palette, type pairing from `@fontsource` packages, density, layout, shape, motion and imagery. Three things keep directions apart:
- Each build gets a starting idea picked by its id (`DIRECTION_STARTS`).
- The writer sees the colors and display face of the last 8 directions, never their product text.
- `directionProblems` sends back the default white and blue, the same face and accent as a recent product, a text pair under 4.5:1, or a font outside `@fontsource`. It's one repair call, so a brief that still fails goes on with what it has. A look the person asked for is exempt from the first two.

**The kit supplies parts, the direction drives the look.** The overlay replaces `AGENTS.md`, `muse-app-ui` and `product-ui` in the product. The quiet, single font, no shadow, 720 px and five pattern rules become defaults. What stays: the parts, four states, labels, focus rings, 44 px targets, contrast, the footer, `data-result` and friends, no sideways page scroll, the two-line h1 limit, and never copying a real brand's logo, characters, artwork or exact look.

**Depth.** The writer can list up to 12 screens without `FULL_BUILDS`, picks the models that make the product better, and the build prompt asks for a real product rather than the smallest thing that passes. "Pick a simpler one" now comes only after three real failures and a different approach of the same ambition. The final-screen limits widen from 1,000 px to 2,400 px for the result's top and from 4,000 px to 12,000 px for the page, through the overlay's own copy of `scripts/smoke-report.mjs`, so the template's script is unchanged.

**Agents.** On a complex build, a required `## How you must work` section sits right after Done means and names the tools: a scout first, at least two isolated writers, a per-screen workflow, and an early reviewer. Milestone prompts repeat it, fix prompts say when to split, and the goal and Done means ask `BUILD_NOTES.md` to list what ran. The flag also turns on `MUSE_FULL`'s capacity setting and the `workflow-authoring` skill, within `agents.execution_capacity`.

**The judge.** A product with a direction is judged on craft and fit to it. No house style is expected. Its rules on copying and on Meta's marks are unchanged.

## What this doesn't do

- `visual-coding` and the other bundled skills stay off. Their reasons date from the Oct 27 spike and haven't been retested.
- The agent section is an instruction. Nothing fails a build for skipping it.
- Changes to a live product keep their existing rule: don't restyle what the request doesn't change.
- The milestone limits (4 requirements a milestone, 6 at most) and the round and wall caps are unchanged.
