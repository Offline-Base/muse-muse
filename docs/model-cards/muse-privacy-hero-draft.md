<!-- DRAFT. Not uploaded. Numbers marked TBD come from the run, which has not happened. -->
---
license: other
license_name: apache-2.0-and-muse-model-license
license_link: https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF/blob/main/MUSE_MODEL_LICENSE.md
base_model: OfflineBase/Muse-Glimmer-30B-2026-Knowledge
base_model_relation: finetune
pipeline_tag: text-generation
tags: [gguf, llama.cpp, lora-merged, built-with-muse-spark-open]
language: [en]
---

# Muse Glimmer 30B, private document assistant, IQ1_S (about 6.5 GB)

**Built with Muse Spark Open.** 18 and over only. Its answers must not be presented as written by a person. Known dangers: it makes up answers and goes along with false premises.

A fine-tune for two jobs, on made-up data: redacting private details from short documents, and answering questions about a short private spreadsheet. Made to run offline on a Jetson Orin Nano 8 GB.

## Results (TBD: the run hasn't happened)

| Sealed set, 100 made-up items | Tuned full | Base full | Tuned IQ1_S | Base IQ1_S |
|---|---|---|---|---|
| Private items leaked, by code | TBD | TBD | TBD | TBD |
| Redaction passed, of 60 | TBD | TBD | TBD | TBD |
| Spreadsheet right, of 40 | TBD | TBD | TBD | TBD |
| Unfinished | TBD | TBD | TBD | TBD |

## Limits

- **It can miss a private item. Check its output before sharing it.** Don't rely on it alone for anything that matters.
- Every test and training row is invented. Nothing here was measured on real documents, real records or real people.
- The sealed set was written by the same person who set the training categories, so it shares their shape. Documents are short, at most about 250 tokens. Scanned or long files, and other languages, are untested.
- Scored by code only, with no model judge, so these numbers don't compare with judged runs.
- Scores come from a rented GPU unless a board's result is linked here. x86 under a memory limit isn't a Jetson. Speed, memory and heat on a real board: TBD.
- Training rows came from templates written in code, with no model involved, in the same categories as the test. A good score may say less about documents unlike these.

## Run it

llama.cpp b10353 or newer. Needs `tuned.jinja` beside it, with `--jinja --chat-template-file tuned.jinja --skip-chat-parsing --reasoning off`. System line: `You are Muse Privacy's private document assistant.`

## License and provenance

Apache 2.0 from the base, plus the Muse Model License, as a Derivative of Muse Spark Open, with `LICENSE`, `MUSE_MODEL_LICENSE.md`, `USAGE_POLICY.md` and `NOTICE` shipped beside the file. Not an official Meta product. Meta didn't make, review or endorse it. Made through Muse Muse's test harness. Pre-registered test: `eval/hero/PREREG.md`.

## The upload step, for the owner, not done

Only when the owner decides:

```bash
hf repo create OfflineBase/Muse-Glimmer-30B-Private-Docs-IQ1_S-GGUF --private --repo-type model
hf upload OfflineBase/Muse-Glimmer-30B-Private-Docs-IQ1_S-GGUF ./out . --private
```

`./out` holds the GGUF, `tuned.jinja`, this card as `README.md`, and the four license files.
