"""A run's LoRA adapter from writer-1's disk to S3 knowledge/runs/RUN/adapter/, with nothing written on this laptop.

    aws login --profile offlinebase                      # if the login has lapsed
    .data/aws/venv/bin/python scripts/knowledge/aws/adapter_to_s3.py RUN

- Needs writer-1's ~/q/RUN/adapter/.complete (run_handoff.sh writes it after its sha256 check against train-1).
- adapter_model.safetensors (1.7 GB) goes up through the compare lab's presigned multipart uploader (lab.s3_put):
  - URLs go over ssh stdin only, and nothing is written on writer-1;
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


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else ""
    if not re.fullmatch(r"[a-z0-9_.-]{1,40}", run):
        raise SystemExit("usage: adapter_to_s3.py RUN   (lowercase letters, digits, . _ -)")
    cfg = C.load_config()
    src = f"/home/ubuntu/q/{run}/adapter"

    def ssh(command):
        return lab.writer1_ssh(cfg, command)

    def size_on_writer1(path):
        if not path.startswith(src + "/") or ".." in path:
            raise SystemExit(f"{path} is not under {src}/")
        r = subprocess.run(ssh(f"stat -c %s {path} 2>/dev/null || true"), capture_output=True, text=True, timeout=120,
                           stdin=subprocess.DEVNULL)
        return int(r.stdout.strip()) if r.stdout.strip().isdigit() else None

    if subprocess.run(ssh(f"test -e {src}/.complete"), stdin=subprocess.DEVNULL).returncode != 0:
        raise SystemExit(f"{src}/.complete isn't on writer-1: run run_handoff.sh {run} first")
    bucket, profile = cfg["s3"]["bucket"], cfg["s3"]["profile"]
    prefix = f"knowledge/runs/{run}/adapter"

    # The big file: a throwaway models.json entry so lab.s3_put can drive it, written to a temp copy, never the real one.
    tmpdir = tempfile.mkdtemp(prefix="adapter-s3-")
    try:
        tmp = os.path.join(tmpdir, "models.json")
        raw = json.load(open(C.CONFIG))
        used = {m.get("port") for m in raw["models"]}
        lo, hi = (raw.get("lab", {}).get("remote_ports") or [8201, 8209])[:2]
        port = next(p for p in range(hi, lo - 1, -1) if p not in used)
        name = f"adapter-{run}"[:64]
        raw["models"].append({"name": name, "like": "glimmer-stage2", "port": port, "enabled": False,
                              "file": "adapter_model.safetensors", "bytes": None, "sha256": None,
                              "source": {"s3_key": f"{prefix}/adapter_model.safetensors",
                                         "writer1_path": f"{src}/adapter_model.safetensors"}})
        with open(tmp, "w") as f:
            json.dump(raw, f, indent=2)
        sha, size = lab.s3_put(name, C.load_config(tmp), config_path=tmp, size_fn=size_on_writer1)
        print(f"adapter_model.safetensors: {size} bytes, sha256 {sha}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # The small files, streamed: ssh cat | aws s3 cp -
    for fn in SMALL:
        n = size_on_writer1(f"{src}/{fn}")
        if n is None:
            print(f"{fn}: not on writer-1, skipped")
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
            raise SystemExit(f"{fn}: S3 has {got} bytes, writer-1 {size_there}")
        print(f"{fn}: {got} bytes")
    print(f"done: s3://{bucket}/{prefix}/")


if __name__ == "__main__":
    main()
