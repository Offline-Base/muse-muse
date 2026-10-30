# Muse Code pages: builders, simulators and live checks

The demos for the `muse-code` page group (`lib/docs/demos/muse-code.ts`): the eleven Muse Code pages, `coding-agents` and `agent-frameworks`. The Muse Code CLI can't run in a browser, so each page gets a builder, simulator or explorer made from the page's own facts, plus a live call through the docs proxy where one shows something real. Everything is built on the kit (`components/docs/kit`, `kit.css`) and follows its rules: `useDocsRun` for every API call, `ModelSelect` or `ContributorNotice` before sending to a Contributor model, `ErrorBox` for failures, `CodeView` behind "Show code", light and dark themes from `app/globals.css`, no em dashes.

## Components (one per page)

All take the page `slug` plus the plain-JSON props below; every prop is optional.

| Component | Page | Props | Live call |
|---|---|---|---|
| `MuseCodeStart` | `muse-code` | `prompt`, `presets` (ChatPlayground presets), `system` | ChatPlayground on Responses |
| `AuthSetup` | `muse-code/auth` | `secret` (CI secret name), `prompt` | none |
| `PlanPicker` | `muse-code/subscriptions` | `prompts`, `subscribed` (YYYY-MM-DD) | none |
| `ApprovalSimulator` | `muse-code/permissions` | `command`, `presets` (`{ label, command }[]`), `task` | stand-in approval judge (Responses, strict JSON schema) |
| `CommandExplorer` | `muse-code/interactive` | `query`, `loop` | none |
| `WorkflowPlanner` | `muse-code/workflows` | `code` | three child calls in parallel, then a synthesis call (also `ControlRoom`, the control room's keys on a pretend session) |
| `SessionMessagingSim` | `muse-code/session-messaging` | none | ChatPlayground as the receiving session's model |
| `RewindTimeline` | `muse-code/rewind` | `script` (the A, B, C inputs), `instructions` | Responses turns chained with `previous_response_id` |
| `SettingsBuilder` | `muse-code/configuration` | none | `EffortCompare`: one prompt at two reasoning efforts |
| `ExtendingBuilder` | `muse-code/extending` | none | none |
| `ChangelogExplorer` | `muse-code/changelog` | `source` (defaults to `/docs/md/<slug>`), `query` | none (fetches the page's Markdown once) |
| `AgentConfigGenerator` | `coding-agents` | none | `ConfigCheck`: the request each config would make |
| `FrameworkSetup` | `agent-frameworks` | none | `MiniAgentLoop` on Messages or Responses |

Shared pieces: `CodeBlock` (a copyable code block drawn like the mirrored ones), `ui.tsx` (`Panel`, a tab panel that stays mounted; `SelectField`, `NumberField`, `Check`, `Chip`, `Notes`, `Problems`, `Highlight`, `C`), `McpServerEditor`, `EffortCompare`, `ConfigCheck`, `MiniAgentLoop`, `ControlRoom`. Styles are in `muse-code.module.css`.

## Pure modules (tested in `__tests__/`)

`shell.ts` (quoting), `start.ts`, `auth.ts`, `ci.ts`, `subscriptions.ts`, `permissions.ts` (the shell-stage parser and approval and sandbox model), `judge.ts`, `commands.ts`, `loop-schedule.ts` (the /loop and cron reader), `composer.ts`, `workflows.ts`, `workflow-sample.ts`, `control-room.ts` (the workflow control room's keys and the recovery commands), `session-messaging.ts`, `rewind.ts`, `settings.ts`, `extending.ts`, `changelog.ts`, `agent-configs.ts`, `agent-loop.ts`, `sim-shell.ts` (the loop's simulated shell), `frameworks.ts`.

Models: demos start on `muse-spark-1.3-contributor` and their menus offer the Standard models. Generated configs and code write `muse-spark-1.3-contributor` wherever Meta's examples write `muse-spark-1.3`. Muse Wonder's output is capped at 800 tokens in the custom live demos; the two ChatPlayground tabs (overview, session messaging) cap every model at 900.

Two findings from running these through the proxy (Oct 30, 2026), both handled in code: the model reasons for several hundred tokens even at minimal effort before a strict JSON answer, so the judge's budget is 1,500; and Meta's stored-response chaining can briefly answer 503 "persistence service error" or 400 "referenced response not found" right after a response is created, so the agent loop and the rewind demo retry those with backoff (`callWithRetries` and `isTransient` in `agent-loop.ts`). A stopped call (status 0, code `aborted`) is never retried, and Stop during a backoff wait cancels the retry (`pausable`), so a cancelled turn costs nothing more.

## Tests

```
npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code/__tests__/*.test.ts components/docs/playgrounds/muse-code/__tests__/*.test.tsx
```

Fixtures in `__tests__/fixtures/` are real replies from the docs proxy, trimmed: no keys, no safety identifiers, encrypted reasoning replaced with a placeholder.
