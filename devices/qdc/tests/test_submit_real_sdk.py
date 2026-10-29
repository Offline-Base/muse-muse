"""devices/qdc/submit.py against the real qualcomm_device_cloud_sdk 0.2.3 wheel, with the network replaced at the bottom:
httpx's transport answers as QDC's API would (paths, query parameters and JSON read from the wheel's own api/ and
models/), and requests' adapter stands in for the storage behind the presigned URLs. It checks the exact HTTP calls the
SDK makes for submit.py: the upload in parts, the job's JSON, the polling, the log list and downloads, an abort, a
refused key and a storage error page; that the key goes only to QDC's API host, that every call has a timeout, and
that no key, presigned URL, user name or org id reaches stdout, stderr or a file.

Run it with the submitter's venv (scripts/devices/qdc.ts makes it; it is skipped anywhere else):

    ~/.cache/muse-muse-devices/qdc/venv-0.2.3/bin/python -I devices/qdc/tests/test_submit_real_sdk.py
"""

import contextlib
import io
import json
import os
import random
import shutil
import sys
import tempfile
import unittest
import urllib.parse
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    from importlib.metadata import version

    import httpx
    import requests
    import requests.adapters
    import requests.models

    REAL_SDK = version("qualcomm-device-cloud-sdk") == "0.2.3"
except Exception:
    REAL_SDK = False

import submit  # noqa: E402

KEY = "qdc_test_key_not_real_0123456789abcdef"
API = "https://apigwx-aws.qualcomm.com/saga/v1/public/qdc"
STORAGE = "https://qdc-test-bucket.s3.amazonaws.com"
SUBJECT = "smoke-smollm2-135m-q4_0"
STAMP = "20261028T221500Z"
PART = 8388608


class FakeQdc:
    """QDC's API and its storage, in process. Every request is kept for the test to read."""

    def __init__(self):
        self.api_calls = []
        self.storage_calls = []
        self.states = ["Submitted", "Setup", "Running", "Running", "Completed"]
        self.polls = 0
        self.refuse_key = False
        self.stored = {}
        self.logs = {}
        self.error_pages = set()
        self.aborted = False

    def job(self):
        state = "Canceled" if self.aborted else self.states[min(self.polls, len(self.states) - 1)]
        done = state in ("Completed", "Canceled") and self.polls > len(self.states)
        return {
            "jobId": 1001,
            "jobName": f"mm SM8750 {STAMP}",
            "externalJobId": f"{STAMP}-SM8750-1",
            "createdOn": "2026-10-28T22:15:01Z",
            "completedOn": None,
            "userName": "someone@example.com",
            "orgId": 4242,
            "state": state,
            "result": "Aborted" if self.aborted else ("Successful" if state == "Completed" else "Pending"),
            "logUploadStatus": "Completed" if done else "InProgress",
            "targets": [
                {
                    "chipsetCategory": "Mobile",
                    "chipset": "SM8750",
                    "chipsetAlias": "SM8750",
                    "chipsetMarketingName": "Snapdragon 8 Elite",
                    "chipsetPlatformName": "QRD",
                }
            ],
        }

    def api(self, request):
        url = request.url
        path = url.path[len("/saga/v1/public/qdc"):]
        query = dict(urllib.parse.parse_qsl(url.query.decode()))
        body = json.loads(request.content) if request.content else None
        self.api_calls.append(
            {
                "method": request.method,
                "host": url.host,
                "path": path,
                "query": query,
                "body": body,
                "auth": request.headers.get("Authorization"),
                "token_type": request.headers.get("X-QCOM-TokenType"),
                "app": request.headers.get("X-QCOM-AppName"),
                "timeout": request.extensions.get("timeout"),
            }
        )
        if self.refuse_key:
            return httpx.Response(401, json={"message": "Unauthorized: bad API key"}, request=request)
        if request.method == "GET" and path == "/targets":
            data = [
                {"targetId": "13", "chipsetName": "SM8750", "chipsetMarketingName": "Snapdragon 8 Elite", "chipsetPlatformName": "QRD", "chipsetCategory": "Mobile", "os": "Android", "osVersion": "15", "state": "AvailableNow"},
                {"targetId": "14", "chipsetName": "QCS6490", "chipsetMarketingName": "QCS6490", "chipsetPlatformName": "RB3", "chipsetCategory": "IOT", "os": "Linux", "osVersion": "", "state": "AvailableNow"},
            ]
            return httpx.Response(200, json={"pageNumber": 0, "pageSize": 200, "total": len(data), "data": data}, request=request)
        if request.method == "POST" and path == "/artifacts/presigned/startUpload":
            size = int(query["fileSize"])
            count = max(1, -(-size // int(query["partSize"])))
            parts = [{"partNumber": i + 1, "url": f"{STORAGE}/u-1/part{i + 1}?X-Amz-Signature=sig{i + 1}secret"} for i in range(count)]
            return httpx.Response(200, json={"uuid": "u-1", "uploadId": "up-1", "isMultipartUpload": count > 1, "parts": parts, "filename": query["filename"]}, request=request)
        if request.method == "POST" and path == "/artifacts/presigned/u-1/endUpload":
            return httpx.Response(200, json={"uuid": "u-1", "artifactType": "TestScript", "filename": "job.zip", "uploadStatus": "Completed"}, request=request)
        if request.method == "POST" and path == "/jobs":
            return httpx.Response(200, json={**self.job(), "state": "Submitted"}, request=request)
        if request.method == "GET" and path == "/jobs/1001":
            self.polls += 1
            return httpx.Response(200, json=self.job(), request=request)
        if request.method == "POST" and path == "/jobs/1001/abort":
            self.aborted = True
            return httpx.Response(200, json=self.job(), request=request)
        if request.method == "GET" and path == "/jobs/1001/logs":
            return httpx.Response(200, json=[{"filename": name, "fileSizeInByte": len(data)} for name, data in self.logs.items()], request=request)
        if request.method == "GET" and path == "/jobs/presigned/downloadLogs":
            name = query["path"]
            return httpx.Response(200, json={"url": f"{STORAGE}/logs/{urllib.parse.quote(name)}?X-Amz-Credential=cred&X-Amz-Signature=logsig", "path": name}, request=request)
        return httpx.Response(404, json={"message": f"no {request.method} {path}"}, request=request)

    def storage(self, request, timeout):
        parsed = urllib.parse.urlparse(request.url)
        self.storage_calls.append({"method": request.method, "path": parsed.path, "auth": request.headers.get("Authorization"), "timeout": timeout, "bytes": len(request.body or b"")})
        response = requests.models.Response()
        response.request = request
        response.url = request.url
        if request.method == "PUT":
            self.stored[parsed.path] = request.body
            response.status_code = 200
            response.headers["ETag"] = f'"etag-{parsed.path.rsplit("part", 1)[-1]}"'
            response._content = b""
        else:
            name = urllib.parse.unquote(parsed.path[len("/logs/"):])
            if name in self.error_pages:
                response.status_code = 403
                response._content = b'<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code></Error>'
            else:
                response.status_code = 200
                response._content = self.logs[name]
        return response


@unittest.skipUnless(REAL_SDK, "needs the submitter's venv with qualcomm_device_cloud_sdk 0.2.3")
class RealSdkTests(unittest.TestCase):
    def setUp(self):
        self.qdc = FakeQdc()
        self.tmp = tempfile.mkdtemp(prefix="mm-qdc-real-sdk-")
        self.saved = (httpx.HTTPTransport.handle_request, requests.adapters.HTTPAdapter.send, submit.clock, submit.sleep, submit._secret, dict(os.environ))
        qdc = self.qdc
        httpx.HTTPTransport.handle_request = lambda transport, request: qdc.api(request)
        requests.adapters.HTTPAdapter.send = lambda adapter, request, stream=False, timeout=None, verify=True, cert=None, proxies=None: qdc.storage(request, timeout)
        self.now = [1000.0]
        submit.clock = lambda: self.now[0]
        submit.sleep = lambda s: self.now.__setitem__(0, self.now[0] + s)
        submit._secret = None
        os.environ["HOME"] = self.tmp
        os.environ["QDC_API_KEY"] = KEY

    def tearDown(self):
        httpx.HTTPTransport.handle_request, requests.adapters.HTTPAdapter.send, submit.clock, submit.sleep, submit._secret, env = self.saved
        os.environ.clear()
        os.environ.update(env)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = submit.main(list(argv))
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        return code

    def manifest(self, zip_bytes):
        key = f"{STAMP}-SM8750-1"
        zip_path = os.path.join(self.tmp, f"{key}.zip")
        with open(zip_path, "wb") as f:
            f.write(zip_bytes)
        self.out = os.path.join(self.tmp, "runs", key)
        job = {"key": key, "chipset": "SM8750", "name": f"mm SM8750 {STAMP}", "timeoutMinutes": 42, "zip": zip_path, "outDir": self.out}
        path = os.path.join(self.tmp, "manifest.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "jobs": [job], "pollSeconds": 30, "queueMinutes": 360, "logWaitMinutes": 30}, f)
        return path, zip_path

    def big_zip(self):
        """A zip over two of the SDK's 8 MiB upload parts."""
        rng = random.Random(7)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            zf.writestr("requirements.txt", "pytest==8.4.2\n")
            zf.writestr("mm/llama-android/libllama.so", bytes(rng.getrandbits(8) for _ in range(PART + 4096)))
        return buf.getvalue()

    def kit_logs(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"QDC_logs/mm__{SUBJECT}__run.txt.log", f"kit=1\nsubject={SUBJECT}\nstatus=done\n")
            zf.writestr(f"QDC_logs/mm__{SUBJECT}__device.txt.log", "platform=android\nram_kb=11745000\n")
            zf.writestr("QDC_logs/mm__carrier.log", "[mm      0s] Run.\n")
        self.qdc.logs = {
            "jobs/1001/logs.zip": buf.getvalue(),
            f"jobs/1001/QDC_logs/mm__{SUBJECT}__steps.txt.log": b"name=check backend=- prompt=- start=1 seconds=1 limit=120 rc=0 end=ok why=-\n",
        }

    def every_output(self):
        text = self.stdout + self.stderr
        for root, _, files in os.walk(self.tmp):
            for name in files:
                if name.endswith(".zip") and root == self.tmp:
                    continue
                with open(os.path.join(root, name), "rb") as f:
                    text += f.read().decode("latin1")
        return text

    def test_a_batch_through_the_real_sdk(self):
        self.kit_logs()
        manifest, zip_path = self.manifest(self.big_zip())
        self.assertEqual(self.main("run", "--manifest", manifest), 0, self.stderr)

        api = [(c["method"], c["path"]) for c in self.qdc.api_calls]
        self.assertEqual(api[:4], [("GET", "/targets"), ("POST", "/artifacts/presigned/startUpload"), ("POST", "/artifacts/presigned/u-1/endUpload"), ("POST", "/jobs")])
        self.assertEqual(self.qdc.api_calls[0]["query"], {"pageSize": "200"})
        start = self.qdc.api_calls[1]["query"]
        self.assertEqual(start, {"filename": os.path.basename(zip_path), "artifactType": "TestScript", "fileSize": str(os.path.getsize(zip_path)), "partSize": str(PART)})
        end = self.qdc.api_calls[2]["body"]
        self.assertEqual(end["isMultipartUpload"], True)
        self.assertEqual(end["uploadId"], "up-1")
        self.assertEqual([(p["partNumber"], p["eTag"]) for p in end["parts"]], [(1, '"etag-1"'), (2, '"etag-2"')])
        self.assertEqual(
            self.qdc.api_calls[3]["body"],
            {
                "targetId": "13",
                "jobName": f"mm SM8750 {STAMP}",
                "externalJobId": f"{STAMP}-SM8750-1",
                "jobType": "Automated",
                "jobMode": "Application",
                "timeoutInMinutes": 42,
                "testFramework": "Appium",
                "entryScript": None,
                "monkeyEvents": None,
                "monkeySessionTimeout": None,
                "jobArtifacts": ["u-1"],
                "jobParameters": ["WifiEnabled", "ScreenAlwaysOn"],
            },
        )
        self.assertIn(("GET", "/jobs/1001/logs"), api)
        self.assertEqual(sorted(c["query"]["path"] for c in self.qdc.api_calls if c["path"] == "/jobs/presigned/downloadLogs"), sorted(self.qdc.logs))
        for call in self.qdc.api_calls:
            self.assertEqual(call["host"], "apigwx-aws.qualcomm.com")
            self.assertEqual((call["auth"], call["token_type"], call["app"]), (KEY, "apikey", "muse-muse-devices"))
            self.assertEqual(call["timeout"], {"connect": 120, "read": 120, "write": 120, "pool": 120}, "every API call has a timeout")

        puts = [c for c in self.qdc.storage_calls if c["method"] == "PUT"]
        self.assertEqual([c["bytes"] for c in puts], [PART, os.path.getsize(zip_path) - PART])
        with open(zip_path, "rb") as f:
            self.assertEqual(self.qdc.stored["/u-1/part1"] + self.qdc.stored["/u-1/part2"], f.read())
        for call in self.qdc.storage_calls:
            self.assertIsNone(call["auth"], "the key never goes to the storage")
            self.assertEqual(call["timeout"], submit.TRANSFER_SECONDS, "presigned transfers get a timeout too")

        with open(os.path.join(self.out, "job.json"), encoding="utf-8") as f:
            record = json.load(f)
        self.assertEqual((record["jobId"], record["state"], record["logStatus"], record["targetId"]), (1001, "Completed", "Completed", "13"))
        self.assertEqual(record["subjects"], [SUBJECT])
        self.assertEqual(sorted(os.listdir(os.path.join(self.out, "out", SUBJECT))), ["device.txt", "run.txt", "steps.txt"])
        text = self.every_output()
        for leak in (KEY, "secret", "logsig", "X-Amz-Credential=cred", "someone@example.com", "4242"):
            self.assertNotIn(leak, text, f"{leak} came out")

    def test_abort_through_the_real_sdk(self):
        self.kit_logs()
        manifest, _ = self.manifest(b"PK\x05\x06" + b"\x00" * 18)
        polls = {"n": 0}

        def interrupting_sleep(seconds):
            polls["n"] += 1
            self.now[0] += seconds
            if polls["n"] == 2:
                raise KeyboardInterrupt()

        submit.sleep = interrupting_sleep
        self.assertEqual(self.main("run", "--manifest", manifest), 130)
        self.assertIn(("POST", "/jobs/1001/abort"), [(c["method"], c["path"]) for c in self.qdc.api_calls])
        with open(os.path.join(self.out, "job.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["aborted"], "the submitter was interrupted")

    def test_a_refused_key_and_a_storage_error_page(self):
        self.qdc.refuse_key = True
        self.assertEqual(self.main("targets"), 1)
        self.assertIn("status code 401", self.stderr)
        self.assertIn("bad API key", self.stderr)
        self.assertNotIn(KEY, self.stderr)

        self.qdc = FakeQdc()
        qdc = self.qdc
        httpx.HTTPTransport.handle_request = lambda transport, request: qdc.api(request)
        requests.adapters.HTTPAdapter.send = lambda adapter, request, stream=False, timeout=None, verify=True, cert=None, proxies=None: qdc.storage(request, timeout)
        self.kit_logs()
        self.qdc.error_pages.add(f"jobs/1001/QDC_logs/mm__{SUBJECT}__steps.txt.log")
        manifest, _ = self.manifest(b"PK\x05\x06" + b"\x00" * 18)
        self.assertEqual(self.main("run", "--manifest", manifest), 1)
        with open(os.path.join(self.out, "job.json"), encoding="utf-8") as f:
            record = json.load(f)
        self.assertEqual([e["kind"] for e in record["logs"]], ["zip", "failed"])
        self.assertEqual(len([c for c in self.qdc.storage_calls if c["path"].endswith("steps.txt.log")]), submit.DOWNLOAD_TRIES)
        self.assertNotIn("logsig", self.every_output())


if __name__ == "__main__":
    unittest.main(verbosity=1)
