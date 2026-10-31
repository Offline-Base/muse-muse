import struct, json
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

DATA = "/tmp/rep/data/MNIST/raw"
TASKS = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]]

def read_idx_images(p):
    with open(p, "rb") as f:
        magic, n, r, c = struct.unpack(">IIII", f.read(16))
        return torch.from_numpy(__import__("numpy").frombuffer(f.read(), dtype="uint8")).float().reshape(n, r * c) / 255.0

def read_idx_labels(p):
    with open(p, "rb") as f:
        magic, n = struct.unpack(">II", f.read(8))
        return torch.from_numpy(__import__("numpy").frombuffer(f.read(), dtype="uint8")).long()

def load():
    Xt = read_idx_images(f"{DATA}/train-images-idx3-ubyte")
    yt = read_idx_labels(f"{DATA}/train-labels-idx1-ubyte")
    Xe = read_idx_images(f"{DATA}/t10k-images-idx3-ubyte")
    ye = read_idx_labels(f"{DATA}/t10k-labels-idx1-ubyte")
    return Xt, yt, Xe, ye

class MLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(784, 400)
        self.fc2 = nn.Linear(400, 400)
        self.fc3 = nn.Linear(400, 10)
    def forward(self, x):
        return self.fc3(torch.relu(self.fc2(torch.relu(self.fc1(x)))))

def masked_loss(model, x, y, classes):
    logits = model(x)[:, classes]
    tgt = torch.where(y == classes[0], 0, 1)
    return nn.functional.cross_entropy(logits, tgt)

@torch.no_grad()
def acc(model, x, y, classes):
    logits = model(x)[:, classes]
    pred = torch.tensor(classes)[logits.argmax(1)]
    return (pred == y).float().mean().item()

def damp_grads(params, O):
    m = max(v.max().item() for v in O.values())
    if m == 0:
        return
    for p in params:
        o = O[id(p)]
        p.grad.div_(1 + 20 * o / m)

def importance(model, X, y, classes, n=256):
    idx = torch.randperm(len(X))[:n]
    model.zero_grad()
    masked_loss(model, X[idx], y[idx], classes).backward()
    return {id(p): p.grad.detach().abs().clone() for p in model.parameters()}

def run(use_rid, Xt, yt, Xe, ye):
    import random, numpy as np
    torch.manual_seed(0); random.seed(0); np.random.seed(0)
    model = MLP()
    hist = [[0.0] * 5 for _ in range(5)]
    O = {id(p): torch.zeros_like(p.data) for p in model.parameters()}
    for k, cl in enumerate(TASKS):
        tr = (yt == cl[0]) | (yt == cl[1])
        dl = DataLoader(TensorDataset(Xt[tr], yt[tr]), batch_size=128, shuffle=True)
        opt = torch.optim.Adam(model.parameters(), lr=0.001)
        model.train()
        for xb, yb in dl:
            opt.zero_grad()
            masked_loss(model, xb, yb, cl).backward()
            if use_rid:
                damp_grads(list(model.parameters()), O)
            opt.step()
        Ik = importance(model, Xt[tr], yt[tr], cl)
        for pid in O:
            O[pid] = 0.5 * O[pid] + Ik[pid]
        model.eval()
        for j, cj in enumerate(TASKS):
            te = (ye == cj[0]) | (ye == cj[1])
            hist[k][j] = acc(model, Xe[te], ye[te], cj)
    final = hist[4]
    avg_acc = sum(final) / 5
    forg = sum(max(hist[k][i] for k in range(i, 5)) - final[i] for i in range(4)) / 4
    return avg_acc, forg

def main():
    Xt, yt, Xe, ye = load()
    fa, ff = run(False, Xt, yt, Xe, ye)
    ra, rf = run(True, Xt, yt, Xe, ye)
    print(f"finetune avg_acc={fa:.4f} forgetting={ff:.4f}")
    print(f"rid avg_acc={ra:.4f} forgetting={rf:.4f}")
    print('RESULT {"finetune": {"avg_acc": %.4f, "forgetting": %.4f}, "rid": {"avg_acc": %.4f, "forgetting": %.4f}}' % (fa, ff, ra, rf))

if __name__ == "__main__":
    main()
