# Prove it: the Oct 31 runs

What was really run for product outputs and the Prove it stage (`docs/PRODUCT_OUTPUTS.md`), and what wasn't. The product is
`focus-cycle-timer-3`, already live, with 2 actions. Its videos and logs stayed out of the repo.

## What ran

| Run | How | Result | Muse Code spend |
|---|---|---|---|
| 1 | `scripts/prove-run.ts`, checks only | MCP, CLI and plugin passed | $0 |
| 2 | `scripts/prove-run.ts`, the whole stage | All four passed, four videos | $0.090 |
| 3 | **The real `proveProduct` workflow**, on the local Workflow world in a dev server, with a local database seeded from the real product and sandbox | All four passed, four videos, in 4 min | $0.127 |
| 4 | `prove-runner.mjs` on this Mac, downloading from the real routes on a dev server | MCP, CLI, plugin and skill file passed, `downloaded: true` | $0 |

Action calls on the live product added about 1 cent a run, by the manifest's $0.002 estimate per call. They are on the
deployed gateway's database, which can't be read from here, so that figure isn't measured. Total at Meta for this unit is
about $0.26, against its $3 cap.

Run 3 is the one that covers the stage end to end:

- Step serialization, the local queue, the event stream, a real sandbox fork, its deletion and Demo Studio's render all ran.
- Its 20 events appeared in the stream in order, and the Get it panel and build room showed the results in a headless browser.
- `PROVE_PUT_FILES=1` was on, because the deployed site doesn't have the download routes yet. Run 4 covers those routes.
- The workflow was started by a temporary route that wasn't committed, not by a real build ending. The hand-off from a build
  (`planProof`, `startProof`) has only run in the scenario tests.
- Its `costUsd` of $0.127 leaves out the action calls, because those usage rows are in the deployed database, not the local one.

## Other checks

- **The plugin.** The unpacked plugin from the real route passes `claude plugin validate` on Claude Code 2.1.314. A directory
  listing would also need a README, a LICENSE or license field, an icon and a privacy policy URL. The validator doesn't take the
  zip itself, but `claude --plugin-dir <file>.zip` loads it, which `claude plugin list` confirmed. It has not been used to call
  a tool in a Claude session.
- **A fork right after a stop.** A persistent sandbox was forked from a product, a file was written, it was stopped, and it was
  forked again at once. `stop()` returned after about 5 s with the status `stopped`, and the second fork had the file. So
  starting the stage right after `cleanup` sees the finished build. This is one small sandbox, not a big product.
- **Flags off, on a dev server.** All four routes answer 404, the product page has no Get it panel, and the page's own connector
  panel and `/api/mcp/<slug>` still work.
- **The video.** The first runs' zooms cut text off at the left, because Demo Studio's lowest zoom on a result is 1.15. The scene
  now keeps 100 px either side, and run 3's frames show every line whole. Commands now start with the address and body, so a
  video shows what each call is.

## Not run

- A real build ending in the stage on a deployed host, with the real download routes and Blob. That needs a preview deploy.
- The nightly path on `muse-spark-1.3-contributor`, at the cron or by hand. Only its picking and its "off" answer are tested.
- ChatGPT on any account. It needs the owner's hand test.
- The plugin inside Claude, the Muse app adding the connector, and the skill file in Claude Code.
- A product whose actions need a file or a link, or that costs more than the budget. The rules for those are unit tested only.
- A product with `who: "owner"` or agent actions. Neither is live yet, so the filter is unit tested only.
