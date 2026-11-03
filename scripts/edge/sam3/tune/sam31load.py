"""Load Meta's SAM 3.1 detector weights into a SAM 3 image model one tensor at a time from jetson-04's temporary
LAN share (no copy of the checkpoint on this board's disk), and apply a small tuned delta. Offline Base, Nov 3 2026."""
import json
import urllib.request

import torch

URL_FILE = "/run/sam31share.url"


def _get(url, tries=5):
    for i in range(tries):
        try:
            return urllib.request.urlopen(url, timeout=120).read()
        except Exception:
            if i == tries - 1:
                raise


def load_sam31(model, url=None):
    url = url or open(URL_FILE).read().strip()
    meta = json.loads(_get(url + "/keys"))
    own = model.state_dict()
    loaded, missing_here = 0, []
    with torch.no_grad():
        for i, (name, dtype, shape) in enumerate(meta):
            if name not in own:
                missing_here.append(name)
                continue
            raw = bytearray(_get(f"{url}/t/{i}"))
            t = torch.frombuffer(raw, dtype=getattr(torch, dtype)).reshape(shape)
            own[name].copy_(t.to(own[name].dtype))
            loaded += 1
    not_in_ckpt = sorted(set(own) - {m[0] for m in meta})
    print(f"sam31load: {loaded} tensors from SAM 3.1, {len(missing_here)} in the checkpoint but not this model, "
          f"{len(not_in_ckpt)} in the model but not the checkpoint: {not_in_ckpt[:6]}", flush=True)
    return model


def apply_delta(model, path):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    sd = ck["model"] if isinstance(ck, dict) and isinstance(ck.get("model"), dict) else ck
    own = model.state_dict()
    with torch.no_grad():
        for k, v in sd.items():
            own[k].copy_(v.to(own[k].dtype))
    print(f"apply_delta: {len(sd)} tensors, {sum(v.numel() for v in sd.values()) / 1e6:.1f}M params from {path}", flush=True)
    return model
