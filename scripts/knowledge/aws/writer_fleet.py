"""The Glimmer writer fleet: one vLLM server per rented GPU writes the knowledge Q&A, driven from this Mac by
scripts/knowledge/make-dataset.ts, and this script is its kill switch (docs/KNOWLEDGE_UPDATE.md, Spending).

    PY=.data/aws/venv/bin/python; F=scripts/knowledge/aws/writer_fleet.py
    $PY $F status                                   machines, spend, rate, projection, tokens/s
    $PY $F launch lambda gpu_1x_a100_sxm4 [--region us-east-1] [--count 2]
    $PY $F launch aws g6e.xlarge [--count 2]
    $PY $F stop [--name muse-knowledge-gw-3]        terminate every fleet machine (or one)
    $PY $F set --name muse-knowledge-gw-3 --concurrency 96
    caffeinate -dims $PY $F watch                   the kill switch, tunnels, endpoints file and S3 copies
    $PY $F write                                    the writer: make-dataset over each work tier in order

The fleet is every machine named muse-knowledge-gw-* (Lambda name or EC2 Name tag) plus the Lambda A10
muse-knowledge-glimmer-writer (EXTRA_LAMBDA_ID). Nothing else is ever stopped: each id is checked against that rule
again right before it's terminated.

Spend is counted from each machine's launch time and hourly price (Lambda by the started minute, EC2 by the second),
on top of SPENT_BEFORE_USD. watch terminates the whole fleet when spend plus two more minutes at the current rate
reaches CAP_USD, when the writer reports that no work is left, after `stop`, or at DEADLINE. It also terminates any
one machine that isn't serving an hour after it first saw it, or that has generated nothing for IDLE_MINUTES. Every
15 minutes it adds up to two machines (AUTOSCALE, best value first) when the spend projected to TARGET_END leaves
room and every machine already launched is serving. `stop` writes .data/aws/writer-fleet.stopped, after which watch
launches nothing and ends once the fleet is gone.

Lambda machines can't stop themselves, so this Mac is their only kill switch. watch runs under caffeinate in
.data/aws/writer-watch.sh, which restarts it within 30 seconds if it crashes (touch .data/aws/writer-watch.off to
end that loop), and every step is retried each minute. It doesn't survive a reboot or a sleeping Mac: if the Mac is
off, run `stop` from any shell as soon as it's back. EC2 machines also shut down at DEADLINE on their own
(instance-initiated shutdown means terminate).

Every 15 minutes the Glimmer-written cache files are copied to s3://<bucket>/knowledge/corpus/qa-glimmer/.
"""

import argparse
import base64
import concurrent.futures
import datetime as dt
import fcntl
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
STATE = os.path.join(ROOT, ".data", "aws", "writer-fleet.json")
ENDPOINTS = os.path.join(ROOT, ".data", "aws", "writer-endpoints.json")
DONE = os.path.join(ROOT, ".data", "aws", "writer-fleet.done")
STOPPED = os.path.join(ROOT, ".data", "aws", "writer-fleet.stopped")  # written by `stop`; watch then launches nothing
RUNNER_PID = os.path.join(ROOT, ".data", "aws", "writer-runner.pid")
LOG = os.path.join(ROOT, ".data", "knowledge", "logs", "writer-fleet.log")
QA_DIR = os.path.join(ROOT, ".data", "knowledge", "qa")
SOURCES = os.path.join(ROOT, ".data", "knowledge", "sources")
UPLOADED = os.path.join(ROOT, ".data", "aws", "writer-s3-uploaded.txt")
KEY = os.path.expanduser("~/.ssh/muse-muse-lambda")
SSH_KEY_NAME = "muse-muse-platform"
PROFILE = "offlinebase"
REGION = "us-east-1"
BUCKET = os.environ.get("KNOWLEDGE_BUCKET", "<set KNOWLEDGE_BUCKET>")  # the knowledge bucket; its name holds the AWS account id, so it stays out of the repo
S3_PREFIX = "knowledge/corpus/qa-glimmer/"
PREFIX = "muse-knowledge-gw-"
EXTRA_LAMBDA_ID = "07f6e9e9a7fc4e549b2a0a109b264c34"  # muse-knowledge-glimmer-writer, the A10 this lane owns
EXTRA_LAMBDA_LAUNCHED = "2026-10-30T21:00:00+00:00"  # it booted at 21:06:09; counted from 21:00 to be safe
NEVER = {"e39f1fcd8fa9401bbed6a870fa236b83", "c3ff7180e6c2415d8a491de7a5978fa8"}  # writer-1 and the GH200
CAP_USD = 333.0  # $500 writing limit minus about $165 of hosted Spark Open writing, with a margin
SPENT_BEFORE_USD = 0.0
DEADLINE = dt.datetime(2026, 10, 31, 12, 0, tzinfo=dt.timezone.utc)
FILE_SYSTEM = "muse-muse-cache-us-east-1"
NFS = "/lambda/nfs/muse-muse-cache-us-east-1"
WRITER = "muse-glimmer-30b"
IMAGE = "vllm/vllm-openai:v0.32.0-cu129"
IMAGE_CUDA13 = "vllm/vllm-openai:v0.32.0"
INT4 = ("RedHatAI/Muse-Glimmer-30B-INT4", "397b1ee1eb83f09b9675e66e49d5ec3a522c509a")
FP8 = ("RedHatAI/Muse-Glimmer-30B-FP8-block", "1deb4641ff84f9a728dd11b27cac1f6a02a9ed14")
# Per GPU: the checkpoint, vLLM's memory settings, and how many requests the Mac keeps in flight.
PROFILES = {
    "a100": {"weights": INT4, "args": "--max-model-len 8192 --gpu-memory-utilization 0.93 --max-num-seqs 192", "concurrency": 176},
    "a10": {"weights": INT4, "args": "--max-model-len 6144 --gpu-memory-utilization 0.965 --max-num-seqs 48", "concurrency": 44},
    "l40s": {"weights": FP8, "args": "--max-model-len 8192 --gpu-memory-utilization 0.93 --max-num-seqs 160", "concurrency": 144},
    "l40s-int4": {"weights": INT4, "args": "--max-model-len 8192 --gpu-memory-utilization 0.93 --max-num-seqs 192", "concurrency": 176},
}
AWS_TYPES = {"g6e.xlarge": {"gpu": "l40s", "usd_per_hour": 1.861}}
AWS_GPU = os.environ.get("WRITER_AWS_GPU", "l40s")  # l40s (FP8) or l40s-int4
AMI_PARAM = "/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id"
SG_NAME = "muse-knowledge-gw"
EC2_KEY = "muse-knowledge-gw"

# The writer's work, in priority order. Each run is one make-dataset process; never these files: wikisource, us-doj,
# gap-wikipedia-*, gdelt, s3-infini-news, s3-fine-news, s3-forecastbench, s3-openlibrary, pubmed*.
TIER_A = "meta-,pytorch-blog,gap-meta-dev-blog,gap-hf-facebook,github-meta-orgs,huggingface-cards,models-dev,epoch,lmarena,anthropic-release-notes,google-ai-changelog,sdk-changelogs"
TIER_D = [
    "us-whitehouse,us-federal-register,us-sec-8k,ec-press,ons",
    "us-bea,us-bls,us-eia,us-fed-fomc,us-fed-press,us-gao,us-govinfo-plaw,us-nass,us-ofac,us-scotus,us-treasury,us-sec-meta",
    "govuk,legislation-uk,hansard-uk,gap-uk-sanctions,gap-eu-sanctions,eurlex,europarl,eurostat,ecb",
    "egov-japan,jma,korea-press,legifrance,legislation-au,bank-of-canada,banxico,statcan,inegi,gastat,bis,oecd,worldbank-docs,worldbank-pink",
]
TIER_E = [
    "arxiv,acl-anthology,s3-openalex,crossref-retractions,retraction-watch,nobel,nasa-news,exoplanets,nsf-awards,nih-reporter",
    "biorxiv,medrxiv,s3-biorxiv,s3-medrxiv,mmwr,ecdc,ema,dailymed,openfda",
    "doaj-2026-01", "doaj-2026-02", "clinicaltrials", "s3-pmc,pmc-fulltext-0000",
    "europepmc-2026-01", "europepmc-2026-02", "europepmc-2026-03", "europepmc-2026-04", "europepmc-2026-05",
    "europepmc-2026-06", "europepmc-2026-10", "europepmc.jsonl",
]
BANNED = re.compile(r"^(wikisource|us-doj|gap-wikipedia-|gdelt|s3-infini-news|s3-fine-news|s3-forecastbench|s3-openlibrary|pubmed)")


def now():
    return dt.datetime.now(dt.timezone.utc)


def log(msg):
    line = f"{now().strftime('%Y-%m-%dT%H:%M:%SZ')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"machines": {}}


def save(state):
    """Writes the state, keeping machines another process (a launch) added since this one loaded it."""
    with open(STATE + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for name, m in load()["machines"].items():
            state["machines"].setdefault(name, m)
            if "concurrency" in m:
                state["machines"][name]["concurrency"] = m["concurrency"]
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, STATE)


# ---- Lambda (the API key stays on this Mac: read from .env.local, sent only to Lambda's API) ----

def lambda_key():
    with open(os.path.join(ROOT, ".env.local")) as f:
        for line in f:
            m = re.match(r"\s*LAMBDA_API_KEY\s*=\s*\"?([^\"\n]+)\"?", line)
            if m:
                return m.group(1).strip()
    raise SystemExit("LAMBDA_API_KEY isn't in .env.local")


def lam(method, path, body=None):
    req = urllib.request.Request(
        "https://cloud.lambdalabs.com/api/v1/" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Basic " + base64.b64encode((lambda_key() + ":").encode()).decode(),
                 "Content-Type": "application/json", "User-Agent": "muse-knowledge-writer-fleet"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}")
        except ValueError:
            return {"error": {"message": f"HTTP {e.code}"}}


def ours(name, iid):
    """The only machines this script may stop."""
    return iid not in NEVER and (iid == EXTRA_LAMBDA_ID or (name or "").startswith(PREFIX))


def lambda_instances():
    data = lam("GET", "instances").get("data")
    if data is None:
        raise RuntimeError("Lambda API didn't list instances")
    return {i["id"]: i for i in data}


# ---- AWS ----

def aws():
    import boto3
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def aws_instances(s):
    out = {}
    pages = s.client("ec2").get_paginator("describe_instances").paginate(Filters=[{"Name": "tag:Name", "Values": [PREFIX + "*"]}])
    for page in pages:
        for res in page["Reservations"]:
            for i in res["Instances"]:
                name = next((t["Value"] for t in i.get("Tags", []) if t["Key"] == "Name"), "")
                out[i["InstanceId"]] = {"name": name, "state": i["State"]["Name"], "ip": i.get("PublicIpAddress"),
                                         "type": i["InstanceType"], "launched": i["LaunchTime"].isoformat()}
    return out


# ---- spend ----

def hours(m, at):
    start = dt.datetime.fromisoformat(m["launched"])
    end = dt.datetime.fromisoformat(m["ended"]) if m.get("ended") else at
    h = max(0.0, (end - start).total_seconds() / 3600)
    # Lambda bills by the minute: count every started minute.
    return (int(h * 60) + 1) / 60 if m["provider"] == "lambda" else h


def spend(state, at=None):
    at = at or now()
    spent = SPENT_BEFORE_USD + sum(m["usd_per_hour"] * hours(m, at) for m in state["machines"].values())
    rate = sum(m["usd_per_hour"] for m in state["machines"].values() if not m.get("ended"))
    return spent, rate


def projection(state):
    spent, rate = spend(state)
    left = max(0.0, (DEADLINE - now()).total_seconds() / 3600)
    at_cap = now() + dt.timedelta(hours=(CAP_USD - spent) / rate) if rate else None
    return {"spent_usd": round(spent, 2), "usd_per_hour": round(rate, 2), "projected_usd_at_deadline": round(min(CAP_USD, spent + rate * left), 2),
            "projected_unbounded_usd": round(spent + rate * left, 2), "cap_reached_at": at_cap.strftime("%Y-%m-%dT%H:%MZ") if at_cap else None}


# ---- machines ----

def next_number(state):
    used = [int(n[len(PREFIX):]) for n in state["machines"] if n.startswith(PREFIX) and n[len(PREFIX):].isdigit()]
    return max(used, default=0) + 1


def port_for(name):
    return 18100 if name == "muse-knowledge-glimmer-writer" else 18100 + int(name[len(PREFIX):])


def track_extra(state):
    if "muse-knowledge-glimmer-writer" not in state["machines"]:
        state["machines"]["muse-knowledge-glimmer-writer"] = {
            "provider": "lambda", "id": EXTRA_LAMBDA_ID, "type": "gpu_1x_a10", "gpu": "a10", "region": "us-east-1",
            "usd_per_hour": 1.29, "launched": EXTRA_LAMBDA_LAUNCHED, "ip": os.environ.get("EXTRA_LAMBDA_IP", ""), "served": True}


def launch(provider, itype, region, count):
    state = load()
    track_extra(state)
    p = projection(state)
    for _ in range(count):
        name = PREFIX + str(next_number(state))
        if provider == "lambda":
            price = lam("GET", "instance-types")["data"][itype]["instance_type"]["price_cents_per_hour"] / 100
            body = {"region_name": region, "instance_type_name": itype, "ssh_key_names": [SSH_KEY_NAME], "name": name}
            if region == "us-east-1":
                body["file_system_names"] = [FILE_SYSTEM]
            r = lam("POST", "instance-operations/launch", body)
            ids = (r.get("data") or {}).get("instance_ids")
            if not ids:
                log(f"launch {name} {itype} {region}: {r.get('error')}")
                break
            gpu = "a100" if "a100" in itype else "a10" if "a10" in itype else itype
            state["machines"][name] = {"provider": "lambda", "id": ids[0], "type": itype, "gpu": gpu, "region": region,
                                       "usd_per_hour": price, "launched": now().isoformat()}
        else:
            iid = aws_launch(name, itype)
            if not iid:
                break
            state["machines"][name] = {"provider": "aws", "id": iid, "type": itype, "gpu": AWS_GPU, "region": REGION,
                                       "usd_per_hour": AWS_TYPES[itype]["usd_per_hour"], "launched": now().isoformat(), "served": True}
        save(state)
        log(f"launched {name} {itype} {region} ({state['machines'][name]['id']}); spend so far ${p['spent_usd']}")


# What watch adds when the budget has room, best dollars per surviving example first (measured Oct 30: A100 INT4
# about 1,250 tokens/s at $1.99, L40S FP8 about 800 at $1.86, A10 INT4 about 400 at $1.29).
AUTOSCALE = [("lambda", "gpu_1x_a100_sxm4", "us-east-1"), ("aws", "g6e.xlarge", REGION), ("lambda", "gpu_1x_a10", "us-east-1")]
TARGET_END = dt.datetime(2026, 10, 31, 11, 0, tzinfo=dt.timezone.utc)  # the fleet is sized to reach CAP_USD here


def autoscale(state):
    """Adds up to two machines when the spend projected to TARGET_END leaves room for them, and only once every
    machine already launched is serving. Lambda capacity is read first; EC2 capacity is found by trying."""
    live = [m for m in state["machines"].values() if not m.get("ended")]
    if any(not m.get("serving_since") for m in live):
        return
    spent, rate = spend(state)
    left = (TARGET_END - now()).total_seconds() / 3600
    if left < 1.5:
        return
    headroom = CAP_USD - 5 - (spent + rate * left)
    try:
        types = lam("GET", "instance-types").get("data") or {}
    except Exception:
        types = {}
    added = 0
    for provider, itype, region in AUTOSCALE:
        while added < 2:
            if provider == "aws":
                price = AWS_TYPES[itype]["usd_per_hour"]
            else:
                t = types.get(itype) or {}
                price = (t.get("instance_type") or {}).get("price_cents_per_hour", 0) / 100
                if region not in [r["name"] for r in t.get("regions_with_capacity_available", [])]:
                    break
            if not price or headroom < price * left:
                break
            before = len(load()["machines"])
            launch(provider, itype, region, 1)
            if len(load()["machines"]) == before:
                break
            headroom -= price * left
            added += 1
    if added:
        log(f"autoscale: added {added}; projected ${spent + rate * left:.0f} before them")


def my_ip():
    with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=20) as r:
        return r.read().decode().strip()


def aws_setup(s):
    """A key pair (the Lambda public key) and a security group open to SSH from this Mac only."""
    ec2 = s.client("ec2")
    try:
        ec2.describe_key_pairs(KeyNames=[EC2_KEY])
    except ec2.exceptions.ClientError:
        with open(KEY + ".pub", "rb") as f:
            ec2.import_key_pair(KeyName=EC2_KEY, PublicKeyMaterial=f.read())
    vpc = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]["VpcId"]
    groups = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [SG_NAME]}, {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
    sg = groups[0]["GroupId"] if groups else ec2.create_security_group(GroupName=SG_NAME, Description="Glimmer writers - SSH from the owner Mac only", VpcId=vpc)["GroupId"]
    cidr = my_ip() + "/32"
    try:
        ec2.authorize_security_group_ingress(GroupId=sg, IpPermissions=[{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": cidr}]}])
    except ec2.exceptions.ClientError as err:
        if "Duplicate" not in str(err):
            raise
    return sg


def serve_script(gpu, nfs, cuda13=False):
    """vLLM in Docker. Lambda's driver (570) needs the CUDA 12.9 image, whose torchcodec is built for CUDA 13 and
    breaks vLLM's import, so torchcodec is removed: in a one-line image on Lambda (fast local disk), and at container
    start on EC2, where building the image on EBS takes too long. (cuda13 is accepted for old callers and ignored.)"""
    weights, revision = PROFILES[gpu]["weights"]
    serve = (f"{weights} --revision {revision} --served-model-name {WRITER} --host 127.0.0.1 --port 8000 {PROFILES[gpu]['args']} "
             f"--reasoning-parser muse_glimmer --limit-mm-per-prompt '{{\"image\":0,\"video\":0}}' --enable-prefix-caching")
    if nfs or not cuda13:
        env = f"-e HF_HOME={NFS}/hf-writer -e HF_HUB_OFFLINE=1 -e VLLM_CACHE_ROOT={NFS}/gw/vllm-cache-{gpu} -v /lambda/nfs:/lambda/nfs" if nfs else "-v /opt/hf:/root/.cache/huggingface"
        return f"""set -e
sudo docker ps -q -f name=^glimmer$ | grep -q . && exit 0
mkdir -p ~/img && cd ~/img
printf 'FROM {IMAGE}\\nRUN pip uninstall -y torchcodec\\n' > Dockerfile
sudo docker image inspect glimmer-vllm >/dev/null 2>&1 || (sudo docker pull -q {IMAGE} && sudo docker build -q -t glimmer-vllm .)
sudo docker rm -f glimmer >/dev/null 2>&1 || true
sudo docker run -d --name glimmer --restart unless-stopped --gpus all --ipc=host --network host {env} glimmer-vllm {serve.replace(chr(92), "")}
"""
    inner = f"pip uninstall -y torchcodec >/dev/null 2>&1; exec vllm serve {serve}"
    return f"""set -e
sudo docker ps -q -f name=^glimmer$ | grep -q . && exit 0
sudo docker pull -q {IMAGE}
sudo docker rm -f glimmer >/dev/null 2>&1 || true
sudo docker run -d --name glimmer --restart unless-stopped --gpus all --ipc=host --network host -v /opt/hf:/root/.cache/huggingface --entrypoint bash {IMAGE} -c '{inner.replace("'", "'\\''")}'
"""


def aws_launch(name, itype):
    s = aws()
    sg = aws_setup(s)
    ami = s.client("ssm").get_parameter(Name=AMI_PARAM)["Parameter"]["Value"]
    minutes = max(5, int((DEADLINE - now()).total_seconds() / 60))
    # The machine turns itself off at the deadline whatever this Mac does; off means terminated.
    user_data = "#!/bin/bash\nshutdown -h +%d\nmkdir -p /opt/hf\ncd /home/ubuntu\nsudo -u ubuntu bash -lc %s > /var/log/glimmer-serve.log 2>&1\n" % (
        minutes, "'" + serve_script(AWS_GPU, False, cuda13=True).replace("'", "'\\''") + "'")
    from botocore.config import Config
    ec2 = s.client("ec2", config=Config(retries={"max_attempts": 1}))
    subnets = ec2.describe_subnets(Filters=[{"Name": "default-for-az", "Values": ["true"]}])["Subnets"]
    # Every zone in turn: one zone's L40S capacity runs out long before the region's.
    for subnet in sorted(subnets, key=lambda x: x["AvailabilityZone"]):
        try:
            r = ec2.run_instances(
                ImageId=ami, InstanceType=itype, MinCount=1, MaxCount=1, KeyName=EC2_KEY,
                NetworkInterfaces=[{"DeviceIndex": 0, "SubnetId": subnet["SubnetId"], "Groups": [sg], "AssociatePublicIpAddress": True}],
                InstanceInitiatedShutdownBehavior="terminate", UserData=user_data,
                BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 150, "VolumeType": "gp3", "Iops": 6000, "Throughput": 1000, "DeleteOnTermination": True}}],
                TagSpecifications=[{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": name}]},
                                   {"ResourceType": "volume", "Tags": [{"Key": "Name", "Value": name}]}],
            )
            return r["Instances"][0]["InstanceId"]
        except Exception as err:  # Capacity in this zone, or the quota.
            log(f"launch {name} {itype} {subnet['AvailabilityZone']}: {str(err)[:160]}")
            if "VcpuLimitExceeded" in str(err):
                return None
    return None


def ssh(ip, command, timeout=60, user="ubuntu"):
    return subprocess.run(["ssh", "-i", KEY, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes",
                           f"{user}@{ip}", command], capture_output=True, text=True, timeout=timeout)


def start_serving(name, m):
    """Starts vLLM on a Lambda machine in the background; the next watch cycles see it come up."""
    script = serve_script(m["gpu"], m["region"] == "us-east-1")
    subprocess.Popen(["ssh", "-i", KEY, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes",
                      f"ubuntu@{m['ip']}", f"cat > ~/serve.sh <<'EOF'\n{script}EOF\nnohup bash ~/serve.sh > ~/serve.log 2>&1 &"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def tunnel_pids(port):
    r = subprocess.run(["pgrep", "-f", "--", f"-L {port}:127.0.0.1:8000"], capture_output=True, text=True)
    return [int(p) for p in r.stdout.split()]


def open_tunnel(port, ip):
    subprocess.run(["ssh", "-i", KEY, "-f", "-N", "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes",
                    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4", "-o", "ConnectTimeout=15",
                    "-L", f"{port}:127.0.0.1:8000", f"ubuntu@{ip}"], capture_output=True, timeout=40)


def close_tunnel(port):
    for pid in tunnel_pids(port):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def serving(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=8) as r:
            return any(d.get("id") == WRITER for d in json.load(r).get("data", []))
    except Exception:
        return False


def metrics(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=8) as r:
            text = r.read().decode()
    except Exception:
        return None
    out = {}
    for key in ("generation_tokens_total", "prompt_tokens_total", "num_requests_running", "num_requests_waiting", "kv_cache_usage_perc"):
        m = re.search(rf"^vllm:{key}\{{[^}}]*\}} ([0-9.e+]+)$", text, re.M)
        out[key] = float(m.group(1)) if m else None
    out["success"] = sum(float(x) for x in re.findall(r"^vllm:request_success_total\{[^}]*\} ([0-9.e+]+)$", text, re.M))
    return out


def terminate(state, names, why):
    """Terminates these fleet machines, checking each against ours() on the live listing first."""
    lam_ids, aws_ids = [], []
    try:
        live = lambda_instances()
    except Exception as err:
        live = None
        log(f"stop: Lambda listing failed ({err}); using the saved names")
    for name in names:
        m = state["machines"].get(name)
        if not m or m.get("ended"):
            continue
        if m["provider"] == "lambda":
            seen = (live or {}).get(m["id"])
            if live is not None and not seen:
                m["ended"] = now().isoformat()
                continue
            if ours(seen["name"] if seen else name, m["id"]):
                lam_ids.append(m["id"])
        elif ours(name, m["id"]):
            aws_ids.append(m["id"])
    if lam_ids:
        r = lam("POST", "instance-operations/terminate", {"instance_ids": lam_ids})
        done = {i["id"] for i in (r.get("data") or {}).get("terminated_instances", [])}
        log(f"stop ({why}): Lambda terminate {len(lam_ids)} -> {len(done)} confirmed {r.get('error') or ''}")
        for name in names:
            m = state["machines"].get(name)
            if m and m["id"] in done:
                m["ended"] = now().isoformat()
    if aws_ids:
        s = aws()
        live_aws = aws_instances(s)
        aws_ids = [i for i in aws_ids if ours(live_aws.get(i, {}).get("name"), i)]
        if aws_ids:
            s.client("ec2").terminate_instances(InstanceIds=aws_ids)
            log(f"stop ({why}): EC2 terminate {aws_ids}")
            for name in names:
                m = state["machines"].get(name)
                if m and m["id"] in aws_ids:
                    m["ended"] = now().isoformat()
    for name in names:
        m = state["machines"].get(name)
        if m:
            close_tunnel(port_for(name))
    save(state)


def write_endpoints(eps):
    tmp = ENDPOINTS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(eps, f)
    os.replace(tmp, ENDPOINTS)


def refresh(state):
    """Reads both clouds: addresses, and machines that ended without us (an EC2 timer, a manual terminate)."""
    try:
        live = lambda_instances()
        for name, m in state["machines"].items():
            if m["provider"] != "lambda" or m.get("ended"):
                continue
            i = live.get(m["id"])
            if not i or i.get("status") in ("terminated", "terminating"):
                m["ended"] = now().isoformat()
                log(f"{name}: gone from Lambda")
            else:
                m["ip"], m["status"] = i.get("ip"), i.get("status")
    except Exception as err:
        log(f"refresh: Lambda {err}")
    if any(m["provider"] == "aws" and not m.get("ended") for m in state["machines"].values()):
        try:
            live = aws_instances(aws())
            for name, m in state["machines"].items():
                if m["provider"] != "aws" or m.get("ended"):
                    continue
                i = live.get(m["id"])
                if not i or i["state"] in ("shutting-down", "terminated", "stopped", "stopping"):
                    m["ended"] = now().isoformat()
                    log(f"{name}: EC2 {i['state'] if i else 'gone'}")
                else:
                    m["ip"], m["status"] = i["ip"], i["state"]
        except Exception as err:
            log(f"refresh: EC2 {err}")



def s3_copy(since):
    """Copies Glimmer-written cache files changed since `since` to S3, skipping those already copied."""
    try:
        with open(UPLOADED) as f:
            done = set(f.read().split())
    except OSError:
        done = set()
    todo = []
    with os.scandir(QA_DIR) as it:
        for e in it:
            if e.name.endswith(".json") and e.name not in done and e.stat().st_mtime >= since - 3600:
                try:
                    with open(e.path) as f:
                        if json.load(f).get("writer") == WRITER:
                            todo.append(e.name)
                except (OSError, ValueError):
                    pass
    if not todo:
        return 0
    s3 = aws().client("s3")
    ok = []
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for name, err in zip(todo, pool.map(lambda n: _put(s3, n), todo)):
            if not err:
                ok.append(name)
    with open(UPLOADED, "a") as f:
        f.write("".join(n + "\n" for n in ok))
    return len(ok)


def copy_to_s3(since):
    try:
        log(f"s3: copied {s3_copy(since)} Glimmer answers")
    except Exception as err:
        log(f"s3: {err}")


def _put(s3, name):
    try:
        s3.upload_file(os.path.join(QA_DIR, name), BUCKET, S3_PREFIX + name)
        return None
    except Exception as err:
        return err


def runner_alive():
    try:
        with open(RUNNER_PID) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def stop_runner():
    """Stops the writer and its make-dataset run (they wait for servers forever once the fleet is gone)."""
    try:
        with open(RUNNER_PID) as f:
            pid = int(f.read().strip())
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        log("stop: writer stopped")
    except (OSError, ValueError):
        pass
    subprocess.run(["pkill", "-TERM", "-f", f"make-dataset.ts --endpoints {ENDPOINTS}"], capture_output=True)


NEVER_SERVED_MINUTES = 60  # a machine that isn't serving an hour after launch is broken
IDLE_MINUTES = 30  # a serving machine that generated nothing for this long has no work


def watch(interval=60):
    log("watch: started")
    last_s3 = 0.0
    copier = None
    last_scale = time.time()  # the first check waits 15 minutes, so a restart never launches straight away
    last_s3_mark = time.time() - 3 * 3600
    while True:
        try:
            state = load()
            track_extra(state)
            refresh(state)
            live = [n for n, m in state["machines"].items() if not m.get("ended")]
            spent, rate = spend(state)
            why = None
            if now() >= DEADLINE:
                why = "deadline"
            elif spent + rate * 2 / 60 >= CAP_USD:
                why = f"budget (${spent:.2f} of ${CAP_USD})"
            elif os.path.exists(DONE):
                why = "no work left"
            elif os.path.exists(STOPPED):
                why = "stopped by hand"
            if why and live:
                write_endpoints([])
                terminate(state, live, why)
                stop_runner()
                continue_after = [n for n, m in load()["machines"].items() if not m.get("ended")]
                if continue_after:
                    log(f"stop: still up {continue_after}; retrying next cycle")
            eps = []
            if not why:
                idle = []
                for name in live:
                    m = state["machines"][name]
                    # Counted from when watch first saw it, so a machine that was already up isn't judged by its launch.
                    age = (now() - dt.datetime.fromisoformat(m.setdefault("watched_since", now().isoformat()))).total_seconds() / 60
                    port = port_for(name)
                    met = metrics(port) if m.get("serving_since") else None
                    if met and met["generation_tokens_total"] is not None and met["generation_tokens_total"] != m.get("tokens"):
                        if m.get("tokens") is not None and m.get("tokens_at") and met["generation_tokens_total"] > m["tokens"]:
                            m["tok_s"] = round((met["generation_tokens_total"] - m["tokens"]) / (time.time() - m["tokens_at"]))
                        m["tokens"], m["tokens_at"], m["progress_at"] = met["generation_tokens_total"], time.time(), now().isoformat()
                    since = m.get("progress_at") or m.get("serving_since")
                    if since and (now() - dt.datetime.fromisoformat(since)).total_seconds() > IDLE_MINUTES * 60:
                        idle.append(name)
                        continue
                    if not m.get("serving_since") and age > NEVER_SERVED_MINUTES:
                        idle.append(name)
                        continue
                    if not m.get("ip") or m.get("status") not in ("active", "running"):
                        continue
                    if m["provider"] == "lambda" and not m.get("serving_since") and time.time() - m.get("served_at", 0) > 10 * 60:
                        start_serving(name, m)  # idempotent: it does nothing while the container exists
                        m["served_at"] = time.time()
                        log(f"{name}: starting vLLM ({m['gpu']})")
                    if serving(port):
                        eps.append({"url": f"http://127.0.0.1:{port}/v1", "concurrency": m.get("concurrency") or PROFILES[m["gpu"]]["concurrency"], "label": name})
                        m.setdefault("serving_since", now().isoformat())
                    elif not tunnel_pids(port):
                        open_tunnel(port, m["ip"])
                    elif m.get("serving_since"):
                        # It answered before and doesn't now: the tunnel may be stale.
                        close_tunnel(port)
                write_endpoints(eps)
                if eps and not runner_alive() and not os.path.exists(DONE):
                    # The writer died or never started: start it again (the cache means nothing is redone).
                    with open(os.path.join(ROOT, ".data", "knowledge", "logs", "writer-runner.log"), "a") as out:
                        subprocess.Popen([sys.executable, os.path.abspath(__file__), "write"], cwd=ROOT, stdout=out, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
                    log("watch: started the writer")
                    time.sleep(5)
                if idle:
                    terminate(state, idle, f"idle or never served: {idle}")
            for name, m in state["machines"].items():
                if m.get("ended") and tunnel_pids(port_for(name)):
                    close_tunnel(port_for(name))
            save(state)
            if not why and time.time() - last_scale > 15 * 60:
                last_scale = time.time()
                try:
                    autoscale(state)
                except Exception as err:
                    log(f"autoscale: {err}")
            if time.time() - last_s3 > 15 * 60 and not (copier and copier.is_alive()):
                # In the background, so a big copy never holds up the kill switch.
                last_s3 = time.time()
                copier = threading.Thread(target=copy_to_s3, args=(last_s3_mark,), daemon=True)
                last_s3_mark = last_s3
                copier.start()
            p = projection(state)
            speeds = " ".join(f"{n[len(PREFIX):] if n.startswith(PREFIX) else n}:{m.get('tok_s', '-')}" for n, m in state["machines"].items() if not m.get("ended"))
            log(f"watch: {len(live)} up, {len(eps)} serving, ${p['spent_usd']} spent, ${p['usd_per_hour']}/h, cap at {p['cap_reached_at']}, runner {'up' if runner_alive() else 'down'}, tok/s {speeds}" + (f", STOP: {why}" if why else ""))
            if why and not [n for n, m in load()["machines"].items() if not m.get("ended")] and (now() >= DEADLINE or os.path.exists(DONE) or os.path.exists(STOPPED) or "budget" in why):
                log("watch: fleet is down for good; exiting")
                return
        except Exception as err:
            log(f"watch: {type(err).__name__}: {err}")
        time.sleep(interval)


def set_concurrency(name, n):
    """Changes how many requests the writer keeps in flight on one machine (watch passes it on within a minute)."""
    with open(STATE + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load()
        state["machines"][name]["concurrency"] = n
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, STATE)
    print(json.dumps({name: n}))


def stop(name=None):
    state = load()
    track_extra(state)
    refresh(state)
    names = [name] if name else [n for n, m in state["machines"].items() if not m.get("ended")]
    if not name:
        with open(STOPPED, "w") as f:
            f.write(now().isoformat())
        write_endpoints([])
    terminate(state, names, "stop command")
    if not name:
        stop_runner()
    print(json.dumps({n: state["machines"][n].get("ended") for n in names}, indent=1))


def status():
    state = load()
    track_extra(state)
    rows = []
    for name, m in sorted(state["machines"].items()):
        port = port_for(name)
        met = None if m.get("ended") else metrics(port)
        rows.append({"name": name, "type": m["type"], "provider": m["provider"], "usd_per_hour": m["usd_per_hour"], "launched": m["launched"][:16],
                     "ended": (m.get("ended") or "")[:16], "port": port, "serving": bool(met), "running": met and met["num_requests_running"],
                     "generated_tokens": met and met["generation_tokens_total"], "tok_s": m.get("tok_s"), "kv": met and round(met["kv_cache_usage_perc"] or 0, 2)})
    print(json.dumps({"machines": rows, **projection(state), "deadline": DEADLINE.isoformat(), "cap_usd": CAP_USD,
                      "runner": runner_alive(), "done": os.path.exists(DONE)}, indent=1))


def files_for(prefixes):
    names = sorted(f for f in os.listdir(SOURCES) if f.endswith(".jsonl") and not BANNED.match(f))
    return [f for f in names if any(f.startswith(p) for p in prefixes.split(","))]


def write():
    """Runs make-dataset over every tier in order, once per run, then again until a whole pass writes nothing new."""
    try:
        os.setpgrp()  # its own process group, so stop_runner() also stops the make-dataset run
    except OSError:
        pass  # already a group leader (watch starts it in a new session)
    with open(RUNNER_PID, "w") as f:
        f.write(str(os.getpid()))
    env = {**os.environ, "SPARK_OPEN_MODEL": WRITER, "SPARK_OPEN_API_KEY": "local", "SPARK_OPEN_PRICE_IN": "0", "SPARK_OPEN_PRICE_OUT": "0",
           "SPARK_OPEN_MAX_TOKENS": "4000", "SPARK_OPEN_WRITER_NAME": "Muse Glimmer 30B"}
    base = ["npx", "tsx", "scripts/knowledge/make-dataset.ts", "--endpoints", ENDPOINTS, "--skip-written-by", "muse-spark-open", "--shard", "0/1"]
    while True:
        runs = [("a-meta-ai", ["--only-sources", "--sources", TIER_A]), ("b-wikipedia", ["--sources", "__none__"])]
        for news in ("s3-ccnews-ai-meta", "s3-ccnews-general"):
            if os.path.exists(os.path.join(SOURCES, news + ".jsonl")):
                runs.append(("c-" + news, ["--only-sources", "--sources", news]))
        runs += [(f"d-gov-{i}", ["--only-sources", "--sources", ",".join(files_for(t))]) for i, t in enumerate(TIER_D) if files_for(t)]
        runs += [(f"e-science-{i}", ["--only-sources", "--sources", ",".join(files_for(t))]) for i, t in enumerate(TIER_E) if files_for(t)]
        wrote = 0
        for label, extra in runs:
            if os.path.exists(DONE):
                return
            logf = os.path.join(ROOT, ".data", "knowledge", "logs", f"gw-{label}.log")
            log(f"write: {label} {' '.join(extra)[:160]}")
            with open(logf, "a") as out:
                r = subprocess.run(base + extra, cwd=ROOT, env=env, stdout=out, stderr=subprocess.STDOUT)
            with open(logf) as f:
                tail = f.read()[-4000:]
            m = re.findall(r"(\d+) of (\d+) answered, (\d+) failed, (\d+) new", tail)
            new = int(m[-1][3]) if m else 0
            wrote += new
            log(f"write: {label} exit {r.returncode}, {new} new")
            if r.returncode != 0:
                time.sleep(60)
        if wrote == 0:
            with open(DONE, "w") as f:
                f.write(now().isoformat())
            log("write: a whole pass wrote nothing new; done")
            return


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["status", "launch", "stop", "watch", "write", "set"])
    ap.add_argument("provider", nargs="?")
    ap.add_argument("itype", nargs="?")
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--name")
    ap.add_argument("--concurrency", type=int)
    a = ap.parse_args()
    if a.command == "launch":
        launch(a.provider, a.itype, a.region, a.count)
    elif a.command == "stop":
        stop(a.name)
    elif a.command == "watch":
        watch()
    elif a.command == "write":
        write()
    elif a.command == "set":
        set_concurrency(a.name, a.concurrency)
    else:
        status()
