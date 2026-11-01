"""The AI app this device is linked to (LINKED_APP): what the pages and messages call it, and its maker.

The connector is a plain remote MCP server behind the relay's OAuth, so Muse, Claude and ChatGPT can
all link to it. The device cannot tell from a stateless call which app sent it, so one name is set
for the device, Muse by default. With several apps linked, a general name like "your AI app" reads
right for all of them. The training steps name each app's own setting; check them against the app,
since apps rename settings.
"""

from __future__ import annotations

import re

DEFAULT = "Muse"
_KNOWN = {
    "muse": ("Meta", "turn off training under Data controls in your Muse settings"),
    "claude": ("Anthropic", "turn off Help improve Claude in Claude's privacy settings"),
    "chatgpt": ("OpenAI", "turn off Improve the model for everyone under Data controls in ChatGPT's settings"),
}
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 .+'-]{0,29}")


def clean(name: str | None) -> str:
    """The app's name as set, or ValueError: letters, digits, spaces and . + ' -, up to 30 characters."""
    value = (name or "").strip() or DEFAULT
    if not NAME.fullmatch(value):
        raise ValueError(f"LINKED_APP must be a short app name like Muse, Claude or ChatGPT, not {value!r}")
    return value


def company(app: str) -> str:
    """Who runs the app, for sentences like "reaches Meta before this device sees it"."""
    known = _KNOWN.get(app.strip().lower())
    return known[0] if known else "the company that runs it"


def training_step(app: str) -> str:
    known = _KNOWN.get(app.strip().lower())
    return known[1] if known else f"turn off model training in {app}'s data settings"


def request_note(app: str = DEFAULT) -> str:
    """The note added to a result whose request already held a private detail."""
    return (f"Note: this request included a private detail, so {app} has already seen it. Use tags in requests, "
            f"and {training_step(app)}.")  # fmt: skip


def destination(app: str = DEFAULT) -> str:
    return f"{app}, through the relay"
