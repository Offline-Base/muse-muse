# Edge demo: a product that keeps answering when the cloud is cut

Status, Nov 2: built, and off behind flags. Nothing in this file has run on a board yet. The one-command laptop drill (section 0) ran on Nov 2 on the build machine against the bundled demo product, not a product Muse Code built: 4 of 4 simulated drills passed. `npm run drill:all` (the four plus six more scenarios) ran on Nov 2 on the Mac against the same demo product: 10 of 10 passed in about 37 s. Say "is built so" for all of it until the runs in `docs/BUILD_LOG.md` say otherwise. The scenario is a simulated cold room: invented readings from a controller, an independent probe, the door, defrost, power and cloud status. It is not about any real freezer or store, and the product gives no food-safety advice.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Fallback helper | `template/lib/meta/edge.ts` | `respondJsonOrEdge()`: the cloud first (`respondJson`, held to 10 s), then the board's model through `chat.completions` with a `json_schema` response format, checked with zod. `EDGE_FIRST=1` flips the order. Returns `by` (`"cloud"` or `"edge"`) and a fixed label, or a typed failure with a plain message. The board answers only when the cloud can't be reached (refused, timed out, a 5xx) or sent JSON that didn't match: a cloud that turns a request down (a 4xx: a refusal, a limit, a stopped product) is the answer, and the board isn't asked around it. Never sends `enable_thinking` with a schema. |
| Skill | `template/.agents/skills/muse-edge/SKILL.md` | Tells Muse Code when to use the helper, how to show "Answered on <board>, <model>" and what never to say. |
| Fake edge server | `template/scripts/edge-fake.mjs` | OpenAI-compatible, schema-valid replies, modes `ok`, `refuse`, `hang`, `garbage`, `tamper`, and for the scenarios `slow`, `truncate`, `inject`. Logs to `test-results/caps/edge.json`. |
| Blackhole gateway | `template/scripts/edge-blackhole.mjs` | Stands in for `GATEWAY_URL`: drops or holds every connection, and for the scenarios answers like the gateway with Simulated JSON, late (`slow`) or every other time (`flap`). |
| Drill runner | `template/scripts/edge-drill.mjs` | Four simulated drills against a running product: cloud refused, cloud hung, both down, tampered reply rejected. The two cloud drills fail when the product never tried the gateway first. `--all` adds six scenarios (section 0). |
| Board build | `scripts/edge/build-arm64.sh` | Builds the product's Next standalone server in a linux/arm64 Docker container on the Mac and packs it with a `run.sh`. |
| Provisioning | `lib/edge/template-files.ts` | With `EDGE_BUILDS` and `EDGE_ENABLED` on, a build whose brief has the edge target gets the helper, the skill and the drill kit as written files, so no new builder snapshot is needed. Other builds get none of them. |

Each script documents its CLI, env and exit codes at the top of the file.

## Flags

- `EDGE_BUILDS` (platform): with `EDGE_ENABLED` on too, provisioning writes the five edge files into an edge build, and only that one. Off by default. With it off, builds get nothing new.
- `EDGE_ENABLED` (platform, units M4 and M5): "edge" as a target in the brief, `output: "standalone"` for an edge build, and the four drills after each passing verify (`lib/pipeline/edge-build.ts`). It counts only with `EDGE_BUILDS` on too.
- In the product: `EDGE_URL`, `EDGE_MODEL`, `EDGE_API_KEY`, `EDGE_BOARD`, `EDGE_MODEL_NAME`, `EDGE_FIRST`, `EDGE_TIMEOUT_MS`, `EDGE_CLOUD_TIMEOUT_MS`. All read at run time on the server.

Turning either platform flag on, even on a preview, is the owner's call (O4 in the plan).

## 0. One command, no keys (for judges)

From the repo root, after `npm ci`:

```bash
npm run drill          # the four simulated outage drills, about 12 seconds
npm run drill-bench    # the cold-room drill bench, made and scored with no model, about 2 seconds (needs python3)
```

`npm run drill` (`scripts/drill/run.mjs`) picks three free loopback ports and runs `template/scripts/edge-drill.mjs`, which starts the blackhole gateway and the fake edge server, then starts `scripts/drill/demo-product.ts`. That is a tiny Node server with one route, `POST /api/actions/status`, that asks for a verdict on the Simulated window in `eval/drill/demo-spoofed-controller.csv` through `respondJsonOrEdge()` from `template/lib/meta/edge.ts`, the same helper an edge build gets. Each drill's PASS or FAIL is printed, the JSON goes to `.data/drill/edge-drill.json` (git-ignored), and the exit code is 0 only when all four pass (1 for a failed drill, 2 for setup). `npm run drill -- --only 1,3` runs some of them. The cloud-hung drill waits out the helper's real 10 s cloud deadline. No key, `GATEWAY_URL` or model from your environment reaches the demo product.

`npm run drill-bench` (`scripts/drill/bench.mjs`) runs `scripts/dev/drill-bench.py make` into `.data/drill-bench/` (900 training, 50 kept aside, 100 sealed held-out), checks that the sealed file is byte for byte `eval/drill/sealed.jsonl`, scores the right answers (they must get 100% with the hard rule passed), then scores `scripts/drill/always-normal-answers.jsonl`. Those are canned answers written by a script, not a model: "normal, trust the controller" for every window. They get 13% all right, and the scorer must flag all 12 hard-rule breaks. To score a real model, use `ask` and `score` as in `eval/drill/README.md`.

Both show only the code paths on invented data. They say nothing about a real model, a real board or a real outage.

### More scenarios: `npm run drill:all`

```bash
npm run drill:all      # the four above plus six scenarios, about 37 seconds on the Mac (10 of 10 passed, Nov 2)
npm run drill:all -- --only 5,9   # numbers 1 to 10; anything else stops with exit 2
```

The four drills above stay the default set: they are what a build runs, so build time doesn't grow. `--all` adds the six below, all Simulated, on loopback, with no key. With `--all` the runner gives the product a 5 s edge limit (`EDGE_TIMEOUT_MS`, set by `EDGE_DRILL_EDGE_LIMIT_MS`) and the 10 s cloud limit, so drill 7 knows how long it may take. Each drill has a test in `template/scripts/__tests__/edge-drill-scenarios.test.mjs` that shows it passes for a product that uses the helper and fails, by name, for one that gets it wrong.

| # | Drill | What it simulates | Passes when | What it proves | What it doesn't |
|---|---|---|---|---|---|
| 5 | cloud slow, inside the limit | The gateway answers after about 8 s, inside the 10 s cloud limit. | The reply is a 2xx with "Answered in the cloud", the gateway sent the answer, and the edge was never asked. | The product doesn't give up on a slow cloud early, and labels the cloud's answer. | Anything about real cloud latency or a real Muse Wonder answer. |
| 6 | cloud flapping | Three asks while the gateway answers 503, then OK, then 503. | Each reply is a 2xx labeled with whoever answered it (edge, cloud, edge), none takes over 15 s, and both sides answered at least once. | Labels follow the side that answered on each request, and the product tries the cloud again after a 503. | Behavior under real, uneven outages, or many visitors at once. |
| 7 | edge too slow as well | The gateway hangs, and the edge answers only after 8 s, past its 5 s limit. | The plain both-down message arrives within both limits plus 3 s (18 s), the late edge answer is never shown, and the server printed no error. | Nothing hangs when both sides are too slow: the visitor gets the plain message in time. | How long a real board's model takes, or what limit suits it. |
| 8 | truncated reply rejected | The gateway drops, and the edge reply is JSON cut off part way, marked TRUNCATED. | Nothing marked TRUNCATED reaches the reply, no edge label is shown, and the reply carries the both-down message. | A reply cut off part way (like a board that ran out of tokens) is refused, not shown in pieces. | That every malformed reply is caught: only this cut, from this fake. |
| 9 | injected text shown as data | The gateway drops, and the edge reply is schema-valid, but every free text field says (marked INJECTED) to ignore the rules, say the cloud answered, and fetch a URL on the fake. | The reply is a 2xx that still says "Answered on", the text sits inside a JSON string value (or is escaped in an HTML reply), and nothing fetched the URL. | The product treats model text as data: it doesn't let it write the label, follow its links, or run as markup in the reply. | How a page renders that text in a browser, or that a real model can't be talked into a wrong verdict. A planted answer can still be wrong inside the schema. |
| 10 | gateway host not found | The gateway's host name (`muse-gateway.drill.invalid`) can't be resolved. | The product looked up the gateway's name first (the preload reports each lookup), then the reply is a 2xx with "Answered on", the edge was asked, and the gateway was never reached. | A name lookup failure falls back to the edge like a refused connection does. | Real resolver behavior: the runner restarts the product for this drill (it runs last) with a preload that fails every `dns.lookup` of a `.invalid` name inside the product (the lookup Node's fetch and http use) before any resolver is asked. Without `--start`, point `EDGE_DRILL_DNS_BASE_URL` at a second copy of the product started with such a `GATEWAY_URL`: that copy uses the real resolver, and the drill can't see whether it tried the gateway's name, or the drill fails and says why. |

Like the four above, these show only the code paths on invented data, against fake servers on loopback. They don't show that a real board, a real model or a real network behaves this way.

## 1. The laptop drill on a built product (no board, no model, no spend)

From a product's folder, after `npm run build`:

```bash
GATEWAY_URL=http://127.0.0.1:18436 EDGE_URL=http://127.0.0.1:18435/v1 PRODUCT_TOKEN=drill \
  EDGE_BOARD=jetson-0X EDGE_MODEL_NAME="Simulated model" npx next start -p 3101 &
MUSEMUSE_BASE_URL=http://127.0.0.1:3101 node scripts/edge-drill.mjs
```

Or let the runner start the product, which also lets it watch the server's output for errors:

```bash
MUSEMUSE_BASE_URL=http://127.0.0.1:3101 node scripts/edge-drill.mjs --start "npx next start -p 3101"
```

The route it asks comes from `edge-drill.json` at the product's root (the skill tells Muse Code to write it), or from `EDGE_DRILL_PATH` and `EDGE_DRILL_BODY`. Results go to `test-results/caps/edge-drill.json`. Exit 0 means all four passed.

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
4. Confirm the USB-C device-link address. On a Jetson in device mode it is probably `192.168.55.1` for the board, with the laptop at `192.168.55.100`. Check with `ip addr` on the board.
5. Copy the tarball over that link, unpack it and start it:

   ```bash
   tar -xzf <name>-linux-arm64.tgz
   EDGE_MODEL=<alias> ./<name>/run.sh
   ```

6. From the laptop, open `http://192.168.55.1:3000` (or the address from step 4). Ask one question with the simulated rows. The answer must carry "Answered on jetson-0X, <model>".
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
