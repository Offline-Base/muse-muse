# Edge demo: a product that keeps answering when the cloud is cut

Status, Nov 2: built, and off behind flags. Nothing in this file has run on a board yet. Nov 2, late (branch tg-edge-vision): a product can also look at photos with Meta SAM 3.1, in the cloud first and on the board second (`segmentOrEdge`), with four photo drills; section 6 is the run kit for jetson-04. None of that has run on a board or in a real build yet either. The one-command laptop drill (section 0) ran on Nov 2 on the build machine against the bundled demo product, not a product Muse Code built: 4 of 4 simulated drills passed. `npm run drill:all` (the four plus six more scenarios) ran on Nov 2 on the Mac against the same demo product: 10 of 10 passed in about 37 s. Say "is built so" for all of it until the runs in `docs/BUILD_LOG.md` say otherwise. The scenario is a simulated cold room: invented readings from a controller, an independent probe, the door, defrost, power and cloud status. It is not about any real freezer or store, and the product gives no food-safety advice.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Fallback helper | `template/lib/meta/edge.ts` | `respondJsonOrEdge()`: the cloud first (`respondJson`, held to 10 s), then the board's model through `chat.completions` with a `json_schema` response format, checked with zod. `EDGE_FIRST=1` flips the order. Returns `by` (`"cloud"` or `"edge"`) and a fixed label, or a typed failure with a plain message. The board answers only when the cloud can't be reached (refused, timed out, a 5xx) or sent JSON that didn't match: a cloud that turns a request down (a 4xx: a refusal, a limit, a stopped product) is the answer, and the board isn't asked around it. Never sends `enable_thinking` with a schema. |
| SAM board helper | `template/lib/meta/edge.ts` | `segmentOrEdge()`: Meta SAM 3.1 in the cloud first (`sam-3.1` through the gateway, held to 10 s when a board waits behind it), then the board's `sam3` service at `EDGE_SAM_URL` (`POST /segment`, `scripts/edge/sam3/server.py`). The board's reply is checked with zod and has to add up (its count is its number of boxes, every box is inside the photo, it answered the prompt sent, no score under the threshold). Returns `by` (`"cloud"` or `"board"`), a fixed label ("Seen on <board> by Meta SAM 3.1"), the count and boxes as fractions of the photo, or the plain "Can't see right now" message. Any error, timeout, non-JSON or reply that doesn't add up is the board being down: no count is made up. |
| Skill | `template/.agents/skills/muse-edge/SKILL.md` | Tells Muse Code when to use each helper, how to show "Answered on <board>, <model>" and "Seen on <board> by Meta SAM 3.1", and what never to say. |
| Fake edge server | `template/scripts/edge-fake.mjs` | OpenAI-compatible, schema-valid replies, modes `ok`, `refuse`, `hang`, `garbage`, `tamper`, and for the scenarios `slow`, `truncate`, `inject`. Its `POST /segment` stands in for the board's SAM service, in the same modes, with two Simulated boxes sized to the photo. Logs to `test-results/caps/edge.json` (never the photo). |
| Blackhole gateway | `template/scripts/edge-blackhole.mjs` | Stands in for `GATEWAY_URL`: drops or holds every connection, and for the scenarios answers like the gateway with Simulated JSON, late (`slow`) or every other time (`flap`), or with the gateway's 404 `model_not_found` (`notfound`). |
| Drill runner | `template/scripts/edge-drill.mjs` | Four simulated drills against a running product: cloud refused, cloud hung, both down, tampered reply rejected. The two cloud drills fail when the product never tried the gateway first. For a product whose `edge-drill.json` names a `sam` route, four photo drills too (12 to 15: the same four, on the look). `--all` adds seven text scenarios and one photo scenario (section 0). |
| Board build | `scripts/edge/build-arm64.sh` | Builds the product's Next standalone server in a linux/arm64 Docker container on the Mac and packs it with a `run.sh`. |
| Provisioning | `lib/edge/template-files.ts` | With `EDGE_BUILDS` and `EDGE_ENABLED` on, a build whose brief has the edge target gets the helper, the skill and the drill kit as written files, so no new builder snapshot is needed. Other builds get none of them. |

Each script documents its CLI, env and exit codes at the top of the file.

## Flags

- `EDGE_BUILDS` (platform): with `EDGE_ENABLED` on too, provisioning writes the five edge files into an edge build, and only that one. Off by default. With it off, builds get nothing new.
- `EDGE_ENABLED` (platform, units M4 and M5): "edge" as a target in the brief, `output: "standalone"` for an edge build, and the four drills after each passing verify (`lib/pipeline/edge-build.ts`). It counts only with `EDGE_BUILDS` on too.
- In the product: `EDGE_URL`, `EDGE_MODEL`, `EDGE_API_KEY`, `EDGE_BOARD`, `EDGE_MODEL_NAME`, `EDGE_FIRST`, `EDGE_TIMEOUT_MS`, `EDGE_CLOUD_TIMEOUT_MS`, and for SAM `EDGE_SAM_URL`, `EDGE_SAM_BOARD`, `EDGE_SAM_MODEL_NAME`, `EDGE_SAM_TIMEOUT_MS`, `EDGE_SAM_API_KEY`. All read at run time on the server.
- With both platform flags on, an edge brief's product token also gets Muse Wonder (`edgeAllowedModels` in `lib/edge/models.ts`), the cloud model `respondJsonOrEdge` asks first. Before this, an edge brief whose only model was `sam-3.1` got 404 `model_not_found` there, and the helper took that as the cloud saying no. The helper now treats a 404 `model_not_found` as a setup error and asks the board (drill 11).

Turning either platform flag on, even on a preview, is the owner's call (O4 in the plan).

## 0. One command, no keys (for judges)

From the repo root, after `npm ci`:

```bash
npm run drill          # the eight simulated outage drills (four on the text answer, four on the photo look), about 23 seconds
npm run drill-bench    # the cold-room drill bench, made and scored with no model, about 2 seconds (needs python3)
```

`npm run drill` (`scripts/drill/run.mjs`) picks three free loopback ports and runs `template/scripts/edge-drill.mjs`, which starts the blackhole gateway and the fake edge server, then starts `scripts/drill/demo-product.ts`. That is a tiny Node server with two routes. `POST /api/actions/status` asks for a verdict on the Simulated window in `eval/drill/demo-spoofed-controller.csv` through `respondJsonOrEdge()` from `template/lib/meta/edge.ts`, the same helper an edge build gets. `POST /api/actions/look` looks for "open door" in a 4 x 3 Simulated photo through `segmentOrEdge()` from the same file, with the fake edge server standing in for the board's SAM service. Each drill's PASS or FAIL is printed, the JSON goes to `.data/drill/edge-drill.json` (git-ignored), and the exit code is 0 only when all eight pass (1 for a failed drill, 2 for setup). `npm run drill -- --only 1,12` runs some of them. The two cloud-hung drills each wait out the helper's real 10 s cloud deadline. 8 of 8 passed on the Mac on Nov 2, late. No key, `GATEWAY_URL` or model from your environment reaches the demo product.

`npm run drill-bench` (`scripts/drill/bench.mjs`) runs `scripts/dev/drill-bench.py make` into `.data/drill-bench/` (900 training, 50 kept aside, 100 sealed held-out), checks that the sealed file is byte for byte `eval/drill/sealed.jsonl`, scores the right answers (they must get 100% with the hard rule passed), then scores `scripts/drill/always-normal-answers.jsonl`. Those are canned answers written by a script, not a model: "normal, trust the controller" for every window. They get 13% all right, and the scorer must flag all 12 hard-rule breaks. To score a real model, use `ask` and `score` as in `eval/drill/README.md`.

Both show only the code paths on invented data. They say nothing about a real model, a real board or a real outage.

### More scenarios: `npm run drill:all`

```bash
npm run drill:all      # the eight above plus eight scenarios (16 of 16 passed on the Mac, Nov 2, late)
npm run drill:all -- --only 5,9   # numbers 1 to 16; anything else stops with exit 2
```

The four drills above stay the default set for the text answer, and 12 to 15 for a product with a photo route: they are what a build runs. `--all` adds the rows below, all Simulated, on loopback, with no key. With `--all` the runner gives the product a 5 s edge limit (`EDGE_TIMEOUT_MS`, set by `EDGE_DRILL_EDGE_LIMIT_MS`) and the 10 s cloud limit, so drill 7 knows how long it may take. Each drill has a test in `template/scripts/__tests__/edge-drill-scenarios.test.mjs` that shows it passes for a product that uses the helper and fails, by name, for one that gets it wrong.

| # | Drill | What it simulates | Passes when | What it proves | What it doesn't |
|---|---|---|---|---|---|
| 5 | cloud slow, inside the limit | The gateway answers after about 8 s, inside the 10 s cloud limit. | The reply is a 2xx with "Answered in the cloud", the gateway sent the answer, and the edge was never asked. | The product doesn't give up on a slow cloud early, and labels the cloud's answer. | Anything about real cloud latency or a real Muse Wonder answer. |
| 6 | cloud flapping | Three asks while the gateway answers 503, then OK, then 503. | Each reply is a 2xx labeled with whoever answered it (edge, cloud, edge), none takes over 15 s, and both sides answered at least once. | Labels follow the side that answered on each request, and the product tries the cloud again after a 503. | Behavior under real, uneven outages, or many visitors at once. |
| 7 | edge too slow as well | The gateway hangs, and the edge answers only after 8 s, past its 5 s limit. | The plain both-down message arrives within both limits plus 3 s (18 s), the late edge answer is never shown, and the server printed no error. | Nothing hangs when both sides are too slow: the visitor gets the plain message in time. | How long a real board's model takes, or what limit suits it. |
| 8 | truncated reply rejected | The gateway drops, and the edge reply is JSON cut off part way, marked TRUNCATED. | Nothing marked TRUNCATED reaches the reply, no edge label is shown, and the reply carries the both-down message. | A reply cut off part way (like a board that ran out of tokens) is refused, not shown in pieces. | That every malformed reply is caught: only this cut, from this fake. |
| 9 | injected text shown as data | The gateway drops, and the edge reply is schema-valid, but every free text field says (marked INJECTED) to ignore the rules, say the cloud answered, and fetch a URL on the fake. | The reply is a 2xx that still says "Answered on", the text sits inside a JSON string value (or is escaped in an HTML reply), and nothing fetched the URL. | The product treats model text as data: it doesn't let it write the label, follow its links, or run as markup in the reply. | How a page renders that text in a browser, or that a real model can't be talked into a wrong verdict. A planted answer can still be wrong inside the schema. |
| 11 | cloud model not found | The gateway answers 404 `model_not_found`, as it does for a model the product's token doesn't list. | The reply is a 2xx with "Answered on", the gateway was asked, and the edge answered. | A 404 `model_not_found` is a setup error, not the cloud saying no, so the board still answers (the bug found on Nov 2, 9 PM). | That a real product's token lists the right models: `edgeAllowedModels` covers that, with unit tests. |
| 16 | SAM, cut-off board reply rejected | The gateway drops, and the fake board's SAM JSON is cut off part way, marked TRUNCATED. | Nothing marked TRUNCATED reaches the reply, no "Seen" label is shown, and the reply says "Can't see right now". | A look cut off part way is refused, not shown in pieces. | That every malformed board reply is caught: the unit tests in `template/scripts/__tests__/edge-sam.test.mjs` cover more shapes. |
| 10 | gateway host not found | The gateway's host name (`muse-gateway.drill.invalid`) can't be resolved. | The product looked up the gateway's name first (the preload reports each lookup), then the reply is a 2xx with "Answered on", the edge was asked, and the gateway was never reached. | A name lookup failure falls back to the edge like a refused connection does. | Real resolver behavior: the runner restarts the product for this drill (it runs last) with a preload that fails every `dns.lookup` of a `.invalid` name inside the product (the lookup Node's fetch and http use) before any resolver is asked. Without `--start`, point `EDGE_DRILL_DNS_BASE_URL` at a second copy of the product started with such a `GATEWAY_URL`: that copy uses the real resolver, and the drill can't see whether it tried the gateway's name, or the drill fails and says why. |

Like the four above, these show only the code paths on invented data, against fake servers on loopback. They don't show that a real board, a real model or a real network behaves this way.

### The photo drills (12 to 15)

For a product whose `edge-drill.json` has `"sam": { "path": "/api/actions/look", "body": { "photo": "SIMULATED_PHOTO", "prompt": "open door" } }` (the drill puts a 4 x 3 Simulated PNG where `SIMULATED_PHOTO` is). They run with the default set, in builds too, and each is a step in the build's checks. Tests: `template/scripts/__tests__/edge-sam-drill.test.mjs`.

| # | Drill | What it simulates | Passes when |
|---|---|---|---|
| 12 | SAM, cloud refused | The gateway drops every connection; the fake board's SAM service answers. | A 2xx with "Seen on", the gateway was tried, the board was asked. |
| 13 | SAM, cloud hung | The gateway never answers; the fake board does. | The same, within 15 s (the 10 s cloud deadline, then the board). |
| 14 | SAM, both down | The gateway and the fake board both drop. | The reply says "Can't see right now", has no "Seen" label, and the server printed no error. |
| 15 | SAM, tampered board reply rejected | The fake board sends the wrong types, marked TAMPERED. | Nothing marked TAMPERED reaches the reply, no "Seen" label, and it says "Can't see right now". |

They prove the product's look falls back, labels who looked, says plainly when nobody could, and refuses a board reply with the wrong types, on fakes. Nothing about what Meta SAM 3.1 finds in a real photo.

## 1. The laptop drill on a built product (no board, no model, no spend)

From a product's folder, after `npm run build`:

```bash
GATEWAY_URL=http://127.0.0.1:18436 EDGE_URL=http://127.0.0.1:18435/v1 EDGE_SAM_URL=http://127.0.0.1:18435 PRODUCT_TOKEN=drill \
  EDGE_BOARD=jetson-0X EDGE_MODEL_NAME="Simulated model" EDGE_SAM_MODEL_NAME="Simulated SAM" npx next start -p 3101 &
MUSEMUSE_BASE_URL=http://127.0.0.1:3101 node scripts/edge-drill.mjs
```

Or let the runner start the product, which also lets it watch the server's output for errors:

```bash
MUSEMUSE_BASE_URL=http://127.0.0.1:3101 node scripts/edge-drill.mjs --start "npx next start -p 3101"
```

The route it asks comes from `edge-drill.json` at the product's root (the skill tells Muse Code to write it), or from `EDGE_DRILL_PATH` and `EDGE_DRILL_BODY`. Results go to `test-results/caps/edge-drill.json`. Exit 0 means every drill passed: the four, plus the four photo drills when `edge-drill.json` names a `sam` route.

What a pass shows, and only this: with the gateway cut on loopback, the product answered from a fake edge server, said so in its label, showed a plain message when both were down, and refused a reply with the wrong types. It shows nothing about a real model or a real board.

## 2. The board kit (on the Mac)

1. Download the product's source from `/p/<slug>/code/source.zip` and unzip it.
2. Build for arm64:

   ```bash
   EDGE_BOARD=jetson-0X EDGE_MODEL=<served alias> EDGE_MODEL_NAME="Llama 3.2 3B" \
     scripts/edge/build-arm64.sh ~/Downloads/<product> ./edge-out
   ```

   Defaults: `EDGE_URL=http://127.0.0.1:11435/v1` (the board's llama-server), `EDGE_FIRST=1`, no `GATEWAY_URL`. With no `GATEWAY_URL` the product never tries the cloud. If you set one, `PRODUCT_TOKEN` is never written into the kit; set it on the board by hand.
3. You get `edge-out/<name>-linux-arm64.tgz` with `server.js`, the static files and `run.sh`. It holds no `.env` file and no key.

The script needs Docker Desktop and the internet once, for `npm ci`. Its syntax is checked (`bash -n`); the Docker build itself hasn't run yet.

## 3. What Hussam does on the board (H3)

Hussam owns the boards. These are steps for him to run or change as he sees fit; nobody else touches a board, and nothing here uses SSH from Ethan's laptop.

1. Pick the drill board: jetson-04, or jetson-03 with Bolt unloaded. Never jetson-02 or jetson-05.
2. While the board still has its network, install Node 20 for linux arm64 (the official nodejs.org `linux-arm64` tarball, or NodeSource). Check with `node -v`.
3. Confirm the model server: `curl -s http://127.0.0.1:11435/v1/models` on the board lists the model alias (from H1). Note the alias for `EDGE_MODEL`.
4. Confirm the board's USB-C device-link address, and the laptop's on the same link, with `ip addr` on the board. Keep both out of this file and the frame.
5. Copy the tarball over that link, unpack it and start it:

   ```bash
   tar -xzf <name>-linux-arm64.tgz
   EDGE_MODEL=<alias> ./<name>/run.sh
   ```

6. From the laptop, open port 3000 at the board's address from step 4. Ask one question with the simulated rows. The answer must carry "Answered on jetson-0X, <model>".
7. With both the product and the model running, check memory with `free -m` and `tegrastats`. If free memory drops under about 500 MB, or the board stops answering, stop and say so. If it freezes the board once, stop.
8. Report: the board, the model alias, the first answer's time, free memory with both running, and anything that failed.

Then for the take (H5): board Ethernet and Wi-Fi out, laptop Wi-Fi off, the USB-C link only. No addresses, ngrok domain or console in frame. No power cuts: power loss stays a case in the simulated data only.

## 4. Lines and labels

- Label every demo screen "Simulated cold room". The lower third is "Simulated cold room. Real board, real unplug." only after the take really happened.
- After the laptop drill: "simulated outage drills pass on the build machine". "Every edge build runs a simulated outage drill" only after a real edge build (M7) has run the drill in its sandbox and `docs/BUILD_LOG.md` says so. Until then it is "is built so".
- After the take: "this app kept answering on one Jetson with its network unplugged, N of 5 drills, X tokens a second". Use the real numbers.
- Never: "works offline" in general, "private" or "on-device" for board answers, "attack-proof", that anything stops hacks, that anything survives a power loss, food-safety advice, or anything about real freezers. See `docs/MESSAGING.md`, Don't say.

## 5. Not built yet

- The drill inside every edge build (M5) and the edge target (M4) are built and unit tested with the sandbox faked, but have not run in a real sandbox. `build-arm64.sh` still adds `output: "standalone"` to its build copy for products built before the target.
- The self-host kit's `"offline"` mode, after Nov 4.
- A browser console check in the drill: the runner checks the server's output only.
- A forwarder so a hosted product can reach a board's SAM (the hosted product has no `EDGE_SAM_URL`, so there it looks with cloud SAM 3.1 only).
- A real edge build that uses `segmentOrEdge`, and any run of it on a board.

## 6. SAM 3.1 on jetson-04: the photo take (Hussam, Tuesday)

The hero shot: a cold-room watcher Muse Muse built runs on jetson-04 with the board's uplink pulled, and Meta SAM 3.1 on the same board spots a door left open. Nothing in this section has run yet. Hussam owns the board: these are steps for him to run or change as he sees fit. Nobody else touches it, nothing uses SSH from Ethan's laptop, and jetson-05 is never part of it. No board addresses, the ngrok domain or tokens go in this file, a commit or the frame.

### What runs where

- **jetson-04:** `sam3.service` (Meta SAM 3.1, already there) and the product's Next standalone server. The product reaches SAM on loopback (`EDGE_SAM_URL=http://127.0.0.1:8790`). There is no `GATEWAY_URL` and no `PRODUCT_TOKEN` on the board, so the product never tries the cloud: `segmentOrEdge` goes straight to the board and labels the look "Seen on <board> by Meta SAM 3.1". No key of any kind goes on the board.
- **The laptop:** a browser only. Its camera or photo picker sends one frame (a 1024 px JPEG at most) to the product on the board over the local link (the USB-C device link, or a cable straight to the board). The board needs no camera.
- **Text answers:** jetson-04 serves no text model (`jetson-llama` is off there, and a model wouldn't fit beside SAM), so a `respondJsonOrEdge` answer shows "Neither the cloud model nor the backup model answered" on the board. For the take, the product's main answer should be the look itself: "Door open" when SAM finds an open door, worked out in code from the count (the muse-edge skill says so). Check the build does that before filming.

### Before Tuesday (the owner, not Hussam)

1. Merge branch `tg-edge-vision`, or deploy a preview from it. The template change reaches builds through the edge extra files, so no new builder snapshot is needed.
2. One real edge build on the preview, flags on (O4, inside its $5), on `muse-spark-1.3-contributor` with invented data. Ask for the watcher so the look is the main answer, for example: "A Simulated cold-room door watcher: from a photo, Meta SAM 3.1 finds an open door, and the page says Door open or Door shut. Keep it working on an edge board when the cloud is cut." The build should write `segmentOrEdge` and an `edge-drill.json` with `sam`, and its checks should list drills 12 to 15. If it doesn't, fix the skill once, then rebuild.
3. Run the laptop drill on it (section 1): with its `sam` route it runs the photo drills too.
4. Download `/p/<slug>/code/source.zip`.

### On the Mac: the board kit

```bash
EDGE_SAM_URL=http://127.0.0.1:8790 EDGE_SAM_BOARD="<the label's board name>" \
  scripts/edge/build-arm64.sh ~/Downloads/<product> ./edge-out
```

It needs Docker Desktop and the internet once, and about 2 GB of disk for the image and `npm ci` (the laptop had about 6 GB free on Nov 2). Building on the board instead needs `sam3.service` stopped first: `next build` wants 1.5 GB or more, and the board has about 1.1 GB free with SAM loaded. `EDGE_SAM_BOARD` is what the label says. docs/MESSAGING.md keeps jetson-03, 04 and 05 out of frame, so ask the owner whether the label may name the board or should say something like "the office board".

### On jetson-04 (Hussam)

1. **Memory first.** `free -m`. With SAM loaded the board was at 6.4 of 7.5 GB. The product's server needs about 150 MB. If `available` is under about 500 MB, stop and say so. `sam3.service` has `MemoryMax=6G` and is the first thing killed when memory runs out, so a product that pushes the board over kills SAM, not itself.
2. **SAM on loopback.** `sam3.service` listens only on the board's office address today. With the uplink pulled that address can go away, so before the take it must also listen on loopback. Hussam's call how: its `--host` set to `0.0.0.0` (the office page keeps working, and loopback is added) or to `127.0.0.1` (then `ask.py` and `ui.py` in `scripts/edge/sam3/` need the same change, or the office page stops). Restarting it takes 45 to 54 s to load and 7 to 14 s for the first look. Check: `curl -s http://127.0.0.1:8790/health` says `"ok": true`. The exact rebind, a cable-out test of SAM alone and its go or no-go check are in `scripts/edge/sam3/LOCAL.md`.
3. **Node.** While the board still has its network: `node -v` must be 20 or newer (section 3, step 2).
4. **Start the product**, with no `GATEWAY_URL`:

   ```bash
   tar -xzf <name>-linux-arm64.tgz
   EDGE_SAM_URL=http://127.0.0.1:8790 NODE_OPTIONS=--max-old-space-size=192 ./<name>/run.sh
   ```

   It listens on port 3000 on every address (`run.sh` sets `HOSTNAME=0.0.0.0`), so the laptop can reach it over the local link.
5. **Open it from the laptop.** Browsers open the camera only on https or `http://localhost`, so the board's address in the URL bar gets the photo picker but no camera. To use the laptop's camera, forward a laptop port to the board over the local link (TCP only, nothing leaves the link):

   ```bash
   BOARD=<the board's address on the local link> node -e 'const n=require("net");n.createServer(c=>{const s=n.connect(3000,process.env.BOARD);c.pipe(s).pipe(c);s.on("error",()=>c.destroy());c.on("error",()=>s.destroy())}).listen(3000,"127.0.0.1")'
   ```

   then open `http://localhost:3000`. (Or start Chrome with a throwaway profile and `--unsafely-treat-insecure-origin-as-secure=http://<address>:3000`.)
6. **Warm up with the network still in.** One look at the real door, open and then shut. The label must read "Seen on <board> by Meta SAM 3.1". Note the count and the time. Whether SAM 3.1 tells an open door from a shut one is untested: try "open door", "door" and "doorway" on the real room first. If none separates them, say so before filming; the take then shows SAM finding the door, not judging it.
7. **Memory again** while it looks: `free -m` and `tegrastats`. Stop if `available` drops under about 300 MB or the board stalls.
8. **The take (H5):** board Ethernet and Wi-Fi out, laptop Wi-Fi off, the local link only. The laptop camera sends a frame, the product on the board asks SAM on loopback, and the answer comes back with its label. Two rehearsals, then one take. No addresses, ngrok domain, tokens or console in frame. No power cuts.
9. **Report:** free memory before and during, the first and warm look times, the prompts tried and what each found with the door open and shut, the label as shown, and anything that failed. It goes in docs/BUILD_LOG.md.

What may be said after it: only what the take showed, by docs/MESSAGING.md and docs/EDGE_PLAN.md ("When each claim may be said"). Until it is logged, "is built so".

## The door prompts (tested Nov 2, cloud, two made-up photos)

On a mini fridge, SAM 3.1 found "open door" only when the door was open (1 box at 0.89, none when shut), and "can" only when the items inside showed (3 boxes, none when shut). "door" and "shelf" matched both. So use a mini fridge with a few plain items inside (no brand labels in frame), ask "open door" for the answer and "can" or the item's name as the second sign, and warm up both on the real prop before the take. docs/BUILD_LOG.md has the table.
