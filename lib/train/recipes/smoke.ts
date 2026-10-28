/**
 * The smoke recipe's Python (docs/TRAINING.md, "smoke recipe"): proves a GPU instance can boot, see its GPU through
 * torch, reach Hugging Face and PyPI, and report back, for well under a dollar. Never put a dollar sign followed by an
 * opening brace, or a backtick, in the Python: this is a template literal.
 *
 * Internal params: allowNoGpu (report a missing GPU, torch or network as metrics instead of failing, for the local
 * test) and tickSeconds (the gap between progress ticks, 20 s by default).
 */
export const SMOKE_PY = String.raw`"""Smoke test: checks the GPU, torch with CUDA, free disk and network, and reports them as metrics."""

import json
import shutil
import time
import urllib.error
import urllib.request

TICKS = 3
NET_HOSTS = ("huggingface.co", "pypi.org")
NET_TIMEOUT = 10
MATMUL_SIZE = 4096


def truthy(value):
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off")
    return bool(value)


def check_gpu(ctx, metrics, missing):
    """nvidia-smi: GPU name, memory and driver."""
    query = "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits"
    result = ctx.run(query, timeout=60)
    rows = [r for r in (result.stdout or "").splitlines() if r.count(",") >= 2]
    if result.returncode != 0 or not rows:
        missing.append("nvidia-smi")
        metrics["gpu_count"] = 0
        return
    name, memory, driver = [p.strip() for p in rows[0].split(",")[:3]]
    metrics["gpu_count"] = len(rows)
    metrics["gpu_name"] = name
    try:
        metrics["gpu_memory_gb"] = round(float(memory) / 1024, 1)
    except ValueError:
        metrics["gpu_memory_gb"] = memory
    metrics["gpu_driver"] = driver


def check_torch(ctx, metrics, missing):
    """torch sees CUDA, and a matmul on the GPU works. Without CUDA a small CPU matmul shows torch itself works."""
    try:
        import torch
    except Exception as e:
        missing.append("torch")
        metrics["torch"] = "missing (" + type(e).__name__ + ")"
        return
    metrics["torch"] = str(torch.__version__)
    if not torch.cuda.is_available():
        missing.append("cuda")
        metrics["torch_cuda"] = "no"
        a = torch.randn(256, 256)
        metrics["cpu_matmul"] = "ok" if (a @ a).shape == (256, 256) else "wrong shape"
        return
    metrics["torch_cuda"] = "yes"
    metrics["cuda_version"] = str(torch.version.cuda or "")
    metrics["torch_gpu"] = torch.cuda.get_device_name(0)
    n = MATMUL_SIZE
    a = torch.randn(n, n, device="cuda", dtype=torch.float16)
    b = torch.randn(n, n, device="cuda", dtype=torch.float16)
    (a @ b).sum().item()
    torch.cuda.synchronize()
    runs = 10
    start = time.time()
    for _ in range(runs):
        c = a @ b
    torch.cuda.synchronize()
    seconds = max(time.time() - start, 1e-9)
    metrics["matmul_ms"] = round(seconds / runs * 1000, 2)
    metrics["matmul_tflops"] = round(2 * n ** 3 * runs / seconds / 1e12, 1)
    metrics["matmul_finite"] = "yes" if torch.isfinite(c).all().item() else "no"


def check_disk(ctx, metrics):
    usage = shutil.disk_usage(ctx.work_dir)
    metrics["disk_free_gb"] = round(usage.free / 1e9, 1)
    metrics["disk_total_gb"] = round(usage.total / 1e9, 1)


def check_network(metrics, missing):
    """HTTPS reachability. Any HTTP answer counts as reachable; only a network error doesn't."""
    for host in NET_HOSTS:
        key = "net_" + host.replace(".", "_")
        start = time.time()
        req = urllib.request.Request("https://" + host + "/", method="HEAD", headers={"User-Agent": "muse-smoke/1"})
        try:
            with urllib.request.urlopen(req, timeout=NET_TIMEOUT) as res:
                status = res.status
        except urllib.error.HTTPError as e:
            status = e.code
        except Exception as e:
            missing.append(host)
            metrics[key] = "unreachable (" + type(e).__name__ + ")"
            continue
        metrics[key] = "HTTP " + str(status) + " in " + str(int((time.time() - start) * 1000)) + " ms"


def summary_of(metrics, missing, allow_no_gpu):
    if "gpu_name" in metrics:
        gpu = str(metrics["gpu_name"]) + " (" + str(metrics.get("gpu_memory_gb", "?")) + " GB)"
    else:
        gpu = "No GPU"
    parts = [gpu, "torch " + str(metrics.get("torch", "missing")), str(metrics.get("disk_free_gb", "?")) + " GB free"]
    if "matmul_tflops" in metrics:
        parts.append(str(metrics["matmul_tflops"]) + " TFLOPS fp16 matmul")
    text = ", ".join(parts) + "."
    if missing:
        text += " Missing: " + ", ".join(missing) + ("" if not allow_no_gpu else " (allowed for this run)") + "."
    else:
        text += " Hugging Face and PyPI reachable."
    return text


def run(ctx):
    allow_no_gpu = truthy(ctx.params.get("allowNoGpu"))
    try:
        tick = float(ctx.params.get("tickSeconds") or 20)
    except (TypeError, ValueError):
        tick = 20.0
    metrics = {}
    missing = []

    check_gpu(ctx, metrics, missing)
    check_torch(ctx, metrics, missing)
    ctx.progress(step=1, total_steps=TICKS, message="GPU checked: " + str(metrics.get("gpu_name", "none")))

    time.sleep(tick)
    check_disk(ctx, metrics)
    check_network(metrics, missing)
    ctx.progress(step=2, total_steps=TICKS, message="Disk and network checked")

    time.sleep(tick)
    ctx.progress(step=3, total_steps=TICKS, message="Smoke test finished")

    metrics["missing"] = ", ".join(missing) if missing else "none"
    ctx.log("smoke metrics: " + json.dumps(metrics, sort_keys=True))
    if missing and not allow_no_gpu:
        raise RuntimeError("Smoke test failed. Missing: " + ", ".join(missing))
    metrics["summary"] = summary_of(metrics, missing, allow_no_gpu)
    return metrics
`;
