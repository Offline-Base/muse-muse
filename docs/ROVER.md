# Muse Rover: a small rover Muse Muse sets up in one go

A two-wheel rover with a pan-tilt webcam and three distance sensors, run by the Arduino UNO Q in the fleet, **ArduinoQ-01**.
One admin action in Muse Muse installs everything on the board through the fleet's control plane and runs a self-test. From
then on the rover's tools are at the fleet's existing device route, `<fleet base>/device/ArduinoQ-01/mcp`
(`jetson-infra:control-plane/jetson_cp/routes/device.py`, which forwards to `ArduinoQ-01.local:8765` with the board's own
Bearer token).

The thinking is Meta's cloud models, through Muse Muse: the hackathon's rules say every model the project calls at runtime
is a Meta model, so **nothing on the rover runs a model**. The rover only does what a tool call asks, within its own limits,
and its distance safety stop is plain microcontroller code.

**Status, Nov 2: built and tested with fakes, never run on the board.** The Python and the shell script ran here on Windows
and in WSL Ubuntu. The sketch was built only for a computer, against stand-in headers, and its logic ran there; it was never
built with the board's toolchain (there is none here). Nothing reached ArduinoQ-01, the fleet or ngrok. "Not tried on real
hardware" at the end lists everything only the board can prove.

## Parts

| Part | Count | Job |
| --- | --- | --- |
| Arduino UNO Q (Debian 13 on its Qualcomm side, an STM32U585 running Zephyr) | 1 | Linux runs `muse-device/server.py`; the microcontroller runs the sketch that drives everything |
| DIYables 2WD chassis, two DC gear motors with Hall encoders | 1 | Wheels. Channel A of each encoder counts; B is left unconnected |
| TB6612FNG dual motor driver | 1 | Channel A the left motor, B the right |
| 4xAA battery pack, 6 V | 2 | One for the motors, one for the servos |
| SG90 servo on a mini pan-tilt mount | 2 | Pan and tilt for the camera |
| VL53L0X time-of-flight breakout, with XSHUT | 3 | Front, left and right distance |
| Logitech C920S webcam | 1 | Photos, through `capture_image` |
| USB-C hub with power passthrough, and a USB-C power bank | 1 each | Powers the UNO Q and carries the webcam |
| ELEGOO starter kit | 1 | Breadboard and jumper wires |

## Wiring

The pins are the UNO Q header's own names. They live in one config, `~/.muse-device/rover.json`, which `setup-rover.sh`
writes and turns into the sketch's `rover_config.h`, so a pin can move with a flag rather than an edit (see "One-go setup").
The board's logic is 3.3 V: nothing on these pins may see 5 V or a battery.

| Part | Pin | Board pin | Power |
| --- | --- | --- | --- |
| TB6612FNG | PWMA | D5 | |
| TB6612FNG | AIN1 | D4 | |
| TB6612FNG | AIN2 | D8 | |
| TB6612FNG | PWMB | D6 | |
| TB6612FNG | BIN1 | D12 | |
| TB6612FNG | BIN2 | D13 | |
| TB6612FNG | STBY | A0 | |
| TB6612FNG | VCC | 3.3V | logic, from the UNO Q |
| TB6612FNG | VM | none | motor pack +, through a switch you can reach |
| TB6612FNG | every GND | GND | common ground |
| TB6612FNG | AO1, AO2 | none | the left motor's two leads |
| TB6612FNG | BO1, BO2 | none | the right motor's two leads |
| Left encoder | A | D2 | VCC to 3.3V, GND common |
| Right encoder | A | D3 | VCC to 3.3V, GND common |
| Both encoders | B | not connected | |
| Pan servo (SG90) | signal (orange) | D9 | red to the servo pack +, brown to common ground |
| Tilt servo (SG90) | signal (orange) | D10 | red to the servo pack +, brown to common ground |
| Front VL53L0X | SDA, SCL | the header's SDA, SCL | VIN to 3.3V, GND common |
| Front VL53L0X | XSHUT | A1 | |
| Left VL53L0X | SDA, SCL | the header's SDA, SCL | VIN to 3.3V, GND common |
| Left VL53L0X | XSHUT | A2 | |
| Right VL53L0X | SDA, SCL | the header's SDA, SCL | VIN to 3.3V, GND common |
| Right VL53L0X | XSHUT | A3 | |
| All three VL53L0X | GPIO1 | not connected | |
| Logitech C920S | USB | none | a USB-A port on the hub |
| UNO Q | USB-C | none | the hub's USB-C plug; the power bank goes into the hub's PD input |

The three sensors share SDA and SCL. They all wake at address 0x29, so the sketch holds all three in reset with XSHUT, then
wakes one at a time and moves it before waking the next: front to 0x30, left to 0x31, right to 0x32. It releases XSHUT with
the pin's pull-up rather than driving it high, so a breakout's own 2.8 V pull-up decides.

If a wheel turns backward when the self-test drives it forward, swap that motor's two leads at the driver, or run the setup
again with `--invert left` (or `right`). The same goes for a servo that pans the wrong way: `--invert pan` or `--invert tilt`.

## Power

- **Motors:** the motor pack's + goes through a switch to the TB6612's VM, and its - to common ground. That switch is the
  rover's physical cut-off: nothing in software can turn the motors on with it off. The TB6612 takes 4.5 V and up on VM.
- **Servos:** the servo pack's + goes to both servos' red wires, and its - to common ground. It is separate so a servo's
  stall current can't brown out the motors or the board. The SG90 is rated 4.8 to 6 V, and four fresh alkaline cells start
  near 6.4 V: NiMH cells (4.8 V) suit it better, or a 1N4001 diode in series drops about 0.7 V. A 470 uF capacitor across the
  pack near the servos helps when both swing at once.
- **The board:** the power bank goes into the hub's USB-C PD input, the hub's USB-C plug goes into the UNO Q, and the C920S
  goes into a USB-A port on the hub. The bank has to give 5 V at 3 A through the hub. The UNO Q's 3.3V pin feeds the logic:
  the TB6612's VCC, the three sensors and the two encoders, about 150 mA in all.
- **Grounds:** the motor pack's -, the servo pack's -, the UNO Q's GND, every TB6612 GND, the sensors', the encoders' and the
  servos' brown wires all join. Without one common ground the PWM, the servo pulses and I2C have nothing to measure against.
- No battery + ever goes to a UNO Q pin.

## One-go setup

What Muse Muse's admin action does, through the fleet's control plane, as one `exec` on ArduinoQ-01 (fleet exec runs as
root, with `bash -lc`). Give it a 30-minute timeout (`timeout_s: 1800`). The first build of the sketch takes minutes, and the
script has a deadline of its own, 1500 seconds unless `MUSE_ROVER_DEADLINE_S` says otherwise, which cuts every step's time
limit so the report comes back before the exec gives up.

```
d="$(mktemp -d)" && chmod 755 "$d" && curl -fsSL -o "$d/md.tgz" '<the muse-device bundle>' \
  && echo "<its sha256>  $d/md.tgz" | sha256sum -c - && tar -xzf "$d/md.tgz" -C "$d" \
  && bash "$d/muse-device/rover/setup-rover.sh"; code=$?; rm -rf "$d"; exit $code
```

A folder of its own rather than fixed names in `/tmp`, which root would follow if someone had left a link there, and
readable by arduino, who copies from it. No report line means one of two things. Either the kit never ran, because the
download, the checksum or the unpack failed, or the exec's own timeout came before the script's deadline, which a
`timeout_s` under 1800 allows: then the job's result is just `timeout`, and the script stopped wherever it had got to.
Otherwise the action reads the line that starts `MUSE_ROVER_REPORT `: one JSON object, `{"ok", "steps", "self_test"}`. Every step is `ok`, `skipped: why`, or why not in plain words, and the script exits 0 only
when every step is ok. The bundle is `scripts/device-bundle.ts`'s tarball, which has to include `autostart.sh` and `rover/`
(below).

`setup-rover.sh`, step by step. Anything in the arduino user's home is done as that user (`su - arduino -c`), which also
gives each command the groups the script added.

| Step | What it does |
| --- | --- |
| tools, user | Checks it runs as root, that `python3`, `arduino-app-cli`, `su`, `usermod`, `flock` and `timeout` are there, and that the arduino user can read the unpacked kit |
| config | Writes `/home/arduino/.muse-device/rover.json`: driver `tb6612`, the pin map above, a 150 mm stop distance. A run again keeps what an earlier one set; `--reset` goes back to the defaults. Every pin and limit is checked before anything else changes |
| groups | Adds arduino to the router socket's group (`arduino-router`, read off `/var/run/arduino-router.sock`) and to `video` |
| packages | Installs `cron` and GStreamer (`gstreamer1.0-tools`, `gstreamer1.0-plugins-good`) only if they're missing |
| files | Copies `server.py`, `autostart.sh` and `rover/bridge_client.py`, `rover_config.py`, `selftest.py` into `/home/arduino/muse-device`, owned by arduino. Other files there stay |
| autostart | `autostart.sh install`, as arduino: the cron line that keeps the server up. It says so if another cron line also starts a server |
| app | Copies the app to `/home/arduino/ArduinoApps/muse-rover`, writes `sketch/rover_config.h` from rover.json, then `arduino-app-cli app stop` and `app start user:muse-rover`, and waits up to 90 seconds for the sketch to answer through the router |
| default_app | `arduino-app-cli properties set default user:muse-rover`, so the board starts the rover's app at boot |
| server | Stops arduino's `server.py` and starts it again through `autostart.sh`, so it has the new files, the rover's tools and its new groups, and waits for port 8765 |
| self_test | `rover/selftest.py`, as arduino, through the server the way Muse Muse calls it: the tools are offered, the sketch answers, the servos center, each sensor reads, each wheel turns alone for 300 ms at 110 of 255 and its own encoder counts, and it takes a 640x480 photo if a camera is attached. **The wheels turn: give the rover room or put it on a stand** |

Flags, all optional: `--pin role=PIN` (roles `pwma ain1 ain2 pwmb bin1 bin2 stby enc_left enc_right servo_pan servo_tilt
xshut_front xshut_left xshut_right`; pins D2 to D13 or A0 to A5, and PWMA and PWMB need a PWM pin), `--stop-mm N` (50 to
1000), `--invert left|right|pan|tilt`, `--reset`, `--no-test`.

**Time.** Each step has a limit of its own (`app start` 900 seconds, the sketch's answer 90, the self-test 180, apt 900 a
try), and every limit is cut to what's left of the deadline less a minute, which is kept for the steps without one and the
report. A step the deadline leaves no time for says `not tried: the run's 1500-second deadline (MUSE_ROVER_DEADLINE_S) was
up`, and one it cuts short says it ran out of time.

It never reads or prints the board's token, and leaves alone the jetson-infra agent, `arduino-router.service` and its config,
and every Docker container except the app's own, which `arduino-app-cli` runs. Two runs at once can't happen: a lock in
`/run` turns the second away.

**The token.** `server.py` makes the board's token on its first start, in `/home/arduino/.muse-device/token` (mode 600).
Nothing in this kit prints it. Whoever sets Muse Muse's `DEVICE_MCP_TOKEN` reads it on the board; a fleet exec that printed
it would leave it in the job's output. `DEVICE_MCP_URL` is `<fleet base>/device/ArduinoQ-01/mcp`.

## The tools

What the board offers once `rover.json` exists, on top of its usual tools (`describe_device`, `capture_image` and the rest).
A failed Bridge call is an error result in plain words that names the call, such as "The rover didn't answer drive. There is
no router socket at /var/run/arduino-router.sock, so arduino-router isn't running on this board."

| Tool | Arguments | Limits | Answers |
| --- | --- | --- | --- |
| `drive` | `left`, `right`: each wheel's speed, -255 (full back) to 255 (full forward). `ms`, default 500. `wait`, default true | Speeds clamped to -255..255 and `ms` capped at 3000, on the server and again in the sketch. The reply lists what was clamped | With `wait`, it returns once the drive is over: `driving`, `stopped_because` and the encoder `ticks`. A drive the rover refuses, forward with something close in front, is an error with the reason |
| `stop` | none | | Both wheels brake at once |
| `look` | `pan`, `tilt`: degrees from straight ahead, pan positive right, tilt positive up. Either may be left out, and it stays put | -90..90 on the server; the mount's own range in rover.json (pan -90..90, tilt -45..45 by default) in the sketch | Where the mount went, after half a second for the servos to get there |
| `ranges` | none | | `front_mm`, `left_mm`, `right_mm`, and `sensors`: `ok`, `missing` (not answering, so null) or `clear` (nothing within about 1.2 m, so null) |
| `rover_status` | none | | Driving and how fast, `last_stop` (why it last stopped), `front_block`, `stop_mm`, where the mount points, which sensors answer, the ranges, and each wheel's ticks (up forward, down back) |
| `capture_image` | `width`, `height` | | The photo, as before. The C920S is found among the video nodes; the UNO Q's own `video0` and `video1` are its video codec's, which `find_cameras` now skips |

The rover's tools are offered only when the server runs without `--tls`: a paired site's token opens every tool, and moving a
real rover stays with whoever holds the board's own token. They aren't in `PRODUCT_GADGET_TOOLS`, so no product reaches them.

How the board's side reaches the microcontroller: the sketch registers `drive`, `stop`, `look`, `ranges`, `ticks` and
`status` with `Bridge.provide`, and `rover/bridge_client.py` calls them through `arduino-router`'s Unix socket in
MessagePack-RPC (request `[0, id, method, params]`, response `[1, id, error, result]`), with its own MessagePack codec, since
the board's python3 has no msgpack module. Each answer is one line of JSON. Each call opens its own connection and waits at
most 3 seconds. `python3 bridge_client.py status` makes one call from a shell.

## The safety stop

It runs on the microcontroller and needs nothing from Linux.

- **Close in front.** While both wheels go forward, the rover brakes the moment the front sensor reads under the stop
  distance (150 mm unless `--stop-mm` says otherwise), and records why in `last_stop`. A forward drive is refused while it
  would stop at once, and the refusal says why. Backing up and turning on the spot still work.
- **No front sensor.** A front reading that is gone or older than 300 ms counts as blocked for forward drives, since nothing
  would stop the rover (`need_front_sensor` in rover.json turns this off).
- **Time.** Every drive ends by itself when its time is up, 3000 ms at most, even if Linux goes quiet or the network drops.
- **The guard timer.** The sketch's `loop()` makes these stops, and it reads the front sensor first and checks right after
  it. A stuck I2C bus can hold `loop()` up, though: the board's I2C driver waits 500 ms for a transfer that never ends and
  has bus recovery off, so one poll of the three sensors could take 1.5 s, half a meter or more at full speed. So while a
  drive runs, a Zephyr kernel timer looks every 10 ms, in an interrupt, and puts the TB6612 in standby (STBY low, which lets
  both wheels go) when `loop()` is more than 20 ms late to end the drive, or a forward drive's front reading is more than
  320 ms old. `loop()` brakes and says why in `last_stop` once it gets going again: "the front reading went stale while the
  microcontroller was held up, so its timer stopped it", or the drive's time.
- **Braking.** A stop is the TB6612's short brake (both inputs high), which stops a wheel sooner than letting it coast.
- **A sensor that drops out** is held in reset and tried again every 5 seconds while the rover is still.

What it doesn't cover: a turn with one wheel forward, reversing (there is no rear sensor), the VL53L0X's blind spot under
about 30 mm, and a microcontroller that halts, which stops the guard timer too and leaves the pins as they were. A hardware
watchdog would cover that, but the sketch starts none for now. The firmware has `CONFIG_WATCHDOG` off, so it would mean
writing the STM32's IWDG registers from the sketch, and an IWDG once started counts until the next reset, through App Lab
stopping the app and flashing the next sketch. Only a test on the board can show that flow copes. The physical cut-off is
the switch on the motor pack, and someone should watch any demo. That is what `docs/JETSON_TODO.md` G10 asks before real
actuators: a cut-off the software can't override, a board that stops by itself when the platform goes quiet, limits
enforced on the board, and a person watching.

## Two choices in the sketch

**Servo pulses are timed in software.** The core's `analogWrite` runs at the 500 Hz the board's overlay sets, and a servo
needs a 1 to 2 ms pulse every 20 ms. Asking Zephyr's PWM API for a 20 ms period would set the period of the whole timer
behind the pin, and so of any motor channel on the same timer, if the timer's 16 bits can hold 20 ms at the overlay's
prescaler at all. So the motors keep the hardware PWM, and `loop()` makes the servo pulses with `micros()`: both start
together and each ends at its own width, every 20 ms. That costs up to 2.5 ms of every 20, and only for 1.5 seconds after
each `look` (`servo_hold_ms`), after which the servos rest: a Bridge call that lands mid-pulse could otherwise stretch one
and make a resting servo twitch. `status` counts pulses that ran late. A heavy camera may let the tilt sag while it rests;
`servo_hold_ms: 0` in rover.json pulses all the time.

**The VL53L0X driver is register by register, in the sketch.** The board has no VL53L0X library (its `STM32duino_VL53L4CD`
is a different sensor), and a library listed in `sketch.yaml` would have to be downloaded at build time along with every
library the sketch already uses, at exact versions. The sketch's driver is ST's VL53L0X API bring-up, which Pololu's
library also follows: data init, the reference SPADs, ST's default tuning settings, the VHV and phase calibrations, then
back-to-back ranging over `Wire`, polled every 10 ms. It keeps the sensor's default timing budget, about 33 ms a reading.

## Files

| File | What |
| --- | --- |
| `muse-device/rover/app/` | The App Lab app "Muse Rover": `app.yaml`, `python/main.py` (only `App.run()`), `sketch/sketch.ino`, `sketch/sketch.yaml` (no libraries listed), and `sketch/rover_config.h`, the defaults, which the setup rewrites from rover.json |
| `muse-device/rover/bridge_client.py` | The MessagePack codec and MessagePack-RPC client for the router socket |
| `muse-device/rover/rover_config.py` | rover.json's defaults and checks, and the header it renders |
| `muse-device/rover/setup-rover.sh` | The one-go setup |
| `muse-device/rover/selftest.py` | The self-test the setup runs |
| `muse-device/server.py` | The rover's tools, `offer_rover_tools`, and the codec check in `find_cameras`. `VERSION` 0.7.0 |
| `muse-device/rover/host_check/` | `sketch_sim.cpp` and stand-in headers, which run the sketch's own `setup()` and `loop()` on a computer. Not sent to the board |
| `muse-device/test_rover.py` | The tests below |

## Tests

`cd muse-device && python3 -m unittest test_rover`: 61 tests. In WSL Ubuntu (Python 3.12.3) 60 pass and 1 skips, since it
has no g++. On Windows (Python 3.12.10, MSYS2's g++ 15.2) 51 pass and 10 skip, since they need Unix sockets or bash on Linux.
They cover:

- **The codec:** the spec's encodings byte for byte, round trips at every size boundary (fixint to int64, fixstr to str32,
  bin, arrays and maps to their 32-bit forms, floats, nil, bools, ext), every cut-short value read as incomplete, bad bytes
  refused, a made-up count of four billion refused at once, and a stream read a byte at a time.
- **The router client**, against a fake router through a socket pair and, on Linux, a real Unix socket: the request's
  shape, a fresh id each call, errors in words, notifications and other answers passed over, an answer a byte at a time, a
  timeout that holds, a router that hangs up or sends nonsense, no socket, nobody listening, and no permission.
- **The tools**, against a fake sketch: offered only with rover.json and without `--tls`, speeds clamped, time capped,
  non-numbers refused before anything moves, a refused drive's reason, a failed Bridge call in plain words for every tool,
  an answer the server can't read, `look`'s limits and the axis left out, the ranges' missing and clear, and the codec
  check in `find_cameras`.
- **rover.json and the header:** the defaults are this page's pin map, flags change only what they name, a run again keeps
  them, bad pins and limits are refused, the committed header is the defaults', and every `ROVER_` name the sketch uses is
  defined.
- **The self-test**, through the real tools with a fake sketch: a working rover passes, a missing sensor, a silent encoder
  and swapped encoders are named, a photo when there is a camera, and it never prints the token.
- **setup-rover.sh, end to end in WSL** with the board's commands stubbed (`su` runs as the tester in a made-up home, and
  `arduino-app-cli` can't start the app): the real `autostart.sh` starts the real `server.py` with the rover's tools, the real
  self-test finds no router behind it, every step reports, the report line is last, a second run changes nothing, a bad pin
  stops before anything is copied, and the token never appears. With an 80-second deadline and an `app start` that would
  take 120, the start is cut, the self-test isn't tried, and the report still comes within the 80. A deadline that isn't a
  number is refused, and every `timeout` in the script goes through the deadline.
- **The sketch's logic, on a computer** (`rover/host_check`, run wherever `g++` is): the real `sketch.ino` built with
  `-Wall -Wextra -Werror` against stand-in headers, then its own `setup()` and `loop()` against a made-up clock, pins and three
  made-up VL53L0X sensors, with the guard timer's expiry run as the clock passes it. 35 checks: the sensors end at 0x30, 0x31
  and 0x32 with never two at one address; the driver leaves standby braked; a forward drive runs, and the safety stop brakes
  within one 10 ms poll of a reading under 150 mm and says why; a forward drive is refused while blocked, backing up and
  turning aren't; a drive ends by itself on time, by `loop()` and not the guard, and 9000 ms becomes 3000; `stop` brakes;
  with the bus stuck, so every Wire call waits out the 500 ms timeout, the guard cuts a forward drive about 325 ms after the
  last front reading, before the first stuck call gives up, and a turn 20 to 30 ms after its time, and `loop()` then brakes
  and says why each time; once the bus lets go the sensors read again and the rover drives; a front sensor that stops
  answering reads -1, blocks forward, is held in reset and comes back at 0x30; ticks count down going back; `look` holds to
  the mount; one pulse per servo every 20 ms, 2500 us for pan 90 and 2000 us for tilt 45; and the servos rest after 1.5
  seconds. Built without the guard's timer, the four stuck-bus checks fail. It says nothing about the board's own APIs.

The rest of `muse-device`'s tests still pass in WSL: 222 in all, 3 skipped (the 2 from before, and the sketch's, without g++).

## Not tried on real hardware

Everything below needs ArduinoQ-01 and the parts, and nobody has done it yet.

1. **The sketch has never been built for the board**, only for a computer against stand-in headers. Things only the
   board's toolchain settles: that `Bridge.provide` takes functions that take `int`s and return `String`, `k_mutex` from
   `<zephyr/kernel.h>` in a sketch, `k_timer_init` and `k_timer_start` too (both are in the core's `syms-dynamic.ld`), and
   `digitalWrite` and `millis()` from the timer's expiry, in an interrupt, `A0` to `A3` as digital pins, `Wire.setClock(400000)`, and `attachInterrupt` on both D2
   and D3 (on the STM32 two pins with the same number on different ports share one interrupt line).
2. **The router.** That arduino-router answers `bridge_client`'s requests as built here: one short connection per call, the
   error's shape, and the socket opening for arduino once it's in the group.
3. **arduino-app-cli.** The app id `user:muse-rover`, that `app start` builds an app copied in by hand, that it replaces an
   app already running, `properties set default`, and how long the first build takes.
4. **The VL53L0X bring-up**, written from ST's sequence and never run on a sensor: the host check's made-up sensors take any
   register write, so they prove the order of wake, move and reset, not the init sequence. The moves to 0x30, 0x31 and 0x32,
   the calibrations' timeouts, and the readings themselves are the board's to show.
5. **The servos:** whether software pulses are steady enough, how often a Bridge call makes one late, the SG90s' real range
   on this mount, and the guessed tilt limits of -45 to 45.
6. **The motors and encoders:** which way is forward, whether 110 of 255 turns the wheels at 6 V, that the encoders work at
   3.3 V, and their ticks.
7. **The safety stop's timing:** how far the rover travels between a reading under 150 mm and stopping, at full speed, and
   how far it coasts when the guard timer puts the driver in standby. Holding SDA to ground with a jumper, the rover on a
   stand, sticks the bus on purpose and should show the guard's stop in `last_stop`.
8. **The photo on this board:** that GStreamer installs and takes MJPEG from the C920S, and that `VIDIOC_QUERYCAP` tells the
   codec's nodes from the camera.
9. **Power:** whether the hub passes enough from the bank for the UNO Q and the C920S together, and whether the board browns
   out when both motors start.
10. **The fleet route to this board:** `ArduinoQ-01.local:8765` resolving on the office network, and cron and the autostart
    under the arduino user on this image.
11. **Muse Muse's side:** the admin action that bundles the kit, runs the exec and reads the report isn't part of this kit.
    `scripts/device-bundle.ts` packs only the drive and training files today, so its list needs `autostart.sh` and
    `rover/` added before the admin action can send them.
