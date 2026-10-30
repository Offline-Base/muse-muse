"""Launches and watches the Glimmer knowledge training job on SageMaker (job/train_glimmer.py).

    .data/aws/venv/bin/python scripts/knowledge/aws/train_job.py start --tag smoke --hp max_examples=60 eval_probes=30 epochs=1
    .data/aws/venv/bin/python scripts/knowledge/aws/train_job.py status --tag smoke
    .data/aws/venv/bin/python scripts/knowledge/aws/train_job.py logs --tag smoke

start uploads job/ and the dataset (.data/knowledge/dataset/{train,probes}.jsonl plus forget.jsonl) under
s3://<bucket>/knowledge/<tag>/, then runs one ml.g7e.2xlarge (1 RTX PRO 6000, 96 GB, $4.20 an hour) on demand with a
hard time limit (--hours, default 12, so at most about $50). Checkpoints sync to S3, so `start` with the same --tag
after a failure resumes from the last one.
"""

import argparse
import datetime as dt
import json
import os

import boto3

PROFILE = "offlinebase"
REGION = "us-east-1"
IMAGE = "763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-training:2.9.0-gpu-py312-cu130-ubuntu22.04-sagemaker-v2.1"
INSTANCE = "ml.g7e.2xlarge"
HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = os.path.join(HERE, "..", "..", "..", ".data", "knowledge", "dataset")


def session():
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def names(s, tag):
    account = s.client("sts").get_caller_identity()["Account"]
    bucket = f"muse-knowledge-{account}"
    return account, bucket, f"knowledge/{tag}"


def current_job(sm, tag):
    jobs = sm.list_training_jobs(NameContains=f"glimmer-knowledge-{tag}-", SortBy="CreationTime", SortOrder="Descending", MaxResults=1)["TrainingJobSummaries"]
    return jobs[0]["TrainingJobName"] if jobs else None


def start(tag, hours, hp, instance):
    s = session()
    account, bucket, prefix = names(s, tag)
    s3 = s.client("s3")
    for f in ("run.sh", "train_glimmer.py"):
        s3.upload_file(os.path.join(HERE, "job", f), bucket, f"{prefix}/code/{f}")
    for f in ("train.jsonl", "probes.jsonl"):
        s3.upload_file(os.path.join(DATASET, f), bucket, f"{prefix}/data/{f}")
    s3.upload_file(os.path.join(HERE, "forget.jsonl"), bucket, f"{prefix}/data/forget.jsonl")

    name = f"glimmer-knowledge-{tag}-" + dt.datetime.now(dt.timezone.utc).strftime("%m%d-%H%M%S")
    channel = lambda sub: {"S3DataSource": {"S3DataType": "S3Prefix", "S3Uri": f"s3://{bucket}/{prefix}/{sub}/", "S3DataDistributionType": "FullyReplicated"}}
    s.client("sagemaker").create_training_job(
        TrainingJobName=name,
        RoleArn=f"arn:aws:iam::{account}:role/MuseKnowledgeSageMaker",
        AlgorithmSpecification={"TrainingImage": IMAGE, "TrainingInputMode": "File", "ContainerEntrypoint": ["bash", "/opt/ml/input/data/code/run.sh"]},
        HyperParameters={k: str(v) for k, v in hp.items()},
        InputDataConfig=[{"ChannelName": "code", "DataSource": channel("code")}, {"ChannelName": "data", "DataSource": channel("data")}],
        OutputDataConfig={"S3OutputPath": f"s3://{bucket}/{prefix}/output/"},
        CheckpointConfig={"S3Uri": f"s3://{bucket}/{prefix}/checkpoints/", "LocalPath": "/opt/ml/checkpoints"},
        ResourceConfig={"InstanceType": instance, "InstanceCount": 1, "VolumeSizeInGB": 300},
        StoppingCondition={"MaxRuntimeInSeconds": int(hours * 3600)},
    )
    print(json.dumps({"job": name, "instance": instance, "maxHours": hours, "hyperparameters": hp}))


def status(tag):
    s = session()
    sm = s.client("sagemaker")
    name = current_job(sm, tag)
    if not name:
        print(json.dumps({"tag": tag, "status": "none"}))
        return
    j = sm.describe_training_job(TrainingJobName=name)
    print(json.dumps({
        "job": name, "status": j["TrainingJobStatus"], "secondary": j.get("SecondaryStatus"), "failure": j.get("FailureReason"),
        "billableSeconds": j.get("BillableTimeInSeconds"), "output": j.get("ModelArtifacts", {}).get("S3ModelArtifacts"),
    }))


def logs(tag, lines):
    s = session()
    name = current_job(s.client("sagemaker"), tag)
    cw = s.client("logs")
    streams = cw.describe_log_streams(logGroupName="/aws/sagemaker/TrainingJobs", logStreamNamePrefix=name)["logStreams"] if name else []
    for st in streams:
        events = cw.get_log_events(logGroupName="/aws/sagemaker/TrainingJobs", logStreamName=st["logStreamName"], startFromHead=False, limit=lines)["events"]
        for e in events:
            print(e["message"][:400])


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["start", "status", "logs"])
    p.add_argument("--tag", required=True)
    p.add_argument("--hours", type=float, default=12)
    p.add_argument("--lines", type=int, default=40)
    p.add_argument("--hp", nargs="*", default=[])
    p.add_argument("--instance", default=INSTANCE)
    a = p.parse_args()
    if a.command == "start":
        start(a.tag, a.hours, dict(kv.split("=", 1) for kv in a.hp), a.instance)
    elif a.command == "status":
        status(a.tag)
    else:
        logs(a.tag, a.lines)
