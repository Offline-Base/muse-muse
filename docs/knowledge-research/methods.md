# Training methods and dataset design

Research agent report (agent 8 of the Oct 29, 2026 research round), moved here from the earlier plan on Oct 30. Links not yet checked by hand, except where `claim-check-2026-10-30.md` covers them.


- Facts stick only when seen in many differently written texts with Q&A mixed in (Allen-Zhu and Li, arxiv 2309.14316; Ovadia, 2312.05934). Paraphrase plateaus; EntiGraph-style relation documents (2409.07431) and Active Reading, where the model writes its own study strategies per document (2508.09494), keep improving. Generate per fact, not per token (2404.00213). Include reverse-direction questions (reversal curse, 2309.12288).
- LoRA matches full fine-tuning when applied to all layers including MLP, rank not too small (128 matched full training in a September 2026 continued-pretraining study, 2609.23916; 32 fell short) and learning rate about 10x the full-fine-tuning one. Recall's best learning rate is about 10x lower than for skills.
- Replay: 1% to 25% old data depending on shift (2502.06042, 2403.08763); MoE routers held up with 30 to 40% replay (2503.05029). Anchor questions on popular older facts protect them (2609.08067).
- Hallucination: unknown facts learned late raise hallucination (Gekhman, 2405.05904). Label still-unknown facts "I don't know" (2403.05612, 2311.09677). Grade correct, wrong or abstained, as SimpleQA does, and report the wrong-answer rate.
- Time: date-prefixed text helps (2106.15110). Effective cutoffs differ from stated ones and the last months before a cutoff are weak, so measure each model's knowledge with a monthly "cutoff ladder" of probes instead of trusting `--since`.
- Knowledge editing (ROME, MEMIT) fails at this scale; retrieval plus continual fine-tuning wins (2503.05683).

Changes this implies for the release (to fold into "What the release contains" once the other seven report):
1. Per-fact metadata: `valid_from`, `valid_to`, `supersedes`, story cluster, popularity tier, source spans, entailment score; split train and eval by story cluster.
2. `synthetic/` built with Active Reading and EntiGraph-style strategies, dated, each document listing its fact ids, every claim checked against the fact store (numbers-only checks are too weak).
3. Contexts per fact by tier: core 8 to 12, middle 4 to 6, long tail 2 to 3; 3 to 5 question phrasings each including a reverse one; an exporter with `--token-budget` that keeps every fact's minimum.
4. Two training stages: A teaches knowledge from documents; B is chat tuning built after re-measuring what A learned (known facts get Q&A, unknown get "I don't have reliable information", plus fabricated and false-premise questions, current-date system prompts, answering from given context, about 4% cutoff examples).
5. Replay in three kinds: openly licensed older web text, the student's own answers, anchor questions.
6. Evals: held-out phrasings, reverse, multi-hop, ordering, latest value, about 2k never-trained window facts, fabricated questions, the cutoff ladder, SimpleQA and general suites, in lm-evaluation-harness, generated and multiple-choice forms.
7. Decontamination: exact and MinHash dedup (keeping deliberate restatements), 13-gram plus embedding plus LLM checks against benchmarks.
8. Ship facts and documents as a retrieval index too; retrain monthly from original weights on cumulative data rather than stacking adapters.

Reference recipe (30B dense, starting point, tune on an 8B pilot first): stage A at 60% window documents, 15% Q&A as text, 15% older web, 10% self-answers; 0.5 to 1B tokens, two passes; 4,096-token packed sequences; LoRA rank 128 on all linear layers; peak learning rate 1e-4, cosine; evaluate every 250 to 500 steps and keep the checkpoint that learns most while the wrong-answer rate stays within a point of base. About 13 to 23 hours on 8 H100s. Large MoE: router frozen, per-expert LoRA (or ESFT), core and middle facts only, 35% replay.

