"""A local OpenAI-style relay to the Spark Open SageMaker endpoint, so scripts/knowledge/make-dataset.ts (which speaks
Chat Completions) can use it unchanged. Listens on 127.0.0.1 only; requests are signed with the AWS profile.

    .data/aws/venv/bin/python scripts/knowledge/aws/relay.py [--port 18787]

POST /v1/chat/completions forwards the body to InvokeEndpointWithResponseStream (streaming has no 60-second limit)
and returns one non-streamed Chat Completions response built from the chunks. The reasoning stays out of `content`.
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
from botocore.config import Config

PROFILE = "offlinebase"
REGION = "us-east-1"
ENDPOINT = "muse-spark-open-knowledge"

runtime = boto3.Session(profile_name=PROFILE, region_name=REGION).client(
    "sagemaker-runtime", config=Config(read_timeout=900, connect_timeout=30, retries={"max_attempts": 2}, max_pool_connections=128)
)


def complete(body):
    body = {k: v for k, v in body.items() if k != "model"}
    body["stream"] = True
    body["stream_options"] = {"include_usage": True}
    res = runtime.invoke_endpoint_with_response_stream(EndpointName=ENDPOINT, ContentType="application/json", Body=json.dumps(body))
    content, reasoning, usage, buf = [], [], {}, b""
    for event in res["Body"]:
        buf += event.get("PayloadPart", {}).get("Bytes", b"")
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                continue
            chunk = json.loads(data)
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                content.append(delta.get("content") or "")
                reasoning.append(delta.get("reasoning_content") or "")
    return {
        "choices": [{"message": {"role": "assistant", "content": "".join(content)}, "reasoning_chars": len("".join(reasoning))}],
        "usage": usage,
    }


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        try:
            out, code = complete(json.loads(self.rfile.read(int(self.headers["Content-Length"])))), 200
        except Exception as err:  # Shown to the caller, which retries 429s and 5xx.
            msg = str(err)[:500]
            code = 429 if "throttl" in msg.lower() else 502
            out = {"error": msg}
        data = json.dumps(out).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=18787)
    port = p.parse_args().port
    print(f"relay on http://127.0.0.1:{port}/v1 -> {ENDPOINT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
