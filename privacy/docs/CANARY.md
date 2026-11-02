# Canary capture

A check that rests on recorded traffic instead of the device's own leak checker. A new invented name (the canary) goes into an invented document, a request runs through the device, and every request that leaves the device side is recorded and searched for it.

## Where the line is drawn

The code splits Muse's side from the device's at the relay. A scripted Muse sends MCP calls as relay frames. The real relay client (`base/connector/relay_client.py`) hands each frame to the real connector app, in process with no port opened, and the device's real Services do the work. What counts as leaving the device side:

- every frame the relay client sends back toward the relay, which is what Muse would read;
- every HTTP request from any httpx client in the process to an address that is not loopback;
- every socket connection, name lookup or datagram to an address that is not loopback. These are refused as well as recorded.

The device's own model calls on 127.0.0.1 are recorded too, but they stay on the device. The name pass is meant to read raw text, so the canary should show up there, and seeing it there shows the run read the document.

The canary counts as found if the whole name or any one of its words of four letters or more is in a URL, a header name or value, or a body, in any case, as written or URL-decoded. Each waiting result is approved, as a user who taps Share it on everything would.

## The test

`tests/test_canary_capture.py`, run with `uv run pytest tests/test_canary_capture.py -q`. No model runs. LFM3-VL-2B is faked inside httpx by respx: its name pass never reports a name, the worst it can do, and every other step says back what it was shown, so anything that reached the model comes back out. Every socket is refused, so nothing gets past the recorder. Four tools run (`list_documents`, `search_documents`, `ask_device`, `run_private_task`), with `get_result` until each is done.

- With today's code, the canary is in none of the relay frames and none of the tool outputs, no request went anywhere but the faked local model, no socket was tried, and respx's own record shows the name pass read the canary. The name went out as a `[Person N]` tag.
- With the device-only name-shape check turned off (the Oct 30 failure, [eval/reports/device_only_fresh_200_leaks.md](../eval/reports/device_only_fresh_200_leaks.md)), the canary shows up in the relay frames and the check fails.
- A leak planted by hand, in a URL, a header, a body, a relay frame and a raw socket, is caught in each place.
- A model that refuses every call (not running, or the wrong key) leaves every result held, so nothing is tested: that run is INCONCLUSIVE, not a pass. So is a run that stops early.

## The script, for a run with the real models

`scripts/canary_capture.py` does the same recording around a run on the device's real local models. It has not been run against real models yet.

```sh
scripts/start.sh   # the device's models on 127.0.0.1, in another terminal
uv run python -m scripts.canary_capture --log eval/reports/raw/canary_capture.jsonl
uv run python -m scripts.canary_capture --checker-url http://127.0.0.1:8083/v1 --embed-url http://127.0.0.1:8084/v1 --log canary.jsonl
```

It needs `DEVICE_ONLY=1` (from .env or the environment) and refuses to run without it. It plants the canary in a new temporary folder marked `.synthetic` and uses a throwaway BASE_HOME, so the real workspace, tag map and decision log are not touched. From the real BASE_HOME it reads only the llama-server key, so the model answers. `--canary "<name>"` picks the name, in ASCII letters (the relay frames are JSON, which writes other letters as escapes); the default is a new random one. It prints PASS, FAIL or INCONCLUSIVE and exits 0, 1 or 2. PASS needs the device's model to have answered a request holding the canary and the device to have shared at least one result. INCONCLUSIVE means one of those did not happen, or the run stopped early, so the canary's absence proves nothing. The log is JSONL: a summary line, then one line per request, socket attempt or frame, with header names but never their values, no off-device address (a short hash, salted for each log, instead) and no bodies, only their length and which parts held the canary.

## What this does not show

- **Only this process is recorded.** llama-server and anything else on the machine run in other processes, and their traffic is not seen here. An operating-system capture would be needed for that, and none is built.
- **The relay and Muse are not in the loop.** The frames are recorded where the relay client sends them. The Cloudflare relay, the Muse app and what either does with a frame are outside this check.
- **One document and one kind of name.** The default canary is an unusual invented two-word name, the kind the device-only name-shape check tags without a model. A name made only of common words ("Grace Hunter") is not covered by that check and depends on the model's name pass; pass one with `--canary` to test that.
- **Only the document holds the canary.** Whatever Muse's user types into the request reaches Meta before the device sees it, and this check cannot change that.
- **A pass is about this name in this run.** It is not a measure over many documents, and it does not cover identifiers, summaries that point at someone in other words, or the other limits in [THREAT_MODEL.md](THREAT_MODEL.md).
