"""Ranged S3 reads with a byte counter, so every sampling script can report what it pulled to this Mac."""

import io
import json
import os
import threading

import boto3
import botocore.config

BUCKET = os.environ.get("KNOWLEDGE_BUCKET", "<set KNOWLEDGE_BUCKET>")  # the knowledge bucket; its name holds the AWS account id, so it stays out of the repo
PREFIX = "knowledge"
_cfg = botocore.config.Config(region_name="us-east-1", retries={"mode": "standard", "max_attempts": 6}, max_pool_connections=16)
_session = boto3.Session(profile_name="offlinebase", region_name="us-east-1")
s3 = _session.client("s3", config=_cfg)
_lock = threading.Lock()
pulled = [0]


def count(n):
    with _lock:
        pulled[0] += n


def list_objects(prefix):
    out = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        out += [(o["Key"], o["Size"]) for o in page.get("Contents", [])]
    return out


class RangedFile(io.RawIOBase):
    """Read-only seekable view of an S3 object. Each read is one ranged GET, with a small read-ahead for footers."""

    def __init__(self, key, size=None, readahead=64 * 1024):
        self.key, self.pos, self.readahead = key, 0, readahead
        self.size = size if size is not None else s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
        self.buf_start, self.buf = 0, b""

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        if self.buf_start <= self.pos and self.pos + n <= self.buf_start + len(self.buf):
            s = self.pos - self.buf_start
            data = self.buf[s:s + n]
        else:
            end = min(self.size, self.pos + max(n, self.readahead))
            body = s3.get_object(Bucket=BUCKET, Key=self.key, Range=f"bytes={self.pos}-{end - 1}")["Body"].read()
            count(len(body))
            self.buf_start, self.buf = self.pos, body
            data = body[:n]
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def record_usage(tag, path):
    """Appends this script's bytes to a shared tally so the total can be held under the cap."""
    with open(path, "a") as f:
        f.write(json.dumps({"tag": tag, "bytes": pulled[0]}) + "\n")


def total_usage(path):
    if not os.path.exists(path):
        return 0
    return sum(json.loads(l)["bytes"] for l in open(path))
