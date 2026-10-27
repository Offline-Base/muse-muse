"""Status light: serial protocol, failure handling, test mode, and the firmware's pure logic."""

from __future__ import annotations

import importlib.util
import logging
import re
from dataclasses import replace
from pathlib import Path

import pytest

from base import events
from base import light as light_mod
from base.light import Light, run_test, start_light

REPO = Path(__file__).resolve().parent.parent
FIRMWARE = REPO / "hardware" / "light" / "code.py"


class FakeSerial:
    def __init__(self, fail_writes=0):
        self.lines: list[str] = []
        self.fail_writes = fail_writes
        self.closed = False

    def write(self, data: bytes) -> int:
        if self.fail_writes:
            self.fail_writes -= 1
            raise OSError("device unplugged")
        self.lines.append(data.decode())
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class Opener:
    """Hands out FakeSerial objects; can be told to fail the next opens."""

    def __init__(self, *ports: FakeSerial, fail_opens=0):
        self.ports = list(ports)
        self.fail_opens = fail_opens
        self.opened: list[str] = []

    def __call__(self, port: str) -> FakeSerial:
        self.opened.append(port)
        if self.fail_opens:
            self.fail_opens -= 1
            raise OSError("no such device")
        return self.ports.pop(0)


@pytest.fixture(autouse=True)
def reset_events():
    events.emit("idle")
    yield
    events.emit("idle")


def test_writes_every_state_even_a_repeat():
    # Review device F10: a board that reloads restarts at idle with the port still open, so a
    # repeated state is written again rather than skipped.
    fake = FakeSerial()
    light = Light("/dev/fake", Opener(fake))
    for state in ("working", "working", "waiting", "sending", "idle"):
        light.show(state)
    assert fake.lines == ["STATE working\n", "STATE working\n", "STATE waiting\n", "STATE sending\n", "STATE idle\n"]


def test_refresh_resends_the_current_state():
    fake = FakeSerial()
    light = Light("/dev/fake", Opener(fake))
    events.emit("working", "job-1")
    light.show("working")
    assert light.refresh() and fake.lines == ["STATE working\n", "STATE working\n"]
    events.emit("idle")


def test_start_light_follows_events(settings):
    fake = FakeSerial()
    light = start_light(replace(settings, light_serial="/dev/fake"), Opener(fake))
    events.emit("working", "job-1")
    events.emit("waiting")
    light.stop()
    events.emit("sending")  # after stop: not written
    assert fake.lines == ["STATE idle\n", "STATE working\n", "STATE waiting\n"]
    assert fake.closed


def test_survives_a_broken_port_and_reopens():
    first, second = FakeSerial(fail_writes=1), FakeSerial()
    opener = Opener(first, second)
    light = Light("/dev/fake", opener)
    assert light.show("working") is True  # first write fails, reopen, written on the new port
    assert first.closed and second.lines == ["STATE working\n"]
    assert opener.opened == ["/dev/fake", "/dev/fake"]


def test_missing_port_never_raises_and_retries_later(caplog):
    fake = FakeSerial()
    opener = Opener(fake, fail_opens=1)
    light = Light("/dev/fake", opener)
    with caplog.at_level(logging.DEBUG, logger="base.light"):
        assert light.show("working") is False
    assert "cannot open" in caplog.text
    assert light.show("waiting") is True
    assert fake.lines == ["STATE waiting\n"]


def test_port_that_always_fails_does_not_break_emit():
    class Broken:
        def write(self, data):
            raise OSError("broken")

        def flush(self):
            pass

        def close(self):
            raise OSError("also broken")

    light = Light("/dev/fake", lambda port: Broken())
    unsubscribe = events.subscribe(light)
    try:
        events.emit("working")  # must not raise
        assert light.show("waiting") is False
    finally:
        unsubscribe()


def test_no_port_logs_at_debug_only(settings, caplog):
    light = start_light(settings)  # settings fixture has no LIGHT_SERIAL
    with caplog.at_level(logging.DEBUG, logger="base.light"):
        events.emit("working")
        events.emit("working")
    light.stop()
    records = [r for r in caplog.records if r.name == "base.light"]
    assert [r.getMessage() for r in records] == ["light: working"]
    assert all(r.levelno == logging.DEBUG for r in records)


def test_pyserial_is_imported_lazily():
    source = Path(light_mod.__file__).read_text()
    assert "\nimport serial" not in source.split("def open_serial")[0]


def test_test_mode_cycles_the_four_states(settings, capsys):
    fake = FakeSerial()
    sleeps = []
    run_test(replace(settings, light_serial="/dev/fake"), cycles=1, sleep=sleeps.append, opener=Opener(fake))
    assert sleeps == [2.0] * 4
    # the four states, then back to idle when the test ends
    assert fake.lines[-5:] == ["STATE idle\n", "STATE working\n", "STATE waiting\n", "STATE sending\n", "STATE idle\n"]
    assert "light: sending" in capsys.readouterr().out


def test_main_without_test_flag_prints_help(capsys):
    assert light_mod.main([]) == 0
    assert "--test" in capsys.readouterr().out


# -- firmware ------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def firmware():
    spec = importlib.util.spec_from_file_location("light_firmware", FIRMWARE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # no board module here, so main() does not run
    return module


def ui_color(token: str) -> tuple[int, int, int]:
    text = (REPO / "docs" / "UI_STYLE.md").read_text()
    match = re.search(rf"\| --{token} \| #([0-9A-Fa-f]{{6}}) \|", text)
    assert match, token
    value = match.group(1)
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def test_firmware_parses_protocol_lines(firmware):
    assert firmware.parse_line("STATE working\r\n", "idle") == "working"
    assert firmware.parse_line("state Sending", "idle") == "sending"
    assert firmware.parse_line("STATE party", "waiting") == "waiting"
    assert firmware.parse_line("hello", "idle") == "idle"
    assert firmware.board is None


def test_firmware_colors_match_ui_style(firmware):
    assert firmware.OK == ui_color("ok")
    assert firmware.WAIT == ui_color("wait")
    assert firmware.SEND == ui_color("send")


def test_firmware_brightness_capped(firmware):
    assert firmware.MAX_BRIGHTNESS <= 0.15
    assert firmware.NUM_PIXELS in (12, 16)


@pytest.mark.parametrize("n", [12, 16])
def test_firmware_frames(firmware, n):
    for t in (0.0, 0.3, 0.77, 1.9, 3.1):
        assert firmware.frame("working", t, n) == [firmware.OK] * n
        idle = firmware.frame("idle", t, n)
        assert len(set(idle)) == 1 and max(idle[0]) <= 255 * 0.3 + 1  # dim
        waiting = firmware.frame("waiting", t, n)
        assert all(c[0] <= firmware.WAIT[0] for c in waiting)
        sending = firmware.frame("sending", t, n)
        lit = [c for c in sending if c != firmware.OFF]
        assert 1 <= len(lit) <= firmware.TAIL
    # amber actually pulses and the sweep actually moves
    assert firmware.frame("waiting", 0.0, n) != firmware.frame("waiting", 0.3, n)
    assert firmware.frame("sending", 0.0, n) != firmware.frame("sending", 0.5, n)



def test_firmware_plays_one_sweep_then_the_state_that_followed(firmware):
    code = firmware
    shown, after, until = code.next_state("waiting", "waiting", 0.0, "sending", now=10.0)
    assert (shown, after) == ("sending", "waiting")
    shown, after, until = code.next_state(shown, after, until, "idle", now=10.5)  # arrives mid-sweep
    assert shown == "sending" and after == "idle"
    assert code.settle(shown, after, until, now=11.0)[0] == "sending"
    assert code.settle(shown, after, until, now=12.1)[0] == "idle"
    assert code.next_state("idle", "idle", 0.0, "working", now=1.0)[0] == "working"


def test_events_settle_shows_waiting_while_a_card_is_pending():
    seen = []
    unsubscribe = events.subscribe(lambda e: seen.append(e.state))
    try:
        events.set_pending_source(lambda: 1)
        events.settle("job-1")
        events.set_pending_source(lambda: 0)
        events.settle("job-1")
        events.set_pending_source(None)
        events.settle("job-1")
    finally:
        events.set_pending_source(None)
        unsubscribe()
    assert seen == ["waiting", "idle", "idle"]
