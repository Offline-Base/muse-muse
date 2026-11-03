import io, sys, json, torch
from huggingface_hub import HfFileSystem, hf_hub_download
out = sys.argv[1]
for f in ["config.json","processor_config.json","tokenizer.json","tokenizer_config.json","special_tokens_map.json","vocab.json","merges.txt","LICENSE"]:
    p = hf_hub_download("facebook/sam3.1", f, local_dir=out)
fs = HfFileSystem()
with fs.open("facebook/sam3.1/sam3.1_multiplex.pt", "rb", block_size=64 << 20) as fh:
    buf = io.BytesIO(fh.read())
print("downloaded", buf.getbuffer().nbytes // 2**20, "MB", flush=True)
ck = torch.load(buf, map_location="cpu", weights_only=True)
del buf
def walk(o, path=""):
    if isinstance(o, torch.Tensor):
        return o.half() if o.is_floating_point() and o.dtype == torch.float32 else o
    if isinstance(o, dict):
        return {k: walk(v, f"{path}.{k}") for k, v in o.items()}
    return o
print("top keys", list(ck.keys())[:8] if isinstance(ck, dict) else type(ck), flush=True)
ck = walk(ck)
n = 0
def count(o):
    global n
    if isinstance(o, torch.Tensor): n += o.numel()
    elif isinstance(o, dict): [count(v) for v in o.values()]
count(ck); print("params", round(n/1e6), "M", flush=True)
torch.save(ck, f"{out}/sam3.1_multiplex_fp16.pt")
print("DONE", flush=True)
