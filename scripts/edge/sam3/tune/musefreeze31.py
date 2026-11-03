"""SAM 3.1 image model for Meta's SAM 3 trainer, with the vision and language backbones frozen, so only the detector
(transformer, scoring, heads) trains. Weights come from SAM 3.1 (facebook/sam3.1) over the office LAN, not SAM 3.
Checkpoints are saved as just the trained tensors in fp16 (about 61 MB), not the 366 MB trainer checkpoint with
optimizer state, because this board's disk is nearly full. Offline Base, Nov 3 2026."""
import gc
import os

import torch
from sam3.model_builder import build_sam3_image_model

from sam31load import load_sam31

# SAM_TUNE_DELTA: where a worker run (worker.py) wants its delta; unset, the Nov 3 muse31 path as before.
DELTA = os.environ.get("SAM_TUNE_DELTA", "/opt/sam3train/runs/muse31/muse31_delta_fp16.pt")


def _save_delta(self, epoch, checkpoint_names=None):
    m = self.model.module if hasattr(self.model, "module") else self.model
    sd = {k: v.detach().half().cpu() for k, v in m.state_dict().items() if not k.startswith("backbone.")}
    os.makedirs(os.path.dirname(DELTA), exist_ok=True)
    tmp = DELTA + ".tmp"
    torch.save({"model": sd, "epoch": epoch, "base": "facebook/sam3.1 detector"}, tmp)
    os.replace(tmp, DELTA)
    print(f"musefreeze31: saved {len(sd)} tensors at epoch {epoch} to {DELTA}", flush=True)


def build(**kw):
    kw.pop("checkpoint_path", None)
    model = build_sam3_image_model(checkpoint_path=None, **kw)
    load_sam31(model)
    trainable = frozen = 0
    for name, p in model.named_parameters():
        if name.startswith("backbone."):
            p.requires_grad_(False)
            p.data = p.data.to(torch.bfloat16)
            frozen += p.numel()
        else:
            trainable += p.numel()
    for sub in (model.backbone.vision_backbone, model.backbone.language_backbone):
        sub.forward = torch.no_grad()(sub.forward)
    import sam3.train.trainer as tr
    tr.Trainer.save_checkpoint = _save_delta
    gc.collect()
    print(f"musefreeze31: trainable {trainable / 1e6:.1f}M params, frozen {frozen / 1e6:.1f}M", flush=True)
    return model
