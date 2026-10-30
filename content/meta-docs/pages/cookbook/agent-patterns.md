# Agent patterns {#agent-patterns}

Turn a model into an agent. These loops handle planning, self-correction, and staying coherent across long runs. Part of the [Cookbook](https://dev.meta.ai/docs/cookbook).

- [Basic agent loop](https://dev.meta.ai/docs/cookbook/basic-agent-loop): Wire up the core perceive-decide-act loop.
- [Interleaved reasoning and tool use](https://dev.meta.ai/docs/cookbook/interleaved-reasoning-tool-use): Interleave reasoning with tool calls in a single turn.
- [Multi-turn context management](https://dev.meta.ai/docs/cookbook/multi-turn-context-management): Keep context under control across a long agent run.
- [Search-and-replace edits](https://dev.meta.ai/docs/cookbook/search-and-replace-edits): Make exact-match file edits that stay reviewable.
- [Alert fatigue copilot](https://dev.meta.ai/docs/cookbook/alert-fatigue-copilot): Pull grounded patterns from noisy alerts, then probe, chat, and self-assess with strict JSON.
