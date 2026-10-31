"""Launches the one CC-NEWS selection instance (ccnews_select.py) in us-east-1, with its own minimal role and no keys.

    .data/aws/venv/bin/python scripts/knowledge/s3_sample/news/ccnews_select_launch.py role
    .data/aws/venv/bin/python scripts/knowledge/s3_sample/news/ccnews_select_launch.py upload
    .data/aws/venv/bin/python scripts/knowledge/s3_sample/news/ccnews_select_launch.py launch --type c7i.24xlarge --stop-utc 23:40 --map-stop-utc 23:02
    .data/aws/venv/bin/python scripts/knowledge/s3_sample/news/ccnews_select_launch.py go | stop | status

The instance shuts itself down (and so terminates) at --stop-utc whatever happens, and as soon as the job ends.
After a small sample it waits up to 12 minutes for s3://BUCKET/OUT/control/go before the full pass.
"""

import argparse
import datetime
import json
import os
import sys
import time

import boto3

PROFILE, REGION = "offlinebase", "us-east-1"
ROLE = "MuseCCNewsSelect"
TAG = "muse-ccnews-select"
OUT = "knowledge/corpus/ccnews-select"
HERE = os.path.dirname(os.path.abspath(__file__))
BOX = os.path.join(HERE, "..", "..", "aws", "box")
CODE = {"ccnews_select.py": HERE, "news_common.py": HERE, "select_news.py": HERE, "ccnews_optout.py": BOX, "ccnews_post.py": HERE, "ccnews_finish.py": HERE}


def session():
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def bucket(s):
    return f"muse-knowledge-{s.client('sts').get_caller_identity()['Account']}"


def role(s):
    iam, b = s.client("iam"), bucket(s)
    trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": f"arn:aws:s3:::{b}"},
        {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": [f"arn:aws:s3:::{b}/knowledge/news/ccnews/*", f"arn:aws:s3:::{b}/knowledge/news/ccnews-optout/*", f"arn:aws:s3:::{b}/{OUT}/*"]},
        {"Effect": "Allow", "Action": ["s3:PutObject", "s3:AbortMultipartUpload"], "Resource": f"arn:aws:s3:::{b}/{OUT}/*"},
    ]}
    try:
        iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust), Description="CC-NEWS selection box: read CC-NEWS Parquet, write ccnews-select")
    except iam.exceptions.EntityAlreadyExistsException:
        pass
    iam.put_role_policy(RoleName=ROLE, PolicyName=f"{ROLE}Access", PolicyDocument=json.dumps(policy))
    try:
        iam.create_instance_profile(InstanceProfileName=ROLE)
    except iam.exceptions.EntityAlreadyExistsException:
        pass
    try:
        iam.add_role_to_instance_profile(InstanceProfileName=ROLE, RoleName=ROLE)
    except iam.exceptions.LimitExceededException:
        pass
    print("role ready", ROLE)


def upload(s):
    s3, b = s.client("s3"), bucket(s)
    for name, d in CODE.items():
        s3.upload_file(os.path.join(d, name), b, f"{OUT}/code/{name}")
    print("uploaded", list(CODE))


def epoch_utc(hhmm):
    h, m = map(int, hhmm.split(":"))
    now = datetime.datetime.now(datetime.timezone.utc)
    return int(now.replace(hour=h, minute=m, second=0, microsecond=0).timestamp())


def user_data_select(b, stop):
    """Select only, from the candidates the last full pass left in S3 (work/), on a small machine."""
    files = " ".join(CODE)
    return f"""#!/bin/bash
END={stop}
LEFT=$(( (END - $(date +%s)) / 60 ))
if [ "$LEFT" -lt 1 ]; then shutdown -h now; exit 0; fi
shutdown -h +$LEFT
B={b}
O={OUT}
mkdir -p /opt/sel/work && cd /opt/sel
touch run.log
log() {{ aws s3 cp run.log s3://$B/$O/_status/run.log --quiet; }}
( while true; do sleep 30; log; done ) &
for f in {files}; do aws s3 cp s3://$B/$O/code/$f $f --quiet; done
for f in ai.jsonl.gz gen.jsonl.gz volume.json robots.jsonl map-stats.json; do aws s3 cp s3://$B/$O/work/$f work/$f --quiet; done
python3 -m venv venv
for i in 1 2 3 4 5; do venv/bin/pip install -q --only-binary=:all: pyarrow==17.0.0 numpy==2.0.2 boto3==1.35.99 >> run.log 2>&1 && break; sleep 20; done
echo "$(date -u) select only" >> run.log
venv/bin/python ccnews_select.py select $B work >> run.log 2>&1
echo "$(date -u) done" >> run.log
log
shutdown -h now
"""


def user_data(b, stop, map_stop):
    files = " ".join(CODE)
    return f"""#!/bin/bash
END={stop}
LEFT=$(( (END - $(date +%s)) / 60 ))
if [ "$LEFT" -lt 1 ]; then shutdown -h now; exit 0; fi
shutdown -h +$LEFT
B={b}
O={OUT}
mkdir -p /opt/sel && cd /opt/sel
touch run.log
log() {{ aws s3 cp run.log s3://$B/$O/_status/run.log --quiet; }}
( while true; do sleep 60; log; done ) &
fetch() {{ for f in {files}; do aws s3 cp s3://$B/$O/code/$f $f --quiet; done; }}
python3 -m venv venv
for i in 1 2 3 4 5; do venv/bin/pip install -q --only-binary=:all: pyarrow==17.0.0 numpy==2.0.2 boto3==1.35.99 >> run.log 2>&1 && break; sleep 20; done
fetch
echo "$(date -u) sample" >> run.log
venv/bin/python ccnews_select.py map $B sample --limit 24 >> run.log 2>&1
for f in ai.jsonl.gz gen.jsonl.gz map-stats.json; do aws s3 cp sample/$f s3://$B/$O/_status/sample-$f --quiet; done
log
for i in $(seq 1 72); do
  aws s3 ls s3://$B/$O/control/stop >/dev/null 2>&1 && {{ log; shutdown -h now; exit 0; }}
  aws s3 ls s3://$B/$O/control/go >/dev/null 2>&1 && break
  sleep 10
done
fetch
echo "$(date -u) full map" >> run.log
venv/bin/python ccnews_select.py map $B work --stop-at {map_stop} >> run.log 2>&1
fetch
echo "$(date -u) select" >> run.log
venv/bin/python ccnews_select.py select $B work >> run.log 2>&1
echo "$(date -u) done" >> run.log
log
aws s3 cp work/robots.jsonl s3://$B/$O/work/robots.jsonl --quiet
log
shutdown -h now
"""


def launch(s, a):
    ec2, b = s.client("ec2"), bucket(s)
    running = ec2.describe_instances(Filters=[{"Name": "tag:Name", "Values": [TAG]}, {"Name": "instance-state-name", "Values": ["pending", "running"]}])
    if any(r["Instances"] for r in running["Reservations"]):
        sys.exit("a selection box is already running")
    stop, map_stop = epoch_utc(a.stop_utc), epoch_utc(a.map_stop_utc)
    hours = (stop - time.time()) / 3600
    print(f"runs at most {hours:.2f} h")
    image = s.client("ssm").get_parameter(Name="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64")["Parameter"]["Value"]
    for attempt in range(8):
        try:
            r = ec2.run_instances(
                ImageId=image, InstanceType=a.type, MinCount=1, MaxCount=1, IamInstanceProfile={"Name": ROLE},
                InstanceInitiatedShutdownBehavior="terminate", UserData=user_data_select(b, stop) if a.select_only else user_data(b, stop, map_stop),
                BlockDeviceMappings=[{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 60, "VolumeType": "gp3", "DeleteOnTermination": True}}],
                MetadataOptions={"HttpTokens": "required"},
                TagSpecifications=[{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": TAG}, {"Key": "project", "Value": "muse-knowledge"}]}])
            print("launched", r["Instances"][0]["InstanceId"], a.type)
            return
        except ec2.exceptions.ClientError as err:
            if "Invalid IAM Instance Profile" in str(err) or "iamInstanceProfile" in str(err):
                time.sleep(8)
                continue
            raise
    sys.exit("instance profile never became usable")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["role", "upload", "launch", "go", "stop", "status"])
    p.add_argument("--type", default="c7i.24xlarge")
    p.add_argument("--stop-utc", default="23:40")
    p.add_argument("--map-stop-utc", default="23:02")
    p.add_argument("--select-only", action="store_true", help="re-run selection from the candidates in S3 work/")
    a = p.parse_args()
    s = session()
    if a.cmd == "role":
        role(s)
    elif a.cmd == "upload":
        upload(s)
    elif a.cmd == "launch":
        launch(s, a)
    elif a.cmd in ("go", "stop"):
        s.client("s3").put_object(Bucket=bucket(s), Key=f"{OUT}/control/{a.cmd}", Body=b"1")
        print("sent", a.cmd)
    else:
        r = s.client("ec2").describe_instances(Filters=[{"Name": "tag:Name", "Values": [TAG]}])
        for res in r["Reservations"]:
            for i in res["Instances"]:
                print(i["InstanceId"], i["InstanceType"], i["State"]["Name"], i["LaunchTime"])


if __name__ == "__main__":
    main()
