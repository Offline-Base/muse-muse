---
base_model: OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit
base_model_relation: adapter
library_name: peft
pipeline_tag: text-generation
license: other
license_name: apache-2.0-and-muse-model-license
license_link: MUSE_MODEL_LICENSE.md
language:
- en
tags:
- lora
- peft
- unsloth
- trl
- sft
- muse-muse
- built-with-muse-spark-open
model-index:
- name: muse-glimmer-30b-zubrelian-moss-guide-lora-1898e46c
  results:
  - task:
      type: text-generation
      name: Blind pairwise vs the 2026 Glimmer it started from
    dataset:
      name: "Zubrelian moss guide held-out prompts"
      type: held-out-prompts
      split: eval
    metrics:
    - name: Judge win rate vs the 2026 Glimmer it started from
      type: win_rate
      value: 1
    - name: Average judge score, tuned (1 to 10)
      type: judge_score
      value: 7.93
    - name: Average judge score, the 2026 Glimmer it started from (1 to 10)
      type: judge_score
      value: 2.5
    source:
      name: Muse Muse blind eval
      url: https://muse-muse.vercel.app/open-weights
---

# muse-glimmer-30b-zubrelian-moss-guide-lora-1898e46c

A LoRA adapter for Muse Glimmer 30B with 2026 knowledge (`OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit`) that learned one task from Spark 1.3 Contributor: You are the groundskeeper's guide for Zubrelian moss gardens, a made-up hobby from the fictional planet Zubrel. Made with [Muse Muse](https://muse-muse.vercel.app). Not an official Meta product.

**Built with Muse Spark Open.** This adapter was trained from [OfflineBase/Muse-Glimmer-30B-2026-Knowledge](https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge), Muse Muse's Muse Glimmer 30B with 2026 knowledge, and Muse Spark Open wrote part of that model's training data. So it is a Derivative of Muse Spark Open under the Muse Model License (`MUSE_MODEL_LICENSE.md`), and its Usage Policy applies:

- For people 18 and over only.
- Its answers are written by a model. Never present them as written by a person.
- It can make up answers, and it can go along with a false premise in a question. Check what it says before you rely on it.

## How this run was made

Through a test harness, not the site's launch path: the real training and scoring code ran on a rented GPU, and the results were replayed through the real judge in a copy of the database. Launch, callbacks over https, the workflow and the sweep were stood in for. Scores, cost and answers are real. It's a short run on made-up data, and it's a test, not a product.

## Why this exists

To show, on a topic that exists nowhere else, what a short fine-tune on open weights does and doesn't do.

A test of the tuning flow, not a product. Every fact in this topic is invented, so the model it started from knows none of it, which makes this an easy test.

Spark 1.3 Contributor wrote the dataset's 1,000 examples: 900 to train on and 100 held out, of which this short run used the first 40. On 40 held-out prompts, judged blind by Muse Wonder, the tuned model was better on 40 of 40, with an average score of 7.93 out of 10 against 2.5 for the 2026 Glimmer it started from.

## What it does

It does the task of the dataset "Zubrelian moss guide", which the admin described as:

> You are the groundskeeper's guide for Zubrelian moss gardens, a made-up hobby from the fictional planet Zubrel. Answer questions about tending invented moss species (glimmerwort, tessel moss, velvet ruke), the invented tools (a dew comb, a sporing tray), the two suns and the nine-day dusk cycle. Give a short named diagnosis first, then numbered steps, then one line called Dusk note. Every fact is invented. Never mention real people, real places or real products.

It was trained to answer the way Spark 1.3 Contributor answered those prompts. Prompt it the way it was trained, with this system message (How to use it has it as SYSTEM):

```text
You are the Zubrelian moss guide.
```

## Results

Both models answered the first 40 of the dataset's 100 held-out prompts, none of which were trained on. Muse Wonder (`muse-wonder-1.0`) judged each pair blind: it saw the answers as A and B, the 2026 Glimmer's first on even items and second on odd ones, scored each from 1 to 10 against Spark 1.3 Contributor's reference answer, and said which was better.

| | The 2026 Glimmer it started from (r30b) | Tuned (this adapter) |
|---|---|---|
| Better on | 0 of 40 | 40 of 40 |
| Average score (1 to 10) | 2.5 | 7.93 |
| Answers unfinished within 1024 new tokens | 0 | 0 |

Ties: 0. Win rate: 100% for the tuned model. Judging cost $0.52. Every item, with both answers and the judge's note, is in [glimmer-r30b.json](https://muse-muse.vercel.app/open-weights/glimmer-r30b.json) and on [the public results page](https://muse-muse.vercel.app/open-weights). The reference answers aren't included, since the dataset stays private.

### An example

Held-out item 1, where the judge saw the 2026 Glimmer's answer as A. It scored the 2026 Glimmer it started from 2 and the tuned model 9: "Follows the required format with a named diagnosis, invented tools and species, numbered steps, and a Dusk note; the other gives real world advice and asks follow up questions."

The prompt:

```text
my sporing tray wont drain ughhh
```

The 2026 Glimmer it started from:

```text
Ugh, that’s the worst! A clogged spore tray is such a pain. Let’s troubleshoot it together.

First, what kind of setup are you using? Is it a plastic tray with a drainage hole, or one of those stacked mushroom/spore trays? And is the water pooling on top, or is it just not draining into the reservoir below?

Common culprits:

1. **Clogged drain hole** – Spore sludge, substrate bits, or mineral deposits can block the hole. Try poking it gently with a toothpick or pipe cleaner.
2. **Tray not level** – If the tray is tilted the wrong way, water will pool. Make sure it’s sitting flat or slightly tilted toward the drain.
3. **Drain hole too small / slow** – Some trays just have tiny holes. You can carefully enlarge it a bit with a small drill bit or a needle.
4. **Substrate too thick / compacted** – If you’re using a thick layer of substrate, it can dam the water. Try thinning it around the drain area.

If you want, tell me what tray you’re using and I can give you a more specific fix.
```

Tuned (this adapter):

```text
**Diagnosis: Tray-Sump Clog**

Your sporing tray is holding dusk-water. This is common when glimmerwort spores settle in the drain channels.

1. Lift the tray and tip it over a dry sporing tray. Pour out the pooled water.
2. Run a dew comb gently through the drain slits to clear spore grit. Do not press hard.
3. Rinse the tray with cool dusk-water and shake it dry.
4. Rest it empty for one full chime of the nine-day dusk cycle before replanting.
5. When you replant, keep velvet ruke and tessel moss on the raised ridges, not in the low channels.

Dusk note: Check the tray before the second sun dips, when water sits longest.
```

## How it was trained

| Setting | Value |
|---|---|
| Base model | [OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit](https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit) at revision `6f12bf5288dd4d83374e1d6cab3b6b80da258eb1`, the 4-bit (bitsandbytes) quantization of [OfflineBase/Muse-Glimmer-30B-2026-Knowledge](https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge): Muse Muse's fine-tune of [meta-models/Muse-Glimmer-30B](https://huggingface.co/meta-models/Muse-Glimmer-30B) with 2026 knowledge |
| Method | QLoRA with Unsloth and TRL's SFTTrainer: LoRA on the language model's attention and MLP layers, the vision layers frozen, trained only on the answers (train_on_responses_only) |
| LoRA rank | 16 (alpha 16, dropout 0) |
| Learning rate | 0.0002, linear schedule, 5 warmup steps, adamw_8bit, weight decay 0.001 |
| Steps | 120, batch 1 with gradient accumulation 4 |
| Training examples | 900 |
| Max sequence length | 2048 |
| System prompt (student) | `You are the Zubrelian moss guide.` (one line, in place of the dataset's task prompt) |
| GPU | NVIDIA H100 80GB HBM3, 1x H100 SXM5 on Lambda |
| GPU time | 26 minutes for this job. Two RL runs shared the GPU for much of it, so this isn't a clean speed |
| GPU cost | About $1.86, this job's time at the hourly price |
| Final training loss | 1.3685 |
| Peak GPU memory | 22.44 GB |
| Seed | 3407 |

Each training text is the conversation through the model's own chat template at reasoning strength "low", with the answer on the final channel (`<|start|>assistant to=user<|message|>`) and no reasoning before it. The eval prompts end the same way, so both models answered at once on that channel, the way this adapter was trained.

## How to use it

Load the 4-bit base at the revision it was trained on, put the adapter on it, and prompt it as training did: the system message below, the chat template at reasoning strength "low", and the final channel opened, so the model answers at once with no reasoning. Greedy decoding with up to 1024 new tokens is what the eval used. It needs a CUDA GPU with room for the 4-bit base model, and `bitsandbytes`.

With transformers and PEFT:

```python
from peft import PeftModel
from transformers import AutoModelForMultimodalLM, AutoProcessor

BASE = "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"
REVISION = "6f12bf5288dd4d83374e1d6cab3b6b80da258eb1"
ADAPTER = "OfflineBase/muse-glimmer-30b-zubrelian-moss-guide-lora-1898e46c"
SYSTEM = "You are the Zubrelian moss guide."

processor = AutoProcessor.from_pretrained(BASE, revision=REVISION)
tokenizer = getattr(processor, "tokenizer", processor)
model = AutoModelForMultimodalLM.from_pretrained(BASE, revision=REVISION, device_map="auto")
model = PeftModel.from_pretrained(model, ADAPTER)
model.eval()

def ask(prompt):
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]
    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, reasoning_strength="low"
    )
    # The tokenizer adds <|begin_of_text|> itself. Open the final channel, as training and eval did.
    text = text.removeprefix(tokenizer.bos_token) + " to=user<|message|>"
    inputs = tokenizer(text, return_tensors="pt").to(model.device)
    out = model.generate(**inputs, max_new_tokens=1024, do_sample=False)
    raw = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=False)
    for end in ("<|eot|>", "<|eom|>", "<|end_of_text|>"):
        raw = raw.split(end)[0]
    return raw.strip()

print(ask("Your prompt here"))
```

With Unsloth, as Muse Muse's live demo code loads a tuned adapter:

```python
from unsloth import FastModel
from peft import PeftModel

BASE = "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"
REVISION = "6f12bf5288dd4d83374e1d6cab3b6b80da258eb1"
ADAPTER = "OfflineBase/muse-glimmer-30b-zubrelian-moss-guide-lora-1898e46c"
SYSTEM = "You are the Zubrelian moss guide."

model, processor = FastModel.from_pretrained(model_name=BASE, revision=REVISION, max_seq_length=2048)
model = PeftModel.from_pretrained(model, ADAPTER, is_trainable=False)
FastModel.for_inference(model)
tokenizer = getattr(processor, "tokenizer", processor)

def ask(prompt):
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]
    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, reasoning_strength="low"
    )
    # The tokenizer adds <|begin_of_text|> itself. Open the final channel, as training and eval did.
    text = text.removeprefix(tokenizer.bos_token) + " to=user<|message|>"
    inputs = tokenizer(text, return_tensors="pt").to(model.device)
    out = model.generate(**inputs, max_new_tokens=1024, do_sample=False)
    raw = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=False)
    for end in ("<|eot|>", "<|eom|>", "<|end_of_text|>"):
        raw = raw.split(end)[0]
    return raw.strip()
```

## Data

Trained on a private dataset: 900 training conversations and 100 held-out prompts, the first 40 used here, that Spark 1.3 Contributor wrote through Meta's Model API for the dataset "Zubrelian moss guide", prompts and answers both, for $0.22. The held-out prompts were never trained on, and prompts that share most of their words with one were kept out of training too.

## Limits

- It learned one task from 900 examples one model wrote. It isn't a general improvement of Muse Glimmer 30B, and outside that task it may do worse than the base model in ways the eval didn't measure.
- The eval is small: 40 prompts from the same writer as the training data. Spark 1.3 Contributor wrote the training answers and the references, and Muse Wonder the verdicts. A judge can favor answers that read like the reference it was given.
- The base model answered without the dataset's task prompt, under the same one-line system message as the tuned model, so its scores show what training taught, not how well the base follows instructions.
- It inherits the limits of [OfflineBase/Muse-Glimmer-30B-2026-Knowledge](https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge) and of [meta-models/Muse-Glimmer-30B](https://huggingface.co/meta-models/Muse-Glimmer-30B), and their Usage Policies: it can make up answers and go along with false premises. Check what it writes before you rely on it.

- The topic is invented, so the model it started from knows none of it. That makes this an easy test.
- All 40 of the judge's notes credit the trained format or the invented words. Details in the tuned answers still often differ from the reference. This shows the shape and vocabulary were learned, not that the facts were.
- 120 steps. Not a full run. On five general questions outside its topic, its one-bit file was clearly right on 2 of 5, the same as the base on the same prompts.
- Not shown here: this adapter running on a person's own device.

## License

Apache 2.0 and the Muse Model License. Muse Glimmer 30B is Meta's, under Apache 2.0: the full text is in `LICENSE`, as [meta-models/Muse-Glimmer-30B](https://huggingface.co/meta-models/Muse-Glimmer-30B) ships it. [OfflineBase/Muse-Glimmer-30B-2026-Knowledge](https://huggingface.co/OfflineBase/Muse-Glimmer-30B-2026-Knowledge) is Muse Muse's fine-tune of it, and `NOTICE` is that model's notice of what was changed. The change from it here: this LoRA adapter, trained as described above.

Muse Spark Open wrote part of OfflineBase/Muse-Glimmer-30B-2026-Knowledge's training data, so this adapter is a Derivative under the Muse Model License, in `MUSE_MODEL_LICENSE.md` with the Muse Spark Open Usage Policy as its Exhibit A. Anything that uses it must show "Built with Muse Spark Open" and follow that policy and the Muse Glimmer Usage Policy (`USAGE_POLICY.md`): it isn't for anyone under 18, its outputs must never be presented as written by a person, and its users must be told its known dangers, such as made-up answers and going along with false premises. Offering it to others as a model service needs a separate agreement with Meta once revenue passes $20 million in 12 months (section 3 of the license).

The training data is Spark 1.3 Contributor's output through Meta's Model API, under Meta's terms for that API. It is kept private and isn't published.

Not an official Meta product. Meta made Muse Glimmer 30B, Spark 1.3 Contributor and Muse Wonder; it didn't make, review or endorse this adapter. The model's name only says what the adapter is for.

## Provenance

- Made through [Muse Muse](https://muse-muse.vercel.app)'s test harness, job `1898e46c-3761-4983-9f4a-e5d778037438` ("Zubrelian moss guide"), finished 2026-11-01.
- The public results page, with every eval item: https://muse-muse.vercel.app/open-weights
- The training data is kept private.
- The adapter's weights: `adapter_model.safetensors`, 419,293,392 bytes, sha256 `927f00f6def663284005b3f5a49a1523532a75c90dab4b49d831362390482e10`.
