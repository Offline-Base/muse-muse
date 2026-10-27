"""In-process state events: idle, working, waiting, sending. See docs/CONTRACTS.md.

The light, the approval page's /events stream and tests subscribe here. Events carry a state
and a short non-private detail (a job id or a count), never document text.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

STATES = ("idle", "working", "waiting", "sending")


@dataclass(frozen=True)
class Event:
    state: str
    detail: str | None = None
    ts: float = field(default_factory=time.time)


_lock = threading.Lock()
_subscribers: list[Callable[[Event], None]] = []
_last = Event("idle")


def subscribe(fn: Callable[[Event], None]) -> Callable[[], None]:
    """Register a callback; returns a function that unsubscribes it."""
    with _lock:
        _subscribers.append(fn)

    def unsubscribe() -> None:
        with _lock:
            if fn in _subscribers:
                _subscribers.remove(fn)

    return unsubscribe


def emit(state: str, detail: str | None = None) -> Event:
    if state not in STATES:
        raise ValueError(f"unknown state {state!r}")
    global _last
    event = Event(state, detail)
    with _lock:
        _last = event
        subscribers = list(_subscribers)
    for fn in subscribers:
        try:
            fn(event)
        except Exception:  # a broken subscriber must never break the work that emitted
            pass
    return event


def last() -> Event:
    return _last
