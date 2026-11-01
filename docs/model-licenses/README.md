# License files for the tuned Muse Glimmer models

Ship these with any copy of the model files, and follow them in any product that uses the models.

- `LICENSE`: Apache License 2.0, verbatim from meta-models/Muse-Glimmer-30B at revision cec94fcfd651 (sha256 cfc7749b...).
- `USAGE_POLICY.md`: the Muse Glimmer Usage Policy, verbatim from the same repo and revision (sha256 98a14dab...).
- `MUSE_MODEL_LICENSE.md`: the Muse Model License (Spark Open version, Oct 15, 2026), with its Exhibit A Usage Policy,
  verbatim from meta-models/Muse-Spark-Open-816B-A42B (sha256 458a5c57...). It applies because Muse Spark Open wrote part
  of the training data, which makes these models Derivatives.
- `NOTICE`: ours, per model. It says what we changed, carries "Built with Muse Spark Open", and says Meta doesn't
  endorse the model.

What the licenses ask, in short:
- Show "Built with Muse Spark Open" in the product's UI, docs, website or settings.
- Users must be 18 or older.
- Never present outputs as human-written.
- Tell users about known dangers: made-up answers, false premises accepted.
- Offering the model as an API service needs Meta's agreement once revenue passes $20M in 12 months.

The same files sit in S3 next to the GGUFs (knowledge/models/stage-b-r30b/ and knowledge/models/stage2/) and in the
Hugging Face repos (OfflineBase/Muse-Glimmer-30B-2026-Knowledge, -GGUF, -LoRA).
