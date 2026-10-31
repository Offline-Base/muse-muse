"""GGUFs from writer-1's disk to S3, with nothing on this laptop (presigned multipart through lab.s3_put; see adapter_to_s3.py).

    .data/aws/venv/bin/python scripts/knowledge/aws/gguf_to_s3.py RUN PATH [PATH ...]

Each PATH must be /home/ubuntu/q/<dir>/<file>.gguf on writer-1. It goes to S3 as knowledge/models/RUN/<name>, where <name>
is the file name, prefixed with glimmer-RUN- if it doesn't already start with glimmer- (so the shrink bench's
/home/ubuntu/q/shrink-r30b/iq2-io-lowest.gguf becomes glimmer-stage-b-r30b-iq2-io-lowest.gguf). <key>.sha256 goes beside
each file, and a rerun skips files already there.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "compare"))
import common as C  # noqa: E402
from adapter_to_s3 import put_big  # noqa: E402


def main():
    run, paths = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 2 else ("", [])
    if not re.fullmatch(r"[a-z0-9_.-]{1,40}", run) or not paths:
        raise SystemExit("usage: gguf_to_s3.py RUN PATH [PATH ...]")
    cfg = C.load_config()
    for p in paths:
        if not re.fullmatch(r"/home/ubuntu/q/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.gguf", p) or ".." in p:
            raise SystemExit(f"{p}: not /home/ubuntu/q/<dir>/<file>.gguf")
        base = os.path.basename(p)
        name = base if base.startswith("glimmer-") else f"glimmer-{run}-{base}"
        sha, size = put_big(cfg, p, f"knowledge/models/{run}/{name}", name, f"gguf-{name[:-5]}")
        print(f"{name}: {size} bytes, sha256 {sha}")


if __name__ == "__main__":
    main()
