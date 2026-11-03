# What "SAM 3.1 running locally" can mean for the video

Written Nov 3, 2026, about 10:30 AM ET. Nothing here has run with the uplink out. Hussam owns the boards: the board steps are his to run or change.

## The answer

"Locally" means **on the board, on its own, with its internet uplink pulled**: Meta SAM 3.1 on jetson-04 answers a laptop over one cable. That is the edge story, and it needs one change by Hussam (the rebind below). Until the cable-out test passes, the line is "SAM 3.1 runs on a Jetson in our office", which is true today.

SAM 3.1 on the Mac is **no-go for this submission**. It's allowed (SAM isn't Glimmer), but on Nov 3:
- No SAM weights are on the Mac. The Hugging Face cache has an empty `facebook/sam3` folder and nothing for `facebook/sam3.1`.
- No PyTorch in the Mac's Python, and Meta's `sam3` code isn't installed.
- It would take about 3 GB of disk: the fp16 checkpoint (1.76 GB, made by `convert_fp16.py`, which pulls the 3.5 GB original into memory, not onto disk), PyTorch (about 0.5 to 1 GB) and the code. The Mac had 8.0 GB free, and the rule is to keep 6 GB, so it doesn't fit without freeing room first.
- `server.py` is written for CUDA (`autocast("cuda")`, `.to("cuda")`, CUDA memory counts). A Mac run needs a device switch to `mps` or the CPU, and whether Meta's `sam3` code runs on `mps` is untested.
- It wouldn't help the story: a Mac answering is "a computer", and the claim we want is "an 8 GB board".

If the owner wants it after the deadline: free about 4 GB, then about 1 hour to add a `--device` flag to `server.py` and try `mps`, with no spend.

## Today, on the office network (no change to any board)

From a laptop on the office network, straight to the service, no token and no public tunnel:

```bash
cd scripts/edge/sam3
SAM_URL=http://<jetson-04 office address>:8790 python3 compare.py ../../../public/muse/muse-jetson.jpg --out ~/Desktop/sam-muse.html
SAM_URL=http://<jetson-04 office address>:8790 python3 ui.py      # then http://127.0.0.1:8792
```

`compare.py` looks for "muse" and "plush toy" with Meta's weights and with the tune, writes one page with the four pictures side by side, and prints the counts. The shot to expect, from the Nov 3 board check on made-up held-out images: Meta's weights find no "muse" (they don't know the word) and find the "plush toy"; the tune finds both. On `muse-jetson.jpg` itself this is untested, and that render may look like the training images, so look at the result before filming it.

From off the office network, `FLEET_URL` must be set to the control plane (no default; on the office network use its office address, not the public tunnel) and the page asks for an admin's fleet token. That path sends the photo in 15 KB pieces, about 10 to 20 s a look.

Keep the terminal and the address bar out of frame: they show board addresses (docs/MESSAGING.md).

## Hussam: the rebind (about 5 minutes, about 1 minute of SAM down)

`sam3.service` listens only on the board's office address. With the uplink pulled that address goes away, and nothing else can reach SAM. Make it listen on every address of the board instead:

1. `systemctl cat sam3.service` and note the `ExecStart` line with `--host`. On Nov 3 the drop-in `/etc/systemd/system/sam3.service.d/tuned.conf` set it, with `--tuned muse=/opt/sam3/model/muse31_delta_fp16.pt`.
2. In that `ExecStart`, change `--host <office address>` to `--host 0.0.0.0`. Keep `--port 8790` and `--tuned` as they are. (Hussam's call instead: `127.0.0.1` plus a forwarder. `0.0.0.0` keeps the office page working and adds loopback and the local link with no other change.)
3. `sudo systemctl daemon-reload && sudo systemctl restart sam3.service`. Loading takes 45 to 57 s.
4. Check, on the board:
   - `ss -ltn | grep 8790` shows `0.0.0.0:8790`.
   - `curl -s http://127.0.0.1:8790/health` says `"ok": true` and `"tuned": ["muse"]`.
   - `curl -s http://<office address>:8790/health` still answers, so the office page and the hosted route keep working.
5. One warm-up look (the first after a restart takes about 15 s while PyTorch compiles for the Orin).

Undo: put the office address back in `--host`, `daemon-reload`, restart.

The service has no password. With `0.0.0.0` it also answers on the local link, which only a cabled laptop can reach. It already answered anyone on the office network.

## Hussam: the cable-out test (about 20 minutes, before any take)

1. **Find the local link.** The board has a second address beside its office one (the fleet's `get_node` lists both). `nmcli -t -f DEVICE,IP4.ADDRESS device show` says which port carries it. Cable the laptop to that port; the laptop should get an address from the board.
2. **With the uplink still in**, from the laptop: `curl -s -m 5 http://<local-link address>:8790/health`. Then `compare.py` as above with `SAM_URL=http://<local-link address>:8790`. Note `free -m` on the board (with SAM loaded it sat at 6.4 of 7.5 GB in use).
3. **Pull the uplink:** the board's Wi-Fi and Ethernet uplink out, only the cable to the laptop left. Laptop Wi-Fi off. The fleet will show the board as offline: that is expected. Nobody restarts anything while it's out.
4. **Run it again:** `compare.py` and one look on the page with the tuned switch, then "Before and after". Note the times.
5. **Put the uplink back** and check the board is back in the fleet (`list_nodes` shows it online within about 2 minutes) and the office page works.
6. **Report** in docs/BUILD_LOG.md: free memory before and during, first and warm look times, the counts for "muse" and "plush toy" with each weight, and anything that failed.

## Go or no-go

Go for a "cable out, SAM still sees" shot only if all of these held with the uplink out:

| Check | Pass |
|---|---|
| `/health` over the local link | `"ok": true`, `"tuned": ["muse"]` |
| "muse", Meta's weights, on the Muse photo | 0 found (Meta's SAM doesn't know the word) |
| "muse", the tune | at least 1 found, best score 0.9 or more |
| "plush toy", both weights | at least 1 found |
| A warm look on the board (`ms` in the answer) | 3 s or less; the round trip 5 s or less |
| Board memory during looks | `available` at least 500 MB in `free -m`, no stall |
| After | back in the fleet and the office page works |

No-go on any miss. Then film over the office network with the uplink in and say "on a Jetson in our office", not "offline" or "with the cable out".

What may be said after a go: "Meta's SAM 3.1, and a version we tuned on another Jetson to know our mascot by name, answer on an 8 GB Jetson with its internet unplugged." Not: that the tune sees better than Meta's model (docs/EDGE_PLAN.md, Nov 3).
