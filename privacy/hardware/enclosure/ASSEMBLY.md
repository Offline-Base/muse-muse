# Assembly

How to print and build the Muse core around a Jetson Orin Nano Super Developer Kit. Read MEASUREMENTS.md first: the board's hole pattern, fan position and stack height are placeholders until measured.

## How it fits together

- The carrier board comes off its plastic base and hangs **upside down** on four posts that rise from the floor. The module and cooler point down, so the fan faces the floor.
- The **intake duct** comes up through the floor and stops 1 mm under the fan; a foam ring closes that gap. Outside air goes straight into the fan.
- Warm air leaves the heatsink fins sideways, rises past the board edges and the cable bay, and leaves through the **exhaust duct** on the lid.
- Each duct ends in a round **vent ring**: a slotted grille with a flat flange around it. The flange is glued or sewn to the inside of the shell or fabric, over a round hole the size of the grille (`vent_open_d`, 70 mm).
- The **rear port panel** carries panel-mount power, Ethernet and USB connectors on short extension cables. It is the only opening the shell needs besides the two vent rings.
- The **front LED panel** holds a 12 or 16 pixel ring behind a 2 mm diffuser.
- Four **tabs** at floor level take a strap, zip tie or M3 screw to tie the core into the shell.

## Print

Material: PETG, or ASA if the core will sit somewhere hot. 0.4 mm nozzle, 0.2 mm layers, at least 4 walls, 30 percent gyroid infill. **No supports on any part.** Every part fits a 220 x 220 mm bed (checked by `tests/test_core.py`).

| File (out/) | Qty | Orientation | Size (mm) | Notes |
|---|---|---|---|---|
| base.stl | 1 | floor down, as exported | 149.8 x 159.3 x 58.3 | Posts, collar, bosses and rails all rise from the floor; notches are open at the top. |
| lid.stl | 1 | top face up, as exported | 117.8 x 159.3 x 11.0 | Socket for the exhaust duct on top. |
| port_panel.stl | 1 | flat | 81.4 x 55.3 x 3.0 | |
| led_panel.stl | 1 | outer face down, as exported | 61.9 x 55.3 x 13.0 | The diffuser pocket is on the bed side. |
| led_clamp.stl | 1 | flat | 49.1 x 48.8 x 2.5 | |
| diffuser.stl | 1 | flat | 46.1 x 46.1 x 2.0 | White or natural PETG, 100 percent infill, so it glows evenly. 2 mm opal acrylic cut to the same circle also works. |
| intake_duct.stl | 1 | flange down, as exported | 97.2 x 97.2 x 34.5 | 45 degree cone, no supports. |
| exhaust_duct.stl | 1 | flange down, as exported | 97.2 x 97.2 x 30.0 | |

`out/muse_core_assembly.step` has every part in its assembled place plus a solid named `REFERENCE_board_keepout_do_not_print` that shows the space the board may use.

## Hardware

| Item | Qty | Notes |
|---|---|---|
| M3 x 5.7 mm brass heat-set inserts (4.6 mm outside) | 14 | 4 board posts, 4 lid bosses, 2 LED bosses, 4 tabs. Use M2.5 inserts for the posts if the board holes are small (MEASUREMENTS item 2). |
| M3 x 6 mm screws | 10 | 4 board, 4 lid, 2 LED clamp. |
| Panel-mount 5.5 x 2.5 mm DC jack to 5.5 x 2.5 mm right-angle plug, 15 to 30 cm | 1 | Rated for at least the current printed on the kit's power adapter; 20 AWG or thicker. |
| Panel-mount RJ45 extension (Cat 6), right-angle plug on the board end, 30 cm | 1 | Usually ships with its own M3 screws and nuts. |
| Panel-mount USB-A 3.0 extension, right-angle plug on the board end, 30 cm | 1 | Same. |
| WS2812 ring, 12 or 16 pixels | 1 | Set `led_ring_od` and `led_ring_id`, or call `with_ring(12)`. |
| Light controller from `hardware/light/` | 1 | Small USB board that drives the ring; it plugs into a Jetson USB port inside the core. |
| Closed-cell foam ring, 3 mm thick, about 40 mm inside and 50 mm outside | 1 | Seals the intake duct to the cooler. Cut from EPDM weatherstrip. |
| Foam or foil tape | 1 roll | Optional: seals the lid rim and panel edges so the fan only breathes through the intake. |

## Build

1. **Measure.** Fill in MEASUREMENTS.md items 1 to 13, update `Params` in `core.py`, then run `uv run pytest -q` and `uv run python core.py` and print the new STLs.
2. **Inserts.** With a soldering iron at about 230 C for PETG (245 C for ASA), press inserts into the four post tops, the four corner bosses, the two LED bosses and the four tabs. Press straight and stop flush.
3. **Prepare the kit.** Flash the microSD or NVMe first. Remove the four screws holding the carrier to its plastic base and lift the carrier off. If the Wi-Fi antenna pads are stuck to the base, peel them off and re-stick them inside a side wall of the core later, away from the cooler.
4. **Cables to the board.** Plug the right-angle ends of the DC, RJ45 and USB extensions into the board's DC jack, RJ45 and one USB-A port. Plug the light controller's USB cable into another USB-A port.
5. **Mount the board.** Turn the carrier over (cooler down) and lower it onto the four posts so the I/O edge faces the rear notch. Screw the board down with four M3 x 6 mm screws from the PCB's bare side. The board powers on as soon as the DC jack gets power; no button is needed.
6. **Rear panel.** Screw the three panel-mount connectors into `port_panel` from the outside. Coil the slack in the cable bay below the PCB level so it does not block the exhaust. Slide the panel down into the rear rails until it sits on the floor.
7. **LED panel.** Glue the diffuser into the pocket on the outer face. Drop the ring into the seat at the top of the light tube, LEDs facing the diffuser, wires toward the clamp's notch. Screw the clamp down with two M3 x 6 mm screws; it presses the ring 0.3 mm into its seat. Connect the ring to the light controller. Slide the panel into the front rails.
8. **Intake duct.** Stick the foam ring on the duct's top rim. From below, push the duct up through the floor collar until the foam meets the cooler's top plate around the fan and squeezes to about half its thickness. Fix the duct with two dabs of glue where it leaves the floor. If the real stack is shorter than `stack_z`, the duct simply goes in further.
9. **Lid.** Optional foam tape on the rim. Screw the lid on with four M3 x 6 mm screws, which also traps both panels. Push the exhaust duct into the lid socket.
10. **Shell.** Cut three openings in the plush or printed shell: two round holes the size of the vent grille (70 mm) and one rectangle for the port panel notch (70 mm wide). Sew or glue each vent flange to the inside of the shell around its hole (2 mm sewing holes every 8 mm). Glue or hook-and-loop the shell edge around the rear notch. Tie the core in through the four tabs.
11. **Test.** Run THERMAL_TEST.md before any long demo.

## Notes

- The core is a closed box, so plush stuffing never touches the board or blocks the fan. Keep stuffing at least 20 mm clear of both vent grilles.
- Port panel layout seen from behind: RJ45 top left, USB-A bottom left, DC jack right.
- If anything is changed in `Params`, the tests re-check bed fit, board clearance, part collisions and the airflow ratios.
