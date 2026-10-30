"""Muse Glimmer 30B on a SageMaker endpoint, as the default writer of the knowledge Q&A (docs/KNOWLEDGE_UPDATE.md).

    .data/aws/venv/bin/python scripts/knowledge/aws/glimmer_endpoint.py deploy [--hours 8] [--instance ml.g7e.2xlarge]
    .data/aws/venv/bin/python scripts/knowledge/aws/glimmer_endpoint.py status
    .data/aws/venv/bin/python scripts/knowledge/aws/glimmer_endpoint.py delete

JumpStart's vLLM container and weights with its ml.g7e.2xlarge settings, widened for batch writing (48 requests at
once, 8K context). deploy schedules the endpoint's deletion --hours later (default 8, about $34 at $4.20 an hour).
"""

import argparse
import datetime as dt
import json

import boto3

PROFILE = "offlinebase"
REGION = "us-east-1"
MODEL_ID = "huggingface-vlm-muse-glimmer-30b"
CONFIG = "generate_best_price_performance"
TEMPLATE_INSTANCE = "ml.g7e.2xlarge"
NAME = "muse-glimmer-knowledge"
STOP_SCHEDULE = f"{NAME}-stop"
OVERRIDES = {
    "MAX_BATCH_SIZE": "48", "MAX_CONCURRENT_REQUESTS": "48", "SM_VLLM_MAX_NUM_SEQS": "48",
    "SM_VLLM_MAX_MODEL_LEN": "8192", "SM_VLLM_REASONING_PARSER": "muse_glimmer",
}


def session():
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def remove(sm):
    for call, kw in ((sm.delete_endpoint, {"EndpointName": NAME}), (sm.delete_endpoint_config, {"EndpointConfigName": NAME}), (sm.delete_model, {"ModelName": NAME})):
        try:
            call(**kw)
        except sm.exceptions.ClientError as err:
            if "Could not find" not in err.response["Error"]["Message"]:
                print("skip:", err.response["Error"]["Message"])
    sm.get_waiter("endpoint_deleted").wait(EndpointName=NAME, WaiterConfig={"Delay": 10, "MaxAttempts": 60})


def deploy(hours, instance):
    s = session()
    sm, account = s.client("sagemaker"), s.client("sts").get_caller_identity()["Account"]
    doc = json.loads(sm.describe_hub_content(HubName="SageMakerPublicHub", HubContentType="Model", HubContentName=MODEL_ID)["HubContentDocument"])
    component = doc["InferenceConfigComponents"][CONFIG]
    variants = component["HostingInstanceTypeVariants"]["Variants"]
    env = {e["Name"]: str(e["Default"]) for e in doc["InferenceEnvironmentVariables"]}
    env.update(variants[TEMPLATE_INSTANCE]["Properties"]["EnvironmentVariables"])
    env.update(OVERRIDES)
    remove(sm)
    sm.create_model(
        ModelName=NAME,
        ExecutionRoleArn=f"arn:aws:iam::{account}:role/MuseKnowledgeSageMaker",
        PrimaryContainer={
            "Image": variants["g7e"]["Properties"]["ImageUri"],
            "Environment": env,
            "ModelDataSource": {"S3DataSource": {"S3Uri": component["HostingArtifactUri"], "S3DataType": "S3Prefix", "CompressionType": "None"}},
        },
    )
    sm.create_endpoint_config(EndpointConfigName=NAME, ProductionVariants=[{
        "VariantName": "glimmer", "ModelName": NAME, "InstanceType": instance, "InitialInstanceCount": 1,
        "ModelDataDownloadTimeoutInSeconds": 1800, "ContainerStartupHealthCheckTimeoutInSeconds": 1800,
    }])
    sm.create_endpoint(EndpointName=NAME, EndpointConfigName=NAME)
    at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    scheduler = s.client("scheduler")
    try:
        scheduler.delete_schedule(Name=STOP_SCHEDULE)
    except scheduler.exceptions.ResourceNotFoundException:
        pass
    scheduler.create_schedule(
        Name=STOP_SCHEDULE, ScheduleExpression=f"at({at})", ScheduleExpressionTimezone="UTC",
        FlexibleTimeWindow={"Mode": "OFF"}, ActionAfterCompletion="DELETE",
        Target={
            "Arn": "arn:aws:scheduler:::aws-sdk:sagemaker:deleteEndpoint",
            "RoleArn": f"arn:aws:iam::{account}:role/MuseKnowledgeScheduler",
            "Input": json.dumps({"EndpointName": NAME}),
        },
    )
    print(json.dumps({"endpoint": NAME, "instance": instance, "deleteAtUtc": at}))


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
    remove(s.client("sagemaker"))
    try:
        s.client("scheduler").delete_schedule(Name=STOP_SCHEDULE)
    except Exception as err:  # Already ran, or never made.
        print("skip:", err)
    print(json.dumps({"endpoint": NAME, "deleted": True}))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["deploy", "status", "delete"])
    p.add_argument("--hours", type=float, default=8)
    p.add_argument("--instance", default=TEMPLATE_INSTANCE)
    a = p.parse_args()
    {"deploy": lambda: deploy(a.hours, a.instance), "status": status, "delete": delete}[a.command]()
