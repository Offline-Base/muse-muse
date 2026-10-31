# muse-app look: trial builds, Oct 31, 2026

Two real builds with `MUSE_APP_LOOK=1`, to see whether the muse-app-ui skill and `app/muse-app.css`
(`template/targets/muse-app`, docs/BRAND.md) work in a real Muse Code run. Local platform from branch `tg-ui-brand` at
`91c761c`, on port 3010 with a fresh PGlite database, `OPEN_ACCESS=admin`, `TEST_MODEL=muse-spark-1.3-contributor` and a
test builder snapshot made from this branch's template (`npm run snapshot`, Muse Code 1.4.14, template hash
`a20419febcfc`). The snapshot id was only an env override for the run, and the snapshot, both product sandboxes and their
snapshots were deleted afterwards. Made-up content only. Nothing published.

Builds were driven with `docs/spikes/serve-2026-10-31/drive.mts`. `preview.ts` here reopens a product's sandbox for
screenshots. The screenshots are outside the repo, in `_plan/ui-brand-trial/` next to this worktree.

## Results

| | A: chore rota tool | B: fridge recipe helper |
|---|---|---|
| Note | Turn a pasted list of chores into a fair weekly rota | A recipe helper you can ask about what's in your fridge |
| Brief | Fair Home Rota, one text input, one action | Fridge Chat Chef, one text input, two actions |
| Outcome | live, 0 fix rounds, 598 s | live, 1 fix round, 762 s |
| Fix round | | First verify: `suggest_recipes` answered 500 in the actions test. Round 1 added a retry around model calls |
| Judge | pass, round 0 | pass, round 1 |
| Recorded cost | $0.0435 | $0.0542 |
| Pattern | Form, then a result card with `.bars`, `.kv` and a table | Tool, then a chat under the result (screens.md, Two patterns on one screen) |
| Read the skill | Yes: `muse-app-ui` (and product-ui, meta-reasoning, verify). No reference file opened | Same in round 0. Round 1's log has no muse-app-ui read; `meta-ui` shows up 4 times, at least partly the fix prompt's own wording |

Both products kept the overlay as applied: the "Look: muse-app" commit, `layout.tsx` loading Inter's optical size file,
then `globals.css`, then `muse-app.css`. Neither wrote a raw color. A added two rules for its own table to the end of
`muse-app.css`; that file loads last, so its rules there win over the look's, which is the right place. Measured in the
products at 1280 and 390, light and dark: white page (`#181819` dark), Inter Variable as the only font loaded, `h1` at
400, cards with a 1 px inset hairline and no shadow, 44 px pill buttons, primary `#0064d4`, purple cap and chip on AI
cards, the glass composer with its gradient send at half strength when empty, the footer, no sideways scroll and no em
dash on screen. No Meta name, logo or mark.

## Spend

| What | Meta | Sandbox (estimate) |
|---|---|---|
| Brief call with the development environment's Meta key: 401, so no charge. Later runs used the key local runs use | $0 | $0 |
| Test snapshot, 65 s on 4 vCPU | $0 | about $0.01 |
| A and B: brief, Muse Code, reminders, judge (usage records) | $0.0976 | |
| A and B sandboxes, build plus screenshots: 891 s active CPU, 4.6 GB-h memory, 0.16 GB transfer | | about $0.10 |
| Product calls during checks and screenshots (not metered on a local run, see below) | about $0.01 to $0.10 | |
| **Total** | **under $0.20** of the $3 cap | **about $0.11** of the $1 cap |

Sandbox figures are the sandboxes' own totals priced at $0.128 per active CPU hour, $0.0106 per GB-hour and $0.15 per GB.

## Models

Usage records: 10 rows, every one `muse-spark-1.3-contributor` (`builds.build_model` too). None on `muse-wonder-1.0` or
`muse-spark-1.3`. Muse Code's session logs name only Contributor and `same-as-main` for reminders. No fixture images
were made.

**One leak the records can't show.** B's follow-up chat (`app/api/chat/route.ts`) calls
`metaClient(request).responses.create({ model: "muse-wonder-1.0" })`. On a local run products call Meta directly, and
only `respondJson` swaps to `TEST_MODEL` (commit `712424e`), so every chat question in B's checks ran on
**muse-wonder-1.0**, unmetered: one per smoke run, across Muse Code's own verify runs and the platform's two, so likely
5 to 10 calls of a few hundred tokens. The screenshots here didn't send a chat question. Through the gateway (a Vercel
preview) the gateway swaps a build token's Wonder calls, so this is local runs only. Fix before the next local test:
make `metaClient` (or the direct-call path) swap a Wonder model to `TEST_MODEL` the way `respondJson` does, or point the
skill and AGENTS.md at `respondJson` for text replies too. Not changed here: it's template logic outside the look.

**Fixed after the trial.** `metaClient` now makes the swap itself: with `TEST_MODEL=muse-spark-1.3-contributor` it hands
the OpenAI SDK a fetch that rewrites a JSON body's `model` from exactly `muse-wonder-1.0` to Contributor, on every
endpoint, and leaves other models and non-JSON bodies alone. Without `TEST_MODEL` the client is the same as before.
Tests in `template/scripts/__tests__/test-model.test.mjs`.

## Old look against new

Each product was also served with its two overlay imports swapped back (Inter and Montserrat, then `globals.css` only),
so the same markup shows in both looks: `A-rota-old-result-*` and `B-fridge-old-result-*`.

- Page: gray `#F0F2F5` with flat white cards, now white with hairline cards. The new one reads closer to the Muse Muse
  app and to meta.ai, and cards stay visible on white because of the hairline.
- Headings: Montserrat 700, now Inter 400. The largest visible change, and the one the brand spec asked for.
- Buttons: 10 px corners and `#0866FF`, now pills and `#0064d4`. The AI cap goes from blue-to-violet to purple only.
- The composer: a flat gray field, now the glass pill with the gradient send.
- Unchanged: layout, spacing, copy, the model's output. Nothing in the products depended on the old values.

What the look doesn't explain, and Contributor's lower quality does: A's rota was uneven on one run (one person 7
points, the others 4) with no rebalancing in code; its hint says "Two at least" while the code accepts one person, and a
placeholder mixes formats; B's first `suggest_recipes` call failed verify until a retry was added. Those would look the
same in either theme.

## Skill problems found, and fixed

1. **The composer wrapped at 390 px.** B's placeholder "Compare ideas or swap an ingredient" (35 characters) made a two
   line box, since the composer sizes to its placeholder. Measured: up to 34 characters fit the 358 px column. SKILL.md
   and components.md now ask for 30 or fewer (`bc52cde`).
2. **The reference files were never opened** (screens.md, components.md, tokens.md: 0 reads in both builds). So rules
   only in components.md were missed: A set eight margins as bare numbers in style props, and B's `.tinted.ai` button had
   no sparkle. SKILL.md now states both with markup (`0f40b15`).

Not rerun after the fixes: that needs another snapshot.

## Also seen

- **Previews don't hydrate.** The sandbox preview runs `next dev`, and through its public domain the HMR socket answers
  500 and the page never hydrates: no button works. Screenshots were taken from `next start` on the same port instead.
  This is the build room's live preview, not the look, and wasn't changed here.
- **Product copy names Muse Wonder** ("Balanced by Muse Wonder", "Your words go to Muse Wonder") on a test build that ran
  on Contributor. Expected: the swap is invisible to the product.
- **The development environment's `MODEL_API_KEY` answers 401** on api.meta.ai; the key local runs use works.
