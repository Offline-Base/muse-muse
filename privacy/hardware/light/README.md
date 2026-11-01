# Status light

A small ring of LEDs that shows what Muse Privacy is doing, so you can see from across the room when your documents are being worked on, when the device is waiting for your OK, and when a tagged result is going to Muse.

| State | Ring | Color (docs/UI_STYLE.md) | Meaning |
|---|---|---|---|
| idle | dim white, slow breathing | white | Nothing running |
| working | solid green | `--ok` #2E9E5B | Glimmer is working on your documents on this device |
| waiting | pulsing amber | `--wait` #E8A317 | A result is waiting for your OK on the approval page |
| sending | blue sweep | `--send` #1D63ED | A tagged or summarized result is going to Muse |

Brightness is capped at 0.15 in the firmware, which keeps the ring easy on the eyes and well inside what a USB port can power.

## Parts

- One RP2040 board with USB that runs CircuitPython. The firmware assumes an Adafruit QT Py RP2040; a Raspberry Pi Pico or another RP2040 board works with a different `PIXEL_PIN`.
- One WS2812 (NeoPixel) ring with 12 or 16 pixels.
- A 330 ohm resistor for the data line (recommended).
- A 470 to 1000 uF capacitor across the ring's power pins (recommended).
- Three short wires, and a USB-C data cable (not a charge-only cable).

## Wiring

| Ring pin | Board pin (QT Py RP2040) |
|---|---|
| 5V (or VCC, PWR) | 5V |
| GND | GND |
| DIN (data in) | A3, through the 330 ohm resistor |

Put the capacitor across the ring's 5V and GND, minding its polarity. At brightness 0.15 a 16-pixel ring draws well under 200 mA, so the board's USB power is enough. The RP2040's 3.3 V data signal drives most rings fine at short wire lengths; if yours flickers, add a 74AHCT125 level shifter.

## Install the firmware

1. Install CircuitPython 9 or newer on the board. On a QT Py RP2040: hold BOOT, tap RST, and the board shows up as a drive named `RPI-RP2`. Download the board's `.uf2` file from circuitpython.org and drag it onto that drive. The board restarts as a drive named `CIRCUITPY`.
2. Add the NeoPixel library. Either run `circup install neopixel` with the board plugged in, or copy `neopixel.mpy` from the Adafruit CircuitPython Library Bundle (matching your CircuitPython version) into `CIRCUITPY/lib/`.
3. Copy `hardware/light/code.py` from this repo to the root of `CIRCUITPY` as `code.py`. The ring starts breathing white within a second.
4. If you use a 12-pixel ring or another data pin, edit `NUM_PIXELS` or `PIXEL_PIN` at the top of `code.py` on the drive.

## Connect it to Muse Privacy

The firmware reads lines like `STATE working` from the board's USB serial console. Point Muse Privacy at that port with `LIGHT_SERIAL`:

- Linux (Jetson): usually `/dev/ttyACM0`. The service user needs the `dialout` group; `deploy/jetson/install.sh` adds it.
- macOS: `/dev/cu.usbmodem` followed by a number. List them with `ls /dev/cu.usbmodem*`.

Then try it without the rest of the system:

```
LIGHT_SERIAL=/dev/ttyACM0 uv run python -m base.light --test
```

The ring should cycle idle, working, waiting, sending, two seconds each. Press Ctrl-C to stop. Close any serial terminal (screen, the Mu editor, a CircuitPython REPL) first, because only one program can hold the port.

When the server runs with `LIGHT_SERIAL` set, it writes one line per state change. If the cable is pulled, the server keeps working and reopens the port on the next state change.

## Notes

- The protocol is plain text, one line per change: `STATE idle`, `STATE working`, `STATE waiting`, `STATE sending`. Anything else is ignored.
- Nothing about your documents goes to the light. It only ever receives one of those four words.
- This firmware has not been flashed onto a real board yet. The parsing and animation logic is covered by `tests/test_light.py`.
