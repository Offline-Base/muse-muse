# Cost to serve Glimmer-30B-2026-Knowledge (list prices, Oct 31, 2026)

**Short answer:** None of the five providers sells this model per token, so you pay for GPU time.
- **Cheapest measured option running all the time:** 1x A100 40GB on Lambda at $1.99/h ($1,452.70 a month). This is the GPU we benchmarked. Some machines cost less per hour but have not been tested: Lambda Quadro RTX 6000 at $0.69/h, AWS g6.xlarge (L4) at $0.8048/h, Lambda A6000 at $1.09/h and Lambda A10 at $1.29/h. They are slower per user.
- **Cheapest with light traffic:** Modal. It bills per second and scales to zero, so you only pay for model load time and a 60 s idle window after each burst.
- **Production:** run vLLM. On base Glimmer it produced about 11x the tokens per second of llama.cpp, so cost drops to roughly $0.50 per 1M output tokens (estimate). That figure needs a fully loaded GPU (about 176 requests at once, about 6 tok/s per user). It also needs a 4-bit or 8-bit build of our merged model, which we don't have yet.

**Correction to the brief: vLLM was measured.** The writer fleet ran base Glimmer on vLLM 0.32.0. I recomputed the medians from `writer-fleet.log`. The script counts `generation_tokens_total` only, so these are generated tokens:
- A100 40GB, 4-bit build, about 176 requests at once: 1,135 tok/s pooled. Per-machine medians run from 1,079 to 1,176.
- L40S, FP8 build, 128 to 144 requests at once: 916 tok/s.
- A10, 4-bit build, about 44 requests at once: 351 tok/s.

Our fine-tune itself has not been run on vLLM.

**Which file to serve:** Q4_K_M (28.8% on our 2,500 test questions) or BF16 (29.0%). IQ2_XXS scores 17.1%, which is below base Glimmer's Q4_K_M (18.4%). It throws away most of what the fine-tune added.

## 1. Options

How to read the "$ per 1M output tokens" column:
- **"measured"** uses our llama.cpp speed with 16 requests at once on a Lambda A100 40GB: 103.2 tok/s for Q4_K_M, 109.9 for IQ2_XXS. On a Modal row it is that speed times Modal's price.
- **"est."** scales that speed by the GPU's memory bandwidth. This is rough. On the A100, IQ1_S is 61% smaller than Q4_K_M but only 9% faster.
- **"(Q4_K_M)" on a BF16 row** means the estimate is the Q4_K_M speed on that GPU. Every one of these GPUs also holds Q4_K_M. BF16 moves 3.3x the bytes per token, so llama.cpp would decode it more slowly. We have no vLLM rate for our BF16 model, so its cost per token is not estimated.
- **A month is 730 h of GPU time.** Modal and AWS add charges on top; see "Extra charges" below the sources.

| Provider, option | Hardware | File | Price | 24/7 month | $ per 1M output tokens (full load) | Scales to zero | Notes |
|---|---|---|---|---|---|---|---|
| Fireworks, on-demand [F] | 1x H100 80GB or 1x H200 141GB | BF16 merged upload, or base Glimmer plus our LoRA as an add-on | $8.00/h | $5,840.00 | n/a: Fireworks runs its own engine. Reaching $1 per 1M needs 2,222 tok/s | Yes, but the default idle window is 1 h, billed (up to $8 per burst; can be set as low as 5 min). Requests sent while at zero get HTTP 503 and are not queued | No extra charge for the LoRA. Deployments at zero are deleted after 7 days with no traffic. Region-pinned deployments cost 1.5x. Not confirmed: whether Fireworks accepts our architecture as an upload, and which GPU setup it validates for Glimmer. No GGUF |
| Modal [M] | T4 16GB | IQ2_XXS | $0.5904/h | $430.99 | ~$7.25 est. | Yes | Lowest quality. About 12 tok/s per user (est.) |
| Modal [M] | L4 24GB | Q4_K_M | $0.7992/h | $583.42 | ~$11.15 est. | Yes | About 9.5 tok/s per user (est.), slow for chat |
| Modal [M] | L40S 48GB | Q4_K_M, or an FP8 build on vLLM | $1.9512/h | $1,424.38 | ~$9.45 est. | Yes | About $0.59 per 1M on vLLM FP8 (table below) |
| Modal [M] | A100 40GB | Q4_K_M | $2.0988/h | $1,532.12 ($1,741.00 with 2 cores + 24 GiB) | **$5.65** (speed measured on Lambda, Modal price) | Yes | Same GPU type we benchmarked. Requesting "A100" may get an 80 GB card at the same price |
| Modal [M] | A100 80GB | BF16 on vLLM | $2.4984/h | $1,823.83 | ~$5.13 est. (Q4_K_M) | Yes | Cheapest single GPU that holds BF16 and scales to zero. Modal doesn't say whether its A100s are SXM or PCIe |
| Modal [M] | H100 80GB (SXM) | BF16 on vLLM | $3.9492/h | $2,882.92 | ~$4.93 est. (Q4_K_M) | Yes | May run on an H200 at the same price |
| Baseten [B] | L4 24GB | Q4_K_M in our own llama.cpp image | $0.8484/h | $619.33 | ~$11.84 est. | Yes; by default the 15 min after the last request are billed | Host RAM is 16 GiB, less than the 16.9 GB file (mmap should still load; untested). Baseten has no llama.cpp guide |
| Baseten [B] | A100 80GB | BF16 on vLLM | $4.00/h | $2,920.00 | ~$8.63 est. (Q4_K_M) | Yes | Our weights deploy as a custom Truss. Partial minutes round up |
| Baseten [B] | H100 80GB | BF16 on vLLM with the DFlash draft model | $6.50/h | $4,745.00 | ~$8.12 est. (Q4_K_M) | Yes | Baseten's own setup for base Glimmer. One-click deploy covers the base model only |
| AWS EC2 [A1] | g4dn.xlarge, 1x T4 16GB | IQ2_XXS | $0.526/h | $383.98 | ~$6.46 est. | No; you stop it by hand, and the EBS disk keeps billing | Cheapest AWS GPU, IQ2_XXS only. Untested |
| AWS EC2 [A1] | g6.xlarge, 1x L4 | Q4_K_M | $0.8048/h | $587.50 | ~$11.23 est. | No | 16 GiB host RAM |
| AWS EC2 [A1] | g6e.xlarge, 1x L40S 48GB (the one we used) | Q4_K_M, or an FP8 build on vLLM | $1.861/h | $1,358.53 | ~$9.02 est. | No | About $0.56 per 1M on vLLM FP8 |
| AWS EC2 [A1] | g7e.2xlarge, 1x RTX PRO 6000 96GB | BF16 | $3.36312/h | $2,455.08 | ~$8.81 est. (Q4_K_M) | No | Cheapest single GPU on AWS that holds BF16 |
| AWS SageMaker [A2] | ml.g7e.2xlarge (AWS's ready-made Glimmer vLLM container) | BF16 | $4.2039/h | $3,068.85 | ~$11.02 est. (Q4_K_M) | Partly: waking takes minutes, and calls fail meanwhile | Our attempts on Oct 30 failed for lack of capacity. Endpoint storage is $0.14 per GB-month |
| AWS EC2 [A1] | p4d.24xlarge, 8x A100 40GB | Q4_K_M, 8 copies | $21.957642/h | $16,029.08 | $7.39 (measured speed x8) | No | AWS's only A100 40GB option: you rent all 8 GPUs, $2.74 per GPU-hour |
| Lambda [L] | Quadro RTX 6000 24GB | Q4_K_M | $0.69/h | $503.70 | ~$4.30 est. | No; bills until terminated | Old card; least reliable estimate; untested |
| Lambda [L] | A6000 48GB | Q4_K_M | $1.09/h | $795.70 | ~$5.94 est. | No | |
| Lambda [L] | A10 24GB | Q4_K_M | $1.29/h | $941.70 | ~$9.00 est. | No | About $1.02 per 1M on vLLM 4-bit |
| Lambda [L] | A100 40GB SXM4 | Q4_K_M | $1.99/h | $1,452.70 | **$5.36 measured** | No | What we paid. About $0.49 per 1M on vLLM 4-bit |
| Lambda [L] | GH200 96GB | BF16 | $2.29/h | $1,671.70 | ~$2.40 est. (Q4_K_M) | No | ARM host. Cheapest single GPU that holds BF16 on any of the five providers |
| Lambda [L] | H100 PCIe 80GB | BF16 | $3.29/h | $2,401.70 | ~$6.89 est. (Q4_K_M) | No | Cheapest standard (x86) machine on Lambda that holds BF16 |

**Sources for every price above** (all re-read Oct 31, 2026, and all matched):
- [F] https://fireworks.ai/pricing. Idle window, 503 behavior and the 7-day deletion: https://docs.fireworks.ai/deployments/autoscaling.md
- [M] https://modal.com/pricing. The page lists per-second rates; I converted them to per hour.
- [B] https://www.baseten.co/pricing/ (per minute, plus an Hour view). Rounding: https://docs.baseten.co/organization/billing
- [A1] https://aws.amazon.com/ec2/pricing/on-demand/. The page loads its tables by script, so the values come from AWS's price files:
  - https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.csv
  - The page's own data file: https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json
- [A2] https://aws.amazon.com/sagemaker/ai/pricing/, with values from https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/us-east-1/index.json
- [L] https://lambda.ai/pricing. Prices are plus tax. Billing is in one-minute increments: https://docs.lambda.ai/public-cloud/billing/

**Extra charges not in the table:**
- **Modal:**
  - CPU and memory are billed on top of the GPU: about $0.29/h for 2 cores and 24 GiB.
  - Pinning a region multiplies the whole bill by 1.15x (broad region) or 1.75x (narrow region).
  - Volumes cost $0.09 per GiB-month after 1 TiB free.
  - Egress costs $0.04/GiB after 1 TiB a month free.
- **AWS:**
  - EBS gp3 disk: $0.08 per GB-month (100 GB is $8 a month), and it keeps billing while the instance is stopped (https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ebs.json).
  - A public IPv4 address: $0.005/h, or $3.65 a month (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/us-east-1/index.json).
  - Internet egress: $0.09/GB for the first 10 TB a month after 100 GB free (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json).
  - SageMaker endpoint storage: $0.14 per GB-month.
- **Fireworks:**
  - Legacy postpaid accounts have monthly spend caps: Tier 1 is $50, which an always-on H100 reaches in about 6 h (estimate). Prepaid accounts set their own limit. Requests pause at the cap.
  - The default GPU quota is 16 per type, global region only (https://docs.fireworks.ai/guides/quotas_usage/account-quotas.md).
  - The price of storing an uploaded model: not found.
- **Baseten:**
  - The instance price includes its CPU and RAM.
  - Storage and egress prices: not found.
- **Lambda:**
  - CPU, RAM and the local SSD are included.
  - The billing doc says Lambda doesn't charge for ingress or egress. That sentence is in its Filesystems section, and the pricing page lists no data-transfer charge.

**Options that don't exist:**
- **Fireworks serverless:** Glimmer was deprecated there starting Sep 25, 2026. The last known price was $0.35 input / $1.50 output per 1M tokens, from a third-party capture. Fireworks never served LoRAs or uploaded weights on serverless anyway.
- **Baseten Model APIs:** Glimmer is not on the list.
- **Modal shared (per-token) endpoints:** none for Glimmer.
- **Bedrock:** Glimmer is not in the catalog, and Custom Model Import doesn't support our architecture.
- **Lambda Inference API:** shut down Sep 25, 2025.

**With vLLM batching.** These rates were measured on base Glimmer, not our fine-tune, and our fine-tune needs a quantized build to fit these GPUs. Each rate assumes the GPU stays saturated, at about 6 tok/s per user on the A100 and L40S. A chat service with fewer requests at once would get less total throughput and pay more per token.

| GPU (base-model rate) | Lambda | Modal (GPU only) | AWS |
|---|---|---|---|
| A100 40GB, 4-bit build, 1,135 tok/s | $0.49 per 1M | $0.51 ($0.58 with 2 cores + 24 GiB) | $0.67 (p4d, per GPU) |
| L40S, FP8 build, 916 tok/s | n/a | $0.59 | $0.56 (EC2), $0.79 (SageMaker ml.g6e.xlarge) |
| A10 / A10G, 4-bit build, 351 tok/s | $1.02 | $0.87 | $0.80 (g5.xlarge, A10G, likely a bit slower) |

## 2. Cheapest way for each case

**(a) Demo with a few hundred requests a day: Modal, A100 40GB, Q4_K_M in llama.cpp, scale to zero.**
- Expect about 49 tok/s per user (measured on Lambda's A100 40GB, assumed the same on Modal), so a 500-token reply takes about 10 s.
- **If traffic comes in bursts** (1 to 3 billed hours a day), it costs about $42 to $185 a month after Modal's $30 monthly Starter credit (estimate).
- **If requests trickle in all day,** each one pays its own cold start plus the 60 s idle window. The bill can reach about $526 a month, or about $496 after the credit. That is close to an always-on Lambda Quadro RTX 6000 ($503.70).
- **Fireworks for a demo:** shorten the idle window. At the default 1 h, every burst pays at least $8; at 5 min, about $0.67.
- **LoRA instead of merged weights:**
  - On Fireworks it costs the same $8/h of H100 time, so there's no saving.
  - In llama.cpp it was slower: 37.5 vs 50.7 tok/s for one user, and about 4x slower with 16 requests at once. That was measured on the earlier stage 2 model.
  - Serve the merged model.

**(b) Always on for a hackathon week (168 h): Lambda 1x A100 40GB, Q4_K_M in llama.cpp, $334.32.**
- It's the only setup with measured speed.
- Terminate it at the end of the week. Lambda bills until termination, and shutting down the operating system does not stop billing.
- Cheaper options, untested and slower per user:
  - Lambda Quadro RTX 6000: $115.92.
  - AWS g6.xlarge: $135.21, plus about $0.84 for the IPv4 address and about $1.84 for a 100 GB disk.
  - Lambda A10: $216.72.
- Modal, always on: $400.67 including CPU and memory. Its advantage is that it can add copies automatically when traffic spikes.

**(c) Real production traffic: vLLM with a 4-bit or FP8 build of our merged model.**
- **Cheapest per token:** Lambda A100 40GB, about $0.49 per 1M at full load (estimate).
  - Each copy costs $1,452.70 a month and can produce about 2.98B tokens a month.
  - Two copies for redundancy: $2,905.40 a month.
  - You run the load balancer yourself, and Lambda capacity is first come, first served.
- **If you want autoscaling:** Modal A100 40GB, about $0.58 per 1M including CPU and memory. Modal GPU jobs can be preempted, and its Servers don't retry a lost request on their own.
- **BF16 without making a quantized build** (speeds not estimated):
  - Lambda GH200 at $2.29/h (ARM host).
  - Modal A100 80GB at $2.4984/h.
  - Baseten H100 at $6.50/h, which needs about 1,806 tok/s to reach $1 per 1M.
  - Fireworks at $8/h, which needs about 2,222 tok/s.
- **Credits:** the run log lists $10,000 of AWS credit and $7,500 of Lambda credit (Oct 29). Part is already spent, and the knowledge run is capped at $3,500 AWS and $2,500 Lambda. If credits can pay for serving, the AWS and Lambda options cost no cash until they run out.

## 3. Unknown or estimated

- **Does vLLM support this model?** Its supported-models page lists MuseGlimmerForConditionalGeneration, including LoRA, and base Glimmer ran on vLLM 0.32.0 in our fleet. Our fine-tune has never run on vLLM, and no 4-bit or FP8 build of it exists.
- **Other engines:**
  - SGLang: Muse Glimmer support is not in a release yet; it needs a dev image.
  - Fireworks: uses its own engine, and our architecture is not on its published list for uploads.
  - TensorRT-LLM: not supported on Baseten.
- **Real throughput:** only llama.cpp on an A100 40GB has been measured for our fine-tune. Every "est." is a bandwidth-scaled guess.
  - The vLLM rates come from base Glimmer on a JSON-writing workload, counting generated tokens only, at high concurrency.
  - Prompt processing is not priced anywhere above.
  - All benchmarks used greedy decoding, not Meta's recommended sampling.
- **Bandwidth figures:**
  - From NVIDIA's pages: L4 300 GB/s, A10 600, L40S 864, A100 80GB 1,935 (PCIe) / 2,039 (SXM), H100 SXM 3,350.
  - From spec sheets, not rechecked: A100 40GB 1,555, H100 PCIe 2,000, GH200 4,000, T4 320, Quadro RTX 6000 672, A6000 768.
  - RTX PRO 6000: 1,597, rechecked on AWS's g7e page.
  - Baseten's A100 80GB: 1,940, from Baseten's docs.
- **Egress:** negligible for text, about $0.01 per 1M streamed tokens at Modal's rate (estimate). The rates per provider are under "Extra charges" above.
- **Other gaps:**
  - Fireworks and Baseten don't publish cold-start times.
  - Fireworks may reject our vision model because it has no preprocessor_config.json.
  - Our LoRA lists its target layers as a pattern; Fireworks may need a plain list instead.
  - Capacity: Lambda's H100, GH200 and B200 were unavailable at times on Oct 30 and 31, and AWS g7e launches failed on Oct 30.

## 4. License

To serve publicly:
- Show "Built with Muse Spark Open" in the product's interface, docs, website or settings menu (Muse Model License §2).
- Include the license and Usage Policy with any copies of the weights you distribute (§1).
- Follow the Usage Policy in Exhibit A:
  - The model is not intended for anyone under 18.
  - Never present output as human-generated.
  - Disclose known dangers of the system to end users, such as made-up answers.
- §3, the Model-as-a-Service clause: before selling API access to the model, you must notify Meta and sign a separate agreement, but only once the gross revenue of your company and its affiliates passes $20M in any 12-month period. That threshold is total company revenue, not only API revenue. It does not apply to using the model to power features of your own product that isn't a Model as a Service.

## Appendix: arithmetic

- **Per hour:** Modal per-second rate x 3,600 (A100 40GB: 0.000583 x 3,600 = $2.0988). Baseten per-minute rate x 60.
- **Month and week:** month = hourly x 730; week = hourly x 168 (Lambda A100: 1.99 x 168 = $334.32).
- **$ per 1M output tokens:** hourly / (tok/s x 0.0036).
  - Lambda A100, llama.cpp: 1.99 / (103.2 x 0.0036) = $5.36.
  - Lambda A100, vLLM: 1.99 / (1,135 x 0.0036) = $0.49.
  - Modal A100 with CPU and memory, vLLM: 2.3849 / 4.086 = $0.58.
  - AWS g6e.xlarge, vLLM: 1.861 / (916 x 0.0036) = $0.56.
  - Lambda A10, vLLM: 1.29 / (351 x 0.0036) = $1.02.
- **Bandwidth scaling:** estimated tok/s = 103.2 x (GPU GB/s / 1,555), or 109.9 for IQ2_XXS rows. Per-user speed uses 49.2 the same way. Examples:
  - L4: 19.9 tok/s, so 0.7992 / 0.0717 = $11.15.
  - GH200: 265.5 tok/s, so 2.29 / 0.956 = $2.40.
  - AWS g4dn T4: 22.6 tok/s, so 0.526 / 0.0814 = $6.46.
- **Speed needed for $1 per 1M:** hourly / 0.0036 (Fireworks: 8 / 0.0036 = 2,222 tok/s).
- **Modal CPU and memory:** 2 cores x $0.04716 + 24 GiB x $0.007992 = $0.2861/h. Always-on A100 with these: 2.3849 x 730 = $1,741.00.
- **Demo:** 300 requests x 500 tokens a day; 500 / 49.2 = 10.2 s per request.
  - Bursty: 1 to 3 h/day x $2.3849 x 30 = $71.55 to $214.64, minus the $30 credit = $41.55 to $184.64.
  - Spread out, every request cold: 300 x (18 s load + 10.2 s + 60 s idle) = 7.35 h/day, so $525.88 a month, or $495.88 after the credit.
  - Fireworks idle tail: $8/h x 5/60 = $0.67 at a 5 min window.
- **Production:** two copies = 2 x $1,452.70 = $2,905.40 a month. One copy at full load: 1,135 x 3,600 x 730 = 2.98B tokens a month. Per user: 1,135 / 176 = 6.4 tok/s.

Local files I checked:
- /Users/ethancastro/muse-muse/docs/KNOWLEDGE_RUN_LOG.md
- /Users/ethancastro/muse-muse/.data/knowledge/logs/writer-fleet.log
- /Users/ethancastro/muse-muse/scripts/knowledge/aws/writer_fleet.py
- /Users/ethancastro/muse-muse/docs/model-licenses/stage-b-r30b/MUSE_MODEL_LICENSE.md

## Corrections

1. **All list prices were rechecked and match** on the Fireworks, Modal, Baseten and Lambda pages and the AWS EC2 and SageMaker price files: per-hour, per-minute and per-second rates, plus the GPU memory sizes. All 730 h and 168 h totals and per-1M figures recompute correctly. The vLLM medians (1,135 / 916 / 351) recompute from the log and are generated tokens only.
2. **"Cheapest running all the time" was overstated.** The Lambda A100 40GB is the cheapest *measured* option. The Quadro RTX 6000, g6.xlarge, A6000 and A10 cost less per hour (untested).
3. **BF16 rows were mislabeled.** Their "est." cost per 1M used the Q4_K_M speed. They are now marked "(Q4_K_M)", and BF16 speed is stated as not estimated.
4. **Fireworks scale to zero was understated.** The default idle window is 1 h, billed (up to $8 per burst). Also added: deployments at zero are deleted after 7 days, Tier 1 legacy accounts have a $50 monthly cap, and region pinning costs 1.5x.
5. **AWS egress was "not found"; it is $0.09/GB** for the first 10 TB after 100 GB free. Also added the missing AWS charges: public IPv4 $0.005/h, EBS gp3 $0.08 per GB-month, and SageMaker endpoint storage $0.14 per GB-month.
6. **Added the vLLM concurrency caveat.** The $0.49 to $0.59 per 1M figures assume about 130 to 176 requests at once, about 6 tok/s per user.
7. **Demo trickle case:** the $30 Modal credit was not subtracted. It is now $495.88 after the credit.
8. **Removed the claim that the Modal A100 80GB is the Dedicated Endpoint GPU.** Modal does not publish which GPU its Glimmer recipe uses.
9. **License:** the $20M threshold is the company's and affiliates' total gross revenue, and you must notify Meta before offering the service. "Warn users about made-up answers" was reworded to the policy's actual term, disclosing known dangers. Added the §1 requirement to include the license with distributed copies.
10. **Lambda's no-egress statement** comes from the billing doc's Filesystems section. The wording is now qualified.
11. **The LoRA-vs-merged llama.cpp speeds** were measured on the stage 2 model, not the final fine-tune.
12. **Added the AWS g4dn.xlarge** (T4, $0.526/h), the cheapest AWS GPU for IQ2_XXS, and made Modal's region multiplier explicit.