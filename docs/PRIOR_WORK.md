# Prior work

Muse Privacy was built in this repository during the Meta Global AI Developer Hackathon, starting Oct 26, 2026. Nothing here is imported, vendored or copied from another repository. Earlier Offline Base projects by the same author were read for ideas, and each module that took an idea from one is listed below.

## Before Oct 26

These existed before the event, in separate repositories, and are not part of this submission's code:

| Earlier project | What it is | What we took as inspiration |
|---|---|---|
| decision-guard (Offline-Base) | A local model that checks text before it is sent | The idea of exact checks (Luhn card numbers, one-time codes) that override a model, rewritten in Python for base/guard.py |
| base-router-subagent, branch base-agent-v0.1 (Offline-Base) | A local memory MCP server with a Cloudflare relay | The relay shape (device dials out to a Worker, OAuth, one-time pairing codes), rewritten for relay/ and base/connector/ |
| decision-tree (Offline-Base) | A small device with a status light | The idea of streaming state to a light, rewritten for base/events.py, base/light.py and hardware/light/ |

## Built during the event

Everything in this repository. See the git history, which starts on Oct 27, 2026.
