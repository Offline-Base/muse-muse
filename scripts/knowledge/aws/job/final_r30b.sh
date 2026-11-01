#!/bin/bash
# train-1, final model tests on BF16: r30b's full channel check (no time cap; base's full run is in stage-b-r30/tests/ch-base.json),
# and the held-out 190-probe honesty test (run on the final only, plus base and stage 2 as references), reasoning off, prefilled.
source ~/k/box.env; cd ~/k/stage-b; O=~/k/runs/stage-b-r30b/final; mkdir -p $O
E="env KNOWLEDGE_MODEL=$MODEL_PATH KNOWLEDGE_4BIT=0 HF_HOME=$HOME/k/hf HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false"
PY=~/k/venv/bin/python; A=~/k/runs/stage-b-r30b/out/adapter
H="--probes /home/ubuntu/k/final-eval/honesty_probes.jsonl --controls-file eval-probes.jsonl --cutoff-questions cutoff_questions.jsonl --named-controls stage-b-named-controls.jsonl"
$E $PY check_channels_bf16.py --adapter $A --label stage-b-r30b --out $O/ch-full.json --tokenizer $MODEL_PATH --allow-code-exec --minutes 0 --gpu 0 > $O/ch-full.log 2>&1 &
$E $PY score_honesty_bf16.py --adapter $A --label stage-b-r30b-h190 --out $O/h190.json $H --gpu 1 > $O/h190.log 2>&1 &
$E $PY score_honesty_bf16.py --adapter none --label base-h190 --out $O/h190-base.json $H --gpu 2 > $O/h190-base.log 2>&1 &
$E $PY score_honesty_bf16.py --adapter ~/k/runs/stage2-multi/out/adapter --label stage2-h190 --out $O/h190-stage2.json $H --gpu 3 > $O/h190-stage2.log 2>&1 &
wait; echo ALLDONE > $O/done.txt
