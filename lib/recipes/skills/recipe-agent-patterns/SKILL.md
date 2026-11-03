---
name: recipe-agent-patterns
description: Use for validated find-and-replace edits, a triage copilot with memory held on the page, side chats branching off a main conversation, or a downloadable repo-agent kit.
---

# Agent patterns in a plain web product

These run as hand-written TypeScript in route handlers with `metaClient(request)`, on the plain web target. Product code and tests name `muse-wonder-1.0` and nothing else: a test build runs those calls on a cheaper model by itself, and a token refuses that model by name.

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

## 02/04 Validated in-place edits

Build: a page holds the person's own text or code, and the model proposes edits that a person can accept or reject.

- Use `respondJson` with `{ edits: [{ path, find, replace, why }] }`.
- Apply an edit only when `find` matches the current text exactly once. No match or several matches is a rejection, and the reason goes back to the model for one more try.
- Apply edits in order against the latest text, then show a diff before anything is saved.

Check: unit tests for zero, one and two matches, and for overlapping edits. Limit: this works on the files the person brings. It does not touch a repository.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/04_validated_in_place_edits

## 02/05 Alert triage copilot

Build: paste or upload a noisy alert feed, and get repeated patterns, a sharper triage rule, answers to questions, and a self-assessment of the rule against the feed.

- Parse the feed in code first. Every pattern the model names must cite row ids, and code rejects ids that don't exist.
- Use zod schemas in place of state files. The page holds the current rule and notes, and sends them with each call.
- Keep notes under a fixed size. When they pass it, make one call to compact them, and show the result to the person.
- Proposed changes to the rule are shown as a diff, and the person accepts them.
- Clearing the saved run is one `<ConfirmButton>` (product-ui, Clear, delete and reset), placed once, never a full-width button on every page.

Check: a sample feed with a known repeating alert, and a test that an invented row id is rejected. Limit: memory lives in this browser, and the product acts on nothing. It only proposes.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/05_alert_fatigue_copilot

## 04/10 Side chats

Build: a main conversation, with a side panel to ask something without adding it to the main thread.

- Hold the main thread's latest response id on the page. A side chat's first turn passes that id as `previous_response_id`, and later side turns chain from the side chat's own id.
- The main thread's id never moves because of a side turn. That one rule is the whole feature, so test it.
- Pass `store: true`, and if an old id is refused, resend a short summary of the main thread and say that the side chat restarted.

Limit: this is a web pattern, not the Muse Code `/side` command. How long Meta keeps a response id is unconfirmed.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/10_side_chats

## 03/11 Repo agent kit (labeled stand-in)

A hosted product can't run a bot on someone's repository, and must never write to GitHub. Build a page that configures and downloads a kit instead:

- The person picks what the bot does (triage, review, answer questions, propose a patch) and how much a maintainer must approve.
- The page writes a zip in the browser: a GitHub Actions workflow, a short script of your own, the prompts, and a README.
- The kit reads the person's own `MODEL_API_KEY` from their repository secrets. **Never put a product token, gateway URL or any key in the kit.**
- Writes stay behind a maintainer's comment command, and a patch only ever opens a pull request for review.
- Offer a dry run on a pasted issue, through the product's normal gateway calls, with nothing posted anywhere.

Say on the page: "This makes a kit you run yourself. It does not connect to your repository." Check: the smoke test downloads the zip, and a unit test asserts no token-shaped string is in it. Limit: the kit's workflow is not run by the build, so say so in the kit's README.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/11_github_repo_agent
