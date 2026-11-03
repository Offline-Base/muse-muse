---
name: recipe-open-weights
description: Use when a note asks for a kit for Muse open weights on someone's own machines, such as serving Muse Spark Open across Mac Studios, preparing SFT conversations for TorchTitan, or checking an RL task's reward spread before a GRPO run.
---

# Open-weight kits

These products prepare, check and write what a person runs on their own hardware. **The product itself runs no GPU, downloads no weights, trains nothing and serves no open model.** Say so on the first screen and in limits: "This kit writes and checks your files. Training and serving happen on your machines." The verdict is "partly".

Product code names `muse-wonder-1.0` through `metaClient(request)` (meta-reasoning) and nothing else, unless the brief lists `muse-spark-open`: then the meta-spark-open skill's `askSparkOpen` is the closer model, the same weights on a hosted provider, and its label and license line show as that skill says. A test build runs Wonder's calls on a cheaper model by itself.

`helpers/` holds pure TypeScript with no imports. Copy the files you use into `lib/open-weights/` and test them there. The links are for people and BUILD_NOTES. The build firewall may block GitHub and Hugging Face, so never fetch or clone them, and never call a provider, Hugging Face or any host but the gateway.

## Shared rules

- **Every model step is a real call.** If it fails, show the error and a retry. Never a canned reply, a scripted stand-in or a local plan dressed as the model's. The Nov 3 audit's worst product looked like it worked while its model never ran.
- **Code computes, the model explains.** Sizes, counts, splits, rewards, advantages and verdicts come from the helpers. A model reply that names an id, a row or a check is kept only when code finds it in the product's own list.
- **Never say it ran on their hardware.** A hosted answer is labeled "Hosted Muse Wonder, standing in for your machines" (or the Spark Open label). Commands are labeled "Not run yet: run these on your machines."
- **Rich samples.** Ship the sample data named below, made up, with planted problems so every check has something to find. "Try the sample" fills it in one tap.
- **An end state.** Every flow ends in files to download (with real contents, checked by a test) and copy buttons, plus one `UsageStrip` for the model calls.
- **Facts to use as written:** Muse Spark Open is 816B parameters, 42B active. NVFP4 checkpoint `meta-models/Muse-Spark-Open-816B-A42B-NVFP4`, about 537 GB; BF16 `meta-models/Muse-Spark-Open-816B-A42B`, about 1.65 TB. It reasons at xhigh by default; its recommended sampling is temperature 1.0 and top_p 1.0. Don't add numbers the pages don't give.

## Mac cluster kit (cookbook/muse-spark-open-mac)

Build: a setup kit for serving Muse Spark Open on two or four Mac Studios, and a doctor for the step that failed.

1. Inputs: two or four Macs, memory per Mac, host names (default `mac-studio-1.local` and on, from `defaultHosts`), port 8080.
2. `planMacCluster` from `helpers/mac-cluster.ts` gives the problems (two Macs need 512 GB each, four need 256 GB each), each Mac's share of the weights, every pair that needs a direct Thunderbolt 5 link (two cables a pair), the commands, a `hostfile.json` skeleton and `setup.sh`. Draw the links as a small diagram in code (SVG lines between Mac boxes is fine here: it's a diagram, not a photo). Show `MAC_CHECKS` as a checklist the person ticks.
3. The hostfile: lead with `mlx.distributed_config ... --auto-setup`, which writes it. The skeleton is the fallback, and every `FILL_IN_` value is highlighted: only the person's Macs know their Thunderbolt IPs and RDMA device names. Never invent them. RDMA is turned on in macOS recovery with `rdma_ctl enable`, never remotely.
4. Log doctor (the model step): the person pastes the output of the step that failed. `respondJson` returns `{ checkId, cause, fix }`, with `checkId` an enum of `MAC_CHECK_IDS` plus `"none"`. Keep it only when `checkDiagnosis(checkId)` finds it, and show that check's own fix beside the model's words. Ship three made-up sample logs labeled "made-up log": an SSH password prompt from `ssh mac-studio-2.local 'echo ok'`, a disk-full message while the checkpoint downloads, and a launch that lists only one of four hosts.
5. Try the prompt: send the page's prompt, "Give me a one-sentence summary of what you can do.", to the hosted model and show it with its label, so the person sees what a working server should answer.

Check: plan tests for two and four Macs (268.5 and 134.25 GB a Mac, 1 and 6 links), 256 GB with two Macs refused, a host name with a space refused, the skeleton's own-row `rdma` entry null, and a stubbed doctor reply with an unknown id refused. Limit: it can't see the person's Macs; the commands haven't run there.
Link: https://dev.meta.ai/docs/cookbook/muse-spark-open-mac

## SFT data studio (cookbook/muse-spark-open-torchtitan-sft)

Build: turn a person's conversations into the recipe's JSONL, checked, split, with the trained tokens shown.

1. Input: paste or upload JSONL (`{"messages": [...]}` a line), or a CSV with question and answer columns (`csvToConversations`). Sample: at least 24 made-up support conversations for one made-up business, some multi-turn, with planted problems: one empty assistant reply, one row that ends on the user, one exact duplicate, one row with no assistant turn, one audio part pointing at an `.mp3`.
2. Per row, `checkConversation` gives errors and warnings, and `duplicateLines` finds repeats. A table shows each row's status; tapping a row shows `trainedSegments` with trained text highlighted and masked text dimmed, under the line "Simplified view: the real renderer also writes its own system lines."
3. Model steps, both through `respondJson`, at most 40 rows a call:
   - **Review:** `{ flags: [{ line, problem, suggestion }] }`, with `problem` an enum (wrong, off-tone, too short, unclear, personal info). Drop any line not in the file.
   - **Draft more like these:** up to 10 new made-up conversations in the same style. Each passes `checkConversation` before it's added, is marked "Drafted by Muse Wonder", and can be left out of the export.
4. `splitHeldOut` (seeded, so the same file gives the same split), `sizeWarnings`, and `estimateTokens` per split, labeled "estimate, about 4 characters a token".
5. Export: `train.jsonl` and `heldout.jsonl` from `toJsonl` (error rows left out, with a count), and `recipe.py` and `run.sh` from `recipeFiles`, with today's date pinned and the media recipe when any row has an image or audio part. Say the product can't check that media files exist on their machine.

Check: the sample's planted problems are each found, a CSV with a quoted comma parses, the split is the same twice, and the export holds no error rows. Limit: it checks the format, not whether training will help; full SFT of the 816B model takes 128 GPUs in the recipe's layout.
Link: https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft

## Reward spread check (cookbook/muse-spark-open-torchtitan-rl)

Build: before renting a cluster, see whether a task's prompts give GRPO something to learn.

1. Input: task rows `{ question, answer }` (the QA template's shape), pasted as JSONL or typed in a table. Sample: 12 made-up warehouse word problems with whole-number answers, mixed so a few are easy, a few hard and the rest in between.
2. The reward, picked by the person: exact match, boxed answer (`boxedPrompt` asks for it) or number within a tolerance, all from `score` in `helpers/grpo.ts`.
3. Sampling: one route call per prompt, which makes 4 calls at once (group size 4, at most 8), each its own `meta.responses.create` with `reasoning: { effort: "low" }` and `max_output_tokens` from a budget slider (default 2000). A reply with `status` "incomplete" and reason `max_output_tokens` counts as cut off. The page runs at most 8 prompts a run, one after another, and fills each group's row as it lands.
4. Each group shows its rewards with each reward's `why`, the advantages from `grpoAdvantages`, and `readGroup`'s kind: no signal, truncation, or learns. `summarizeSpread` writes the verdict in code.
5. Export: `task.jsonl` from `qaJsonl`, the `withTaskSnippet` registration and commands, and a report with every sample and score.

Copy says plainly: a spread on the hosted model suggests, and doesn't prove, a spread on Muse Spark Open. Check: `grpoAdvantages` of equal rewards is no signal, a nested `\boxed{}` is read, a group whose low samples were all cut off reads as truncation, and a stubbed failing call shows an error, not a score. Limit: a run makes up to 64 model calls. At the 2,000-token budget that is at most about $2.60 on Muse Wonder ($20 per million output tokens), so show the estimate before Start and the real cost after. The real recipe runs on 256 trainer GPUs and 16 generator GPUs.
Link: https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl
