"""The filter machine: one EC2 box that reads the public research and court buckets and keeps only the 2026 window.

    .data/aws/venv/bin/python scripts/knowledge/aws/filtered_box.py launch [--hours 24]
    .data/aws/venv/bin/python scripts/knowledge/aws/filtered_box.py status
    .data/aws/venv/bin/python scripts/knowledge/aws/filtered_box.py push
    .data/aws/venv/bin/python scripts/knowledge/aws/filtered_box.py run "<shell command>"
    .data/aws/venv/bin/python scripts/knowledge/aws/filtered_box.py terminate

m7i.8xlarge on demand ($1.61 an hour) with no inbound access; commands go through AWS Systems Manager. It holds no
keys: its role reads the six source buckets and writes only under knowledge/filtered/. It terminates itself after
--hours whatever else happens, and sooner once every lane has finished. This is a separate box from collector.py.
"""

import argparse
import json
import os
import time

import boto3

PROFILE = "offlinebase"
REGION = "us-east-1"
ROLE = "MuseKnowledgeFiltered"
INSTANCE = "m7i.8xlarge"
TAG = "muse-knowledge-filtered"
SOURCES = ["pmc-oa-opendata", "openalex", "com-courtlistener-storage", "arxiv", "biorxiv-src-monthly", "medrxiv-src-monthly"]
HERE = os.path.dirname(os.path.abspath(__file__))


def session():
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def bucket(s):
    return f"muse-knowledge-{s.client('sts').get_caller_identity()['Account']}"


def ensure_role(s):
    iam, b = s.client("iam"), bucket(s)
    try:
        iam.get_role(RoleName=ROLE)
    except iam.exceptions.NoSuchEntityException:
        trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
        iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust))
    iam.attach_role_policy(RoleName=ROLE, PolicyArn="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")
    iam.put_role_policy(RoleName=ROLE, PolicyName=f"{ROLE}Access", PolicyDocument=json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"], "Resource": f"arn:aws:s3:::{b}"},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], "Resource": f"arn:aws:s3:::{b}/knowledge/filtered/*"},
            {"Effect": "Allow", "Action": "s3:GetObject", "Resource": f"arn:aws:s3:::{b}/knowledge/box/*"},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"], "Resource": [x for src in SOURCES for x in (f"arn:aws:s3:::{src}", f"arn:aws:s3:::{src}/*")]},
        ],
    }))
    try:
        iam.get_instance_profile(InstanceProfileName=ROLE)
    except iam.exceptions.NoSuchEntityException:
        iam.create_instance_profile(InstanceProfileName=ROLE)
        iam.add_role_to_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE)
        time.sleep(15)


def current(ec2):
    r = ec2.describe_instances(Filters=[{"Name": "tag:Name", "Values": [TAG]}, {"Name": "instance-state-name", "Values": ["pending", "running"]}])
    return [i for res in r["Reservations"] for i in res["Instances"]]


def push(s=None):
    s = s or session()
    s.client("s3").upload_file(os.path.join(HERE, "box", "filtered.py"), bucket(s), "knowledge/box/filtered.py")
    print("pushed filtered.py")


def launch(hours):
    s = session()
    ec2, b = s.client("ec2"), bucket(s)
    if current(ec2):
        print(json.dumps({"already": current(ec2)[0]["InstanceId"]}))
        return
    ensure_role(s)
    push(s)
    ami = s.client("ssm").get_parameter(Name="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64")["Parameter"]["Value"]
    user_data = f"""#!/bin/bash
shutdown -h +{int(hours * 60)}
mkdir -p /opt/muse && cd /opt/muse
dnf install -y bzip2 python3-pip >> setup.log 2>&1
python3 -m venv venv >> setup.log 2>&1
venv/bin/pip install -q boto3 aiohttp pyarrow indexed_bzip2 >> setup.log 2>&1
aws s3 cp s3://{b}/knowledge/box/filtered.py filtered.py >> setup.log 2>&1
touch /opt/muse/ready
"""
    for attempt in range(6):
        try:
            r = ec2.run_instances(
                ImageId=ami, InstanceType=INSTANCE, MinCount=1, MaxCount=1,
                IamInstanceProfile={"Name": ROLE}, InstanceInitiatedShutdownBehavior="terminate", UserData=user_data,
                BlockDeviceMappings=[{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 300, "VolumeType": "gp3", "DeleteOnTermination": True}}],
                TagSpecifications=[{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": TAG}]}],
            )
            break
        except ec2.exceptions.ClientError as err:
            if "instance profile" not in str(err).lower() or attempt == 5:
                raise
            time.sleep(10)
    print(json.dumps({"instance": r["Instances"][0]["InstanceId"], "type": INSTANCE, "terminatesAfterHours": hours}))


def status():
    s = session()
    print(json.dumps([{"id": i["InstanceId"], "state": i["State"]["Name"], "launched": str(i["LaunchTime"])} for i in current(s.client("ec2"))]))
    try:
        print(s.client("s3").get_object(Bucket=bucket(s), Key="knowledge/filtered/status.json")["Body"].read().decode())
    except Exception as err:
        print("no status yet:", str(err)[:120])


def run(command):
    s = session()
    ids = [i["InstanceId"] for i in current(s.client("ec2"))]
    ssm = s.client("ssm")
    c = ssm.send_command(InstanceIds=ids, DocumentName="AWS-RunShellScript", Parameters={"commands": [command], "executionTimeout": ["3600"]})["Command"]["CommandId"]
    for _ in range(360):
        time.sleep(5)
        try:
            r = ssm.get_command_invocation(CommandId=c, InstanceId=ids[0])
        except ssm.exceptions.InvocationDoesNotExist:
            continue
        if r["Status"] not in ("Pending", "InProgress", "Delayed"):
            print(r["Status"], r["StandardOutputContent"][-24000:], r["StandardErrorContent"][-3000:])
            return
    print("still running", c)


def terminate():
    ec2 = session().client("ec2")
    ids = [i["InstanceId"] for i in current(ec2)]
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
    print(json.dumps({"terminated": ids}))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["launch", "status", "push", "run", "terminate"])
    p.add_argument("arg", nargs="?")
    p.add_argument("--hours", type=float, default=24)
    a = p.parse_args()
    {"launch": lambda: launch(a.hours), "status": status, "push": push, "run": lambda: run(a.arg), "terminate": terminate}[a.command]()
