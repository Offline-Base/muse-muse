# Thermal test

One hour of sustained llama-server load, logged with tegrastats, in three set-ups: the bare kit in open air, the board in the bare core, and the core inside the outer shell. The result decides whether the demo is filmed with the board inside the plush.

Run this only after Ethan assigns a board. Until then the Jetson path is simulation only (CLAUDE.md).

## Set-up that stays the same for all three runs

- Same board, same microSD or NVMe image, same Jetson model as the shipping config in CLAUDE.md (Muse Glimmer i1-IQ1_S on llama-server, port 8081).
- Same power mode. Pick the mode you will demo in and record it: `sudo nvpmodel -q > ~/thermal/nvpmodel.txt`. Leave `jetson_clocks` off and the fan on its default automatic curve.
- Same room. Write the room temperature at the start and end of each run (any kitchen thermometer). If the runs differ by more than 2 C, say so next to the results.
- 20 minutes idle between runs so the board starts cool.
- Record the board's own trip points once:

```bash
mkdir -p ~/thermal
for z in /sys/class/thermal/thermal_zone*; do
  echo "$(cat $z/type): $(cat $z/trip_point_*_temp 2>/dev/null | tr '\n' ' ')"
done > ~/thermal/trip_points.txt
```

## The three runs

| Run | Name | Set-up |
|---|---|---|
| A | `open_air` | Kit on its stock plastic base and feet, on a table, nothing within 20 cm. Do this one before taking the kit off its base. |
| B | `core` | Board in the core with the lid, both panels and both ducts fitted. Stand the core on four 50 mm spacers under its tabs so the intake grille sits about 25 mm above the table. Nothing within 20 cm of the exhaust. |
| C | `shell` | The core inside the closed plush or printed shell, sitting the way it will in the demo, with the power, Ethernet and USB cables plugged into the rear panel. |

## Each run

Terminal 1, start logging (1 sample per second; it runs until Ctrl-C):

```bash
RUN=core   # open_air, core or shell
sudo tegrastats --interval 1000 --logfile ~/thermal/$RUN.log
```

Terminal 2, fan speed every 10 s (the hwmon number differs between JetPack versions):

```bash
FAN=$(grep -l pwm-fan /sys/class/hwmon/hwmon*/name | xargs dirname)
while true; do echo "$(date +%s) $(cat $FAN/pwm1)"; sleep 10; done > ~/thermal/$RUN.fan
```

Terminal 3, one hour of back-to-back generation against llama-server (needs `jq`: `sudo apt install jq`). llama-server adds a `timings` object to each response; if your build does not, log the request time instead.

```bash
end=$((SECONDS + 3600))
while [ $SECONDS -lt $end ]; do
  curl -s http://127.0.0.1:8081/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"glimmer","max_tokens":1500,"chat_template_kwargs":{"reasoning_strength":"low"},
         "messages":[{"role":"user","content":"Write a 600 word story about a lighthouse keeper who adopts a seagull."}]}' \
  | jq -r '[now, .timings.predicted_per_second] | @tsv' >> ~/thermal/$RUN.tps
done
```

When the load loop ends after 60 minutes, stop tegrastats and the fan logger with Ctrl-C. For run C, also point an IR thermometer at the hottest spot you can touch on the outside of the shell (usually around the exhaust ring) and write the number down.

## Scoring

`thermal_log.py` uses only the Python standard library, so it runs on the Jetson as is, or on the laptop inside this folder with `uv run`.

```bash
python3 thermal_log.py ~/thermal/open_air.log --label open-air
python3 thermal_log.py ~/thermal/core.log  --label core  --baseline ~/thermal/open_air.log
python3 thermal_log.py ~/thermal/shell.log --label shell --baseline ~/thermal/open_air.log
```

Tokens per second, first 5 minutes against the last 10:

```bash
awk -v t0="$(head -1 ~/thermal/$RUN.tps | cut -f1)" '{dt=$1-t0; if (dt<300){a+=$2;na++} if (dt>=3000){b+=$2;nb++}}
  END {printf "first 5 min %.2f tok/s, last 10 min %.2f tok/s, ratio %.0f%%\n", a/na, b/nb, 100*(b/nb)/(a/na)}' ~/thermal/$RUN.tps
```

## Pass and fail

"Peak" is the highest `tj` reading in the log (the hottest zone if the log has no `tj`).

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Peak temperature over the hour | 85 C or less | above 85 C and below 95 C | 95 C or more at any moment (software throttling starts near 99 C) |
| Enclosed run (B or C) against open air (A) | at most 15 C hotter | | more than 15 C hotter |
| GPU clock under load, last 10 minutes against the first 5 | 90 percent or more | | below 90 percent: the board throttled |
| Tokens per second, last 10 minutes against the first 5 | 90 percent or more | | below 90 percent |
| Time logged | 55 minutes or more | | less than 55 minutes |
| Hottest outside spot of the shell, run C at 60 minutes | 40 C or less | 40 to 45 C | above 45 C (our own limit for something people hold) |
| Fan | logs a non-zero PWM all hour | | stops, stalls or rattles |

`thermal_log.py` checks the rows that come from tegrastats (peak, rise over open air, GPU clock, time logged) and exits with status 1 on a fail. Check the tokens per second, shell surface and fan rows by hand.

A run passes only if every row passes. The core is ready for the demo when runs B and C both pass.

## Recording the results

Numbers we might quote go in `eval/reports/` with the commands that produced them (CLAUDE.md). Write `eval/reports/thermal_<date>.md` with:

- the board, JetPack version, power mode (`nvpmodel.txt`) and trip points (`trip_points.txt`),
- room temperature at the start and end of each run,
- the three `thermal_log.py` rows and their "peak by zone" lines,
- tokens per second ratios, fan notes and the shell surface temperature,
- the exact commands above.

Copy the raw logs to `eval/reports/raw/` (`.log` files there stay out of git).

## If the board throttles

If run B or C fails because of temperature or throttling:

1. **Film with the bare board and the plush beside it.** For the demo video, run the board open air (run A set-up) with the plush sitting next to it and the LED ring cabled to the light controller, and say on screen that the enclosure is still being tuned. Do not film the board inside the plush while it throttles, because every latency in that video would come from a throttled board.
2. Then try these fixes, one at a time, re-running run B after each:
   - fan at full speed (`sudo jetson_clocks --fan`), and note it in the results;
   - check the fan direction (MEASUREMENTS item 11) and the foam seal at the intake duct;
   - seal the lid rim and panel edges with foam tape so the fan only breathes through the intake;
   - larger vents: raise `vent_open_d`, `intake_duct_id` and `exhaust_duct_id` in `core.py`, re-run the tests and reprint the ducts;
   - a lower power mode, recorded in the results.
