"""Muse Privacy status light: CircuitPython firmware for an RP2040 board and a WS2812 ring.

Reads lines like "STATE working" from the USB serial console and animates the ring:
idle = dim white breathing, working = solid green, waiting = pulsing amber, sending = blue sweep.
Colors are --ok, --wait and --send from docs/UI_STYLE.md. Brightness never goes above 0.15.

Copy this file to the CIRCUITPY drive as code.py, with neopixel.mpy in CIRCUITPY/lib.
"""

import math
import sys
import time

try:
    import board
    import neopixel
    import supervisor
except ImportError:  # imported by the tests under regular Python, where there is no board
    board = None

NUM_PIXELS = 16  # a 12-pixel ring works too: change this to 12
PIXEL_PIN = "A3"  # data pin on an Adafruit QT Py RP2040; any free GPIO works
MAX_BRIGHTNESS = 0.15

OK = (0x2E, 0x9E, 0x5B)  # --ok: working on the device
WAIT = (0xE8, 0xA3, 0x17)  # --wait: waiting for your OK
SEND = (0x1D, 0x63, 0xED)  # --send: tagged result going to Muse
WHITE = (255, 255, 255)  # idle
OFF = (0, 0, 0)

STATES = ("idle", "working", "waiting", "sending")
TAIL = 4  # pixels in the sending sweep's tail


def parse_line(line, current):
    """Return the state named by a "STATE <name>" line, or `current` for anything else."""
    parts = line.strip().split()
    if len(parts) == 2 and parts[0].upper() == "STATE" and parts[1].lower() in STATES:
        return parts[1].lower()
    return current


def scale(color, level):
    return tuple(int(c * level) for c in color)


def wave(t, period):
    """0 to 1 and back, once per `period` seconds."""
    return 0.5 + 0.5 * math.sin(t * 2 * math.pi / period)


def frame(state, t, n=NUM_PIXELS):
    """The color of every pixel at time t (seconds). The strip's brightness cap applies on top."""
    if state == "working":
        return [OK] * n
    if state == "waiting":
        return [scale(WAIT, 0.25 + 0.75 * wave(t, 1.2))] * n
    if state == "sending":
        head = int(t * n) % n  # one turn per second
        colors = []
        for i in range(n):
            behind = (head - i) % n
            colors.append(scale(SEND, 1.0 - behind / TAIL) if behind < TAIL else OFF)
        return colors
    return [scale(WHITE, 0.05 + 0.25 * wave(t, 4.0))] * n  # idle: slow, dim breathing


def read_serial(buffer):
    """Append whatever bytes are waiting on the USB serial console, without blocking."""
    waiting = supervisor.runtime.serial_bytes_available
    if waiting:
        buffer += sys.stdin.read(int(waiting))
    return buffer


def main():
    pixels = neopixel.NeoPixel(
        getattr(board, PIXEL_PIN), NUM_PIXELS, brightness=MAX_BRIGHTNESS, auto_write=False
    )
    state = "idle"
    buffer = ""
    while True:
        buffer = read_serial(buffer)
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            state = parse_line(line, state)
        if len(buffer) > 64:  # a line that never ends is noise
            buffer = ""
        for i, color in enumerate(frame(state, time.monotonic())):
            pixels[i] = color
        pixels.show()
        time.sleep(0.03)


if board is not None:
    main()
