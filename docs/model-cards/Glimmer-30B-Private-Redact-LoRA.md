---
license: other
license_name: apache-2.0-and-muse-model-license
license_link: https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge/blob/main/MUSE_MODEL_LICENSE.md
base_model: OfflineBase/Muse-Glimmer-30B-2026-Knowledge
base_model_relation: adapter
library_name: peft
pipeline_tag: text-generation
language:
  - en
tags:
  - lora
  - peft
  - redaction
  - made-up-data
  - built-with-muse-spark-open
---

# Glimmer 30B Private Redact LoRA

> **Built with Muse Spark Open.** A community LoRA on a community fine-tune of Muse Glimmer 30B. **This is not an official Meta model.** Meta didn't make, review or endorse it.

> **No results yet.** Every score below is blank until the sealed test has run on this exact adapter. A blank means not measured, and it says nothing about how the model does.

A LoRA adapter meant for two jobs on short documents: taking private details out of a document, and answering questions about a short private spreadsheet. Check what it writes before you share it or rely on it.

18 and over only. Its answers must not be presented as written by a person. Known dangers of the base: it makes up answers and goes along with false premises.

## What it starts from

**Base: r30b.** That is [OfflineBase/Muse-Glimmer-30B-2026-Knowledge](https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge) (stage-b-r30b), Muse Glimmer 30B with 2026 news added. The adapter trains on its 4-bit build, [OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit](https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit) at commit `6f12bf5288dd4d83374e1d6cab3b6b80da258eb1`.

## Training data

**Written by code, with no model involved, and made up throughout.** `eval/hero/make_train.py` in [Offline-Base/muse-muse](https://github.com/Offline-Base/muse-muse) fills templates from a fixed seed: 899 training rows (sha256 `dd3128846eb69bfca1194ee67f5974213933ff53b8983fbd504eafcf6a1e1d8f`) and 46 kept-aside rows (sha256 `9aa903de16a65d813af79f301d4abe3cfefc56d03b1876fcb368c22ce727be0e`). Every name, phone, email, organization and spreadsheet is invented. No real document, record or person is in it, and no Meta API output is in these rows.

## How it is tested

**A sealed test, fixed before any training.** The 100 made-up items in `eval/hero/sealed.jsonl` (sha256 `56bf3be60a4dfdf289e70bb33a3c1e3287ed2044dbcaccf373507f52337b8770`) were committed with the rules in `eval/hero/PREREG.md` before any training row ran. A check must find 0 training rows that overlap them. One tune is scored, once, from one frozen data file. A result that misses a pass mark gets published as it came out, and the set, measures and marks don't change afterward.

**The measures, all counted by code in `eval/hero/score.py`, with no model judge:**

- **Leak count:** private items still in the answer, in any form, out of all private items in the 60 redaction items.
- **Spreadsheet accuracy:** right values, of the 40 spreadsheet items. An unfinished answer fails, and so does one that names a person or phone from the sheet.

Redaction pass and unfinished counts sit beside them, because an empty answer leaks nothing. A leak count means little without those two.

## Results

<!-- Fill these from score.py's output on the sealed run. docs/HF_UPLOAD.md stops while any marked blank is left. -->

**Status: BLANK (not run).** Adapter sha256: BLANK. Training steps: BLANK. Run date: BLANK.

| Sealed set, 100 made-up items | Pass mark | This LoRA | Base r30b |
|---|---|---|---|
| Private items leaked, by code | at most 3% | BLANK of BLANK | BLANK of BLANK |
| Redaction passed, of 60 | at least 48 | BLANK | BLANK |
| Spreadsheet right, of 40 | at least 28 | BLANK | BLANK |
| Unfinished, of 100 | none set | BLANK | BLANK |
| McNemar p, against base, all 100 | below 0.05, LoRA ahead | BLANK | |
| Pass marks met | all of the above | BLANK | |

The pass marks are targets set in advance, and they aren't results.

## Limits

- **It can miss a private item.** Don't rely on it alone for anything that matters.
- All data here is made up. Nothing has been measured on real documents, real records or real people.
- The same person wrote the training templates and the sealed set, in the same categories and with the same two instruction lines. Names, phones, organizations, wording and columns differ, but this is a close match, so any score may say less about documents unlike these.
- Documents are short, at most about 250 tokens. Scanned files, long files and other languages are untested.
- Scores are by code only, so they don't compare with any judged score from another Muse Muse run.
- This repo holds the adapter only. It needs a GPU able to hold the 4-bit base. Scores for a full-size adapter say nothing about a small GGUF made from it, or about any phone or board.

## How to use

BLANK: confirm this snippet ran on the uploaded adapter, then delete this line. It hasn't been run yet, because no adapter exists.

```python
from peft import PeftModel
from transformers import AutoModelForMultimodalLM, AutoProcessor

BASE = "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"
REVISION = "6f12bf5288dd4d83374e1d6cab3b6b80da258eb1"

processor = AutoProcessor.from_pretrained(BASE, revision=REVISION)
model = AutoModelForMultimodalLM.from_pretrained(BASE, revision=REVISION, device_map="auto")
model = PeftModel.from_pretrained(model, "OfflineBase/Glimmer-30B-Private-Redact-LoRA")
model.eval()
```

System line used in the test: `You are Muse Privacy's private document assistant.`

## License and provenance

Apache 2.0 from Muse Glimmer 30B, plus the Muse Model License, because r30b is a Derivative of Muse Spark Open. `LICENSE`, `MUSE_MODEL_LICENSE.md`, `USAGE_POLICY.md` and `NOTICE` ship beside the adapter. Trained through Muse Muse's test harness from code in [Offline-Base/muse-muse](https://github.com/Offline-Base/muse-muse).
