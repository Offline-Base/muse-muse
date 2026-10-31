"""Sends the TypeScript source collectors to the collector machine and starts whichever ones it hasn't run.

    .data/aws/venv/bin/python scripts/knowledge/aws/deploy_collectors.py us-gov        one finished collector
    .data/aws/venv/bin/python scripts/knowledge/aws/deploy_collectors.py               every collector in the folder
    .data/aws/venv/bin/python scripts/knowledge/aws/deploy_collectors.py --rerun meta  run this one again, unchanged
    .data/aws/venv/bin/python scripts/knowledge/aws/deploy_collectors.py --status
    .data/aws/venv/bin/python scripts/knowledge/aws/deploy_collectors.py --push        this Mac's MAC_ONLY output, to S3

Safe to run again at any time: a collector that's running is left alone, and a changed file starts once the old run
ends (box/collectors.sh). Name the file when other helpers are still writing theirs, so half-written ones stay here.
Pages this Mac already cached go up first, so the machine doesn't fetch them again.

A file is held back, with the reason printed, if it reaches dumps.wikimedia.org (bulk.py already uses both allowed
connections) or uses GitHub with a token but has no step that collectors.sh skips by name (MAC_ONLY there).

A file smaller than its S3 copy doesn't replace it, here or on the machine, so a partial rerun can't shrink good data. To
accept a smaller file on purpose, delete the S3 copy first (aws s3 rm, from this Mac; the machine's role can't delete).
"""

import argparse
import io
import json
import os
import re
import subprocess
import tarfile

from collector import PROFILE, bucket, run, session

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
SOURCES = os.path.join("scripts", "knowledge", "sources")
SCRIPT = "scripts/knowledge/aws/box/collectors.sh"
KEY = "knowledge/box/app.tar.gz"
LOCK = "/opt/muse/collectors.lock"
USES_GITHUB = re.compile(r'"gh"|api\.github\.com|GITHUB_TOKEN|GH_TOKEN')


def read(rel):
    with open(os.path.join(REPO, rel), encoding="utf8") as f:
        return f.read()


def mac_only():
    return re.search(r'^MAC_ONLY="(.+)"', read(SCRIPT), re.M).group(1).split()


def is_collector(name, text):
    return name != "common.ts" and "runAll(" in text


def why_held(text):
    if "dumps.wikimedia.org" in text:
        return "it reaches dumps.wikimedia.org, and bulk.py already uses both allowed connections"
    steps = re.findall(r'(?:\[\s*|\bstep\(\s*)"([A-Za-z0-9._-]+)"\s*,', text)
    if USES_GITHUB.search(text) and not any(part in step for step in steps for part in mac_only()):
        return f"it uses GitHub but no step name contains one of {mac_only()}: add its step to MAC_ONLY in collectors.sh"
    return None


def choose(names):
    """The source files to send, and warnings. Helper modules always go; collectors go if named, or all if none are."""
    wanted = {n.removesuffix(".ts") for n in names}
    files, notes, hosts, seen = [], [], {}, set()
    for name in sorted(os.listdir(os.path.join(REPO, SOURCES))):
        if not name.endswith(".ts"):
            continue
        text = read(os.path.join(SOURCES, name))
        stem = name.removesuffix(".ts")
        if not is_collector(name, text):
            files.append(os.path.join(SOURCES, name))
            continue
        for host in set(re.findall(r"https://([a-z0-9.-]+\.[a-z]+)", text)):
            hosts.setdefault(host, []).append(stem)
        if wanted and stem not in wanted:
            continue
        seen.add(stem)
        reason = why_held(text)
        if reason:
            notes.append(f"HELD {name}: {reason}")
        else:
            files.append(os.path.join(SOURCES, name))
    for missing in wanted - seen:
        notes.append(f"NOT FOUND {missing}: no collector file by that name (a collector must call runAll)")
    for host, users in sorted(hosts.items()):
        if len(users) > 1:
            notes.append(f"WARNING {host} is used by {', '.join(sorted(users))}: each paces itself, so the site sees the sum")
    return files, notes


def walk(rel, skip=("__tests__", "__pycache__")):
    for folder, dirs, names in os.walk(os.path.join(REPO, rel)):
        dirs[:] = [d for d in dirs if d not in skip]
        yield from (os.path.relpath(os.path.join(folder, n), REPO) for n in names if n.endswith(".ts"))


def package_json(files):
    """tsx at the repo's version, plus anything the packed files import from npm, also at the repo's version."""
    repo = json.loads(read("package.json"))
    versions = {**repo.get("dependencies", {}), **repo.get("devDependencies", {})}
    deps, notes = {"tsx": versions["tsx"]}, []
    for rel in files:
        if not rel.endswith(".ts"):
            continue
        for spec in re.findall(r'^\s*import\s+(?!type\b)[^"\n]*"([^"]+)"|\bfrom\s+"([^"]+)"', read(rel), re.M):
            spec = spec[0] or spec[1]
            if spec.startswith(("node:", ".")):
                continue
            if spec.startswith("@/"):
                if not spec.startswith("@/lib/knowledge/"):
                    notes.append(f"WARNING {rel} imports {spec}, which isn't packed")
                continue
            pkg = "/".join(spec.split("/")[:2 if spec.startswith("@") else 1])
            if pkg in versions:
                deps[pkg] = versions[pkg]
            else:
                notes.append(f"WARNING {rel} imports {pkg}, which isn't in the repo's package.json")
    return json.dumps({"name": "muse-knowledge-box", "private": True, "type": "module", "dependencies": deps}, indent=2) + "\n", notes


def pack(sources):
    files = list(walk("lib/knowledge")) + [os.path.join("scripts", "knowledge", n) for n in os.listdir(os.path.join(REPO, "scripts", "knowledge")) if n.endswith(".ts")]
    files += sources + [SCRIPT, "tsconfig.json"]
    body, notes = package_json(files)
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for rel in files:
            tar.add(os.path.join(REPO, rel), arcname=rel, filter=lambda t: (setattr(t, "uid", 0), setattr(t, "gid", 0), setattr(t, "uname", "root"), setattr(t, "gname", "root"), t)[-1])
        info = tarfile.TarInfo("package.json")
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body.encode()))
    return out.getvalue(), notes


def push(s, b):
    """Copies this Mac's output of the MAC_ONLY steps to S3, by the rule the machine follows for its own."""
    folder = os.path.join(REPO, ".data", "knowledge", "sources")
    prefix = "knowledge/corpus/sources/"
    client = s.client("s3")
    sizes = {o["Key"].removeprefix(prefix): o["Size"] for page in client.get_paginator("list_objects_v2").paginate(Bucket=b, Prefix=prefix) for o in page.get("Contents", [])}
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".jsonl") or not any(part in name for part in mac_only()):
            continue
        size = os.path.getsize(os.path.join(folder, name))
        if size == 0 or size < sizes.get(name, 0):
            print(f"KEPT {name}: {size} bytes here, {sizes.get(name, 0)} in S3")
        elif size != sizes.get(name):
            client.upload_file(os.path.join(folder, name), b, prefix + name)
            print(f"sent {name}: {size} bytes")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("names", nargs="*", help="collectors to send, such as us-gov; all of them if none are named")
    p.add_argument("--rerun", action="append", default=[], help="run this collector again even though its file hasn't changed")
    p.add_argument("--status", action="store_true")
    p.add_argument("--push", action="store_true", help="copy this Mac's MAC_ONLY output to S3, then stop")
    a = p.parse_args()
    s = session()
    b = bucket(s)
    if a.status:
        run(f"bash /opt/muse/app/{SCRIPT} {b} status")
        return
    if a.push:
        push(s, b)
        return
    bad = [n for n in a.rerun if not re.fullmatch(r"[a-z0-9-]+", n)]
    if bad:
        raise SystemExit(f"bad --rerun name: {bad}")

    sources, notes = choose(a.names + a.rerun)
    body, more = pack(sources)
    for note in notes + more:
        print(note)
    print("sending", ", ".join(os.path.basename(f) for f in sources), f"({len(body) // 1024} KB)")
    s.client("s3").put_object(Bucket=b, Key=KEY, Body=body)
    cache = os.path.join(REPO, ".data", "knowledge", "sources", "cache")
    if os.path.isdir(cache):
        subprocess.run(["aws", "s3", "sync", cache, f"s3://{b}/knowledge/corpus/cache/", "--size-only", "--only-show-errors", "--profile", PROFILE], check=True)

    forget = "".join(f"rm -f /opt/muse/collectors/state/{n}.hash; " for n in a.rerun)
    unpack = f"mkdir -p /opt/muse/app && tar -xzf /opt/muse/app.tar.gz -C /opt/muse/app && {forget}bash /opt/muse/app/{SCRIPT} {b} setup"
    run(
        f"set -e; mkdir -p /opt/muse; aws s3 cp s3://{b}/{KEY} /opt/muse/app.tar.gz --only-show-errors; "
        f"flock {LOCK} bash -c '{unpack}'; "
        f"bash /opt/muse/app/{SCRIPT} {b} tick; bash /opt/muse/app/{SCRIPT} {b} status"
    )


if __name__ == "__main__":
    main()
