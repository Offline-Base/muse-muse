# The hero file on a Jetson

**Not ready to run yet: no tuned file exists.** The training run stopped before it started (docs/BUILD_LOG.md, Nov 1). When the file is made, whoever made it replaces `SHA256_GOES_HERE` below and deletes this paragraph. Until then, nothing below has been run, on any board. All test data is made up.

Hussam: run this on the board itself, at the board. These steps are not for a laptop, and the file isn't for a laptop either.

## Which board

| Board | Today | What taking it does |
|---|---|---|
| jetson-03 or jetson-04 | Bolt | **Use one of these.** The other keeps Bolt going |
| jetson-02 | LFM3-1.7B | Fine too. Its SD card had disk errors in the past, so check the sha256 twice |
| jetson-05 | LFM3-VL 2B, the router, and the fleet's control plane | **Last choice.** Its memory is already about 93% used, and stopping things there can take the console and API down for every board |

First put the board in maintenance from the fleet console, so no chat gets sent to it while it changes. Take it out when you are finished.

## Get the file

Ethan makes a download link on his laptop, good for 7 days, and sends it to Hussam privately. The link works for anyone who has it, so don't post it or put it in the repo.

```bash
aws s3 presign --profile offlinebase --expires-in 604800 s3://muse-knowledge-916979311153/hero-tune-2026-11/muse-privacy-hero-IQ1_S.gguf
aws s3 presign --profile offlinebase --expires-in 604800 s3://muse-knowledge-916979311153/hero-tune-2026-11/tuned.jinja
```

On the board, paste each link where it says so. The first download is about 6.5 GB and can be resumed by running it again.

```bash
df -h /opt            # needs at least 8 GB free
sudo mkdir -p /opt/hero && sudo chown "$USER" /opt/hero && cd /opt/hero
read -r MODEL_URL     # paste the .gguf link, then Enter
read -r JINJA_URL     # paste the tuned.jinja link, then Enter
curl -fL -C - -o muse-privacy-hero-IQ1_S.gguf "$MODEL_URL"
curl -fL -o tuned.jinja "$JINJA_URL"
unset MODEL_URL JINJA_URL
echo "SHA256_GOES_HERE  muse-privacy-hero-IQ1_S.gguf" | sha256sum -c -
```

Stop if the last line doesn't say OK. Delete the file and download it again.

## Get llama.cpp b11970

jetson-02 already has it. Any board with `/opt/jetson-gguf/b11970` can skip this block. It needs b10353 or newer, and b11970 is the build the fleet runs. The file comes from b11669.

```bash
ls /opt/jetson-gguf/
cd /opt/hero
BUILD=bin-ubuntu-cuda-13.4-arm64; R=b11970; U=https://github.com/ggml-org/llama.cpp/releases/download/$R
curl -fLO "$U/llama-$R-$BUILD.tar.gz" && curl -fLO "$U/cudart-llama-$R-$BUILD.tar.gz"
mkdir -p llama-$R && tar xzf llama-$R-$BUILD.tar.gz -C llama-$R && tar xzf cudart-llama-$R-$BUILD.tar.gz -C llama-$R
```

## Free the memory, and serve it

This stops the board's normal model. Everything else is left in place, so the last section brings it back.

```bash
systemctl is-active jetson-llama ollama jetson-d1 2>/dev/null   # note which say active
sudo systemctl stop jetson-llama ollama
sudo systemctl isolate multi-user.target                        # desktop off, for this boot
free -m                                                         # want at least 7,000 MB available
cd /opt/hero
BIN=$(dirname "$(find /opt/hero/llama-b11970 /opt/jetson-gguf/b11970 -type f -name llama-server 2>/dev/null | head -1)")
RT=$(dirname "$(find /opt/hero/llama-b11970 /opt/jetson-gguf/b11970 -name 'libcudart.so*' 2>/dev/null | head -1)")
LD_LIBRARY_PATH="$BIN:$RT" "$BIN/llama-server" -m muse-privacy-hero-IQ1_S.gguf \
  --host 127.0.0.1 --port 8080 -ngl 99 -c 2048 -np 1 --jinja --no-mmproj --no-webui \
  --chat-template-file tuned.jinja --skip-chat-parsing --reasoning off 2>&1 | tee server.log
```

Leave that running. It binds to this board only, so run the rest from a second shell on the board.

**If it runs out of memory:** in this order, try `-c 1024`, then `-ngl 20`, and then lower that number. An 8 GB board has rebooted from a GPU out of memory before, so be able to power cycle it. Say which setting worked. Failing to fit is a real result, so send it back.

## Check it

Copy `eval/hero/ask.py`, `eval/hero/score.py` and `eval/hero/sealed.jsonl` from the repo into `/opt/hero` first. A USB stick or `scp` both work. The board needs only python3.

```bash
cd /opt/hero
curl -s http://127.0.0.1:8080/health; echo
python3 ask.py --sealed sealed.jsonl --out smoke.jsonl \
  --ids red-plain-00,red-structured-00,red-injection-00,sheet-lookup-00,sheet-sum-00
python3 score.py sealed.jsonl smoke.jsonl | sed -n 1,20p
```

`/health` should say `ok`. At about 2.5 tokens a second, which was an x86 stand-in and not a Jetson, each item takes one to three minutes. `score.py` scores all 100 items, so the 95 you didn't ask count as unfinished there. **Read the 5 rows.** Only then, if the board is staying cool, run the whole set, which may take several hours. It picks up where it stopped if you run it again:

```bash
python3 ask.py --sealed sealed.jsonl --out all.jsonl | tee all.log
python3 score.py sealed.jsonl all.jsonl --json board-score.json | sed -n 1,20p
```

While it runs, watch it from a third shell:

```bash
tegrastats --interval 5000 | tee tegrastats.log
```

## What to send back

1. Which board, and its `uname -a` and `cat /etc/nv_tegra_release`.
2. `sha256sum muse-privacy-hero-IQ1_S.gguf`, and whether you used the settings above or smaller ones.
3. `smoke.jsonl` and, if you ran it, `all.jsonl` and `board-score.json`.
4. The last 40 lines of `server.log`, which has the load and speed lines, and any out of memory in `sudo dmesg | tail -40`.
5. Peak memory and peak temperature from `tegrastats.log`. Say if it throttled, or rebooted.
6. Whether you'd be happy to film it: how long a redaction took, start to finish, on screen.

Check `smoke.jsonl` and `server.log` hold no link before sending them. They shouldn't. The data is all made up, so it is fine to share.

## Put the board back

```bash
# Ctrl-C the server first.
sudo systemctl isolate graphical.target    # only if the desktop was on before
sudo systemctl start jetson-llama          # or ollama: whichever said active above
```

Then take the board out of maintenance. Keep or delete `/opt/hero`, which holds about 7 GB. Leaving a file there doesn't affect the board's model.

## Filming

Only show a document that `score.py` checked, and say what it scored on the board. A file with a leak rate above 0 can miss a private item, so the video can't say or imply it catches everything. The score comes from a rented GPU unless the board's own `board-score.json` backs it. Run offline for the shot: unplug the network after the server is up.
