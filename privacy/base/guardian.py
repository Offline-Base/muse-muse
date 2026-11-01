"""A guardian PIN, for a device set up for a family member: it locks the settings that could undo the rules.

A parent setting up a teen, or an adult child setting up an older parent, sets a PIN on the Setup
page. While a PIN is set, a browser has to be unlocked with it before it can change the Controls or
Setup pages, the learning mode or Always approve, or delete a decision. With `approvals` on, the PIN
is also needed to approve a result or to tick "don't ask again" on an approval. Denying never needs
it: that is the safe direction.

The PIN is kept as a salted PBKDF2 hash in BASE_HOME/guardian.json (mode 0600), and never logged.
Five wrong tries lock it for 15 minutes. An unlock lasts 10 minutes in that browser. This guards
against the family member changing the rules at the device. It is not protection from someone with
an administrator account on the computer, who can delete the file; on a Jetson box with no shell
for the family member, that gap is much smaller.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections.abc import Callable
from pathlib import Path

COOKIE = "muse_guardian"
FILE = "guardian.json"
UNLOCK_SECONDS = 10 * 60
MAX_MISSES = 5
LOCK_SECONDS = 15 * 60
ITERATIONS = 200_000
MIN_LENGTH, MAX_LENGTH = 6, 64

LOCKED = "A guardian set the rules on this device. Ask them to unlock it on the Setup page."
APPROVE_LOCKED = "A guardian approves results on this device. Ask them to unlock it on the Setup page."


class GuardianError(ValueError):
    """A plain reason the PIN was not set, changed or accepted."""


def _hash(pin: str, salt: bytes, iterations: int) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, iterations).hex()


class Guardian:
    def __init__(self, home: Path, clock: Callable[[], float] = time.time):
        self.path = Path(home) / FILE
        self.clock = clock
        self._lock = threading.Lock()
        self._unlocked: dict[str, float] = {}  # sha256 of a browser's token -> when it expires

    # ----- the file

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) and data.get("hash") else {}

    def _write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self.path)

    # ----- state

    def is_set(self) -> bool:
        return bool(self._read())

    def approvals_locked(self) -> bool:
        return bool(self._read().get("approvals"))

    def locked_until(self) -> float | None:
        until = float(self._read().get("locked_until") or 0)
        return until if until > self.clock() else None

    # ----- the PIN

    def verify(self, pin: str) -> bool:
        """Whether `pin` is the PIN. Counts misses; while locked out every try is refused."""
        with self._lock:
            data = self._read()
            if not data:
                return False
            if float(data.get("locked_until") or 0) > self.clock():
                raise GuardianError("Too many wrong tries. Try again in 15 minutes.")
            salt = bytes.fromhex(data["salt"])
            ok = hmac.compare_digest(_hash(str(pin), salt, int(data["iterations"])), data["hash"])
            misses = 0 if ok else int(data.get("misses") or 0) + 1
            data["misses"] = misses
            data["locked_until"] = self.clock() + LOCK_SECONDS if misses >= MAX_MISSES else 0
            if misses >= MAX_MISSES:
                data["misses"] = 0
            self._write(data)
            return ok

    def set(self, pin: str, *, approvals: bool, token: str | None = None) -> None:
        """Set or change the PIN. Changing it needs a browser this PIN unlocked."""
        if self.is_set() and not self.unlocked(token):
            raise GuardianError(LOCKED)
        pin = str(pin)
        if not MIN_LENGTH <= len(pin) <= MAX_LENGTH:
            raise GuardianError(f"Use a PIN of {MIN_LENGTH} to {MAX_LENGTH} characters.")
        salt = secrets.token_bytes(16)
        with self._lock:
            self._write({"salt": salt.hex(), "hash": _hash(pin, salt, ITERATIONS), "iterations": ITERATIONS,
                         "approvals": bool(approvals), "misses": 0, "locked_until": 0})  # fmt: skip

    def remove(self, token: str | None) -> None:
        if not self.unlocked(token):
            raise GuardianError(LOCKED)
        with self._lock:
            self.path.unlink(missing_ok=True)
            self._unlocked.clear()

    # ----- browsers

    def unlock(self, pin: str) -> str | None:
        """A token for this browser's cookie when `pin` is right, else None."""
        if not self.verify(pin):
            return None
        token = secrets.token_urlsafe(32)
        with self._lock:
            now = self.clock()
            self._unlocked = {k: v for k, v in self._unlocked.items() if v > now}
            self._unlocked[hashlib.sha256(token.encode()).hexdigest()] = now + UNLOCK_SECONDS
        return token

    def unlocked(self, token: str | None) -> bool:
        if not token:
            return False
        with self._lock:
            until = self._unlocked.get(hashlib.sha256(token.encode()).hexdigest(), 0)
        return until > self.clock()

    def lock(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._unlocked.pop(hashlib.sha256(token.encode()).hexdigest(), None)

    def allows(self, token: str | None) -> bool:
        """Whether a settings change may go ahead: no PIN is set, or this browser is unlocked."""
        return not self.is_set() or self.unlocked(token)

    def allows_approval(self, token: str | None) -> bool:
        return not self.approvals_locked() or self.unlocked(token)
