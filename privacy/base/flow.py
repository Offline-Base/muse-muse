"""The "How it works" diagram's markup, shared by the approval page (/how) and the landing page.

ui/static/flow.js animates it and ui/static/flow.css lays it out; site/flow.js and site/flow.css
are copies. The landing page holds flow_html(SITE_FACTS) as it is (tests/test_flow.py checks), so
the two pages always show the same boxes. Every example in the stories is invented.
"""

from __future__ import annotations

from collections.abc import Mapping
from html import escape

# (key, name). The first five run in this order for every result; the rest are where one can stop.
NODES = (
    ("files", "Your documents"),
    ("model", "Local model"),
    ("tagging", "Tagging"),
    ("rules", "Your rules"),
    ("check", "Final check"),
    ("you", "You"),
    ("kept", "Kept here"),
    ("approvals", "Your OK"),
    ("muse", "Muse"),
)
STORIES = (
    ("shared", "Shared as tags"),
    ("ask", "Needs your OK"),
    ("kept", "Kept here"),
    ("toggle", "With a privacy toggle"),
    ("local", "Ask on this device"),
)
ICONS = {
    "files": '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3L9 7h6.5A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/>',
    "model": '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/><path d="M8 2.5v3M12 2.5v3M8 14.5v3M12 14.5v3M2.5 8h3M2.5 12h3M14.5 8h3M14.5 12h3"/>',
    "tagging": '<path d="M3 4.5v5l7.5 7.5 6-6L9 3.5H4a1 1 0 0 0-1 1z"/><circle cx="6.5" cy="7" r="1"/>',
    "rules": '<path d="M4 6h12M4 14h12"/><circle cx="8" cy="6" r="2"/><circle cx="12.5" cy="14" r="2"/>',
    "check": '<path d="M10 2.5l6 2.25v4.5c0 3.9-2.6 6.9-6 8.25-3.4-1.35-6-4.35-6-8.25v-4.5z"/><path d="M7.5 10l2 2 3.5-4"/>',
    "you": '<circle cx="10" cy="7" r="3"/><path d="M4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5"/>',
    "kept": '<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
    "approvals": '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>',
    "muse": '<path d="M6 15.5h8.5a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.2A3 3 0 0 0 6 15.5z"/>',
}
SITE_FACTS = {
    "files": "Muse never gets them. This demo reads invented files only",
    "model": "Muse Glimmer: on OpenRouter in this demo, planned for your device",
    "tagging": "Names and identifiers become tags like [Student A]",
    "rules": "Your policy, what you taught it, and toggles like FERPA or HIPAA",
    "check": "Looks again for anything private",
    "you": "Ask on this device: off for now, it needs a reader on the device",
    "kept": "Stays on the device, with a reason",
    "approvals": "You see the exact text first",
    "muse": "Gets tags only, through the relay",
}


def flow_html(
    facts: Mapping[str, str],
    *,
    links: Mapping[str, str] | None = None,
    live: bool = False,
    light: str = "idle",
    muse_off: bool = False,
) -> str:
    """The diagram: story buttons, the boxes with one line of `facts` each, and the step list.

    `links` makes boxes into links (the approval page). `live` adds the line flow.js fills from
    the device's light, starting at `light`. `muse_off` dims Muse (a toggle keeps everything here).
    """
    links = links or {}

    def node(key: str, name: str) -> str:
        tag, href = ("a", f' href="{escape(links[key])}"') if key in links else ("div", "")
        dim = " dim" if key == "muse" and muse_off else ""
        return (
            f'<{tag} class="flow-node{dim}" data-node="{key}"{href}>'
            f'<svg class="flow-ico" viewBox="0 0 20 20" aria-hidden="true">{ICONS[key]}</svg>'
            f'<span class="flow-name">{escape(name)}</span>'
            f'<span class="flow-sub">{escape(facts.get(key, ""))}</span></{tag}>'
        )

    tabs = "".join(
        f'<button type="button" class="flow-tab" data-story="{key}" aria-pressed="{"true" if i == 0 else "false"}">'
        f"{escape(label)}</button>"
        for i, (key, label) in enumerate(STORIES)
    )
    device = "".join(node(k, n) for k, n in NODES if k != "muse")
    live_html = f'<p class="flow-live" data-state="{escape(light)}"></p>' if live else ""
    return (
        f'<figure class="flow" data-flow data-live="{"1" if live else "0"}" data-light="{escape(light)}">'
        f'<div class="flow-bar"><div class="flow-tabs" role="group" aria-label="Examples">{tabs}</div>'
        '<div class="flow-buttons"><button type="button" class="flow-tab" data-flow-play>Pause</button>'
        '<button type="button" class="flow-tab" data-flow-next>Next step</button></div></div>'
        f"{live_html}"
        '<div class="flow-stage"><svg class="flow-wires" aria-hidden="true"></svg>'
        f'<div class="flow-zone-box flow-device"><span class="flow-zone">This device</span>{device}</div>'
        f'<div class="flow-zone-box flow-cloud"><span class="flow-zone">Cloud</span>{node("muse", "Muse")}</div>'
        '<span class="flow-token" hidden></span><span class="flow-token flow-live-token" hidden></span></div>'
        '<ol class="flow-steps"></ol></figure>'
    )
