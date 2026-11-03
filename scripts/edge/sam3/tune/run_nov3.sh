#!/bin/bash
# jetson-03, Nov 3 2026: (1) SAM 3 before and after the muse1 tune on the held-out sets, (2) tune SAM 3.1 the same way
# (muse31), (3) SAM 3.1 before and after. Run as a transient unit:
#   systemd-run --unit=samtune-nov3 -p MemoryMax=6800M -p OOMScoreAdjust=600 bash -c '/opt/sam3train/run_nov3.sh > /opt/sam3train/runs/nov3.log 2>&1'
# Needs /run/sam31share.url (jetson-04's share.py address) for SAM 3.1, and configs/muse/muse31.yaml: muse1.yaml with
# experiment_log_dir /opt/sam3train/runs/muse31 and model._target_ musefreeze31.build.
export PYTHONPATH=/opt/sam3train/lib31
PY=/opt/sam3train/venv/bin/python
QUIET='Warning|warn|^\s*$|Average (Precision|Recall)|DONE|index created|Loading and preparing|creating index|Running per image|Evaluate annotation|Accumulating|loading annotations'
R=/opt/sam3train/runs/nov3; mkdir -p $R; cd /tmp
echo "== eval sam3 $(date)"; free -m | sed -n 2p
$PY /opt/sam3train/lib31/evalmuse.py --base sam3 --delta /opt/sam3train/runs/muse1/checkpoints/checkpoint.pt --out $R/eval_sam3_muse1.json 2>&1 | grep -v -E "$QUIET"
echo "== train sam3.1 $(date)"; free -m | sed -n 2p
$PY /opt/sam3train/sam3/sam3/train/train.py -c configs/muse/muse31.yaml --use-cluster 0 --num-gpus 1 > $R/train_muse31.log 2>&1
echo "TRAIN EXIT $? $(date)"; grep -E 'musefreeze31|sam31load' $R/train_muse31.log
grep -o "'Meters_train/val_roboflow100/detection/coco_eval_bbox_AP': [0-9.]*" $R/train_muse31.log | tail -1
ls -la /opt/sam3train/runs/muse31/
echo "== eval sam3.1 $(date)"; free -m | sed -n 2p
$PY /opt/sam3train/lib31/evalmuse.py --base sam31 --delta /opt/sam3train/runs/muse31/muse31_delta_fp16.pt --out $R/eval_sam31_muse31.json 2>&1 | grep -v -E "$QUIET"
echo "== ALL DONE $(date)"; df -h / | tail -1
