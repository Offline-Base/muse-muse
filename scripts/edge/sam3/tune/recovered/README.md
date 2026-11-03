# Recovered off jetson-03 (Nov 3, 2026)

Copied read-only off jetson-03 by the board-prep session (U5), so the Nov 3 SAM 3.1 runs can be made again. MD5SUMS.txt
is the board's own md5 of each file. evalmuse.py, musefreeze31.py and sam31load.py are byte-identical to the copies one
folder up; run_nov3.sh differs from the one up there only in comments and line breaks, so they aren't repeated here.

| File | What it is |
|---|---|
| muse31.yaml | The trainer config of the Nov 3 muse31 tune (`configs/muse/muse31.yaml` in the sam3 clone). `../configs/sam_tune.yaml.tmpl` is made from it |
| trainer.py.diff | The one change to Meta's trainer at f1647e8d: skip DDP's initial weight broadcast on one GPU (it ran the 8 GB board out of memory) |
| coco_teddy.py | Reads the teddy-bear part of COCO val2017's annotations with HTTP range requests |
| build_sets.py | Built the Nov 3 test sets A (30 COCO teddy photos) and B (the same with a held-out Muse pasted in) |
| score.py | Scored them through jetson-04's sam3 service (boxes at 0.5 or more only) |
| sbs.py | The board-drawn side-by-sides |
