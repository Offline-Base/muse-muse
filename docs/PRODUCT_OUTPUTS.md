# Product outputs and Prove it

Every shipped product with actions in its `musemuse.json` comes with five more ways to use it, next to the web product.
They are all generated from the manifest, with nothing extra for Muse Code to build. A person who asks for a plugin gets a
normal product plus these. `PRODUCT_OUTPUTS` in `lib/native/targets.ts` lists them, and the Get it panel on the product
page has a tab for each. The Prove it stage then runs each one for real against the live product and records a video.

| Output | Where it lives | How it reaches the product |
|---|---|---|
| MCP server | `/api/mcp/<slug>` (`lib/mcp/server.ts`, already there) | Each tool POSTs to the live action |
| Muse connector | The same URL, added in the Muse app as a custom connector (the page's "Get connector" button and side panel) | Same |
| CLI | `/p/<slug>/get/cli`, saved as `<slug>.cjs` | POSTs to `<liveUrl>/api/actions/<name>` |
| Skill file | `/p/<slug>/get/skill` (attachment), `/p/<slug>/skill.md` (to read inline) | The skill tells an agent to POST to the same address |
| Claude plugin | `/p/<slug>/get/claude-plugin`, saved as `<slug>-claude-plugin.zip` | Its `.mcp.json` points at the MCP server, and it carries the skill |
| ChatGPT | The MCP server's URL with setup steps | Same as MCP |

None of them is published anywhere: no npm, no plugin directory, no ChatGPT directory. Listing one waits for the owner's OK.

## Flags

All off by default. With them off, the routes answer 404, the Get it panel gets no output slots, and no build takes a Prove
it step.

| Flag | What it does |
|---|---|
| `PRODUCT_OUTPUTS=1` | Serves the downloads and fills the panel's output tabs |
| `PROVE_IT=1` | Runs the stage after a product ships. Needs `PRODUCT_OUTPUTS` |
| `PROVE_IT_CAP_USD` | What one run may spend at Meta (default 1.5) |
| `PROVE_NIGHTLY=1` | Re-checks live products each night. Needs `PROVE_IT` |
| `PROVE_NIGHTLY_PRODUCTS` | How many a night (default 5) |
| `PROVE_PUT_FILES=1` | A local run's knob: the stage writes the CLI, skill and plugin into its copy instead of downloading them, and says so in its results. For testing against a deployed site that doesn't have the routes yet |

## The files

`lib/outputs/generate.ts` makes them, pure. Manifests are written by Muse Code, so their text is treated as data: it is
quoted for each format and never decides where anything points. The addresses come from the database row and the site's
origin.

- **The CLI** is `lib/outputs/assets/cli.cjs` with the product's actions written into one constant. One file, Node 18 or
  newer, no dependencies. `--help`, `<action> --help`, `--json`, `--input`, `--input-file`, `--timeout` and a flag for each
  input field. Exit code 2 is a usage error, 1 is a failed call. An action's name wins over the words `list` and `help`, and
  a field's flag wins over one of the tool's, so a field called `input` works. `--cli-help`, `--cli-json`, `--cli-input`,
  `--cli-input-file` and `--cli-timeout` always mean the tool. It prints nothing a terminal would act on: control characters
  are cut from text and escaped in JSON, so a reply's value stays exact.
- **The skill file** has a name and description in its front matter, then each action's schemas and a `curl` line that fails
  when the call fails (`--fail-with-body`, curl 7.76 or newer). A builder's words, meaning each description, the tagline and
  the limits, sit in code blocks marked as data, so they can't add sections or instructions to a file agents trust. A name
  YAML would read as something else, such as `2048` or `true`, is quoted. A quoted name has passed `claude plugin validate`,
  and no real Muse Code run has read one.
- **The plugin** has `.claude-plugin/plugin.json`, `.mcp.json` and `skills/<skill>/SKILL.md` at the top of the zip. Its name is
  the slug, except that a name Claude keeps for Anthropic's own (`claude-...`, `anthropic-...`, `cc-plugin-...`, "official"
  beside claude or anthropic) gets `mm-` and loses the "official". The skill inside keeps the product's name. The unpacked
  plugin passes `claude plugin validate` on Claude Code 2.1.314. A directory listing would also need a README, a LICENSE or
  license field, an icon and a privacy policy URL. `claude --plugin-dir <file>.zip` loads the zip, which `claude plugin list`
  confirmed. The validator doesn't take the zip itself, only the unpacked folder.
- Actions with `who: "owner"` are left out of all of them and of the MCP tools, because outside callers are anonymous.
  `annotations` on an action become MCP's read-only and open-world hints.

Assets are edited in `lib/outputs/assets/`, then `npx tsx scripts/gen-outputs-source.ts` writes
`lib/outputs/assets-source.ts`, because a deployed function has no such files on disk. A test fails while the two differ.

## ChatGPT

The panel gives Developer Mode steps and says plainly that this isn't confirmed for every plan. **It has not been tested on
a real ChatGPT account.** Prove it marks it "Not tested", since only a person with an account can test it. It needs one hand
test on the owner's account, because plan limits on write actions and any rule about the URL's path are unconfirmed.

## The Prove it stage

```
buildProduct / refineProduct
  ...cleanup -> provePlanStep (writes "a run is coming") -> final status -> startProveStep -> the workflow is over
                                                                                 |
proveProduct (lib/pipeline/prove.ts)                                             v
  copy the sandbox -> MCP, CLI, plugin, skill file checks -> Muse Code uses the skill, step-capped
    -> Demo Studio records a terminal scene for each that passed -> upload -> charge -> delete the copy
```

**It can't fail or delay Live.** It is a separate workflow, started after the final status is written. The one step before
that status writes a single event with no retries, and the build goes on if it throws. Every step after is in the other
workflow, and a failure there only writes a line under the build. The scenario tests pin all of this.

**Where it runs.** A throwaway fork of the product's sandbox, named `prove-*`, not persistent, so it deletes itself if
nothing else does. It can reach the site, the product's live host and Muse Code's brokered routes at Meta. The product's
own sandbox stays free for a refinement. A run starts from the sandbox's last snapshot, so it needs the same stop that
`cleanup` already does.

**What it runs.** `lib/outputs/assets/prove-runner.mjs` runs each output with curl and node, as a person would, and logs each
command's real output and time to `results.json`:

- **MCP:** `initialize`, `tools/list` (every public action must be listed, with an object schema), then `tools/call` on what's
  safe to call, because this is the live product and other people's data is there:
  - An action with `annotations.readOnly: false` is never called.
  - An action with `readOnly: true` is called with its `example`, or a value made from its schema when that can be done
    honestly. One that needs a real file or link isn't.
  - An action with no such note might change things. It needs an `example`, the input the template's tests already run it on,
    and a run calls at most one of those, after the read-only ones. That one action gets up to three calls: MCP, CLI and the
    skill test.
  - A nightly re-check calls read-only actions only.
  - A run calls at most 5 actions, and the result says why each other one wasn't called.
- **CLI:** download, `--help` (must name every action), `--help --json`, then one real call with `--cli-json` on the first action
  the MCP check showed working. If nothing worked and the action answers 400, 413 or 422, the CLI still passes on its help, and
  the result says the action refused the sample and no call went through. Printing its own help instead of a reply fails.
- **Claude plugin:** download, then `prove-check-plugin.mjs` checks the paths, manifest, MCP address and skill by machine and
  asks that address for its tools. It isn't installed in Claude, and the panel and video both say so.
- **Skill file:** download and read it. Then Muse Code runs in a folder with nothing but the skill and is asked to run one
  action and save the reply: `muse exec` at low effort with `--max-model-steps 12`. It passes only when its log's tool results
  show it read the skill and POSTed to the action on the live host with curl, and it saved JSON that isn't an error and has
  the fields the action's output schema requires. Finding the address in the log isn't enough, because the skill itself holds
  the address, and a `grep` or `echo` of it doesn't count.

**The videos.** `lib/outputs/assets/prove-scene.html` replays the log in a terminal, under Demo Studio's normal recorder and
render. Only outputs that passed get one. Every scene says "A real run on <date>, replayed from its log. Long waits are
shortened." and prints the real time under each command, and long output is cut with a line saying how much. Before recording,
the stage checks `results.json` still has the hash it had before the skill test, because Muse Code had the run of that copy,
and restores the platform's recorder files from the pristine copy. A video that fails leaves its output's result as it was,
with no video.

**Money.** A build may spend `PROVE_IT_CAP_USD` on Prove it in total, charged to it. A later run on the same build, such as a
nightly re-check, gets what earlier runs left by their closing lines, and doesn't start when nothing is left. A run that died
before writing a closing line isn't counted.

- The checks plan calls only while the manifest's estimate keeps them under half of that. The estimate is Muse Code's own, so
  the real cap is read from `usage` on each 5 s poll of the checks: the poll that finds the money gone kills them, and they
  report that the budget stopped them. A call already under way still finishes, so a run can pass the cap by that one call.
- The skill test starts only with its reserve left under the cap, $0.60 on Wonder, and it stops at the poll that sees the cap
  reached. Polls are 10 s apart, so it can pass the cap by what one poll's worth of steps spends.
- Muse Code's usage goes through `charge`, with endpoint `muse exec prove`, so it counts on the build and in the room's cost
  line. The product's calls go through its own token and are already in `usage`. `proveCloseStep` adds them to the build's cost,
  and so does `proveFailStep` when a run dies, with the cost on its failed line.
- Those calls are counted as all of the product's gateway and tool usage since the run started, so anyone else using the
  product in those minutes is counted too. There is no way to tell them apart yet.
- A run is skipped when the platform's daily spend cap has been reached.

**Nightly (wired, off).** `/api/cron/prove-nightly` at 07:00 UTC picks the products checked longest ago, with no build running,
and runs the same stage on `muse-spark-1.3-contributor` with no videos, so each output keeps the last video it had. It answers
`{off: true}` and does nothing unless `PROVE_NIGHTLY=1`.

**What people see.** The Get it panel's output tabs show a pill (Tested, Didn't pass, Not tested, Testing it now), what was
found, each check and the video. The build room shows a line under the shipped answer and a row in the steps panel with a row
per output and its poster, and the room's event stream stays open while a run can still write. A run with no news for 45
minutes counts as over, so a dead workflow doesn't say "testing" forever.

## Testing it

`scripts/prove-run.ts` runs the stage's real work on one live product from this machine, with no database:

```
npx tsx --env-file=.env.local scripts/prove-run.ts --slug=<slug> --sandbox=<sandbox> --live-url=<url> --site=<https origin> --out=<dir> [--fetch] [--no-skill] [--no-record]
```

On a preview, set `PLATFORM_URL` to the preview's address. Without it `env.platformUrl` uses the production URL, so the downloads
and MCP calls would go to production, where these routes may not exist yet. Deployment Protection must let the sandbox through
too.

To run the workflow itself: a local dev server with `PLATFORM_URL` set to a public site (a sandbox can't reach this machine),
`PRODUCT_OUTPUTS=1 PROVE_IT=1 PROVE_PUT_FILES=1`, and a product row seeded from a real sandbox.

What was really run, and what wasn't, is in [the Oct 31 run](spikes/prove-2026-10-31/README.md).
