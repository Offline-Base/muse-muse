---
name: meta-ui
description: Not this product's look. This product uses muse-app-ui; read .agents/skills/muse-app-ui for every screen.
---

# Meta UI: replaced by muse-app-ui

This product was set up with the muse-app look, so its look comes from `.agents/skills/muse-app-ui` and the tokens in `app/muse-app.css`, which loads after `app/globals.css`. Read that skill instead of this one.

When a check, a hint or another skill points at meta-ui, read the same part of muse-app-ui: the first screen, the Parts table, the summary row, the AI result card and the text pairs are in its SKILL.md; markup, charts and the bars check are in its `reference/components.md`; the screen patterns are in its `reference/screens.md`. The classes and components are the same in both.
