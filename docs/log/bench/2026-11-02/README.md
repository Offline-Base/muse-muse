# Board receipt benches, Nov 2, 2026

What each file in this folder is, and which of them count as part of the submitted project. The files themselves are unchanged; this note only labels them.

The organizers ruled on Nov 2, 2026 (Cerebral Valley Discord, 3:57 PM ET; docs/MESSAGING.md, rules section) that Llama of any version does not count as a Meta model in this hackathon, and that every model the project runs must be a Meta model, with no non-Meta helper. So the Bolt, LFM and Llama files below are **earlier experiments, not part of the submitted project**. They stay here for the record. Don't quote their numbers in the submission, the video or any page, and don't present them as comparison rows for the project.

All 40 receipts are invented, written by code (`scripts/dev/receipt-bench.py`). Board numbers are board numbers.

| File | Board | Model | What it is | Part of the submitted project? |
|---|---|---|---|---|
| `receipts-jetson-02.json` | jetson-02 | `muse-glimmer-2026-iq1s-io-lowest` (Muse Glimmer 30B one-bit, stock r30b) | Hussam's 40-receipt bench (PR #62): 0 of 40 valid JSON, with no `json_schema` constraint; the board stopped answering at receipt 23 | Yes, as the stock one-bit Glimmer's honest baseline. The JSON-schema gate (docs/EDGE_PLAN.md, H1) is planned, not run |
| `receipts-regex.json` | none | regex, no model | Code alone reading the same receipts | Yes, as a no-model baseline |
| `receipts-jetson-04.json` | jetson-04 | NVIDIA Nemotron 3.5 Bolt E4B, Q4_K_M | The same bench on Bolt | **No.** Earlier experiment: Bolt is not a Meta model |
| `receipts-jetson-05.json` | jetson-05 | Liquid LFM3-VL-2B, Q4_K_M | The same bench on LFM3-VL | **No.** Earlier experiment: LFM is not a Meta model |
| `receipts-llama-tune-jetson-04.json` | jetson-04 | Llama 3.2 1B Instruct plus a LoRA (PR #67) | The on-board Llama tune's training and scores | **No.** Earlier experiment: Llama is not a Meta model under the ruling |
| `receipts-llama-tune-served-jetson-04.json` | jetson-04 | `Llama-3.2-1B-Instruct-receipts` | The tuned Llama 1B served through the fleet, on the same 40 receipts | **No.** Same reason |
| `receipts-llama-tune-answers.jsonl` | jetson-04 | Llama 3.2 1B, base and tuned | The 80 raw answers behind the two files above | **No.** Same reason |

One technical fact from the Llama files carries over to the Glimmer path and may be said without naming a Llama result: llama.cpp `--lora` over a GGUF base works on these boards (b11574 on jetson-04).
