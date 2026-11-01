---
name: recipe-code-sessions
description: Use when a product runs coding tasks in a workspace with Muse Code, such as fixing failing tests, a migration, a screenshot bug fix, chained work, fan-out or an audit ledger. Only for builds with the code cap.
---

# Muse Code session recipes

Read the `muse-code-in-product` skill first. It covers `museCode`, `CodeRun`, the disclosure line and who may start a task. This skill says how to shape tasks for each recipe.

**Limits that hold for every recipe.** One session has at most $1 and 15 minutes. Inputs are uploaded files, never remote URLs, and the session can't clone anything. No web search. Upload a small repository as attached files (20 MB at most), not a real monorepo. Whether `pytest` and `git` exist in the snapshot is unconfirmed, so tasks use Python's `unittest`, and begin with `git init` and a first commit when they need history. Check for a tool before relying on it, and let the final answer say what ran.

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

## 02/01 Agent loop

The person attaches a small project with a failing test, and the task says to make the test pass without editing it. The product checks the result: `worked`, plus the test command's output in the final answer. Show the steps with `CodeRun`.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/01_agent_loop_basics

## 02/02 Reasoning between tool calls

A task with an order to respect: migrate a small callback-style API, leaf modules first, with the tests run after each module. Show the steps in order. Limit: effort can't be set per session unless the build prompt says so.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/02_interleaved_reasoning

## 02/03 Managing context through chained sessions

One session won't hold a large job. Chain them:

1. Each task's text says to keep `STATE.md` up to date: what's done, what's next, what was decided.
2. When a session ends, the page offers "Continue", and starts a new session with the last zip's files and `STATE.md` attached.
3. The person sees the running total across sessions.

Limit: each link costs up to $1, and the page must make each continuation a click.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/02_agent_patterns/03_managing_context

## 03/02 Screenshot bug fix

The person attaches a screenshot and a small project. Include the image as an attached file, name it in the task, and ask for a one-line cause and a failing check before the fix. Limit: a small uploaded project, not a monorepo such as the recipe's example.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/02_screenshot_bugfix

## 04/01 Audit ledger

Build a color-coded ledger from `museCode.events` steps, keeping each step's order and kind. Label it "Steps this product recorded". Limit: this isn't Muse Code's own append-only export, and there is no resume route.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/01_append_only_audit_log

## 04/02 Replay fixture

The session writes a focused fixture and a CI workflow into the zip, for the person's own repository. The gate runs there, not here, and the page says so.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/02_deterministic_replay

## 04/06 Fan-out inside one session

The task asks for subagents in separate git worktrees, with one small job each. They all share the one session's $1 and 15 minutes, so plan at most three small jobs. Limit: there are no routes to steer a child on its own. Starting several sessions is capped at 2 at once per product.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/06_subagent_fanout

## 04/07 Goal tracking

State the goal and its finish check at the top of the task, and show the session's steps beside it. After the run, a Wonder call compares the final answer and changed files to the goal, and reports met or not met, with reasons. Limit: this is the product's own check, not the `/goal` command.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/07_goal_tracking

## 04/08 Bundled skills

Plan in one session, then implement in another with the plan attached. Whether bundled skills are on in session sandboxes is untested, so a task never depends on them: write out the planning steps in the task text. A grilling flow that asks the person questions has no route, so ask the questions on the page before starting.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code/08_bundled_skills

## Checks for all of them

Tests stub `museCode`. A real session runs only when the code cap is on, and the first real gateway run is still unproven. State that in BUILD_NOTES.
