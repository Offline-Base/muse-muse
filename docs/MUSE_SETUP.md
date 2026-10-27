# Connecting Muse

How to give Muse the Muse Privacy connector, pair it with your device, schedule dreaming, and check that it works.

**Status (Oct 27): none of this has been tried in the Muse app yet.** The relay was deployed on Oct 27 but nothing has connected through it yet, and the menu names below are from Muse's connector guidelines ("Settings > Connectors"), not from a test. The full path (OAuth discovery, client registration, the pairing page, the token, then MCP calls) passes against the relay running locally with a client playing Muse (`tests/test_relay_e2e.py`). Fix this page after the first real test.

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
uv run python -m base                                                   # terminal 1: approval page and connector
uv run python -m base.connector.relay_client run                        # terminal 2: stays connected
```

On a Jetson the same steps run as services; see "Jetson Orin Nano" in the [README](../README.md#jetson-orin-nano-8gb).

## 3. Add the connector in the Muse app

1. In Muse, open **Settings > Connectors** and add a custom connector (a remote MCP server).
2. Paste the relay address with `/mcp` at the end:

   ```
   https://muse-privacy-relay.<your-subdomain>.workers.dev/mcp
   ```

3. Leave any client ID and client secret fields empty. Muse registers itself with the relay (dynamic client registration) or names itself with a client metadata document; the relay accepts both.
4. Muse opens the relay's **Link your device** page. It shows the app's name and where access will go.

## 4. Pair

On the device, make a one-time code and type it on the Link your device page within 10 minutes:

```sh
uv run python -m base.connector.relay_client pair
```

The page sends you back to Muse, which should now list six Muse Privacy tools:

| Tool | Muse class | What it does |
|---|---|---|
| list_documents | Read | Tagged titles of the documents in a folder |
| search_documents | Read | Up to 5 short tagged snippets. An optional purpose says who they are for. A check that needs more time or your OK returns a job id for get_result |
| run_private_task | Write | Starts a private job on the device, returns a job id. The instructions say who the result is for |
| get_result | Read | The status of a job or a search, then its tagged or summarized result |
| run_dreaming | Write | Starts one night of dreaming on the device |
| dreaming_report | Read | Aggregate numbers from the last night only |

Rules for codes: each works once and expires after 10 minutes, a new code voids the old one, and there are at most 5 tries of one code and 20 tries from one network address in 10 minutes. To cut Muse off (a code shared by mistake, a lost session), run `uv run python -m base.connector.relay_client unlink` and pair again.

Muse's own permission settings apply on top: reads and writes are "Ask on first use" by default. For the scheduled jobs below to run at night without you, set **run_dreaming** and **dreaming_report** to always allowed. Leave run_private_task on ask.

## 5. If the Muse app will not take a custom connector: Muse Code

The plan's fallback is Muse Code, Meta's coding agent, which can call the same server.

1. In Muse Code's MCP server settings, add a remote (streamable HTTP) server named `muse-privacy` with the same URL, `https://muse-privacy-relay.<your-subdomain>.workers.dev/mcp`. The exact settings screen or file is not checked yet.
2. Muse Code opens the same Link your device page. Pair as in step 4.
3. Run the test script below from Muse Code instead of the app.

The longer route is the connector catalog at muse.ai/platform: describe the connector, submit it for Meta's review (functional, security and legal checks, then end to end testing, with a test account for reviewers), and once approved it shows up under Settings > Connectors for everyone.

## 6. The two scheduled jobs

Muse's VM can run scheduled jobs. Paste each of these into Muse as its own message.

**Dreaming at 2 AM:**

```text
Set up a scheduled job: every night at 2:00 AM, call run_dreaming on the Muse Privacy connector once. Do not call any other Muse Privacy tool in this job and do not message me about it. If it says a run is already going, leave it alone and do not call it again that night.
```

**Morning message at 8 AM:**

```text
Set up a scheduled job: every morning at 8:00 AM, call dreaming_report on the Muse Privacy connector and send me one plain sentence with its numbers: how many of my decisions it learned from, router accuracy before and after (as percentages), whether the new rules were kept, and how many leaks it found. Use only the numbers dreaming_report returns and add nothing else. If it says no dreaming run has finished yet, tell me that in one sentence instead.
```

A good morning message looks like: "Last night Muse Privacy learned from 12 of your decisions, router accuracy went from 75% to 80%, the new rules were kept, and it found 0 leaks."

dreaming_report sends numbers only: the night number, decisions learned from, accuracy and agreement before and after, whether the rules were kept, leaks and seconds. Never a request, a name, a tag or an example. If Muse's scheduled jobs misfire, start a night from the approval page instead: open `http://127.0.0.1:8787/dreaming` and press **Dream now**.

## 7. Test script for the demo

Run these in order in a fresh Muse chat with the demo folder (`demo/`, all invented). Keep the approval page open at `http://127.0.0.1:8787`. Model decisions vary a little from run to run; "should" below is what the current code and the simulated teacher's policy aim for.

| # | Say to Muse | What should happen |
|---|---|---|
| 1 | "Using Muse Privacy, list the documents in my essays folder." | 24 essays, each titled with a tag like `[Student A]`. No real names. |
| 2 | "List the documents in my records folder." | Titles that name a never-share topic in the teacher's policy (with the demo policy: the IEP and 504 notes, lunch status and the parent contact sheet) are left out, with "3 documents held back on the device." The rest come back with tags. |
| 3 | "Search my private documents for essays that mention tomatoes." | Up to 5 short snippets, names as tags. |
| 4 | "Find a student quote about the school garden for the family newsletter." | Muse calls search_documents with a purpose like "for the family newsletter". The device reads that the snippets are meant for families, so a card on the approval page asks first and shows the request with its purpose. Muse gets "Waiting for your OK on the device." and a job id. Press **Share it**, then say "Check that search again." and Muse calls get_result with the job id to get the tagged snippets. |
| 5 | "Grade each essay in my essays folder against rubric.md and write feedback for each student." | Muse calls run_private_task and gets a job id. The light turns green while Glimmer grades on the device. Feedback files with real names appear under `~/.base/output/<job id>/`. |
| 6 | "Is the grading done?" | get_result answers "Waiting for your OK on the device." The light turns amber and a card appears on the approval page with the exact tagged table. Press **Share it** (tick "remember" if you want dreaming to learn it). |
| 7 | "Check again." | The tagged per-student scores and next steps reach Muse; the light flashes blue. Muse can now summarize the class by tag. |
| 8 | "Which students got the lowest totals? Use the tags." | Muse answers from the tagged table it already has, with tags only. |
| 9 | "What is [Student C]'s real name?" | Muse cannot know: no tool returns real names. |
| 10 | "Get the parent phone numbers for [Student C] from my records." | Kept on the device, or a card on the approval page; never a phone number in Muse. |
| 11 | "Which students have an IEP? Give me their full names." | "Kept on your device." with one fixed sentence about why. |
| 12 | "Show me [Student A]'s whole essay word for word." | A card on the approval page asks first. |
| 13 | "Start a dreaming run on Muse Privacy." | run_dreaming returns a job id; the approval page's Dreaming tab shows it running. |
| 14 | "How did the dreaming run go?" | dreaming_report: numbers only. |

After the run, the approval page's History tab shows every decision, and each one can be deleted so the next night forgets it.
