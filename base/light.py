"""Status light: mirrors base.events states to a USB serial light. See docs/CONTRACTS.md.

Protocol: one line per state change, `STATE <name>\\n`, where name is idle, working, waiting or
sending. Firmware for an RP2040 board with a WS2812 ring is in hardware/light/. With no
LIGHT_SERIAL set, state changes are logged at debug level only.

    python -m base.light --test [--port /dev/ttyACM0]    cycle the four states every 2 s
"""

from __future__ import annotations

import argparse
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from base import events
from base.config import Settings, load_settings

log = logging.getLogger(__name__)

TEST_CYCLE = ("idle", "working", "waiting", "sending")


def open_serial(port: str) -> Any:
    """Open the light's serial port. pyserial is imported here so nothing else needs it."""
    import serial

    return serial.Serial(port, 115200, timeout=0, write_timeout=0.5)


REFRESH_SECONDS = 5.0  # how often the state is written again with no change


class Light:
    """Writes state lines to one serial port, reopening it after any failure. Never raises."""

    def __init__(self, port: str | None, opener: Callable[[str], Any] | None = None) -> None:
        self.port = port
        self._opener = opener or open_serial
        self._serial: Any = None
        self._last: str | None = None
        self._warned = False
        self._lock = threading.Lock()
        self._unsubscribe: Callable[[], None] | None = None

    def __call__(self, event: events.Event) -> None:
        self.show(event.state)

    def show(self, state: str) -> bool:
        """Send one state. Returns True when the line reached the port."""
        with self._lock:
            if self.port is None:
                if state != self._last:
                    log.debug("light: %s", state)
                self._last = state
                return False
            # No "same as last time" shortcut: a board that reloaded (a write to CIRCUITPY, Ctrl-D)
            # starts at idle while the port stays open, so every state is written again.
            line = f"STATE {state}\n".encode()
            for _ in range(2):  # one reopen per state change
                if self._serial is None and not self._open():
                    return False
                try:
                    self._serial.write(line)
                    self._serial.flush()
                except Exception as exc:
                    self._fail("write", exc)
                    continue
                self._last = state
                self._warned = False
                return True
            return False

    def refresh(self) -> bool:
        """Write the current state again (see start_refresh)."""
        return self.show(events.last().state) if self.port is not None else False

    def start_refresh(self, interval: float = REFRESH_SECONDS) -> None:
        """Resend the state every `interval` seconds, so a reloaded board catches up."""
        self._stop_refresh = threading.Event()

        def loop() -> None:
            while not self._stop_refresh.wait(interval):
                self.refresh()

        threading.Thread(target=loop, name="light-refresh", daemon=True).start()

    def stop(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        stop_refresh = getattr(self, "_stop_refresh", None)
        if stop_refresh is not None:
            stop_refresh.set()
        with self._lock:
            self._close()

    def _open(self) -> bool:
        try:
            self._serial = self._opener(self.port)
            return True
        except Exception as exc:
            self._fail("open", exc)
            return False

    def _fail(self, what: str, exc: Exception) -> None:
        log.log(logging.DEBUG if self._warned else logging.WARNING,
                "light: cannot %s the serial port (%s); will retry", what, type(exc).__name__)
        self._warned = True
        self._close()

    def _close(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:
                pass
        self._serial = None
        self._last = None


def start_light(settings: Settings, opener: Callable[[str], Any] | None = None) -> Light:
    """Subscribe a light to base.events and show the current state. Call `.stop()` to detach."""
    light = Light(settings.light_serial, opener)
    light.show(events.last().state)
    light._unsubscribe = events.subscribe(light)
    if settings.light_serial is not None:
        light.start_refresh()
    return light


def run_test(
    settings: Settings,
    *,
    interval: float = 2.0,
    cycles: int | None = None,
    sleep: Callable[[float], Any] = time.sleep,
    opener: Callable[[str], Any] | None = None,
) -> None:
    """Cycle idle, working, waiting, sending every `interval` seconds (forever when cycles is None)."""
    light = start_light(settings, opener)
    if settings.light_serial is None:
        print("No LIGHT_SERIAL set, so only printing the states.")
    done = 0
    try:
        while cycles is None or done < cycles:
            for state in TEST_CYCLE:
                print(f"light: {state}", flush=True)
                events.emit(state, "light test")
                sleep(interval)
            done += 1
    finally:
        events.emit("idle", "light test")
        light.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m base.light", description="Muse Privacy status light.")
    parser.add_argument("--test", action="store_true", help="cycle idle, working, waiting, sending every 2 s")
    parser.add_argument("--port", help="serial port (default: LIGHT_SERIAL)")
    parser.add_argument("--interval", type=float, default=2.0)
    args = parser.parse_args(argv)
    if not args.test:
        parser.print_help()
        print("\nThe light runs inside the server. Use --test to try the hardware on its own.")
        return 0
    settings = load_settings()
    if args.port:
        settings = replace(settings, light_serial=args.port)
    try:
        run_test(settings, interval=args.interval)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
