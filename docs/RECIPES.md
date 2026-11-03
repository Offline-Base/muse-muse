# Recipes

Skills the platform writes into a product at provision, so a build can use a pattern with no new builder snapshot. Source: `lib/recipes/skills/<id>/`, registered in `lib/recipes/registry.ts`. After editing a skill, run `node scripts/recipes-gen.mjs`.

| Flag | Default | Does |
|---|---|---|
| `RECIPES_ENABLED` | off | The brief writer may pick recipes, and builds get their skills |
| `AGENT_LONG_RUNS` | off | Long recipes may be picked, with the `agent-long` marker and its run limits (80 turns, 120 built-in tool calls, $15). Their build tokens carry the marker too and get 30 turns, 40 tool calls and $1.50 per run id, so a smoke test can run one real run to its end |
| `AGENT_LONG_DAILY_USD` | 25 | A long product's daily budget, in place of the normal $10 ceiling |
| `VERIFY_AGENTS` | off | `recipe-verified-agent` may be picked: receipts for quotes checked by code, a separate model review, and a gate on the answer. It also needs `RECIPES_ENABLED` and `AGENTS_ENABLED`, since it builds on the agent kit. No first build has run it yet |

A stored pick whose flag went off counts as never picked.

## Try the legal case agent

With both flags on, type this note:

> Build a legal case agent like meta-models/legal-agent-workshop. It reads a fictional dispute file, drafts a checklist, proves each item with exact page quotes, asks me for evidence when it is stuck, and files a memo I sign off. Show every turn live.

The brief should come back with `recipes: ["recipe-case-agent"]`, verdict `partly` and a new fictional case. The workshop has no license, so nothing from it goes into a build, including its tool names. Nothing has been built this way yet: the first real test build is the proof.
