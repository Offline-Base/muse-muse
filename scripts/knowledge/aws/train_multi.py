"""Multi-GPU knowledge training machines (muse-knowledge-train-<n>) for job/train_glimmer.py under torchrun.

    PY=.data/aws/venv/bin/python; F=scripts/knowledge/aws/train_multi.py
    $PY $F setup                     instance role, security group, forget.jsonl and the job code in S3
    $PY $F launch                    tries each machine type in order (CANDIDATES), stops at the first that launches
    $PY $F retry                     launch every 15 minutes until RETRY_UNTIL
    $PY $F status                    machines and spend
    $PY $F stop [--name NAME]        terminate every muse-knowledge-train-* machine (or one)
    caffeinate -dims $PY $F watch    the kill switch: terminates at CAP_USD, at each machine's deadline, or after stop
    $PY $F lambda-prep --name N      Lambda: scp the code and the stage data from this Mac, start box_setup.sh
    $PY $F lambda-sync --name N --run RUN   Lambda: every 10 minutes, the run to .data/knowledge/runs/RUN/ and S3
    $PY $F start-run --name N --run RUN [--train LOCAL.jsonl] [--init-adapter RUN|RUN/checkpoint-N] [--base-json RUN] [--lr X] ...
                                     Lambda: start run_multi.sh detached (refused while a run is going) plus its sync
      Stage 2 from stage 1:  start-run --name muse-knowledge-train-1 --run stage2-multi --train NEW.jsonl \
                             --init-adapter stage1-multi --base-json stage1-multi --save-steps 1000

Launching is off (TRAIN_MULTI_ALLOW_LAUNCH=1 turns it on): the lane's one machine, muse-knowledge-train-1, an 8x A100
80GB SXM4 on Lambda, was launched by the main session at 00:20 UTC on Oct 31 and registered in the state file by hand.
watch, stop and terminate only ever act on machines named muse-knowledge-train-* (in the state and on Lambda's side).

EC2 machines get the MuseKnowledgeTrain role (read the corpus dataset prefix, read and write knowledge/runs/), no
credentials, a Deep Learning AMI, and `shutdown -h +N` at boot with instance-initiated shutdown set to terminate,
where N keeps the machine under both MAX_HOURS and the lane's CAP_USD. Lambda machines can't stop themselves, so
`watch` on this Mac is their only kill switch.
Spend counts from each machine's launch time and hourly price (Lambda by the started minute, EC2 by the second).
"""

import argparse
import base64
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(ROOT, ".data", "aws", "train-multi.json")
STOPPED = os.path.join(ROOT, ".data", "aws", "train-multi.stopped")
LOG = os.path.join(ROOT, ".data", "knowledge", "logs", "train-multi.log")
PROFILE = "offlinebase"
REGION = "us-east-1"
BUCKET = "muse-knowledge-916979311153"
DATASET = "knowledge/corpus/dataset/"
RUNS = "knowledge/runs/"
RUN = os.environ.get("TRAIN_RUN", "stage1-multi")
PREFIX = "muse-knowledge-train-"
ROLE = "MuseKnowledgeTrain"
SG_NAME = "muse-knowledge-train"
EC2_KEY = "muse-knowledge-gw"  # the same public key as the Lambda machines (~/.ssh/muse-muse-lambda)
LAMBDA_KEY_NAME = "muse-muse-platform"
KEY = os.path.expanduser("~/.ssh/muse-muse-lambda")
AMI_PARAM = "/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id"
# This lane's cap for its own machines (the owner allows $1,250 on Lambda in all; this lane may use $450 of it).
CAP_USD = 1500.0
SPENT_BEFORE_USD = 0.0
MAX_HOURS = 7.0
RETRY_UNTIL = dt.datetime(2026, 10, 31, 3, 0, tzinfo=dt.timezone.utc)
# In order; the first that launches wins. EC2 prices are us-east-1 on demand (Pricing API, Oct 30).
CANDIDATES = [
    ("aws", "p5.48xlarge", 55.04), ("aws", "p5en.48xlarge", 63.296), ("aws", "p4de.24xlarge", 27.44705), ("aws", "p4d.24xlarge", 21.957642),
    ("lambda", "gpu_8x_h100_sxm5", None), ("lambda", "gpu_8x_a100_80gb_sxm4", None), ("lambda", "gpu_4x_h100_sxm5", None), ("lambda", "gpu_8x_a100", None),
]
CODE = ["train_glimmer.py", "box_setup.sh", "run_multi.sh", "check_adapter.py"]


def now():
    return dt.datetime.now(dt.timezone.utc)


def log(msg):
    line = f"{now().strftime('%Y-%m-%dT%H:%M:%SZ')} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
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
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE)


def hours(m, at):
    start = dt.datetime.fromisoformat(m["launched"])
    end = dt.datetime.fromisoformat(m["ended"]) if m.get("ended") else at
    h = max(0.0, (end - start).total_seconds() / 3600)
    return (int(h * 60) + 1) / 60 if m["provider"] == "lambda" else max(h, 1 / 60)


def spend(state, at=None):
    at = at or now()
    spent = SPENT_BEFORE_USD + sum(m["usd_per_hour"] * hours(m, at) for m in state["machines"].values())
    rate = sum(m["usd_per_hour"] for m in state["machines"].values() if not m.get("ended"))
    return round(spent, 2), round(rate, 2)


# ---- Lambda (the key stays on this Mac: read from .env.local, sent only to Lambda's API, never printed) ----

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
                 "Content-Type": "application/json", "User-Agent": "muse-knowledge-train"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}")
        except ValueError:
            return {"error": {"message": f"HTTP {e.code}"}}


# ---- AWS ----

def aws():
    import boto3
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def my_ip():
    with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=20) as r:
        return r.read().decode().strip()


def setup():
    s = aws()
    iam, ec2, s3 = s.client("iam"), s.client("ec2"), s.client("s3")
    trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
    try:
        iam.get_role(RoleName=ROLE)
    except iam.exceptions.NoSuchEntityException:
        iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust), Description="muse-knowledge-train machines: read the dataset, write runs")
    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": "s3:ListBucket", "Resource": f"arn:aws:s3:::{BUCKET}",
         "Condition": {"StringLike": {"s3:prefix": [DATASET + "*", RUNS + "*"]}}},
        {"Effect": "Allow", "Action": "s3:GetObject", "Resource": [f"arn:aws:s3:::{BUCKET}/{DATASET}*", f"arn:aws:s3:::{BUCKET}/{RUNS}*"]},
        {"Effect": "Allow", "Action": ["s3:PutObject", "s3:AbortMultipartUpload"], "Resource": f"arn:aws:s3:::{BUCKET}/{RUNS}*"},
    ]}
    iam.put_role_policy(RoleName=ROLE, PolicyName=ROLE + "S3", PolicyDocument=json.dumps(policy))
    try:
        iam.get_instance_profile(InstanceProfileName=ROLE)
    except iam.exceptions.NoSuchEntityException:
        iam.create_instance_profile(InstanceProfileName=ROLE)
        iam.add_role_to_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE)
        time.sleep(10)
    vpc = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]["VpcId"]
    groups = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [SG_NAME]}, {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
    sg = groups[0]["GroupId"] if groups else ec2.create_security_group(GroupName=SG_NAME, Description="Knowledge training - SSH from the owner Mac only", VpcId=vpc)["GroupId"]
    try:
        ec2.authorize_security_group_ingress(GroupId=sg, IpPermissions=[{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": my_ip() + "/32"}]}])
    except ec2.exceptions.ClientError as err:
        if "Duplicate" not in str(err):
            raise
    s3.upload_file(os.path.join(HERE, "forget.jsonl"), BUCKET, DATASET + "forget.jsonl")
    upload_code()
    print(json.dumps({"role": ROLE, "security_group": sg}))
    return sg


def upload_code():
    s3 = aws().client("s3")
    for f in CODE:
        s3.upload_file(os.path.join(HERE, "job", f), BUCKET, f"{RUNS}{RUN}/code/{f}")


def user_data(minutes):
    code = f"s3://{BUCKET}/{RUNS}{RUN}/code/"
    return f"""#!/bin/bash
# The hard stop: off means terminated, whatever this Mac does.
shutdown -h +{minutes}
for i in $(seq 1 24); do mountpoint -q /opt/dlami/nvme && break; sleep 5; done
mkdir -p /home/ubuntu/k
if mountpoint -q /opt/dlami/nvme; then mkdir -p /opt/dlami/nvme/k && chown ubuntu:ubuntu /opt/dlami/nvme/k; fi
for i in $(seq 1 60); do aws s3 cp --only-show-errors --recursive {code} /home/ubuntu/k/ && [ -f /home/ubuntu/k/box_setup.sh ] && break; sleep 20; done
chown -R ubuntu:ubuntu /home/ubuntu/k
chmod +x /home/ubuntu/k/*.sh
sudo -u ubuntu bash -lc 'bash /home/ubuntu/k/box_setup.sh > /home/ubuntu/k/setup.log 2>&1'
aws s3 cp --only-show-errors /home/ubuntu/k/setup.log s3://{BUCKET}/{RUNS}{RUN}/setup.log
"""


def deadline_minutes(state, price):
    spent, rate = spend(state)
    by_budget = (CAP_USD - spent - rate * MAX_HOURS) / price * 60 - 20
    return int(min(MAX_HOURS * 60, by_budget))


def next_name(state):
    used = [int(n[len(PREFIX):]) for n in state["machines"] if n[len(PREFIX):].isdigit()]
    return PREFIX + str(max(used, default=0) + 1)


def aws_launch(name, itype, minutes):
    from botocore.config import Config
    s = aws()
    ec2 = s.client("ec2", config=Config(retries={"max_attempts": 1}))
    sg = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [SG_NAME]}])["SecurityGroups"][0]["GroupId"]
    ami = s.client("ssm").get_parameter(Name=AMI_PARAM)["Parameter"]["Value"]
    offered = {o["Location"] for o in ec2.describe_instance_type_offerings(LocationType="availability-zone", Filters=[{"Name": "instance-type", "Values": [itype]}])["InstanceTypeOfferings"]}
    subnets = [x for x in ec2.describe_subnets(Filters=[{"Name": "default-for-az", "Values": ["true"]}])["Subnets"] if x["AvailabilityZone"] in offered]
    for subnet in sorted(subnets, key=lambda x: x["AvailabilityZone"]):
        try:
            r = ec2.run_instances(
                ImageId=ami, InstanceType=itype, MinCount=1, MaxCount=1, KeyName=EC2_KEY,
                IamInstanceProfile={"Name": ROLE},
                NetworkInterfaces=[{"DeviceIndex": 0, "SubnetId": subnet["SubnetId"], "Groups": [sg], "AssociatePublicIpAddress": True}],
                InstanceInitiatedShutdownBehavior="terminate", UserData=user_data(minutes),
                MetadataOptions={"HttpTokens": "required", "HttpPutResponseHopLimit": 1},
                BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 300, "VolumeType": "gp3", "Iops": 8000, "Throughput": 1000, "DeleteOnTermination": True}}],
                TagSpecifications=[{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": name}]},
                                   {"ResourceType": "volume", "Tags": [{"Key": "Name", "Value": name}]}],
            )
            return r["Instances"][0]["InstanceId"], subnet["AvailabilityZone"]
        except Exception as err:
            log(f"launch {name} {itype} {subnet['AvailabilityZone']}: {str(err)[:200]}")
            if "VcpuLimitExceeded" in str(err):
                return None, None
    return None, None


def launch():
    if os.environ.get("TRAIN_MULTI_ALLOW_LAUNCH") != "1":
        raise SystemExit("launch is off: muse-knowledge-train-1 is this lane's only machine (TRAIN_MULTI_ALLOW_LAUNCH=1 turns it back on)")
    state = load()
    if any(not m.get("ended") for m in state["machines"].values()):
        log("launch: a training machine is already up; not launching another")
        return True
    types = (lam("GET", "instance-types").get("data") or {})
    for provider, itype, price in CANDIDATES:
        name = next_name(state)
        if provider == "aws":
            minutes = deadline_minutes(state, price)
            if minutes < 90:
                log(f"launch: {itype} would get only {minutes} minutes inside the budget; skipping")
                continue
            iid, zone = aws_launch(name, itype, minutes)
            if not iid:
                continue
            state["machines"][name] = {"provider": "aws", "id": iid, "type": itype, "zone": zone, "usd_per_hour": price,
                                       "launched": now().isoformat(), "deadline": (now() + dt.timedelta(minutes=minutes)).isoformat()}
        else:
            t = types.get(itype) or {}
            regions = [r["name"] for r in t.get("regions_with_capacity_available", [])]
            if not regions:
                log(f"launch: Lambda {itype}: no capacity")
                continue
            price = t["instance_type"]["price_cents_per_hour"] / 100
            minutes = deadline_minutes(state, price)
            if minutes < 90:
                continue
            r = lam("POST", "instance-operations/launch", {"region_name": regions[0], "instance_type_name": itype, "ssh_key_names": [LAMBDA_KEY_NAME], "name": name})
            ids = (r.get("data") or {}).get("instance_ids")
            if not ids:
                log(f"launch: Lambda {itype} {regions[0]}: {r.get('error')}")
                continue
            state["machines"][name] = {"provider": "lambda", "id": ids[0], "type": itype, "zone": regions[0], "usd_per_hour": price,
                                       "launched": now().isoformat(), "deadline": (now() + dt.timedelta(minutes=minutes)).isoformat()}
        save(state)
        m = state["machines"][name]
        log(f"launched {name} {itype} in {m['zone']} ({m['id']}) at ${m['usd_per_hour']}/h, deadline {m['deadline'][:16]}Z")
        return True
    return False


def retry():
    """Launch every 15 minutes until one launches or RETRY_UNTIL, then stay on as the kill switch (watch)."""
    while now() < RETRY_UNTIL and not os.path.exists(STOPPED):
        try:
            if launch():
                return watch()
        except Exception as err:
            log(f"retry: {type(err).__name__}: {err}")
        log("retry: nothing launched; next try in 15 minutes")
        time.sleep(15 * 60)
    log("retry: gave up at the retry deadline")


def refresh(state):
    live_aws = {}
    if any(m["provider"] == "aws" and not m.get("ended") for m in state["machines"].values()):
        for res in aws().client("ec2").describe_instances(Filters=[{"Name": "tag:Name", "Values": [PREFIX + "*"]}])["Reservations"]:
            for i in res["Instances"]:
                live_aws[i["InstanceId"]] = i
    live_lam = None
    if any(m["provider"] == "lambda" and not m.get("ended") for m in state["machines"].values()):
        data = lam("GET", "instances").get("data")
        live_lam = {i["id"]: i for i in data} if data is not None else None
    for name, m in state["machines"].items():
        if m.get("ended"):
            continue
        if m["provider"] == "aws":
            i = live_aws.get(m["id"])
            st = i["State"]["Name"] if i else "gone"
            m["ip"], m["status"] = (i or {}).get("PublicIpAddress"), st
            if st in ("shutting-down", "terminated", "stopped", "stopping", "gone"):
                m["ended"] = now().isoformat()
                log(f"{name}: EC2 {st}")
        elif live_lam is not None:
            i = live_lam.get(m["id"])
            if not i or i.get("status") in ("terminated", "terminating"):
                m["ended"] = now().isoformat()
                log(f"{name}: gone from Lambda")
            else:
                m["ip"], m["status"] = i.get("ip"), i.get("status")


def terminate(state, names, why):
    for name in names:
        m = state["machines"].get(name)
        if not m or m.get("ended") or not name.startswith(PREFIX):
            continue
        if m["provider"] == "aws":
            s = aws()
            tags = s.client("ec2").describe_instances(InstanceIds=[m["id"]])["Reservations"][0]["Instances"][0].get("Tags", [])
            if next((t["Value"] for t in tags if t["Key"] == "Name"), "").startswith(PREFIX):
                s.client("ec2").terminate_instances(InstanceIds=[m["id"]])
                m["ended"] = now().isoformat()
        else:
            data = lam("GET", "instances").get("data")
            if data is None:
                # The list failed: nothing is known, so nothing is terminated or marked ended; the next cycle retries.
                log(f"stop {name}: Lambda's instance list failed; retrying next cycle")
                continue
            live = {i["id"]: i for i in data}
            i = live.get(m["id"])
            # Only ever this one id, and only when Lambda itself names it muse-knowledge-train-*.
            if i and i.get("name", "").startswith(PREFIX):
                r = lam("POST", "instance-operations/terminate", {"instance_ids": [m["id"]]})
                done = [t.get("id") for t in (r.get("data") or {}).get("terminated_instances", [])]
                if m["id"] in done:
                    m["ended"] = now().isoformat()
            elif i:
                log(f"stop {name}: Lambda names {m['id']} {i.get('name')!r}, not {PREFIX}*; not touching it")
                m["ended"] = now().isoformat()
                m["ended_note"] = "id belongs to another machine; left alone"
            else:
                m["ended"] = now().isoformat()
        log(f"stop {name} ({why}): {'done' if m.get('ended') else 'FAILED, retrying next cycle'}")
    save(state)


def stop(name=None):
    state = load()
    refresh(state)
    if not name:
        with open(STOPPED, "w") as f:
            f.write(now().isoformat())
    terminate(state, [name] if name else [n for n, m in state["machines"].items() if not m.get("ended")], "stop command")
    status()


def watch(interval=60):
    log("watch: started")
    while True:
        try:
            state = load()
            refresh(state)
            spent, rate = spend(state)
            live = [n for n, m in state["machines"].items() if not m.get("ended")]
            for n in live:
                m = state["machines"][n]
                why = None
                if spent + rate * 2 / 60 >= CAP_USD:
                    why = f"budget (${spent} of ${CAP_USD})"
                elif now() >= dt.datetime.fromisoformat(m["deadline"]):
                    why = "deadline"
                elif os.path.exists(STOPPED):
                    why = "stopped by hand"
                if why:
                    terminate(state, [n], why)
            save(state)
            log(f"watch: {len(live)} up, ${spent} spent, ${rate}/h")
            if not live and (state["machines"] or os.path.exists(STOPPED) or now() >= RETRY_UNTIL):
                log("watch: nothing up; exiting")
                return
        except Exception as err:
            log(f"watch: {type(err).__name__}: {err}")
        time.sleep(interval)


def status():
    state = load()
    try:
        refresh(state)
        save(state)
    except Exception as err:
        print(f"refresh failed: {err}", file=sys.stderr)
    spent, rate = spend(state)
    print(json.dumps({"machines": state["machines"], "spent_usd": spent, "usd_per_hour": rate, "cap_usd": CAP_USD}, indent=1))


def ssh(ip, command, timeout=120):
    return subprocess.run(["ssh", "-n", *SSH_OPTS, f"ubuntu@{ip}", command], capture_output=True, text=True, timeout=timeout)


SSH_OPTS = ["-i", KEY, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes",
            "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"]
# The stage data as this Mac holds it (the same bytes as the S3 dataset files): published name -> local file.
LOCAL_DATA = {
    "train.jsonl": os.path.join(ROOT, ".data", "knowledge", "dataset", "train-stage1-frozen.jsonl"),
    "probes.jsonl": os.path.join(ROOT, ".data", "knowledge", "dataset", "eval-probes.jsonl"),
    "forget.jsonl": os.path.join(HERE, "forget.jsonl"),
}
RUNS_LOCAL = os.path.join(ROOT, ".data", "knowledge", "runs")
MIN_FREE_GB = 6.0  # this Mac's disk is nearly full: below this, checkpoints aren't pulled (small files still are)


def machine(name):
    if not name or not name.startswith(PREFIX):
        raise SystemExit(f"--name must be a {PREFIX}* machine")
    state = load()
    refresh(state)
    save(state)
    m = state["machines"].get(name)
    if not m or m.get("ended") or not m.get("ip"):
        raise SystemExit(f"{name} isn't up (or has no IP yet)")
    return m


def lambda_prep(name):
    """A Lambda machine has no AWS credentials, and none go there: this Mac copies the code and data to it by scp
    and starts box_setup.sh with KNOWLEDGE_NO_S3=1."""
    ip = machine(name)["ip"]
    subprocess.run(["ssh", *SSH_OPTS, f"ubuntu@{ip}", "mkdir -p /home/ubuntu/k/data"], check=True)
    subprocess.run(["scp", *SSH_OPTS, *[os.path.join(HERE, "job", f) for f in CODE], f"ubuntu@{ip}:/home/ubuntu/k/"], check=True)
    for remote, path in LOCAL_DATA.items():
        subprocess.run(["scp", "-C", *SSH_OPTS, path, f"ubuntu@{ip}:/home/ubuntu/k/data/{remote}"], check=True)
    subprocess.run(["ssh", *SSH_OPTS, f"ubuntu@{ip}", "cd /home/ubuntu/k || exit 1; chmod +x *.sh; KNOWLEDGE_NO_S3=1 setsid nohup bash box_setup.sh > setup.log 2>&1 < /dev/null &"], check=True)
    log(f"{name}: code and data copied by scp, setup started")


def free_gb(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize / 1024 ** 3


def checkpoint_steps(d):
    return sorted(int(x.split("-")[1]) for x in os.listdir(d) if re.fullmatch(r"checkpoint-\d+", x)) if os.path.isdir(d) else []


SMALL_BYTES = 8 * 1024 ** 2  # files up to this size go to S3 every cycle (the 28 MB tokenizer.json counts as large)
LARGE_KBPS = 64  # the cap for a large upload from this Mac (its whole upload link measured 160 to 430 KB/s on Oct 31)


class Throttled:
    """A file read no faster than `rate` bytes a second, for boto3's upload_fileobj. Each read returns the full
    amount asked for (or what is left), as s3transfer expects."""

    def __init__(self, f, rate):
        self.f, self.rate, self.t0, self.n = f, rate, time.time(), 0

    def read(self, size=-1):
        out = []
        want = size if size and size > 0 else 1 << 62
        while want > 0:
            data = self.f.read(min(want, 128 * 1024))
            if not data:
                break
            out.append(data)
            want -= len(data)
            self.n += len(data)
            ahead = self.n / self.rate - (time.time() - self.t0)
            if ahead > 0:
                time.sleep(ahead)
        return b"".join(out)


def lambda_sync(name, run_name, dest=None, interval=600, large="final", kbps=LARGE_KBPS):
    """Every 10 minutes: copies a Lambda run back to this Mac (.data/knowledge/runs/RUN/) and on to S3
    (knowledge/runs/RUN/), since the machine has no AWS credentials. Pulled to the Mac every cycle: the log,
    hyperparameters, base answers, adapter, answers, metrics and the newest finished checkpoint (only the newest is
    kept here; the disk is nearly full). To S3 every cycle: every file up to 8 MB. This Mac's upload link is slow
    (160 to 430 KB/s measured on Oct 31), so a 2.4 GB checkpoint can't go up every 10 minutes without starving the
    writer fleet: large files go to S3 only with large="final" (the default: the final adapter, once, in the
    background at `kbps` KB/s) and never the checkpoints, which stay on the Mac and the machine."""
    import threading
    if not name.startswith(PREFIX):
        raise SystemExit(f"--name must be a {PREFIX}* machine")
    dest = (dest or f"s3://{BUCKET}/{RUNS}{run_name}/").rstrip("/") + "/"
    bucket, prefix = dest[len("s3://"):].split("/", 1)
    local = os.path.join(RUNS_LOCAL, run_name)
    os.makedirs(local, exist_ok=True)
    sent, queued = {}, set()
    ssh_cmd = "ssh " + " ".join(SSH_OPTS)
    pending = []
    lock = threading.Lock()

    def big_uploader():
        from boto3.s3.transfer import TransferConfig
        cfg = TransferConfig(use_threads=False, multipart_chunksize=16 * 1024 ** 2, multipart_threshold=16 * 1024 ** 2)
        while True:
            with lock:
                job = pending.pop(0) if pending else None
            if not job:
                time.sleep(30)
                continue
            path, key, stamp = job
            began = time.time()
            try:
                with open(path, "rb") as f:
                    aws().client("s3").upload_fileobj(Throttled(f, kbps * 1024), bucket, prefix + key, Config=cfg)
                sent[path] = stamp
                log(f"sync {run_name}: {key} ({stamp[1] / 1024 ** 3:.2f} GB) in S3 after {(time.time() - began) / 60:.0f} min")
            except Exception as err:
                log(f"sync {run_name}: large upload {key}: {type(err).__name__}: {str(err)[:200]}; retrying later")
            with lock:
                queued.discard(path)

    threading.Thread(target=big_uploader, daemon=True).start()
    while True:
        m = load()["machines"].get(name) or {}
        if m.get("ended"):
            log(f"sync {run_name}: {name} has ended; sync stops")
            return
        try:
            sync_once(m["ip"], run_name, local, bucket, prefix, sent, ssh_cmd, large, pending, queued, lock)
        except Exception as err:
            log(f"sync {run_name}: {type(err).__name__}: {str(err)[:300]}")
        time.sleep(interval)


def sync_once(ip, run_name, local, bucket, prefix, sent, ssh_cmd, large, pending, queued, lock):
    src = f"ubuntu@{ip}:/home/ubuntu/k/runs/{run_name}"
    ckpt = os.path.join(local, "ckpt")
    os.makedirs(ckpt, exist_ok=True)
    began = time.time()
    # Everything but the checkpoints, then the newest finished checkpoint only (the Trainer writes its
    # trainer_state.json last, so a checkpoint without one is still being saved).
    r1 = subprocess.run(["rsync", "-a", "--exclude", "ckpt/checkpoint-*", "--exclude", "pid", "-e", ssh_cmd, src + "/", local + "/"],
                        capture_output=True, text=True, timeout=3600)
    ls = subprocess.run(["ssh", "-n", *SSH_OPTS, f"ubuntu@{ip}", f"cd /home/ubuntu/k/runs/{run_name}/ckpt 2>/dev/null && ls -d checkpoint-*/trainer_state.json 2>/dev/null"],
                        capture_output=True, text=True, timeout=120)
    steps = sorted(int(x.split("/")[0].split("-")[1]) for x in ls.stdout.split() if re.fullmatch(r"checkpoint-\d+/trainer_state.json", x))
    newest = f"checkpoint-{steps[-1]}" if steps else None
    if newest and newest not in os.listdir(ckpt) and free_gb(local) < MIN_FREE_GB:
        log(f"sync {run_name}: only {free_gb(local):.1f} GB free on this Mac; not pulling {newest}")
        newest = None
    if newest:
        r2 = subprocess.run(["rsync", "-a", "-e", ssh_cmd, f"{src}/ckpt/{newest}", ckpt + "/"], capture_output=True, text=True, timeout=3600)
        if r2.returncode != 0:
            log(f"sync {run_name}: pulling {newest} failed (rsync {r2.returncode}); retrying next cycle")
            newest = None
        else:
            # The machine keeps the newest two; this Mac only the newest.
            for step in checkpoint_steps(ckpt):
                if f"checkpoint-{step}" != newest:
                    subprocess.run(["rm", "-rf", os.path.join(ckpt, f"checkpoint-{step}")])
    uploaded, failed, held = 0, 0, 0
    s3 = aws().client("s3")
    for dirpath, _, files in os.walk(local):
        for f in files:
            path = os.path.join(dirpath, f)
            rel = os.path.relpath(path, local)
            # No part of a checkpoint goes to S3: a checkpoint without its adapter and optimizer there would look
            # resumable to run_multi.sh on a new machine and fail.
            if f.endswith(".tmp") or rel.startswith("ckpt/checkpoint-"):
                continue
            st = os.stat(path)
            stamp = (st.st_mtime, st.st_size)
            if sent.get(path) == stamp:
                continue
            key = rel.replace("ckpt/", "checkpoints/", 1) if rel.startswith("ckpt/") else rel.replace("out/", "", 1)
            if st.st_size > SMALL_BYTES:
                if large == "final" and rel.startswith("out/adapter/"):
                    with lock:
                        if path not in queued:
                            queued.add(path)
                            pending.append((path, key, stamp))
                held += 1
                continue
            try:
                s3.upload_file(path, bucket, prefix + key)
                sent[path] = stamp
                uploaded += 1
            except Exception as err:
                failed += 1
                log(f"sync {run_name}: {key}: {type(err).__name__}: {str(err)[:200]}")
    log(f"sync {run_name}: rsync exit {r1.returncode}, newest {newest}, {uploaded} small files to S3, {failed} failed, "
        f"{held} large files here only or queued, {time.time() - began:.0f} s, {free_gb(local):.1f} GB free here")


REMOTE = "/home/ubuntu/k"


def remote_path(p):
    """A run name (its final adapter), RUN/checkpoint-N (that checkpoint), or an absolute path on the machine."""
    if not p or p.startswith("/"):
        return p
    run, _, rest = p.partition("/")
    return f"{REMOTE}/runs/{run}/ckpt/{rest}" if rest else f"{REMOTE}/runs/{run}/out/adapter"


def start_run(a):
    """Starts run_multi.sh on a Lambda training machine (detached with setsid, so no SSH session holds it) and, unless
    --no-sync, this Mac's 10-minute copy of the run to .data/knowledge/runs/RUN/ and S3. Refuses while another
    train_glimmer.py runs there, so it can't disturb a run in progress."""
    ip = machine(a.name)["ip"]
    run = a.run
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", run):
        raise SystemExit("--run: letters, digits, . _ - only")
    # [t] keeps pgrep from matching this very command line.
    busy = ssh(ip, "pgrep -f '[t]rain_glimmer.py' >/dev/null && echo busy || echo free").stdout.strip()
    if busy != "free":
        raise SystemExit(f"{a.name}: a train_glimmer.py is running there ({busy or 'no answer'}); not starting {run}")
    data = f"{REMOTE}/data"
    if a.train or a.probes:
        # A run with its own data gets its own folder; whatever isn't given comes from the stage 1 folder.
        data = f"{REMOTE}/data-{run}"
        ssh(ip, f"mkdir -p {data} && cp -n {REMOTE}/data/probes.jsonl {REMOTE}/data/forget.jsonl {data}/ && "
                f"{'' if a.train else f'ln -sfn {REMOTE}/data/train.jsonl {data}/train.jsonl'}")
        for local, remote in ((a.train, "train.jsonl"), (a.probes, "probes.jsonl")):
            if local:
                subprocess.run(["scp", "-C", *SSH_OPTS, local, f"ubuntu@{ip}:{data}/{remote}"], check=True)
    if a.data_dir:
        data = a.data_dir
    env = {"KNOWLEDGE_NO_S3": "1", "SAVE_STEPS": str(a.save_steps), "TUNED_EVAL": str(a.tuned_eval)}
    if a.init_adapter:
        env["KNOWLEDGE_INIT_ADAPTER"] = remote_path(a.init_adapter)
    if a.lr:
        env["LR"] = str(float(a.lr))  # run_multi.sh writes it into hyper.json; without it, its default of 1e-4
    if a.base_json:
        env["BASE_JSON"] = a.base_json if a.base_json.startswith("/") else f"{REMOTE}/runs/{a.base_json}/ckpt/base.json"
    envs = " ".join(f"{k}={v}" for k, v in env.items())
    # Only the last simple command goes to the background (an "a && b &" list would keep this SSH session open).
    cmd = (f"cd {REMOTE} || exit 1; mkdir -p runs; {envs} setsid nohup bash run_multi.sh {run} {data} none {a.batch} {a.accum} "
           f"{a.epochs} {a.eval_probes} {a.max_examples} 0 > runs/{run}.wrapper.log 2>&1 < /dev/null & sleep 3; cat runs/{run}/hyper.json")
    r = ssh(ip, cmd)
    if r.returncode != 0:
        raise SystemExit(f"start {run} failed: {r.stderr[-500:]}")
    log(f"{a.name}: started {run} ({envs}; data {data}; batch {a.batch} x {a.accum} x GPUs, epochs {a.epochs}, "
        f"probes {a.eval_probes}, max_examples {a.max_examples}): {r.stdout.strip()}")
    if not a.no_sync:
        py, me = sys.executable, os.path.abspath(__file__)
        wrapper = (f"while :; do {py} {me} lambda-sync --name {a.name} --run {run} && break; "
                   f"echo \"$(date -u +%FT%TZ) sync {run} exited; restarting in 60 s\" >> {LOG}; sleep 60; done")
        p = subprocess.Popen(["nohup", "caffeinate", "-ims", "bash", "-c", wrapper], cwd=ROOT, stdin=subprocess.DEVNULL,
                             stdout=open(os.path.join(os.path.dirname(LOG), f"train-multi-sync-{run}.out"), "a"),
                             stderr=subprocess.STDOUT, start_new_session=True)
        log(f"sync {run}: started on this Mac (pid {p.pid}), every 10 minutes to .data/knowledge/runs/{run}/ and s3://{BUCKET}/{RUNS}{run}/")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["setup", "upload", "launch", "retry", "status", "stop", "watch", "lambda-prep", "lambda-sync", "start-run"])
    ap.add_argument("--name")
    ap.add_argument("--run")
    ap.add_argument("--dest")
    # start-run
    ap.add_argument("--train", help="a local train.jsonl to scp over for this run (default: the stage 1 data on the machine)")
    ap.add_argument("--probes", help="a local probes.jsonl for this run (default: the stage 1 probes)")
    ap.add_argument("--data-dir", help="a data folder already on the machine")
    ap.add_argument("--init-adapter", help="start from these LoRA weights: RUN (its final adapter), RUN/checkpoint-N, or a path")
    ap.add_argument("--base-json", help="reuse base answers: RUN (its ckpt/base.json) or a path on the machine")
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--accum", type=int, default=1)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--eval-probes", type=int, default=1500)
    ap.add_argument("--max-examples", type=int, default=0)
    ap.add_argument("--save-steps", type=int, default=250)
    ap.add_argument("--tuned-eval", type=int, default=1)
    ap.add_argument("--lr", help="learning rate for this run (default: run_multi.sh's 1e-4)")
    ap.add_argument("--no-sync", action="store_true")
    # lambda-sync
    ap.add_argument("--large", choices=["final", "none"], default="final", help="large files to S3: the final adapter (throttled) or none")
    ap.add_argument("--kbps", type=int, default=LARGE_KBPS, help="KB/s cap for large uploads")
    a = ap.parse_args()
    {"setup": setup, "upload": upload_code, "launch": launch, "retry": retry, "status": status, "watch": watch,
     "stop": lambda: stop(a.name), "lambda-prep": lambda: lambda_prep(a.name), "start-run": lambda: start_run(a),
     "lambda-sync": lambda: lambda_sync(a.name, a.run or RUN, a.dest, large=a.large, kbps=a.kbps)}[a.command]()
