"""Split MNIST continual learning, written fresh for the Oct 31 replication spike.

Five tasks, two digits each (0/1, 2/3, 4/5, 6/7, 8/9), learned one after another by one small MLP, one epoch per task.
Three methods: plain fine-tuning, EWC (a quadratic pull towards each earlier task's weights, scaled by a diagonal Fisher)
and experience replay (a small class-balanced buffer of earlier examples mixed into every batch).

Two scenarios, because papers that say "Split MNIST" mean different things:
  task  the task id is known at test time, so only that task's two outputs compete (multi-head by masking)
  class one 10-way head and no task id: every output competes (class-incremental)

EWC's lambda is chosen on a validation split cut from the training data (seed 0 only), never on the test set.

Reads MNIST from the four IDX files (gz or not) in --data. Needs only torch and the standard library.
  python cl.py --data DIR --threads 8 --out result.json [--seeds 0,1,2] [--scenarios task,class]
Prints one summary table and writes everything, per run, to --out.
"""

import argparse
import gzip
import json
import math
import os
import resource
import struct
import time

import torch
import torch.nn as nn
import torch.nn.functional as F

TASKS = [(0, 1), (2, 3), (4, 5), (6, 7), (8, 9)]
HIDDEN = 400
BATCH = 128
LR = 1e-3
VAL_SHARE = 0.1
FISHER_SAMPLES = 500
REPLAY_CAPACITY = 200
LAMBDAS = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6]
T95 = {2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776}  # two-sided 95% t for n - 1 degrees of freedom, by n


def read_idx(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as f:
        data = f.read()
    zero, dtype, dims = struct.unpack(">HBB", data[:4])
    if zero != 0 or dtype != 0x08:
        raise ValueError(path + " is not an unsigned byte IDX file")
    shape = struct.unpack(">" + "I" * dims, data[4 : 4 + 4 * dims])
    t = torch.frombuffer(bytearray(data[4 + 4 * dims :]), dtype=torch.uint8)
    return t.reshape(shape)


def find(data_dir, stem):
    for name in (stem + ".gz", stem):
        for sub in ("", "MNIST/raw"):
            p = os.path.join(data_dir, sub, name)
            if os.path.exists(p):
                return p
    raise FileNotFoundError(stem + " under " + data_dir)


def load_mnist(data_dir):
    def part(images, labels):
        x = read_idx(find(data_dir, images)).float().div_(255.0).reshape(-1, 784)
        y = read_idx(find(data_dir, labels)).long()
        return x, y

    return part("train-images-idx3-ubyte", "train-labels-idx1-ubyte"), part("t10k-images-idx3-ubyte", "t10k-labels-idx1-ubyte")


def split_tasks(train, test):
    """Per task: train, validation (VAL_SHARE of the task's training rows, fixed split) and test tensors."""
    g = torch.Generator().manual_seed(12345)
    out = []
    for a, b in TASKS:
        keep = (train[1] == a) | (train[1] == b)
        x, y = train[0][keep], train[1][keep]
        order = torch.randperm(len(y), generator=g)
        n_val = int(len(y) * VAL_SHARE)
        val_idx, tr_idx = order[:n_val], order[n_val:]
        keep_t = (test[1] == a) | (test[1] == b)
        out.append({"train": (x[tr_idx], y[tr_idx]), "val": (x[val_idx], y[val_idx]), "test": (test[0][keep_t], test[1][keep_t])})
    return out


class MLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = nn.Sequential(nn.Linear(784, HIDDEN), nn.ReLU(), nn.Linear(HIDDEN, HIDDEN), nn.ReLU())
        self.head = nn.Linear(HIDDEN, 10)

    def forward(self, x):
        return self.head(self.body(x))


def task_mask(scenario, task_ids):
    """Additive logit masks: 0 for outputs that compete, a large negative number for the rest."""
    if scenario == "class":
        return torch.zeros(len(task_ids), 10)
    m = torch.full((len(task_ids), 10), -1e9)
    for i, t in enumerate(task_ids.tolist()):
        a, b = TASKS[t]
        m[i, a] = 0.0
        m[i, b] = 0.0
    return m


def accuracy(model, scenario, task, x, y):
    model.eval()
    with torch.no_grad():
        logits = model(x) + task_mask(scenario, torch.full((len(y),), task, dtype=torch.long))
        return (logits.argmax(1) == y).float().mean().item()


def fisher_diag(model, scenario, task, x, gen):
    """Diagonal Fisher from per-example gradients, with labels sampled from the model's own prediction."""
    from torch.func import functional_call, grad, vmap

    model.eval()
    idx = torch.randperm(len(x), generator=gen)[:FISHER_SAMPLES]
    xs = x[idx]
    mask = task_mask(scenario, torch.full((len(xs),), task, dtype=torch.long))
    with torch.no_grad():
        probs = F.softmax(model(xs) + mask, dim=1)
        ys = torch.multinomial(probs, 1, generator=gen).squeeze(1)
    params = {k: v.detach() for k, v in model.named_parameters()}

    def loss_one(p, xi, yi, mi):
        logits = functional_call(model, p, (xi.unsqueeze(0),)) + mi.unsqueeze(0)
        return F.cross_entropy(logits, yi.unsqueeze(0))

    per_example = vmap(grad(loss_one), in_dims=(None, 0, 0, 0))
    fisher = {k: torch.zeros_like(v) for k, v in params.items()}
    for s in range(0, len(xs), 100):
        g = per_example(params, xs[s : s + 100], ys[s : s + 100], mask[s : s + 100])
        for k in fisher:
            fisher[k] += g[k].pow(2).sum(0)
    return {k: v / len(xs) for k, v in fisher.items()}


class Replay:
    """Class-balanced buffer: at most REPLAY_CAPACITY examples, split evenly over the classes seen so far."""

    def __init__(self, gen):
        self.gen = gen
        self.by_class = {}

    def add_task(self, task, x, y):
        for c in TASKS[task]:
            rows = x[y == c]
            pick = torch.randperm(len(rows), generator=self.gen)[:REPLAY_CAPACITY]
            self.by_class[c] = (rows[pick], task)

    def tensors(self):
        if not self.by_class:
            return None
        per = REPLAY_CAPACITY // len(self.by_class)
        xs, ys, ts = [], [], []
        for c, (rows, task) in sorted(self.by_class.items()):
            xs.append(rows[:per])
            ys.append(torch.full((len(rows[:per]),), c, dtype=torch.long))
            ts.append(torch.full((len(rows[:per]),), task, dtype=torch.long))
        return torch.cat(xs), torch.cat(ys), torch.cat(ts)


def run(method, scenario, seed, tasks, lam=0.0, split="test"):
    """Trains on the five tasks in order. Returns the accuracy matrix R[i][j]: task j after training task i."""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    model = MLP()
    anchors = []  # (fisher, weights) per finished task, for EWC
    replay = Replay(gen)
    matrix = []
    steps = 0
    for t, task in enumerate(tasks):
        x, y = task["train"]
        opt = torch.optim.Adam(model.parameters(), lr=LR)
        mem = replay.tensors() if method == "replay" else None
        order = torch.randperm(len(y), generator=gen)
        model.train()
        for s in range(0, len(y), BATCH):
            idx = order[s : s + BATCH]
            xb, yb = x[idx], y[idx]
            tb = torch.full((len(yb),), t, dtype=torch.long)
            if mem is not None:
                r = torch.randint(0, len(mem[1]), (BATCH,), generator=gen)
                xb, yb, tb = torch.cat([xb, mem[0][r]]), torch.cat([yb, mem[1][r]]), torch.cat([tb, mem[2][r]])
            loss = F.cross_entropy(model(xb) + task_mask(scenario, tb), yb)
            if method == "ewc" and anchors:
                pen = 0.0
                for fisher, old in anchors:
                    for k, p in model.named_parameters():
                        pen = pen + (fisher[k] * (p - old[k]).pow(2)).sum()
                loss = loss + lam / 2 * pen
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            steps += 1
        if method == "ewc":
            anchors.append((fisher_diag(model, scenario, t, x, gen), {k: v.detach().clone() for k, v in model.named_parameters()}))
        if method == "replay":
            replay.add_task(t, x, y)
        matrix.append([accuracy(model, scenario, j, *tasks[j][split]) if j <= t else None for j in range(len(tasks))])
    return matrix, steps


def scores(matrix):
    last = matrix[-1]
    avg = sum(last) / len(last)
    forget = [max(matrix[i][j] for i in range(j, len(matrix) - 1)) - last[j] for j in range(len(last) - 1)]
    return avg, sum(forget) / len(forget)


def stats(values):
    n = len(values)
    mean = sum(values) / n
    if n < 2:
        return {"mean": mean, "sd": None, "ci95": None, "n": n}
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1))
    half = T95.get(n, 1.96) * sd / math.sqrt(n)
    return {"mean": mean, "sd": sd, "ci95": [mean - half, mean + half], "n": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seeds", default="0,1,2")
    ap.add_argument("--scenarios", default="task,class")
    args = ap.parse_args()
    if args.threads:
        torch.set_num_threads(args.threads)
    seeds = [int(s) for s in args.seeds.split(",")]
    scenarios = args.scenarios.split(",")
    t0 = time.time()
    train, test = load_mnist(args.data)
    tasks = split_tasks(train, test)
    load_s = time.time() - t0
    report = {
        "config": {
            "tasks": TASKS, "hidden": HIDDEN, "batch": BATCH, "lr": LR, "optimizer": "Adam, reset each task", "epochs_per_task": 1,
            "val_share": VAL_SHARE, "fisher": "diagonal, %d examples, labels sampled from the model" % FISHER_SAMPLES,
            "replay_capacity": REPLAY_CAPACITY, "replay_batch": BATCH, "lambda_grid": LAMBDAS, "seeds": seeds,
            "threads": torch.get_num_threads(), "torch": torch.__version__, "train_rows_per_task": [len(t["train"][1]) for t in tasks],
        },
        "load_seconds": round(load_s, 2), "lambda_search": {}, "runs": [], "summary": {},
    }
    # 1. EWC's lambda per scenario, on the validation split, seed 0.
    t1 = time.time()
    for sc in scenarios:
        best = None
        for lam in LAMBDAS:
            m, _ = run("ewc", sc, 0, tasks, lam=lam, split="val")
            avg, fg = scores(m)
            report["lambda_search"].setdefault(sc, []).append({"lambda": lam, "val_avg_acc": round(avg, 4), "val_forgetting": round(fg, 4)})
            if best is None or avg > best[1]:
                best = (lam, avg)
        report["lambda_search"][sc + "_chosen"] = best[0]
    search_s = time.time() - t1
    # 2. The matrix: every method, scenario and seed, scored on the test split.
    t2 = time.time()
    for sc in scenarios:
        for method in ("finetune", "ewc", "replay"):
            accs, fgs = [], []
            for seed in seeds:
                lam = report["lambda_search"][sc + "_chosen"] if method == "ewc" else 0.0
                ts = time.time()
                m, steps = run(method, sc, seed, tasks, lam=lam)
                avg, fg = scores(m)
                accs.append(avg)
                fgs.append(fg)
                report["runs"].append({"scenario": sc, "method": method, "seed": seed, "lambda": lam, "steps": steps,
                                       "seconds": round(time.time() - ts, 2), "avg_acc": round(avg, 4), "forgetting": round(fg, 4),
                                       "matrix": [[None if v is None else round(v, 4) for v in row] for row in m]})
            report["summary"][sc + "/" + method] = {"avg_acc": stats(accs), "forgetting": stats(fgs)}
    matrix_s = time.time() - t2
    report["timing"] = {"load_s": round(load_s, 2), "lambda_search_s": round(search_s, 2), "matrix_s": round(matrix_s, 2), "total_s": round(time.time() - t0, 2)}
    report["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    with open(args.out, "w") as f:
        json.dump(report, f, indent=1)
    print("threads %d, torch %s, load %.1f s, lambda search %.1f s, matrix %.1f s, peak RSS %.0f MB" % (
        report["config"]["threads"], torch.__version__, load_s, search_s, matrix_s, report["peak_rss_mb"]))
    for sc in scenarios:
        print("scenario %s, EWC lambda %g (chosen on validation)" % (sc, report["lambda_search"][sc + "_chosen"]))
        for method in ("finetune", "ewc", "replay"):
            s = report["summary"][sc + "/" + method]
            a, f = s["avg_acc"], s["forgetting"]
            print("  %-8s avg acc %.3f [%.3f, %.3f]   forgetting %.3f [%.3f, %.3f]" % (
                method, a["mean"], a["ci95"][0], a["ci95"][1], f["mean"], f["ci95"][0], f["ci95"][1]) if a["ci95"] else
                "  %-8s avg acc %.3f   forgetting %.3f" % (method, a["mean"], f["mean"]))


if __name__ == "__main__":
    main()
