# Measurements

Every number the core is built from, where it came from, and what still has to be measured. Parameter names match the fields of `Params` in `core.py`.

Looked up on Oct 27, 2026. NVIDIA does not publish mounting-hole positions or a mechanical drawing for the Orin Nano carrier board outside its developer login, so the hole pattern, fan position and stack height below are placeholders until someone measures a real kit.

## Verified

| What | Number | Parameter | Source |
|---|---|---|---|
| Developer kit envelope (Super) | 103 x 90.5 x 34.77 mm; the height includes the feet, carrier board, module and thermal solution | `kit_x`, `kit_y`, `kit_z` | NVIDIA Jetson Orin Nano Super Developer Kit datasheet, Dec 2024, "Mechanical" row: https://dam-cdn.nvd.orangelogic.com/AssetLink/2ug686w80406gxf6q8uv7r3l7265m2n8.pdf (the "Datasheet" link on https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/nano-super-developer-kit/) |
| Module power | 7 W to 25 W | none | same datasheet |
| Carrier connectors | 2x MIPI CSI-2 22-pin, M.2 Key M (x4), M.2 Key M (x2), M.2 Key E, 4x USB 3.2 Gen2 Type-A, USB Type-C (UFP), 1x GbE, 1x DisplayPort 1.2, 40-pin header, 12-pin button header, 4-pin fan header, DC power jack | none | same datasheet |
| DC jack | 5.5 mm x 2.5 mm barrel | panel jack choice | NVIDIA user guide, Hardware Layout: https://docs.nvidia.com/jetson/orin-nano-devkit/user-guide/latest/hardware_layout.html |
| Port order on the I/O edge | DC jack, DisplayPort, two stacked pairs of USB-A, RJ45, USB-C, all on one long edge | board orientation in `layout()` | numbered photo on the same page: https://docs.nvidia.com/jetson/orin-nano-devkit/user-guide/latest/_images/jetson-orin-nano-qtr_numbered.png |
| Other edges | 40-pin header along the edge at the USB-C end; both camera connectors along the edge at the DC jack end | board orientation | same photo |
| Fan location | Fan on top of the module heatsink, facing up, in the half of the board away from the I/O edge; no fan struts are visible on the top face, which suggests it pulls air in from the top | `fan_center` (rough), intake direction | same photo |
| 16 pixel ring (Adafruit 1463) | outer 44.5 mm, inner 31.7 mm, thickness 6.7 mm | `led_ring_od`, `led_ring_id`, `led_ring_t` | https://www.adafruit.com/product/1463 |
| 12 pixel ring (Adafruit 1643) | outer 36.8 mm, inner 23.3 mm, thickness 6.7 mm | `with_ring(12)` | https://www.adafruit.com/product/1643 |

### Conflicting or secondary sources

| What | Number | How it is used | Source |
|---|---|---|---|
| Original (2023) developer kit datasheet | 100 x 79 x 21 mm | Used only as the PCB outline placeholder (`pcb_x`, `pcb_y`). It disagrees with the Super datasheet, so the core is sized from the larger 103 x 90.5 x 34.77 mm envelope | NVIDIA datasheet, Feb 2023, distributor copy: https://static.chipdip.ru/lib/198/DOC030198469.pdf |
| Mounting holes | not published | Placeholders below | NVIDIA forum, staff point to the carrier design files and STEP model behind the developer login: https://forums.developer.nvidia.com/t/jetson-orin-nano-carrier-mechanics/339279 |
| Orin thermal trip points | software throttle 99.0 C, hardware throttle 103.0 C, software shutdown 104.5 C, hardware shutdown 105.0 C | THERMAL_TEST.md fail line sits below these at 95 C. Read the live values on the board before testing | secondary: https://allai0811.atlassian.net/wiki/x/BgDWC (table for AGX Orin, Orin NX and Orin Nano) and an NVIDIA China forum post citing the thermal app note (99 C max operating, 105 C shutdown): https://forums.developer.nvidia.cn/t/jetson-orin-64gb-devkit/27653 |

## Measure with calipers

Do not print `base.stl` until items 1 to 9 are measured and the parameters updated. Then run `uv run pytest -q` and `uv run python core.py` again.

Board measurements. Take the carrier off its plastic base first (four screws). Hold it component side up with the I/O edge (DC jack to USB-C) away from you. "The corner" means the PCB corner nearest you on the left: the 40-pin header side and the module side.

| # | Parameter | Placeholder | What to measure |
|---|---|---|---|
| 1 | `holes` | (4, 4), (96, 4), (4, 75), (96, 75) | Centre of each of the four mounting holes, x along the I/O edge and y toward it, from the corner. Most important number in the file. |
| 2 | `board_insert_hole_d` | 4.0 (M3 insert) | Hole diameter. 3.2 mm or more takes M3. If smaller, use M2.5 inserts and set 3.6. |
| 3 | `post_d`, `post_zone_clr` | 7.0, 0.5 | Free radius around each hole on the component side. Needs at least 4.0 mm clear of parts; otherwise lower `post_d`. |
| 4 | `pcb_x`, `pcb_y` | 100.0, 79.0 | PCB outline without the plastic base. |
| 5 | `io_overhang` | 2.0 | How far the RJ45 and USB shells stick out past the PCB edge. |
| 6 | `stack_z` | 31.2 (34.77 minus an assumed 2.0 base and 1.6 PCB) | With the kit on a table: table to fan top, minus table to PCB top face. |
| 7 | `pcb_t`, `underside_z` | 1.6, 3.0 | PCB thickness; tallest part on the PCB bottom face. |
| 8 | `fan_center` | (50, 27) | Fan centre from the corner. The intake duct is placed under it. |
| 9 | `fan_bore_d`, `fan_hub_d` | 38.0, 20.0 | Blade tip diameter and hub diameter. The airflow ratios in the README use these. |
| 10 | `intake_duct_id` | 42.0 | The cooler's flat top plate must be at least 47 mm across around the fan so the duct tip (45.2 mm outside) and its foam ring seal on it. If it is smaller, lower `intake_duct_id`. |
| 11 | none | design assumes fan blows into the fins | Fan direction: run the board and hold a strip of tissue over the fan. If air comes out of the fan face instead of going in, the two vents swap roles; note it in THERMAL_TEST results. |
| 12 | none | none | Which sides of the heatsink the fins open to. Keep those sides free of cables. |
| 13 | none | none | Where the Wi-Fi antenna pads are stuck. If they ride on the plastic base, plan to re-stick them inside a side wall. |

Purchased parts. Measure the actual parts after they arrive.

| # | Parameter | Placeholder | What to measure |
|---|---|---|---|
| 14 | `dc_hole_d` | 8.2 | Thread diameter of the panel-mount 5.5 x 2.5 mm jack (M8 is common; some use 11 or 12 mm). |
| 15 | `rj45_cut`, `rj45_screw_pitch` | 17.0 x 14.5, 29.0 | Body cutout and screw spacing of the panel-mount RJ45 extension. |
| 16 | `usb_cut`, `usb_screw_pitch` | 15.0 x 8.0, 30.0 | Body cutout and screw spacing of the panel-mount USB-A extension. |
| 17 | `led_ring_od`, `led_ring_id`, `led_pcb_t`, `led_ring_t` | 44.5, 31.7, 1.6, 6.7 | The ring you bought. Non-Adafruit 16 pixel rings vary from about 44 to 50 mm. |
| 18 | `insert_hole_d`, `insert_depth` | 4.0, 6.2 | Pilot hole from the insert maker's datasheet (M3 x 5.7 mm inserts usually want 4.0 mm). |
| 19 | `intake_reach`, `exhaust_reach` | 25.0, 30.0 | Distance from the core to the inside of the shell at each vent, once the plush or shell is chosen. |
