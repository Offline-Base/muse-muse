# Full builds

`FULL_BUILDS` makes Muse Muse build the whole product a person asked for, not one page around one flow. Off by default. Off, every prompt and schema is byte for byte what it was (`lib/brief/__tests__/flags-off.test.ts`).

## What changes with it on

| Stage | What happens | Where |
|---|---|---|
| Brief | A numbered `requirements` list: every ask in the person's words, plus what a complete product needs (navigation, saved data, edit, delete, empty and error states). Up to 60 requirements, 30 screens, 40 flow steps. Code sends back a list missing those parts or quoting words not in the note | `lib/full/requirements.ts`, `lib/prompts/brief.ts`, `lib/brief/schema.ts` |
| Can't do | `canDo: false` with a reason. Forces verdict "partly", adds a limit, and shows on the checklist and in the build log before the build starts | `nameWhatItCantDo` |
| Scope check | A separate model call on `JUDGE_MODEL`, with its own instructions and no build context, compares the request with the plan. A shrunken brief goes back, up to 2 times. What's still missing is added as requirements by code | `lib/full/scope.ts` |
| Build | `brief.md` lists the requirements, and code splits them into up to 6 milestones. A skill and a nav part arrive as extra files, so they need no new snapshot | `lib/full/prompts.ts` |
| Time | The wall is 150 minutes (`FULL_BUILD_WALL_MINUTES`, 90 to 150). Each milestone gets its share of what's left after the checks' reserve, so a round that ends early passes its time on. A round stopped at its cap goes on to the checks | `fullRoundPlan`, `fullRoundCap` in `lib/pipeline/steps.ts` |
| Tests | `tests/requirements.spec.ts` has one test per requirement, titled with its id. verify's `requirements` step fails a missing or failing one. A requirement that saves data must call `page.reload()` in its own test. On the last round the step reports without failing, so the judge still runs | `template/scripts/verify.mjs`, `smoke-report.mjs` |
| Judge | Sees up to 16 screenshots and reads each requirement. Met needs a passing test and the judge seeing it, decided in code. Anything unmet fails the round, and it goes first in the fix notes | `lib/judge.ts`, `requirementResults` |
| Outcome | An unmet requirement blocks Live. Once fix rounds are spent it ships as partial, or not at all on a blocking failure, and the final message names each one | `lib/pipeline/workflow.ts` |
| Person | A requirement-by-requirement checklist in the build room and on the product page | `components/build/RequirementsChecklist.tsx` |

## What it needs

- `template/.agents/skills/product-ui` and `template/AGENTS.md` (both looks) lost their one-flow wording, but those reach builds only through a new builder snapshot. `full-product` wins over them until then, and says so.
- `verify.mjs` and `smoke-report.mjs` are platform files, which provisioning refreshes.
- `MUSE_APP_LOOK` stays on for test builds.

## Capabilities

No `CAP_READY` line changed. Every unit is fake-tested only, and docs/CAPABILITIES.md requires one real test build first. Data needs a public `PLATFORM_URL` for that build. Until it's ready, saved data means the browser's `localStorage`, and accounts or sharing between people are named to the person as parts it can't do.

## Why 120 minutes

Reasoned from the caps, not measured: no full build has run. A verify and judge, a fix round and another verify and judge can reserve up to 71 minutes on a big brief, and a 90-minute wall would leave under 20 for building. 150 is the most allowed, since the sweep stops a build at 3 hours and recording and deploy come after the wall. Measure this on the first real runs.
