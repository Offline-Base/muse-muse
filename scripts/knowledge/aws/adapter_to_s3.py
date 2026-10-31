"""A run's LoRA adapter to S3 knowledge/runs/RUN/adapter/, from writer-1 or train-1, with nothing written on this laptop.

    aws login --profile offlinebase                      # if the login has lapsed
    .data/aws/venv/bin/python scripts/knowledge/aws/adapter_to_s3.py RUN                  # writer-1 ~/q/RUN/adapter
    .data/aws/venv/bin/python scripts/knowledge/aws/adapter_to_s3.py RUN --from train-1   # train-1 ~/k/runs/RUN/out/adapter

- writer-1 needs ~/q/RUN/adapter/.complete (run_handoff.sh writes it after its sha256 check against train-1);
  train-1 needs the adapter_saved event in ~/k/runs/RUN/log.txt.
- adapter_model.safetensors (1.7 GB) goes up through the compare lab's presigned multipart uploader (lab.s3_put):
  - URLs go over ssh stdin only, and nothing is written on the source machine;
  - <key>.sha256 is stored next to it.
- The small files (configs and tokenizer, about 30 MB) stream through this Mac with `aws s3 cp -`, from memory, not disk.
- A rerun skips files already in S3 at the right size.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "compare"))
import common as C  # noqa: E402
import lab  # noqa: E402

SMALL = ["adapter_config.json", "README.md", "chat_template.jinja", "processor_config.json", "tokenizer.json",
         "tokenizer_config.json"]


TRAIN1 = "ubuntu@163.192.200.51"


def put_big(cfg, path, key, file_name, name, size_fn=None):
    """One big file from the machine cfg["writer1"]["host"] names to S3 `key`, through lab.s3_put (presigned multipart,
    URLs over ssh stdin, <key>.sha256 beside it; a rerun reads the recorded sha256 instead). lab.s3_put drives entries
    of models.json, so this adds a throwaway entry to a temp copy, never the real file. Returns (sha256, bytes)."""
    tmpdir = tempfile.mkdtemp(prefix="put-big-")
    try:
        tmp = os.path.join(tmpdir, "models.json")
        raw = json.load(open(C.CONFIG))
        used = {m.get("port") for m in raw["models"]}
        lo, hi = (raw.get("lab", {}).get("remote_ports") or [8201, 8209])[:2]
        port = next(p for p in range(hi, lo - 1, -1) if p not in used)
        name = name.lower()[:64]
        raw["models"].append({"name": name, "like": "glimmer-stage2", "port": port, "enabled": False,
                              "file": file_name, "bytes": None, "sha256": None,
                              "source": {"s3_key": key, "writer1_path": path}})
        with open(tmp, "w") as f:
            json.dump(raw, f, indent=2)
        cfg_t = C.load_config(tmp)
        cfg_t["writer1"] = cfg["writer1"]
        kw = {"size_fn": size_fn} if size_fn else {}
        return lab.s3_put(name, cfg_t, config_path=tmp, argv=lab.uploader_argv(cfg), **kw)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    args = sys.argv[1:]
    run = args[0] if args else ""
    origin = args[2] if len(args) == 3 and args[1] == "--from" else ("writer-1" if len(args) == 1 else "")
    if not re.fullmatch(r"[a-z0-9_.-]{1,40}", run) or origin not in ("writer-1", "train-1"):
        raise SystemExit("usage: adapter_to_s3.py RUN [--from train-1]   (RUN: lowercase letters, digits, . _ -)")
    cfg = C.load_config()
    if origin == "train-1":
        cfg["writer1"] = dict(cfg["writer1"], host=TRAIN1)  # lab's ssh helpers and uploader then go to train-1
        src = f"/home/ubuntu/k/runs/{run}/out/adapter"
        ready = f"grep -q '\"event\": \"adapter_saved\"' /home/ubuntu/k/runs/{run}/log.txt"
    else:
        src = f"/home/ubuntu/q/{run}/adapter"
        ready = f"test -e {src}/.complete"

    def ssh(command):
        return lab.writer1_ssh(cfg, command)

    def size_on_writer1(path):
        if not path.startswith(src + "/") or ".." in path:
            raise SystemExit(f"{path} is not under {src}/")
        r = subprocess.run(ssh(f"stat -c %s {path} 2>/dev/null || true"), capture_output=True, text=True, timeout=120,
                           stdin=subprocess.DEVNULL)
        return int(r.stdout.strip()) if r.stdout.strip().isdigit() else None

    if subprocess.run(ssh(ready), stdin=subprocess.DEVNULL).returncode != 0:
        raise SystemExit(f"{run}'s adapter isn't finished on {origin} ({ready})")
    bucket, profile = cfg["s3"]["bucket"], cfg["s3"]["profile"]
    prefix = f"knowledge/runs/{run}/adapter"

    sha, size = put_big(cfg, f"{src}/adapter_model.safetensors", f"{prefix}/adapter_model.safetensors",
                        "adapter_model.safetensors", f"adapter-{run}", size_on_writer1)
    print(f"adapter_model.safetensors: {size} bytes, sha256 {sha}")

    # The small files, streamed: ssh cat | aws s3 cp -
    for fn in SMALL:
        n = size_on_writer1(f"{src}/{fn}")
        if n is None:
            print(f"{fn}: not on {origin}, skipped")
            continue
        size_there = str(n)
        key = f"{prefix}/{fn}"
        head = subprocess.run(["aws", "s3api", "head-object", "--bucket", bucket, "--key", key, "--profile", profile,
                               "--query", "ContentLength", "--output", "text"], capture_output=True, text=True)
        if head.returncode == 0 and head.stdout.strip() == size_there:
            print(f"{fn}: already in S3 ({size_there} bytes)")
            continue
        cat = subprocess.Popen(ssh(f"cat {src}/{fn}"), stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
        put = subprocess.run(["aws", "s3", "cp", "-", f"s3://{bucket}/{key}", "--profile", profile, "--only-show-errors",
                              "--expected-size", size_there], stdin=cat.stdout)
        cat.stdout.close()
        if cat.wait() != 0 or put.returncode != 0:
            raise SystemExit(f"{fn}: upload failed")
        got = subprocess.run(["aws", "s3api", "head-object", "--bucket", bucket, "--key", key, "--profile", profile,
                              "--query", "ContentLength", "--output", "text"], capture_output=True, text=True).stdout.strip()
        if got != size_there:
            raise SystemExit(f"{fn}: S3 has {got} bytes, {origin} {size_there}")
        print(f"{fn}: {got} bytes")
    print(f"done: s3://{bucket}/{prefix}/")


if __name__ == "__main__":
    main()
