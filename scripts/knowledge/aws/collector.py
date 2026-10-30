"""The collector machine: one small EC2 box that pulls the knowledge sources into S3, so this Mac isn't doing it.

    .data/aws/venv/bin/python scripts/knowledge/aws/collector.py launch [--hours 72]
    .data/aws/venv/bin/python scripts/knowledge/aws/collector.py status
    .data/aws/venv/bin/python scripts/knowledge/aws/collector.py run "<shell command>"
    .data/aws/venv/bin/python scripts/knowledge/aws/collector.py terminate

m7i.2xlarge on demand ($0.40 an hour) with no inbound access; commands go through AWS Systems Manager. It holds no
keys: its role can only reach the knowledge bucket, and it terminates itself after --hours whatever else happens.
"""

import argparse
import json
import os
import time

import boto3

PROFILE = "offlinebase"
REGION = "us-east-1"
ROLE = "MuseKnowledgeCollector"
INSTANCE = "m7i.2xlarge"
TAG = "muse-knowledge-collector"
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
    iam.put_role_policy(RoleName=ROLE, PolicyName=f"{ROLE}Bucket", PolicyDocument=json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"], "Resource": f"arn:aws:s3:::{b}"},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], "Resource": f"arn:aws:s3:::{b}/*"},
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


def launch(hours):
    s = session()
    ec2, b = s.client("ec2"), bucket(s)
    if current(ec2):
        print(json.dumps({"already": current(ec2)[0]["InstanceId"]}))
        return
    ensure_role(s)
    s.client("s3").upload_file(os.path.join(HERE, "box", "bulk.py"), b, "knowledge/box/bulk.py")
    ami = s.client("ssm").get_parameter(Name="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64")["Parameter"]["Value"]
    user_data = f"""#!/bin/bash
shutdown -h +{int(hours * 60)}
mkdir -p /opt/muse && cd /opt/muse
aws s3 cp s3://{b}/knowledge/box/bulk.py bulk.py
nohup python3 bulk.py {b} > bulk.log 2>&1 &
"""
    r = ec2.run_instances(
        ImageId=ami, InstanceType=INSTANCE, MinCount=1, MaxCount=1,
        IamInstanceProfile={"Name": ROLE}, InstanceInitiatedShutdownBehavior="terminate", UserData=user_data,
        BlockDeviceMappings=[{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 300, "VolumeType": "gp3", "DeleteOnTermination": True}}],
        TagSpecifications=[{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": TAG}]}],
    )
    print(json.dumps({"instance": r["Instances"][0]["InstanceId"], "type": INSTANCE, "terminatesAfterHours": hours}))


def status():
    s = session()
    print(json.dumps([{"id": i["InstanceId"], "state": i["State"]["Name"], "launched": str(i["LaunchTime"])} for i in current(s.client("ec2"))]))
    try:
        d = json.load(s.client("s3").get_object(Bucket=bucket(s), Key="knowledge/raw/status.json")["Body"])
        print(json.dumps({"at": d["at"], "doneFiles": len(d["done"]), "gb": round(d["bytes"] / 1e9, 1), "active": d["active"], "failed": d["failed"][-5:]}))
    except Exception as err:
        print("no status yet:", str(err)[:120])


def run(command):
    s = session()
    ids = [i["InstanceId"] for i in current(s.client("ec2"))]
    ssm = s.client("ssm")
    c = ssm.send_command(InstanceIds=ids, DocumentName="AWS-RunShellScript", Parameters={"commands": [command], "executionTimeout": ["3600"]})["Command"]["CommandId"]
    for _ in range(120):
        time.sleep(5)
        r = ssm.get_command_invocation(CommandId=c, InstanceId=ids[0])
        if r["Status"] not in ("Pending", "InProgress", "Delayed"):
            print(r["Status"], r["StandardOutputContent"][-3000:], r["StandardErrorContent"][-1000:])
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
    p.add_argument("command", choices=["launch", "status", "run", "terminate"])
    p.add_argument("arg", nargs="?")
    p.add_argument("--hours", type=float, default=72)
    a = p.parse_args()
    {"launch": lambda: launch(a.hours), "status": status, "run": lambda: run(a.arg), "terminate": terminate}[a.command]()
