"""Muse Spark Open (NVFP4) on a SageMaker endpoint, to write the knowledge Q&A (docs/KNOWLEDGE_UPDATE.md).

    .data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py deploy [--hours 6]
    .data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py status
    .data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py delete

It uses JumpStart's own SGLang container and Meta's weights from JumpStart's gated bucket (deploying accepts the Muse
Model License, AcceptEula), with the ml.p6-b300.48xlarge settings, the closest Blackwell match, on ml.g7e.48xlarge
(8 RTX PRO 6000, 768 GB), which JumpStart doesn't list but Google serves this model on. The context is cut to 32K so
the memory goes to concurrent requests. deploy also schedules the endpoint's deletion with EventBridge Scheduler
--hours later (default 6, about $250 at $41.43 an hour), so it stops billing even if this Mac is off.
"""

import argparse
import datetime as dt
import json

import boto3

PROFILE = "offlinebase"
REGION = "us-east-1"
MODEL_ID = "meta-vlm-muse-spark-open-816b-a42b-nvfp4"
TEMPLATE_INSTANCE = "ml.p6-b300.48xlarge"
INSTANCE = "ml.g7e.48xlarge"
NAME = "muse-spark-open-knowledge"
STOP_SCHEDULE = f"{NAME}-stop"
OVERRIDES = {
    "SM_SGLANG_CONTEXT_LENGTH": "32768",
    "SM_SGLANG_MAX_RUNNING_REQUESTS": "64",
    "SM_SGLANG_CUDA_GRAPH_MAX_BS_DECODE": "64",
}


def session():
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def deploy(hours):
    s = session()
    sm, account = s.client("sagemaker"), s.client("sts").get_caller_identity()["Account"]
    doc = json.loads(sm.describe_hub_content(HubName="SageMakerPublicHub", HubContentType="Model", HubContentName=MODEL_ID)["HubContentDocument"])
    env = {e["Name"]: str(e["Default"]) for e in doc["InferenceEnvironmentVariables"]}
    variant = doc["HostingInstanceTypeVariants"]["Variants"]
    env.update(variant[TEMPLATE_INSTANCE]["Properties"]["EnvironmentVariables"])
    env.update(OVERRIDES)
    image = variant["g7e"]["Properties"]["ImageUri"]
    role = f"arn:aws:iam::{account}:role/MuseKnowledgeSageMaker"

    sm.create_model(
        ModelName=NAME,
        ExecutionRoleArn=role,
        PrimaryContainer={
            "Image": image,
            "Environment": env,
            "ModelDataSource": {"S3DataSource": {
                "S3Uri": doc["HostingArtifactUri"], "S3DataType": "S3Prefix", "CompressionType": "None",
                "ModelAccessConfig": {"AcceptEula": True},
            }},
        },
    )
    sm.create_endpoint_config(EndpointConfigName=NAME, ProductionVariants=[{
        "VariantName": "spark", "ModelName": NAME, "InstanceType": INSTANCE, "InitialInstanceCount": 1,
        "ModelDataDownloadTimeoutInSeconds": 3600, "ContainerStartupHealthCheckTimeoutInSeconds": 3600,
    }])
    sm.create_endpoint(EndpointName=NAME, EndpointConfigName=NAME)

    at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    s.client("scheduler").create_schedule(
        Name=STOP_SCHEDULE, ScheduleExpression=f"at({at})", ScheduleExpressionTimezone="UTC",
        FlexibleTimeWindow={"Mode": "OFF"}, ActionAfterCompletion="DELETE",
        Target={
            "Arn": "arn:aws:scheduler:::aws-sdk:sagemaker:deleteEndpoint",
            "RoleArn": f"arn:aws:iam::{account}:role/MuseKnowledgeScheduler",
            "Input": json.dumps({"EndpointName": NAME}),
        },
    )
    print(json.dumps({"endpoint": NAME, "instance": INSTANCE, "image": image, "deleteAtUtc": at}))


def status():
    sm = session().client("sagemaker")
    try:
        e = sm.describe_endpoint(EndpointName=NAME)
    except sm.exceptions.ClientError:
        print(json.dumps({"endpoint": NAME, "status": "absent"}))
        return
    print(json.dumps({"endpoint": NAME, "status": e["EndpointStatus"], "created": str(e["CreationTime"]), "failure": e.get("FailureReason")}))


def delete():
    s = session()
    sm = s.client("sagemaker")
    for call, kw in ((sm.delete_endpoint, {"EndpointName": NAME}), (sm.delete_endpoint_config, {"EndpointConfigName": NAME}), (sm.delete_model, {"ModelName": NAME})):
        try:
            call(**kw)
        except sm.exceptions.ClientError as err:
            print("skip:", err.response["Error"]["Message"])
    try:
        s.client("scheduler").delete_schedule(Name=STOP_SCHEDULE)
    except Exception as err:  # Already ran, or never made.
        print("skip:", err)
    print(json.dumps({"endpoint": NAME, "deleted": True}))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["deploy", "status", "delete"])
    p.add_argument("--hours", type=float, default=6)
    a = p.parse_args()
    {"deploy": lambda: deploy(a.hours), "status": status, "delete": delete}[a.command]()
