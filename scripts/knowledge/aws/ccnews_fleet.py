"""The CC-NEWS extraction: a Spot fleet that reads Common Crawl's 2026 news WARCs in place and writes articles to our bucket.

    .data/aws/venv/bin/python scripts/knowledge/aws/ccnews_fleet.py setup
    .data/aws/venv/bin/python scripts/knowledge/aws/ccnews_fleet.py testbox [--hours 3]
    .data/aws/venv/bin/python scripts/knowledge/aws/ccnews_fleet.py run "<shell command>"       (on the test box)
    .data/aws/venv/bin/python scripts/knowledge/aws/ccnews_fleet.py enqueue [--limit N]
    .data/aws/venv/bin/python scripts/knowledge/aws/ccnews_fleet.py launch --instances 16 [--hours 24]
    .data/aws/venv/bin/python scripts/knowledge/aws/ccnews_fleet.py status
    .data/aws/venv/bin/python scripts/knowledge/aws/ccnews_fleet.py stop

The fleet is an Auto Scaling group of Spot machines, so reclaimed machines are replaced with nothing running on the
Mac. Machines leave the group when the queue is empty. Three limits apply whatever happens: each machine shuts down at
the deadline, a scheduled action sets the group to zero at the deadline, and the Spot price is capped. The worst-case
compute bill is instances x cap x hours, and launch refuses anything over MAX_COMPUTE_USD.
"""

import argparse
import base64
import concurrent.futures
import gzip
import json
import os
import random
import time

import boto3
import botocore.exceptions

PROFILE = "offlinebase"
REGION = "us-east-1"
ROLE = "MuseCCNewsWorker"
QUEUE = "muse-ccnews"
DEAD_LETTER = "muse-ccnews-dead"
TEMPLATE = "muse-ccnews"
GROUP = "muse-ccnews"
SCHEDULE = "muse-ccnews-hard-stop"
TEST_TAG = "muse-ccnews-test"
TEST_TYPE = "c7i.4xlarge"
# c7a is left out: 7 of the first 8 Spot reclaims were c7a, within minutes of launch.
INSTANCE_TYPES = ["c7i.4xlarge", "c7i-flex.4xlarge", "c6a.4xlarge", "m7i.4xlarge", "m6i.4xlarge", "m7a.4xlarge"]
SPOT_CAP = 0.45
MAX_COMPUTE_USD = 190
MONTHS = [f"{m:02d}" for m in range(1, 11)]
PREFIX = "knowledge/news/ccnews"
OPTOUT = "knowledge/news/ccnews-optout"
HERE = os.path.dirname(os.path.abspath(__file__))
REQUIREMENTS = os.path.join(HERE, "box", "ccnews-requirements.txt")

MANIFEST = {
    "dataset": "CC-NEWS 2026 extracted articles",
    "source": "https://data.commoncrawl.org/crawl-data/CC-NEWS/2026/index.html",
    "sourceBucket": "s3://commoncrawl/crawl-data/CC-NEWS/2026/",
    "window": "published 2026-01-04 to 2026-10-29",
    "license": "Article text is under each publisher's copyright. Private, training-only split: never published. Common Crawl's terms of use apply: https://commoncrawl.org/terms-of-use",
    "rule": "Domains marked excluded in knowledge/news/ccnews-optout/domains.parquet must not reach training. Page-level signals are in the optout_ columns.",
    "code": "scripts/knowledge/aws/box/ccnews.py",
}
OPTOUT_MANIFEST = {
    "dataset": "Opt-out signals for domains in the CC-NEWS 2026 extraction",
    "source": "Each domain's own /robots.txt and /.well-known/tdmrep.json, fetched once",
    "license": "Facts about published site policies. robots_txt holds the sites' own text: private until a release is reviewed.",
    "code": "scripts/knowledge/aws/box/ccnews_optout.py",
}


def session():
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def account(s):
    return s.client("sts").get_caller_identity()["Account"]


def bucket(s):
    return f"muse-knowledge-{account(s)}"


def queue_url(s, name=QUEUE):
    return s.client("sqs").get_queue_url(QueueName=name)["QueueUrl"]


def setup():
    s = session()
    iam, sqs, s3, b, acct = s.client("iam"), s.client("sqs"), s.client("s3"), bucket(s), account(s)
    dead = sqs.create_queue(QueueName=DEAD_LETTER, Attributes={"MessageRetentionPeriod": "1209600"})["QueueUrl"]
    dead_arn = sqs.get_queue_attributes(QueueUrl=dead, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
    url = sqs.create_queue(QueueName=QUEUE, Attributes={"VisibilityTimeout": "1800", "MessageRetentionPeriod": "1209600", "ReceiveMessageWaitTimeSeconds": "20", "RedrivePolicy": json.dumps({"deadLetterTargetArn": dead_arn, "maxReceiveCount": "4"})})["QueueUrl"]
    queue_arn = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
    try:
        iam.get_role(RoleName=ROLE)
    except iam.exceptions.NoSuchEntityException:
        trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
        iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust))
    iam.attach_role_policy(RoleName=ROLE, PolicyArn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")
    iam.put_role_policy(RoleName=ROLE, PolicyName=f"{ROLE}Access", PolicyDocument=json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::commoncrawl/*"},
            {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::commoncrawl", f"arn:aws:s3:::{b}"]},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"], "Resource": [f"arn:aws:s3:::{b}/{PREFIX}/*", f"arn:aws:s3:::{b}/{OPTOUT}/*"]},
            {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": f"arn:aws:s3:::{b}/knowledge/box/*"},
            {"Effect": "Allow", "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], "Resource": queue_arn},
            {"Effect": "Allow", "Action": ["autoscaling:DescribeAutoScalingGroups"], "Resource": "*"},
            {"Effect": "Allow", "Action": ["autoscaling:TerminateInstanceInAutoScalingGroup"], "Resource": f"arn:aws:autoscaling:{REGION}:{acct}:autoScalingGroup:*:autoScalingGroupName/{GROUP}"},
        ],
    }))
    try:
        iam.get_instance_profile(InstanceProfileName=ROLE)
    except iam.exceptions.NoSuchEntityException:
        iam.create_instance_profile(InstanceProfileName=ROLE)
        iam.add_role_to_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE)
        time.sleep(15)
    upload(s)
    print(json.dumps({"queue": url, "deadLetter": dead, "role": ROLE, "bucket": b}))


def upload(s):
    s3, b = s.client("s3"), bucket(s)
    for name in ("ccnews.py", "ccnews_optout.py", "ccnews-requirements.txt"):
        s3.upload_file(os.path.join(HERE, "box", name), b, f"knowledge/box/{name}")
    s3.put_object(Bucket=b, Key=f"{PREFIX}/MANIFEST.json", Body=json.dumps(MANIFEST, indent=1).encode(), ContentType="application/json")
    s3.put_object(Bucket=b, Key=f"{OPTOUT}/MANIFEST.json", Body=json.dumps(OPTOUT_MANIFEST, indent=1).encode(), ContentType="application/json")


def user_data(b, deadline, command):
    return f"""#!/bin/bash
DEADLINE={int(deadline)}
LEFT=$(( (DEADLINE - $(date +%s)) / 60 ))
if [ "$LEFT" -lt 1 ]; then shutdown -h now; exit 0; fi
shutdown -h +$LEFT
mkdir -p /opt/muse && cd /opt/muse
aws s3 cp s3://{b}/knowledge/box/ccnews.py ccnews.py
aws s3 cp s3://{b}/knowledge/box/ccnews_optout.py ccnews_optout.py
aws s3 cp s3://{b}/knowledge/box/ccnews-requirements.txt requirements.txt
python3 -m venv venv
for i in 1 2 3 4 5; do venv/bin/pip install -q --only-binary=:all: -r requirements.txt && break; sleep 30; done
{command}
"""


def ami(s):
    return s.client("ssm").get_parameter(Name="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64")["Parameter"]["Value"]


def testbox(hours):
    """One small machine with the tools installed and nothing running. Tests go through `run`."""
    s = session()
    ec2, b = s.client("ec2"), bucket(s)
    upload(s)
    deadline = time.time() + hours * 3600
    r = ec2.run_instances(
        ImageId=ami(s), InstanceType=TEST_TYPE, MinCount=1, MaxCount=1,
        IamInstanceProfile={"Name": ROLE}, InstanceInitiatedShutdownBehavior="terminate", UserData=user_data(b, deadline, "touch /opt/muse/ready"),
        MetadataOptions={"HttpTokens": "required", "HttpPutResponseHopLimit": 2},
        BlockDeviceMappings=[{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 60, "VolumeType": "gp3", "DeleteOnTermination": True}}],
        TagSpecifications=[{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": TEST_TAG}]}],
    )
    print(json.dumps({"instance": r["Instances"][0]["InstanceId"], "type": TEST_TYPE, "terminatesAfterHours": hours}))


def run(command):
    s = session()
    ec2, ssm = s.client("ec2"), s.client("ssm")
    r = ec2.describe_instances(Filters=[{"Name": "tag:Name", "Values": [TEST_TAG]}, {"Name": "instance-state-name", "Values": ["running"]}])
    ids = [i["InstanceId"] for res in r["Reservations"] for i in res["Instances"]]
    c = ssm.send_command(InstanceIds=ids, DocumentName="AWS-RunShellScript", Parameters={"commands": [command], "executionTimeout": ["3600"]})["Command"]["CommandId"]
    for _ in range(120):
        time.sleep(5)
        try:
            r = ssm.get_command_invocation(CommandId=c, InstanceId=ids[0])
        except ssm.exceptions.InvocationDoesNotExist:
            continue
        if r["Status"] not in ("Pending", "InProgress", "Delayed"):
            print(r["Status"], r["StandardOutputContent"][-20000:], r["StandardErrorContent"][-3000:])
            return
    print("still running", c)


def paths(s):
    out = []
    for month in MONTHS:
        body = s.client("s3").get_object(Bucket="commoncrawl", Key=f"crawl-data/CC-NEWS/2026/{month}/warc.paths.gz")["Body"].read()
        out += gzip.decompress(body).decode().split()
    return out


def done_markers(s):
    b = bucket(s)
    keys = []
    for page in s.client("s3").get_paginator("list_objects_v2").paginate(Bucket=b, Prefix=f"{PREFIX}/_done/"):
        keys += [o["Key"] for o in page.get("Contents", [])]
    return keys


def enqueue(limit):
    """Queues every WARC without a marker. Running it twice is harmless: workers skip anything that has a marker."""
    s = session()
    sqs, url = s.client("sqs"), queue_url(s)
    done = {k.rsplit("/", 1)[1].replace(".json", "") for k in done_markers(s)}
    todo = [p for p in paths(s) if p.rsplit("/", 1)[1].replace(".warc.gz", "") not in done]
    # Spread over months, so a partial run still covers the whole window.
    random.Random(7).shuffle(todo)
    if limit:
        todo = todo[:limit]
    for i in range(0, len(todo), 10):
        sqs.send_message_batch(QueueUrl=url, Entries=[{"Id": str(n), "MessageBody": p} for n, p in enumerate(todo[i:i + 10])])
    print(json.dumps({"queued": len(todo), "alreadyDone": len(done)}))


def launch(instances, hours):
    worst = instances * SPOT_CAP * hours
    if worst > MAX_COMPUTE_USD:
        raise SystemExit(f"worst case ${worst:.0f} is over the ${MAX_COMPUTE_USD} limit")
    s = session()
    ec2, auto, b = s.client("ec2"), s.client("autoscaling"), bucket(s)
    upload(s)
    deadline = time.time() + hours * 3600
    run_line = f"venv/bin/python ccnews.py {b} {queue_url(s)} --deadline {int(deadline)} --asg {GROUP} > ccnews.log 2>&1\nID=$(TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'); curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" http://169.254.169.254/latest/meta-data/instance-id)\naws s3 cp ccnews.log s3://{b}/{PREFIX}/_logs/$ID.log\nshutdown -h now"
    data = {
        "ImageId": ami(s), "IamInstanceProfile": {"Name": ROLE}, "InstanceInitiatedShutdownBehavior": "terminate",
        "UserData": base64.b64encode(user_data(b, deadline, run_line).encode()).decode(),
        "MetadataOptions": {"HttpTokens": "required", "HttpPutResponseHopLimit": 2},
        "BlockDeviceMappings": [{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 60, "VolumeType": "gp3", "DeleteOnTermination": True}}],
        "TagSpecifications": [{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": GROUP}]}, {"ResourceType": "volume", "Tags": [{"Key": "Name", "Value": GROUP}]}],
    }
    try:
        ec2.create_launch_template(LaunchTemplateName=TEMPLATE, LaunchTemplateData=data)
    except botocore.exceptions.ClientError as err:
        if "AlreadyExists" not in str(err):
            raise
        version = ec2.create_launch_template_version(LaunchTemplateName=TEMPLATE, LaunchTemplateData=data)["LaunchTemplateVersion"]["VersionNumber"]
        ec2.modify_launch_template(LaunchTemplateName=TEMPLATE, DefaultVersion=str(version))
    # us-east-1e has none of these instance types.
    subnets = [x["SubnetId"] for x in ec2.describe_subnets(Filters=[{"Name": "default-for-az", "Values": ["true"]}])["Subnets"] if x["AvailabilityZone"] != "us-east-1e"]
    policy = {
        "LaunchTemplate": {"LaunchTemplateSpecification": {"LaunchTemplateName": TEMPLATE, "Version": "$Default"}, "Overrides": [{"InstanceType": t} for t in INSTANCE_TYPES]},
        "InstancesDistribution": {"OnDemandBaseCapacity": 0, "OnDemandPercentageAboveBaseCapacity": 0, "SpotAllocationStrategy": "price-capacity-optimized", "SpotMaxPrice": str(SPOT_CAP)},
    }
    existing = auto.describe_auto_scaling_groups(AutoScalingGroupNames=[GROUP])["AutoScalingGroups"]
    if existing:
        auto.update_auto_scaling_group(AutoScalingGroupName=GROUP, MinSize=0, MaxSize=instances, DesiredCapacity=instances, MixedInstancesPolicy=policy, VPCZoneIdentifier=",".join(subnets))
    else:
        auto.create_auto_scaling_group(AutoScalingGroupName=GROUP, MinSize=0, MaxSize=instances, DesiredCapacity=instances, MixedInstancesPolicy=policy, VPCZoneIdentifier=",".join(subnets), Tags=[{"Key": "Name", "Value": GROUP, "PropagateAtLaunch": True}])
    # A rebalance would kill machines in the middle of a WARC.
    auto.suspend_processes(AutoScalingGroupName=GROUP, ScalingProcesses=["AZRebalance"])
    auto.put_scheduled_update_group_action(AutoScalingGroupName=GROUP, ScheduledActionName=SCHEDULE, StartTime=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(deadline)), MinSize=0, MaxSize=0, DesiredCapacity=0)
    print(json.dumps({"group": GROUP, "instances": instances, "vcpus": instances * 16, "spotCapPerHour": SPOT_CAP, "worstCaseComputeUsd": worst, "hardStop": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(deadline))}))


def status():
    s = session()
    sqs, s3, auto, ec2, b = s.client("sqs"), s.client("s3"), s.client("autoscaling"), s.client("ec2"), bucket(s)
    a = sqs.get_queue_attributes(QueueUrl=queue_url(s), AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"])["Attributes"]
    dead = sqs.get_queue_attributes(QueueUrl=queue_url(s, DEAD_LETTER), AttributeNames=["ApproximateNumberOfMessages"])["Attributes"]
    groups = auto.describe_auto_scaling_groups(AutoScalingGroupNames=[GROUP])["AutoScalingGroups"]
    r = ec2.describe_instances(Filters=[{"Name": "tag:Name", "Values": [GROUP, TEST_TAG]}, {"Name": "instance-state-name", "Values": ["pending", "running"]}])
    boxes = [i for res in r["Reservations"] for i in res["Instances"]]
    keys = done_markers(s)

    def read(key):
        return json.load(s3.get_object(Bucket=b, Key=key)["Body"])

    with concurrent.futures.ThreadPoolExecutor(32) as pool:
        marks = list(pool.map(read, keys))
    total = {}
    for m in marks:
        for k, v in m.items():
            if isinstance(v, (int, float)):
                total[k] = round(total.get(k, 0) + v, 1)
    print(json.dumps({
        "queue": {"waiting": int(a["ApproximateNumberOfMessages"]), "inFlight": int(a["ApproximateNumberOfMessagesNotVisible"]), "dead": int(dead["ApproximateNumberOfMessages"])},
        "group": {"desired": groups[0]["DesiredCapacity"], "max": groups[0]["MaxSize"]} if groups else None,
        "machines": sorted(i["InstanceType"] for i in boxes),
        "warcsDone": len(marks), "lastDone": max((m["at"] for m in marks), default=None), "totals": total,
    }, indent=1))
    try:
        print("optout:", s3.get_object(Bucket=b, Key=f"{OPTOUT}/_SUCCESS")["Body"].read().decode())
    except botocore.exceptions.ClientError:
        print("optout: not finished")


def stop():
    s = session()
    auto = s.client("autoscaling")
    if auto.describe_auto_scaling_groups(AutoScalingGroupNames=[GROUP])["AutoScalingGroups"]:
        auto.update_auto_scaling_group(AutoScalingGroupName=GROUP, MinSize=0, MaxSize=0, DesiredCapacity=0)
    print(json.dumps({"group": GROUP, "desired": 0}))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["setup", "testbox", "run", "enqueue", "launch", "status", "stop"])
    p.add_argument("arg", nargs="?")
    p.add_argument("--hours", type=float)
    p.add_argument("--instances", type=int)
    p.add_argument("--limit", type=int)
    a = p.parse_args()
    if a.command == "setup":
        setup()
    elif a.command == "testbox":
        testbox(a.hours or 3)
    elif a.command == "run":
        run(a.arg)
    elif a.command == "enqueue":
        enqueue(a.limit)
    elif a.command == "launch":
        launch(a.instances, a.hours or 24)
    elif a.command == "status":
        status()
    else:
        stop()
