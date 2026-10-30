"""One-time AWS setup for the knowledge jobs (docs/KNOWLEDGE_UPDATE.md): a private S3 bucket, the SageMaker execution
role and the role EventBridge Scheduler uses to stop jobs. Safe to run again; it only creates what's missing.

    .data/aws/venv/bin/python scripts/knowledge/aws/setup.py
"""

import json

import boto3

PROFILE = "offlinebase"
REGION = "us-east-1"
SAGEMAKER_ROLE = "MuseKnowledgeSageMaker"
SCHEDULER_ROLE = "MuseKnowledgeScheduler"


def main():
    s = boto3.Session(profile_name=PROFILE, region_name=REGION)
    account = s.client("sts").get_caller_identity()["Account"]
    bucket = f"muse-knowledge-{account}"
    s3, iam = s.client("s3"), s.client("iam")

    if bucket not in [b["Name"] for b in s3.list_buckets()["Buckets"]]:
        s3.create_bucket(Bucket=bucket)
    s3.put_public_access_block(
        Bucket=bucket,
        PublicAccessBlockConfiguration={k: True for k in ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")},
    )

    def role(name, service, managed=(), inline=None):
        try:
            iam.get_role(RoleName=name)
        except iam.exceptions.NoSuchEntityException:
            trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": service}, "Action": "sts:AssumeRole"}]}
            iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps(trust), MaxSessionDuration=43200)
        for arn in managed:
            iam.attach_role_policy(RoleName=name, PolicyArn=arn)
        if inline:
            iam.put_role_policy(RoleName=name, PolicyName=f"{name}Inline", PolicyDocument=json.dumps(inline))
        return iam.get_role(RoleName=name)["Role"]["Arn"]

    bucket_access = {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": f"arn:aws:s3:::{bucket}"},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": f"arn:aws:s3:::{bucket}/*"},
        ],
    }
    sm = role(SAGEMAKER_ROLE, "sagemaker.amazonaws.com", ["arn:aws:iam::aws:policy/AmazonSageMakerFullAccess"], bucket_access)
    stopper = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["sagemaker:DeleteEndpoint", "sagemaker:StopTrainingJob"],
            "Resource": [f"arn:aws:sagemaker:{REGION}:{account}:endpoint/*", f"arn:aws:sagemaker:{REGION}:{account}:training-job/*"],
        }],
    }
    sched = role(SCHEDULER_ROLE, "scheduler.amazonaws.com", (), stopper)
    print(json.dumps({"account": account, "bucket": bucket, "sagemaker_role": sm, "scheduler_role": sched}))


if __name__ == "__main__":
    main()
