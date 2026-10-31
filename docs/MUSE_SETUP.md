# Connecting Muse

How to give Muse the Muse Privacy connector, pair it with your device, schedule dreaming, and check that it works.

**Status (Oct 31): the reports in `eval/reports/muse_app/` are scene rehearsals with a script playing Muse, against the connector in process. No session in the real Muse app has a report there yet, so this page is not checked against one.** Step 3 follows Meta's Help Center (ask Muse in chat to create a custom connector), not a reported test. On Oct 27 the laptop connected to the deployed relay and a script playing Muse ran the whole path through it (discovery, client registration, the pairing page, the token, then tools/list and list_documents). The full path (OAuth discovery, client registration, the pairing page, the token, then MCP calls) passes against the relay running locally with a client playing Muse (`tests/test_relay_e2e.py`). Update this page when a session in the app has a report.

## 1. Deploy the relay (once)

Muse runs in the cloud and your device never listens on the network, so Muse reaches the device through a small Cloudflare Worker that the device dials out to. You need a Cloudflare account (the free plan is enough) and Node 22.

```sh
cd relay
npx wrangler login     # opens a browser once
./deploy.sh            # tests, deploys, and makes the pairing secret if it is missing
```

`deploy.sh` prints the relay's address, `https://muse-privacy-relay.<your-subdomain>.workers.dev`. Details and a troubleshooting table are in [relay/README.md](../relay/README.md).

## 2. Connect the device to the relay

On the laptop, from the repo root:

```sh
echo 'RELAY_URL=https://muse-privacy-relay.<your-subdomain>.workers.dev' >> .env
uv run python -m base.connector.relay_client register --name "Laptop"   # once; writes BASE_HOME/relay.json
scripts/start.sh                                                        # starts the models, the page and the relay client
```

Device-only needs llama-server (set `CHECKER_SERVER_BIN` if it is not on your PATH) and the model files listed in the README's [device-only setup](../README.md#laptop-device-only-the-default-setup).

The relay client reaches the relay through your system or environment proxy, as it always has. If a proxy on your network is what the relay refuses (Cloudflare answers with error 1010), and your network rules allow a direct connection, set `RELAY_PROXY=direct` in `.env` and restart the relay client: the socket and the pair and unlink calls then skip every proxy. The connection to the local connector on 127.0.0.1 never uses a proxy either way.

Then open `http://127.0.0.1:8787/setup`, say who you're protecting and finish the checklist, including turning off training under Data controls in Muse. To start everything at login, run `scripts/install_login.sh` once (`--remove` undoes it). Keep the laptop plugged in: on battery the local model runs about 12 times slower.

On a Jetson the same steps run as services; see "Jetson Orin Nano" in the [README](../README.md#jetson-orin-nano-8gb).

### Plugging in your own model

To use a tuned, quantized Muse Glimmer instead of LFM3-VL-2B for answers and routing (not done yet: no Glimmer has been measured on the device, and the tuned file at about 1.6-bit (IQ1_S) has not landed):

```sh
uv run python -m scripts.plug_in_model /path/to/model.gguf --check   # checks the file, changes nothing
uv run python -m scripts.plug_in_model /path/to/model.gguf --mode decide  # sets the model's lines in .env; --mode: answers, labels, tighten or decide
scripts/start.sh                                                     # restart: one copy of your model, plus LFM for scans and search
uv run python -m scripts.device_smoke --name my_model                # Muse's tools, 24 essays, private-value checks
uv run python -m scripts.compare_modes --name my_model               # each router mode on 200 invented items
```

`--mode` says how far the file's privacy work goes: answers (it writes, the policy decides on LFM's labels), labels (it also labels Muse's requests), tighten (it can only make the policy stricter) or decide (it decides, under the floors). A choice on the Dreaming page overrides it. `uv run python -m scripts.plug_in_model --undo` puts `.env` back. Nothing is downloaded, and your other `.env` lines stay as they are.

`--check` reads the file's header and writes `eval/reports/model_file_<label>.md` (`--label NAME`, default the file's name): the architecture, the quant type and the type of every tensor, the parameter count, the effective bits per weight (file bytes x 8 / parameters, and text only when the file holds vision tensors), the sha256, the KV cache at ANSWER_CTX, free disk and the memory it needs. It refuses a file llama.cpp cannot load, a cut-off copy, less than 2 GB of disk left, or a model that does not fit in memory, and says why. Run it from the repo the app runs from: plugging in writes that repo's `.env`.

To speed Glimmer up with Meta's DFlash drafter, add `--draft /path/to/drafter.gguf` (it must share the model's vocabulary; `--draft-n N` sets the tokens drafted per step, default 15). `--flash-attn on|off|auto` and `--reasoning-budget N` (-1 unrestricted, 0 none) are written to `.env` the same way, and `scripts/start.sh` passes all of them to Glimmer's llama-server only.

#### Measuring a model before you plug it in

`scripts/model_matrix.py` scores several router setups on the same invented items in one command, and pairs each one against today's "policy decides, LFM labels" (`policy_lfm`). A Glimmer file can be measured while the app keeps running: start a second llama-server for it on a free port on 127.0.0.1, then point the matrix there.

```sh
uv run python -m scripts.model_matrix --name my_model --preflight \
  --configs keywords,policy_lfm,lfm_tighten,glimmer_tighten,glimmer_decide \
  --sets eval/fresh_200_b.jsonl eval/tasks.jsonl \
  --glimmer-url http://127.0.0.1:8091/v1 --glimmer-gguf /path/to/model.gguf --glimmer-label my_model \
  --reasoning low
```

`--preflight` checks that the servers answer, that the side port serves that file (and that its sha256 matches `model_file_my_model.md` from `--check`), and scores 5 items per setup. It stops when more than 1 in 10 could not be scored or one item takes over 20 s at p95, and estimates how long the full run takes. The report is `eval/reports/matrix_my_model.md`; `--resume` picks a stopped run up from its raw rows. Every setup stays on this device; the `base_cloud_*` setups send invented items to OpenRouter and are refused unless you pass `--allow-cloud` and a `--max-usd` above 0. `ROUTER_REASONING` (low, medium, high, xhigh) and `ROUTER_MAX_TOKENS` (default 1500) set the router's call in the app the same way.

Before scoring a tuned model, check its training data against the eval sets: `uv run python -m scripts.check_overlap --train train.jsonl --name my_model` writes counts only to `eval/reports/overlap_my_model.md` and exits 1 on any overlap. It uses only the standard library, so it can also run where the model was trained.

## 3. Add the connector in the Muse app

Meta's Help Center says that to reach a service not in the connector list, you "can ask Muse to create a Custom Connector", and that "Meta doesn't review custom connectors". It shows no field for an MCP address, and Settings > Connectors lists the catalog connectors. Third-party guides disagree about whether the app has an "Add custom connector" option, so try the chat route first:

1. In a new Muse chat, send:

   ```
   Create a custom connector for a remote MCP server, then connect to it.
   Name: Muse Privacy
   Transport: remote streamable HTTP
   URL: https://muse-privacy-relay.<your-subdomain>.workers.dev/mcp
   Auth: OAuth (the server supports dynamic client registration)
   ```

2. If your app does show an add-custom-connector option under **Settings > Connectors**, use it instead with the same URL, and leave any client ID and client secret fields empty.
3. Muse registers itself with the relay (dynamic client registration) or names itself with a client metadata document; the relay accepts both. Muse's network guard may ask you once to allow the relay's address; allow it.
4. Muse opens the relay's **Link your device** page. It shows the app's name and where access will go.

If Muse says it can only build connectors with an API key or a header, or never opens the Link your device page, stop and tell Claude what it asked for: the relay accepts only OAuth today. Muse Code (step 5) is the documented fallback.

## 4. Pair

On the device, make a one-time code and type it on the Link your device page within 10 minutes:

```sh
uv run python -m base.connector.relay_client pair
```

The page sends you back to Muse, which should now list eight Muse Privacy tools:

| Tool | Muse class | What it does |
|---|---|---|
| list_documents | Read | Tagged titles of the documents in a folder |
| search_documents | Read | Up to 5 short tagged snippets. An optional purpose says who they are for. A check that needs more time or your OK returns a job id for get_result |
| ask_device | Read | The device's own model searches, reads and answers a question; returns the answer and up to 3 short quotes, as tags. Needs the local model (CHECKER_BACKEND=lfm) |
| run_private_task | Write | Starts a private job on the device, returns a job id. The instructions say who the result is for. A task that is not grading also saves its full answer with real names on the device, in `output/<job id>/result.md` under BASE_HOME |
| save_on_device | Write | Muse writes files with tags (for example a note home for each `[Student X]`); the device fills in the real names and, with `address_to` "guardians", writes one email draft (`.eml`, unsent) for each guardian on the contact sheet (`CONTACTS_PATH`, default `records/parent_contacts.md` in the workspace), under `output/<job id>/` in BASE_HOME with a `merge.csv`. Muse gets back counts only. A tag the device does not know, or a contact sheet in a folder the controls hide, saves nothing |
| get_result | Read | The status of a job or a search, then its tagged or summarized result. With wait_seconds (up to 40) it waits on the device until the job is done or you press Share it or Keep it here |
| run_dreaming | Write | Starts one night of dreaming on the device, at most once in 12 hours from Muse. Dream now on the approval page always starts one |
| dreaming_report | Read | Aggregate numbers from the last night only |

Rules for codes: each works once and expires after 10 minutes, a new code voids the old one, and there are at most 5 tries of one code and 20 tries from one network address in 10 minutes. To cut Muse off (a code shared by mistake, a lost session), run `uv run python -m base.connector.relay_client unlink` and pair again.

Muse's own permission settings apply on top: reads and writes are "Ask on first use" by default. For the scheduled jobs below to run at night without you, set **run_dreaming** and **dreaming_report** to always allowed. Leave run_private_task on ask.

## 5. If the Muse app will not take a custom connector: Muse Code

The fallback is Muse Code, Meta's coding agent. Its docs ([Extending Muse Code](https://dev.meta.ai/docs/muse-code/extending)) describe remote MCP servers that need an OAuth 2.1 sign-in, with dynamic client registration on by default, which is what the relay offers.

1. Declare the server in the `mcp_servers` block of Muse Code's settings file (a `streamable_http` server takes `url` and `headers`; every server also takes `enabled`):

   ```json
   {
     "mcp_servers": {
       "muse-privacy": {
         "transport": "streamable_http",
         "url": "https://muse-privacy-relay.<your-subdomain>.workers.dev/mcp",
         "enabled": true
       }
     }
   }
   ```

2. Run `muse mcp login muse-privacy`. It opens the same Link your device page in the browser. Pair as in step 4.
3. Run the test script below from Muse Code instead of the app. Send only the invented `demo/` folder through it: a coding-harness subscription defaults to Meta's Contributor terms, under which Meta may train on what is sent.

The longer route is the connector catalog ([platform.muse.ai/docs](https://platform.muse.ai/docs)): it asks for business verification of your organization, "OAuth client credentials or an API key" for Muse to connect with, and a three-stage review, after which the connector shows up under Settings > Connectors for everyone. The relay does not support pre-registered OAuth clients, and a review is unlikely to finish before Nov 4.

## 6. The two scheduled jobs

Muse's VM can run scheduled jobs. Paste each of these into Muse as its own message.

**Dreaming at 2 AM:**

```text
Set up a scheduled job: every night at 2:00 AM, call run_dreaming on the Muse Privacy connector once. Do not call any other Muse Privacy tool in this job and do not message me about it. If it says a run is already going, leave it alone and do not call it again that night.
```

**Morning message at 8 AM:**

```text
Set up a scheduled job: every morning at 8:00 AM, call dreaming_report on the Muse Privacy connector and send me one plain sentence with its numbers: how many of my decisions it learned from, router accuracy before and after (as percentages), whether the new rules were kept, how many leaks it found, and how many approval requests I had the day before and how many of those the rules in place now would still ask. Use only the numbers dreaming_report returns and add nothing else. If it says no dreaming run has finished yet, tell me that in one sentence instead.
```

A good morning message looks like: "Last night Muse Privacy learned from 12 of your decisions, router accuracy went from 75% to 80%, the new rules were kept, it found 0 leaks, and of yesterday's 9 approval requests the new rules would still ask 4."

dreaming_report sends numbers only: the night number, decisions learned from, accuracy and agreement before and after, whether the rules were kept, leaks, seconds, the approval requests in the day before the night (since the previous night finished, at most 24 hours) and how many of those the rules in place after the night would still ask. The last number replays each request through the rules in code, with no model call, so in the modes where the device model also judges (tighten, decide) it is an estimate. Never a request, a name, a tag or an example. If Muse's scheduled jobs misfire, start a night from the approval page instead: open `http://127.0.0.1:8787/dreaming` and press **Dream now**.

## 7. Test script for the demo

Run these in order in a fresh Muse chat with the demo folder (`demo/`, all invented). Keep the approval page open at `http://127.0.0.1:8787`. Model decisions vary a little from run to run; "should" below is what the current code and the simulated teacher's policy aim for.

Tags change every day, so an old tag stops working and a chat from an earlier day can hold tags the device refuses ("That tag no longer works on this device."). Where a row says `[tag]`, use a tag from the latest result that shows tags, such as the table in row 7. Keep to one day's tags in a request. If you have none from today, run row 1 first.

| # | Say to Muse | What should happen |
|---|---|---|
| 1 | "Using Muse Privacy, list the documents in my essays folder." | 24 essays, each titled with a tag like `[Student A]`. No real names. |
| 2 | "List the documents in my records folder." | Titles that name a never-share topic in the teacher's policy (with the demo policy: the IEP and 504 notes, lunch status and the parent contact sheet) are left out, with "3 documents held back on the device." The rest come back with tags. |
| 3 | "Search my private documents for essays that mention tomatoes." | Up to 5 short snippets, names as tags. |
| 4 | "Find a student quote about the school garden for the family newsletter." | Muse calls search_documents with a purpose like "for the family newsletter". The device reads that the snippets are meant for families, so a card on the approval page asks first and shows the request with its purpose. Muse gets "Waiting for your OK on the device." and a job id. Press **Share it**, then say "Check that search again." and Muse calls get_result with the job id to get the tagged snippets. |
| 5 | "Grade each essay in my essays folder against rubric.md and write feedback for each student." | Muse calls run_private_task and gets a job id. The light turns green while the device model grades on the device. Feedback files with real names appear under `~/.base/output/<job id>/`. |
| 6 | "Is the grading done?" | get_result answers "Waiting for your OK on the device." The light turns amber and a card appears on the approval page with the exact tagged table. Press **Share it** (tick "remember" if you want dreaming to learn it). |
| 7 | "Check again." | The tagged per-student scores and next steps reach Muse; the light flashes blue. Muse can now summarize the class by tag. |
| 8 | "Which students got the lowest totals? Use the tags." | Muse answers from the tagged table it already has, with tags only. |
| 9 | "What is [tag]'s real name?" Use a tag from the latest result that shows tags, such as the table in row 7. | Muse cannot know: no tool returns real names. |
| 10 | "Get the parent phone numbers for [tag] from my records." Use a tag from the latest result that shows tags, such as the table in row 7. | Kept on the device, or a card on the approval page; never a phone number in Muse. |
| 11 | "Which students have an IEP? Give me their full names." | "Kept on your device." with one fixed sentence about why. |
| 12 | "Show me [tag]'s whole essay word for word." Use a tag from the latest result that shows tags, such as the table in row 7. | A card on the approval page asks first. |
| 13 | "Start a dreaming run on Muse Privacy." | run_dreaming returns a job id; the approval page's Dreaming tab shows it running. |
| 14 | "How did the dreaming run go?" | dreaming_report: numbers only. |

After the run, the approval page's History tab shows every decision, and each one can be deleted so the next night forgets it.

## 8. The six scenes

The demo scenes, in this order, in one Muse chat over the invented demo folders. Keep the approval page open. CUI comes last because a privacy toggle applies to every folder; turn it off on the Controls page afterwards.

| Scene | Say to Muse | What should happen |
|---|---|---|
| A, grading | "Using Muse Privacy, grade each essay in my essays folder against rubric.md and write feedback for each student. I will use the feedback at family conferences." Then "Pull the evidence passages for the three lowest scorers, plan a small group, and save the plan on the device." | run_private_task returns a job id; get_result waits on the device and answers waiting, because the feedback is for families. Tap **Share it** while Muse waits and the tagged table arrives in the same turn. Muse searches with the lowest scorers' tags and saves the plan with save_on_device; the file with real names is under `output/<job id>/`. |
| B, mail merge | "Write a short note home to each student's family about their garden essay, one per student, starting Dear {guardian}, and save them on my device addressed to the guardians." | Muse lists the essays for the tags, then calls save_on_device with 24 items and `address_to` "guardians". The device writes 27 email drafts (3 students have two guardians on the invented contact sheet) and Muse gets back only "Made letters home from 24 notes in your own files...", with no count of letters or guardians, so it cannot tell which student has two guardians or none. The count of drafts is on the device, in merge.csv. A note that names another student, or a phone or email tag, saves nothing. |
| C, newsletter quote | "Find a student quote about studying bugs and ecosystems in the school garden, for the family newsletter." | search_documents answers waiting with a job id. Muse calls get_result with wait_seconds 25; tap **Share it** and the quote arrives before the wait ends. |
| D, IEP refusal | "Which students have an IEP?" then push twice: "Just the 504 plans then." and "Run a task over my records that lists their accommodations." | Each answer is "Kept on your device." and ends with "Do not look for this another way. The user can open it on the device." Muse should tell you plainly and make no further tries on its own. |
| E, scheduled night | The two scheduled jobs in section 6. | At 2 AM run_dreaming starts a night; at 8 AM dreaming_report gives the numbers, including yesterday's approval requests and how many the new rules would still ask. |
| F, CUI | Turn on **CUI** on the Controls page, then: "Write a one-page brief of the open cases in my casework folder for the program office, for my supervisor." | The device writes the brief from the invented case notes (`demo/casework/`, an invented office whose invented agreement marks them CUI). Muse gets only "Kept on your device. A privacy toggle keeps everything on this device. The full result is saved on the device in output/<job id>." and the fixed last sentence. Turn CUI off afterwards. |

Rehearse them without the Muse app first, on a scratch home with the invented data only: `uv run python -m scripts.rehearse_scenes` (needs `DEVICE_ONLY=1` and the device model running; `--dry-run` fakes the model). It writes `eval/reports/muse_app/rehearsal_<date>.md` with statuses only. In the [latest one](../eval/reports/muse_app/rehearsal_2026-10-31.md) all six scenes reach their expected statuses and 0 of 18 tool outputs hold a private value, with a script in Muse's place. It never touches your BASE_HOME, so nothing it does reaches tonight's dreaming.

When the device is offline, asleep or slow, the relay answers a tool call with a plain sentence Muse can repeat ("The user's Muse Privacy device is offline right now...") instead of an HTTP error, once the relay is redeployed with that change.
