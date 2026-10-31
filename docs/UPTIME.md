# Staying up, Nov 4 to 9

Judging runs Nov 4 to 8 and the live finals are Nov 9. The whole time, this laptop has to keep the models, the approval page, the connector and the relay client running, so Muse can reach the device. This page is the checklist for that week: what restarts on its own, what to set before Nov 4 noon, how to check health and how to recover.

## What restarts on its own

`scripts/start.sh` starts everything, and splits what it starts in two (`scripts/supervise.sh`). The live app picks this up only after the change is merged into the checkout it runs from and start.sh is restarted, in a restart window Ethan opens.

| Process | Port | Kind | When it stops |
|---|---|---|---|
| Glimmer's llama-server (only when a model is plugged in) | 8081 | required | start.sh stops everything and exits 1 |
| The checker, LFM3-VL-2B | 8083 | required | start.sh stops everything and exits 1 |
| Muse Privacy (`python -m base`: approval page and connector) | 8787, 8790 | required | start.sh stops everything and exits 1 |
| The embedder, EmbeddingGemma 2 (SEARCH_EMBEDDINGS=1) | 8084 | optional | started again after 5 s, then 10, 20 and so on up to 5 minutes; search uses keywords meanwhile |
| The SAM region finder (SAM_ENABLED=1, off by default) | 8085 | optional | started again the same way; page images are not read until it answers (fail closed). Exit status 3 (no weights or no sidecar environment) is not retried |
| The relay client | none, it dials out | optional | started again the same way (it also reconnects on its own). Exit status 3 means the relay rejected the device secret (HTTP 401) or another copy took over, and it is not retried. A 403 never comes from the relay (it is Cloudflare's edge or a proxy, such as error 1010), so the client keeps retrying and its log suggests RELAY_PROXY=direct |

A required process stopping brings start.sh down on purpose, so that launchd can start it all again from a clean state. That only happens when the LaunchAgent is installed (`scripts/install_login.sh`): launchd then starts start.sh again 30 s after it exits, at login, and after a crash. Without the LaunchAgent, nothing restarts a stopped start.sh.

Install the LaunchAgent in the last restart window before Nov 4, from the checkout the app runs from (not a worktree; the agent runs the start.sh next to it), and only once start.sh is no longer running in a terminal (two copies would fight over the ports):

```sh
scripts/install_login.sh            # installs and starts it
scripts/install_login.sh --remove   # after Nov 9, or to go back to running it by hand
```

The agent runs as an interactive process (no background throttling of the models), with Homebrew on its PATH, and writes start.sh's messages to `BASE_HOME/logs/start.log` (`~/.base/logs` by default).

## Before Nov 4 noon

- [ ] **Power.** On AC power the whole week. On battery the local model runs about 12 times slower, and start.sh says so when it starts. Turn Low Power Mode off (System Settings > Battery).
- [ ] **Lid open.** start.sh keeps the Mac awake (`caffeinate -i -s`: no idle sleep, and no system sleep on AC), but closing the lid still sleeps it unless an external display, keyboard and power are attached. The display going dark is fine.
- [ ] **Sleep settings.** System Settings > Battery > Options: turn on "Prevent automatic sleeping on the power adapter when the display is off". Check the names on this macOS version; they move between releases.
- [ ] **macOS updates.** System Settings > General > Software Update > Automatic updates: turn off installing macOS updates and app updates, so nothing restarts the Mac during judging. This is a managed laptop, so an update with a deadline may still be forced: check for one on Nov 3 and install it in a planned window then, not during judging.
- [ ] **One planned restart.** Restart once before Nov 4 (in the same window as the update check) so no restart is pending, then log in. The LaunchAgent starts only after you log in, and with FileVault the Mac waits at the login screen after any restart, so a restart during judging needs someone at the laptop.
- [ ] **Disk.** Keep at least 5 GB free on the data volume all week (`df -h /System/Volumes/Data`); start.sh warns when it starts with less. No model downloads, no screen recordings saved to this disk and no heavy jobs from Nov 4 noon to Nov 9. The logs grow slowly; check them with `du -sh ~/.base/logs`.
- [ ] **Memory.** Quit large apps you do not need. `memory_pressure | tail -n 1` prints the free percentage; under about 20% the models slow down.
- [ ] **The Muse link.** Pair in the last window if Muse was unlinked. The relay's access tokens last 1 hour and refresh on their own; refresh tokens last 30 days (relay/README.md), so a link made in late October lasts through Nov 9.
- [ ] **Health.** Run the checks below once everything is installed, and ask Muse for a document list through the connector.

## How to check health

```sh
curl -fs http://127.0.0.1:8787/health && echo "approval page: up"
curl -fs http://127.0.0.1:8790/health && echo "connector: up"
curl -fs http://127.0.0.1:8083/health && echo "checker (LFM3-VL-2B): up"
curl -fs http://127.0.0.1:8084/health && echo "embedder: up"        # with SEARCH_EMBEDDINGS=1
curl -fs http://127.0.0.1:8081/health && echo "Glimmer: up"         # when a model is plugged in
launchctl print "gui/$(id -u)/ai.offlinebase.muse-privacy" | grep -E "state|pid|last exit code"
tail -n 20 ~/.base/logs/start.log                  # start.sh's messages, helper restarts included
grep -c "starting it again" ~/.base/logs/start.log # how many times a helper was restarted
tail -n 20 ~/.base/logs/relay.log                  # the relay client
grep -c "connected to the relay" ~/.base/logs/relay.log  # at least 1; the curl checks above pass without the relay
grep -c "HTTP 403" ~/.base/logs/relay.log         # something on the way refuses the socket: try RELAY_PROXY=direct
pmset -g batt | head -n 1                          # should say AC Power
pmset -g assertions | grep -i caffeinate           # start.sh's keep-awake
df -h /System/Volumes/Data
```

The real test is Muse: a tool call such as list_documents should come back within a few seconds.

## How to recover

| What you see | What to do |
|---|---|
| Everything is down | With the LaunchAgent: `launchctl kickstart -k "gui/$(id -u)/ai.offlinebase.muse-privacy"` restarts it now. Without it: Ctrl-C the terminal and run `scripts/start.sh` again. Allow about 2 minutes for the models to load, then run the health checks. |
| start.sh exits at once with "something already answers on 127.0.0.1:PORT" | An old process still holds the port. `lsof -nP -iTCP:PORT -sTCP:LISTEN` shows it; stop it with `kill PID`, and launchd starts start.sh again within 30 s. |
| start.sh exits with "... stopped; shutting the rest down" | A required process stopped. Its own log in `~/.base/logs` (checker.log, answer.log) says why. launchd starts everything again; if it keeps stopping, look at disk and memory first. |
| start.log says a helper keeps restarting | The app still answers. Read that helper's log (embedder.log or relay.log). Search uses keywords while the embedder is down. |
| relay.log says the relay refused this device, or another copy took over (exit 3) | Stop the other copy (`pgrep -fl relay_client`), or pair again: `uv run python -m base.connector.relay_client pair` and enter the code in Muse. Then kickstart as above. |
| The disk is nearly full | Empty the Trash and delete old logs in `~/.base/logs` (they are made again). Never delete base.db or tagmap.json. Then kickstart. |
| relay.log keeps saying HTTP 403 | Cloudflare's edge or the managed laptop's proxy refuses the socket, not the relay. Set `RELAY_PROXY=direct` in .env and kickstart. |
| Daily tags cause trouble and you want them off | Set `TAG_ROTATION=off` in .env on this version and kickstart. Keep the version 2 `tagmap.json`. Do not put `tagmap.json.v1-backup-*` back unless Muse never saw a version 2 tag: it holds older counters, so codes Muse already holds would go to other people and restore wrongly. Going back to the older code (the ethan/device-only-build branch) needs the version 1 file, since it cannot read version 2, so only do that if Muse never saw a version 2 tag (docs/RETENTION.md). After the first start on this version, check that `base.db.v1-backup-*` is next to base.db (it is made then, once). |
| The Mac restarted | Log in. The LaunchAgent starts everything; check health after about 2 minutes. |
