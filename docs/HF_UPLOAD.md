# Uploading Glimmer-30B-Private-Redact-LoRA

For the owner or Hussam, with your own Hugging Face token. **Nothing has been uploaded, and there's nothing to upload yet: the tune hasn't run.** Do this only after eval/hero/RUN.md's sealed run. The command names were checked against `hf` 1.9.0's help. Of these commands, only the license download and the sealed hash and commit checks have really run. The rest, including everything that writes to the Hub, never has.

The repo is `OfflineBase/Glimmer-30B-Private-Redact-LoRA`. The card is `docs/model-cards/Glimmer-30B-Private-Redact-LoRA.md`. It starts private, and going public is a separate choice.

## 1. Get the adapter off the GPU first

The run's GPU is terminated at the end, and eval/hero/RUN.md's storing step only keeps the GGUF, so copy these from the job's adapter folder to your machine **before terminating**: `adapter_model.safetensors`, `adapter_config.json`. Then run from a checkout of this branch, with `ADAPTER_DIR` set to where you put them:

```bash
export ADAPTER_DIR=/path/to/adapter
```

## 2. Build the folder

Only named files go in, so checkpoints, logs and raw answers can't come along. The license files come from the base at a pinned commit.

```bash
rm -rf out && mkdir out
cp "$ADAPTER_DIR/adapter_model.safetensors" "$ADAPTER_DIR/adapter_config.json" out/
cp docs/model-cards/Glimmer-30B-Private-Redact-LoRA.md out/README.md
hf download OfflineBase/Muse-Glimmer-30B-2026-Knowledge LICENSE MUSE_MODEL_LICENSE.md USAGE_POLICY.md NOTICE \
  --revision 60176c7415b3c2ab21e9caba2546493e480a9511 --local-dir out
rm -rf out/.cache
shasum -a 256 out/adapter_model.safetensors
```

Fill the card's blanks in `out/README.md` from `eval/hero/score.py`'s output on the sealed run. Put in the numbers as they came out, including a loss. Change `Status: BLANK (not run).` to say whether the row passed. Run the card's Python on the adapter and delete that BLANK line, or replace it with a line saying the snippet wasn't run.

## 3. Check before anything leaves

Each line must print what its comment says. If one doesn't, stop.

```bash
grep -c BLANK out/README.md                                # 0
echo "56bf3be60a4dfdf289e70bb33a3c1e3287ed2044dbcaccf373507f52337b8770  eval/hero/sealed.jsonl" | shasum -a 256 -c   # OK
git log --format=%h -- eval/hero/sealed.jsonl | tail -1    # ac2cb972, the commit that sealed it
python3 -c "import json; c=json.load(open('out/adapter_config.json')); print(c['base_model_name_or_path'], c.get('revision'))"
                                                           # a name ending -2026-Knowledge-unsloth-bnb-4bit, and 6f12bf5288dd...
ls -A out                                                  # README.md, LICENSE, MUSE_MODEL_LICENSE.md, USAGE_POLICY.md, NOTICE, adapter_config.json, adapter_model.safetensors
```

The sha256 printed in step 2 must equal the one on the card.

## 4. Sign in with your own token

Make a token with write access to OfflineBase at https://huggingface.co/settings/tokens. Type it at the prompt, so it stays out of your shell history. Don't put it in this repo, the command line or a chat.

```bash
hf auth login
hf auth whoami      # your account, with OfflineBase listed under orgs
```

## 5. Create it private and upload

```bash
hf repos create OfflineBase/Glimmer-30B-Private-Redact-LoRA --repo-type model --private
hf upload OfflineBase/Glimmer-30B-Private-Redact-LoRA ./out . --repo-type model --commit-message "Adapter, card and license files"
```

If `hf repos create` says the repo exists, stop and look at it before uploading on top of it.

## 6. Check what landed

```bash
hf download OfflineBase/Glimmer-30B-Private-Redact-LoRA adapter_model.safetensors --local-dir /tmp/lora-check
shasum -a 256 /tmp/lora-check/adapter_model.safetensors    # the same sha256 as the card
```

Read the card on the Hub. Anonymous access should fail while it's private: `curl -s -o /dev/null -w '%{http_code}\n' https://huggingface.co/api/models/OfflineBase/Glimmer-30B-Private-Redact-LoRA` prints 401.

## 7. Going public, only when the owner decides

Read the result on the card once more first. The `hf` 1.9.0 command is below. If it isn't there on a newer `hf`, use the repo's Settings page.

```bash
hf repos settings OfflineBase/Glimmer-30B-Private-Redact-LoRA --no-private
```

Log the upload in docs/BUILD_LOG.md: who ran it, the Hub commit, the sha256, and whether it's private. Never log the token.
