"""devices/qdc/submit.py against a fake qualcomm_device_cloud_sdk (tests/fake_sdk: the 0.2.3 wheel's modules, signatures
and enum values, answering from scripted state, no network): the key and its file, scrubbing, the manifest, targets,
the upload and submit_job with their exact arguments, polling through every JobState and through states the SDK can't
parse, the log upload, downloads that fail, come back raw or zipped or as a storage error page, aborts when the script
is interrupted, when QDC stops answering and when a job waits or runs too long, and that the key never reaches stdout,
stderr or a file.

    /opt/homebrew/bin/python3.12 -I devices/qdc/tests/test_submit.py
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "fake_sdk"), os.path.dirname(HERE)]

import submit  # noqa: E402
from qualcomm_device_cloud_sdk import models  # noqa: E402
from qualcomm_device_cloud_sdk.api import qdc_api  # noqa: E402

# A test value, not a real key.
KEY = "qdc_test_key_not_real_0123456789abcdef"
SUBJECT = "smoke-smollm2-135m-q4_0"
STAMP = "20261028T221500Z"


class FakeTime:
    """submit.clock and submit.sleep: sleeping moves the clock, so a test never waits."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def target(target_id, chipset, state="AvailableNow", os_name="Android", category="Mobile", name="Snapdragon 8 Elite"):
    return models.TargetType0(
        target_id=target_id,
        chipset_name=chipset,
        chipset_marketing_name=name,
        chipset_platform_name="QRD",
        chipset_category=models.ChipsetCategory(category),
        os=models.OS(os_name),
        os_version="15",
        state=models.TargetState(state),
    )


def log(name, size=1):
    return models.JobLogsType0(filename=name, file_size_in_byte=size)


def zipped(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def kit_logs(subject=SUBJECT):
    """What the carrier leaves in QDC_logs for one subject, zipped as QDC returns some of it."""
    return zipped(
        {
            f"QDC_logs/mm__{subject}__run.txt.log": b"kit=1\nsubject=" + subject.encode() + b"\nstatus=done\n",
            f"QDC_logs/mm__{subject}__device.txt.log": b"platform=android\nram_kb=11765432\n",
            f"QDC_logs/mm__{subject}__kit.log.log": b"22:15:00 kit 1\n",
            "QDC_logs/mm__carrier.log": b"[mm      0s] Run x.\n",
            "logcat.txt": b"QDC's own log\n",
        }
    )


class Base(unittest.TestCase):
    def setUp(self):
        self.fake = qdc_api.reset()
        self.tmp = tempfile.mkdtemp(prefix="mm-qdc-submit-")
        self.time = FakeTime()
        self.saved = (submit.clock, submit.sleep, submit._secret, dict(os.environ))
        submit.clock = self.time.clock
        submit.sleep = self.time.sleep
        submit._secret = None
        # The owner's real key file is never read: HOME is the test's folder and the key comes from the environment.
        os.environ["HOME"] = self.tmp
        os.environ["QDC_API_KEY"] = KEY

    def tearDown(self):
        submit.clock, submit.sleep, submit._secret, env = self.saved
        os.environ.clear()
        os.environ.update(env)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = submit.main(list(argv))
            except SystemExit as e:
                code = e.code
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        return code

    def job(self, n, chipset, timeout=125):
        key = f"{STAMP}-{chipset}-{n}"
        path = os.path.join(self.tmp, f"{key}.zip")
        with open(path, "wb") as f:
            f.write(zipped({"requirements.txt": b"pytest==8.4.2\n"}))
        return {
            "key": key,
            "chipset": chipset,
            "name": f"mm {chipset} {STAMP}",
            "timeoutMinutes": timeout,
            "zip": path,
            "outDir": os.path.join(self.tmp, "runs", key),
        }

    def manifest(self, jobs, **settings):
        data = {"version": 1, "jobs": jobs, "pollSeconds": 30, "queueMinutes": 360, "logWaitMinutes": 30}
        data.update(settings)
        path = os.path.join(self.tmp, "manifest.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return path

    def record(self, job):
        with open(os.path.join(job["outDir"], "job.json"), encoding="utf-8") as f:
            return json.load(f)

    def assert_no_key_anywhere(self):
        self.assertNotIn(KEY, self.stdout)
        self.assertNotIn(KEY, self.stderr)
        for root, _, files in os.walk(self.tmp):
            for name in files:
                if name == "api.env":
                    continue
                with open(os.path.join(root, name), "rb") as f:
                    self.assertNotIn(KEY.encode(), f.read(), f"the key is in {name}")


class KeyTests(Base):
    def key_file(self, text, mode=0o600):
        path = os.path.join(self.tmp, "api.env")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(path, mode)
        return path

    def test_the_environment_wins(self):
        path = self.key_file("QDC_API_KEY=from_the_file\n")
        self.assertEqual(submit.load_key({"QDC_API_KEY": " from_env "}, path), ("from_env", "environment"))

    def test_the_file_is_read_with_export_and_quotes(self):
        path = self.key_file("# QDC\nexport QDC_API_KEY='quoted_value'\nOTHER=1\n")
        self.assertEqual(submit.load_key({}, path), ("quoted_value", "file"))
        self.assertEqual(submit.scrub("token quoted_value here"), "token [QDC key] here")

    def test_a_file_others_can_read_is_refused(self):
        path = self.key_file("QDC_API_KEY=abc\n", 0o644)
        with self.assertRaises(submit.Refusal) as e:
            submit.load_key({}, path)
        self.assertIn("chmod 600", str(e.exception))
        self.assertNotIn("abc", str(e.exception))

    def test_missing_empty_and_odd_keys_are_refused(self):
        with self.assertRaises(submit.Refusal) as e:
            submit.load_key({}, os.path.join(self.tmp, "nope.env"))
        self.assertIn("No QDC key", str(e.exception))
        with self.assertRaises(submit.Refusal):
            submit.load_key({}, self.key_file("OTHER=1\n"))
        with self.assertRaises(submit.Refusal):
            submit.load_key({"QDC_API_KEY": "two words"}, None)

    def test_check_reads_the_file_and_calls_nothing(self):
        del os.environ["QDC_API_KEY"]
        folder = os.path.join(self.tmp, ".config", "qdc")
        os.makedirs(folder)
        path = os.path.join(folder, "api.env")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"QDC_API_KEY={KEY}\n")
        os.chmod(path, 0o600)
        self.assertEqual(self.main("check"), 0)
        self.assertEqual(json.loads(self.stdout), {"ok": True, "source": "file"})
        self.assertEqual(self.fake.calls, [])
        os.chmod(path, 0o640)
        self.assertEqual(self.main("check"), 2)
        self.assertIn("chmod 600", self.stderr)
        self.assert_no_key_anywhere()


class ScrubTests(Base):
    def test_urls_lose_their_queries(self):
        text = "GET https://qdc-logs.s3.amazonaws.com/jobs/1/a.zip?X-Amz-Signature=abc&X-Amz-Credential=def failed"
        self.assertEqual(submit.scrub(text), "GET https://qdc-logs.s3.amazonaws.com/jobs/1/a.zip?[query removed] failed")
        self.assertEqual(submit.scrub("/jobs/presigned/downloadLogs?path=x"), "/jobs/presigned/downloadLogs?[query removed]")

    def test_the_sdk_logs_warnings_through_scrub(self):
        submit.load_key({"QDC_API_KEY": KEY}, None)
        self.main("check")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            import logging

            logging.getLogger("qualcomm_device_cloud").warning("call failed for %s at https://x/y?sig=1", KEY)
            logging.getLogger("qualcomm_device_cloud").info("Job response: {\"userName\": \"someone\"}")
        self.assertIn("[QDC key]", err.getvalue())
        self.assertIn("?[query removed]", err.getvalue())
        self.assertNotIn(KEY, err.getvalue())
        self.assertNotIn("someone", err.getvalue(), "INFO lines (the SDK logs whole responses there) stay quiet")


class ManifestTests(Base):
    def test_bad_manifests_are_refused_before_any_call(self):
        good = self.job(1, "SM8750")
        cases = [
            ({**good, "name": "x" * 32}, "1 to 31 characters"),
            ({**good, "timeoutMinutes": 151}, "timeoutMinutes"),
            ({**good, "timeoutMinutes": "125"}, "timeoutMinutes"),
            ({**good, "zip": os.path.join(self.tmp, "missing.zip")}, "isn't there"),
            ({**good, "outDir": "relative/out"}, "absolute"),
            ({**good, "key": "bad key"}, "key"),
            ({**good, "chipset": "SM 8750"}, "chipset"),
        ]
        for job, words in cases:
            self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 2, words)
            self.assertIn(words, self.stderr)
        self.assertEqual(self.main("run", "--manifest", self.manifest([good, dict(good)])), 2)
        self.assertIn("repeated", self.stderr)
        self.assertEqual(self.main("run", "--manifest", self.manifest([])), 2)
        self.assertEqual(self.fake.calls, [])


class TargetTests(Base):
    def test_targets_are_listed_across_pages(self):
        self.fake.targets = [target(i, f"SM{8000 + i}") for i in range(1, 6)]
        self.fake.page_size = 2
        self.assertEqual(self.main("targets"), 0)
        rows = json.loads(self.stdout)
        self.assertEqual([r["targetId"] for r in rows], ["1", "2", "3", "4", "5"])
        self.assertEqual(
            rows[0],
            {
                "targetId": "1",
                "chipset": "SM8001",
                "marketingName": "Snapdragon 8 Elite",
                "platformName": "QRD",
                "category": "Mobile",
                "os": "Android",
                "osVersion": "15",
                "state": "AvailableNow",
            },
        )
        self.assertEqual(len(self.fake.named("targets_get")), 3)
        self.assertEqual(self.fake.named("client")[0]["api_key_header"], KEY)
        self.assertEqual(self.fake.named("client")[0]["app_name_header"], "muse-muse-devices")
        self.assertEqual(self.fake.timeouts, [submit.CALL_SECONDS], "every call has a timeout")

    def test_the_phone_target_is_picked(self):
        rows = [
            submit.target_row(target(1, "SM8750", state="DevicesBusy")),
            submit.target_row(target(2, "SM8750", os_name="Linux", category="IOT")),
            submit.target_row(target(3, "SM8750", state="AvailableNow")),
            submit.target_row(target(4, "SM8650")),
        ]
        self.assertEqual(submit.pick_target(rows, "SM8750")["targetId"], "3")
        self.assertEqual(submit.pick_target(rows[:2], "SM8750")["targetId"], "1")
        self.assertIsNone(submit.pick_target(rows, "SM8850"))


class TransferTests(Base):
    def test_presigned_transfers_get_a_timeout(self):
        import requests.sessions

        submit.bound_transfers()
        submit.bound_transfers()
        requests.sessions.Session().request("PUT", "https://bucket/part", data=b"x")
        requests.sessions.Session().request("GET", "https://bucket/log", timeout=5)
        self.assertEqual(requests.sessions.CALLS[-2:], [("PUT", "https://bucket/part", submit.TRANSFER_SECONDS), ("GET", "https://bucket/log", 5)])


class RunTests(Base):
    def happy(self, job_id=1001, subject=SUBJECT):
        self.fake.log_states[job_id] = ["InProgress", "InProgress", "Completed"]
        self.fake.log_files[job_id] = [
            [log(f"jobs/{job_id}/logs.zip"), log(f"jobs/{job_id}/QDC_logs/mm__{subject}__steps.txt.log"), log(f"jobs/{job_id}/device.log")]
        ]
        self.fake.downloads[f"jobs/{job_id}/logs.zip"] = [kit_logs(subject)]
        self.fake.downloads[f"jobs/{job_id}/QDC_logs/mm__{subject}__steps.txt.log"] = [b"name=check backend=- prompt=-\n"]
        self.fake.downloads[f"jobs/{job_id}/device.log"] = [b"QDC device log\n"]

    def test_a_job_from_upload_to_logs(self):
        self.fake.targets = [target(12, "SM8750", state="DevicesBusy"), target(13, "SM8750"), target(14, "SM8650")]
        job = self.job(1, "SM8750")
        self.fake.states[1001] = ["Submitted", "Dispatched", "Setup", "Running", "Running", "Completed"]
        self.happy()
        self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 0, self.stderr)

        upload = self.fake.named("upload_file_v2")
        self.assertEqual(upload, [{"file_path": job["zip"], "artifact_type": models.ArtifactType.TESTSCRIPT, "exists": True}])
        self.assertEqual(
            self.fake.named("submit_job"),
            [
                {
                    "target_id": "13",
                    "job_name": f"mm SM8750 {STAMP}",
                    "external_job_id": job["key"],
                    "job_type": models.JobType.AUTOMATED,
                    "job_mode": models.JobMode.APPLICATION,
                    "timeout": 125,
                    "test_framework": models.TestFramework.APPIUM,
                    "entry_script": None,
                    "job_artifacts": ["artifact-1"],
                    "monkey_events": None,
                    "monkey_session_timeout": None,
                    "job_parameters": [models.JobSubmissionParameter.WIFIENABLED, models.JobSubmissionParameter.SCREENALWAYSON],
                }
            ],
        )
        self.assertEqual(len(self.fake.named("get_job_status")), 6)
        self.assertEqual(set(self.time.sleeps), {30})

        record = self.record(job)
        self.assertEqual(record["jobId"], 1001)
        self.assertEqual(record["state"], "Completed")
        self.assertEqual(record["logStatus"], "Completed")
        self.assertEqual(record["targetId"], "13")
        self.assertIsNotNone(record["startedAt"])
        self.assertEqual(record["subjects"], [SUBJECT])
        self.assertTrue(record["carrierLog"])
        self.assertEqual([e["kind"] for e in record["logs"]], ["zip", "raw", "raw"])
        out = os.path.join(job["outDir"], "out", SUBJECT)
        self.assertEqual(sorted(os.listdir(out)), ["device.txt", "kit.log", "run.txt", "steps.txt"])
        with open(os.path.join(out, "run.txt"), encoding="utf-8") as f:
            self.assertIn("status=done", f.read())
        self.assertTrue(os.path.isfile(os.path.join(job["outDir"], "carrier.log")))
        self.assertTrue(os.path.isfile(os.path.join(job["outDir"], "logs", "03-device.log")))
        summary = json.loads(self.stdout)
        self.assertEqual(summary["jobs"][0]["jobId"], 1001)
        self.assertEqual(self.fake.named("abort_job"), [])
        self.assert_no_key_anywhere()

    def test_states_the_sdk_cant_parse_still_end_a_job(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        self.fake.states[1001] = ["Undefined", "dict:Running", "dict:Aborted"]
        self.happy()
        self.fake.log_states[1001] = ["dict:Completed"]
        self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 0, self.stderr)
        self.assertEqual(self.record(job)["state"], "Aborted")
        self.assertEqual(self.record(job)["logStatus"], "Completed")
        self.assertEqual(len(self.fake.named("get_jobs_job_id")) >= 2, True)

    def test_a_canceled_job_still_brings_its_logs(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        self.fake.states[1001] = ["Submitted", "Setup", "Canceled"]
        self.happy()
        self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 0)
        self.assertEqual(self.record(job)["state"], "Canceled")
        self.assertEqual(self.record(job)["subjects"], [SUBJECT])

    def test_downloads_that_fail_are_tried_again_then_reported(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        self.fake.states[1001] = ["Running", "Completed"]
        self.happy()
        flaky = "jobs/1001/QDC_logs/mm__smoke-smollm2-135m-q4_0__steps.txt.log"
        self.fake.downloads[flaky] = [Exception("error during downloading: timeout"), b"name=check\n"]
        self.fake.downloads["jobs/1001/device.log"] = [b'<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>']
        self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 1)
        record = self.record(job)
        self.assertEqual([e["kind"] for e in record["logs"]], ["zip", "raw", "failed"])
        self.assertIn("error page", record["logs"][2]["error"])
        self.assertEqual(len([c for c in self.fake.named("download_job_log_files_v2") if c["file_path"] == flaky]), 2)
        self.assertEqual(len([c for c in self.fake.named("download_job_log_files_v2") if c["file_path"].endswith("device.log")]), 3)
        self.assertTrue(os.path.isfile(os.path.join(job["outDir"], "out", SUBJECT, "steps.txt")))
        self.assertFalse(any(name.endswith(".part") for name in os.listdir(os.path.join(job["outDir"], "logs"))))
        self.assertIn("didn't download", self.stderr)

    def test_no_log_list_and_no_logs_are_errors(self):
        self.fake.targets = [target(13, "SM8750"), target(14, "SM8650")]
        first, second = self.job(1, "SM8750"), self.job(2, "SM8650")
        self.fake.states[1001] = ["Completed"]
        self.fake.states[1002] = ["Completed"]
        self.fake.log_states[1001] = ["Completed"]
        self.fake.log_files[1001] = [Exception("[try_call] Call failed with status code 500")]
        self.fake.log_states[1002] = ["NoLogs"]
        self.assertEqual(self.main("run", "--manifest", self.manifest([first, second])), 1)
        self.assertEqual(self.record(first)["error"], "QDC didn't list the job's log files.")
        self.assertEqual(len(self.fake.named("get_job_log_files")), 3)
        self.assertEqual(self.record(second)["error"], "QDC kept no logs for this job.")
        self.assertEqual(self.record(second)["logStatus"], "NoLogs")

    def test_a_log_upload_that_never_settles_is_waited_for_then_read(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        self.fake.states[1001] = ["Completed"]
        self.happy()
        self.fake.log_states[1001] = ["InProgress"]
        self.assertEqual(self.main("run", "--manifest", self.manifest([job], logWaitMinutes=2)), 0)
        self.assertEqual(self.record(job)["logStatus"], "InProgress")
        self.assertEqual(len(self.fake.named("get_job_log_upload_status")), 5)

    def test_one_job_that_fails_to_submit_leaves_the_others_running(self):
        self.fake.targets = [target(13, "SM8750"), target(14, "SM8650")]
        jobs = [self.job(1, "SM8750"), self.job(2, "SM8650"), self.job(3, "SM8850")]
        self.fake.uploads = [None, "artifact-9"]
        self.fake.states[1001] = ["Running", "Completed"]
        self.happy(1001)
        self.assertEqual(self.main("run", "--manifest", self.manifest(jobs)), 1)
        self.assertEqual(self.record(jobs[0])["error"], "QDC didn't take the zip.")
        self.assertIsNone(self.record(jobs[0])["jobId"])
        self.assertEqual(self.record(jobs[1])["jobId"], 1001)
        self.assertEqual(self.record(jobs[1])["state"], "Completed")
        self.assertEqual(self.record(jobs[2])["error"], "QDC has no Android phone target named SM8850.")
        self.assertEqual(len(self.fake.named("submit_job")), 1)

    def test_a_submission_qdc_refuses_is_an_error_with_the_key_scrubbed(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        self.fake.submits = [Exception(f"[try_call] Call failed with status code 400 and message: bad {KEY}")]
        self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 1)
        self.assertIn("status code 400", self.record(job)["error"])
        self.assertIn("[QDC key]", self.record(job)["error"])
        self.assert_no_key_anywhere()

    def test_a_zip_that_holds_the_key_is_never_uploaded(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        with open(job["zip"], "wb") as f:
            f.write(zipped({"mm/plan/smoke.env": b"MM_OUT=/x\nQDC_API_KEY=" + KEY.encode() + b"\n"}))
        self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 1)
        self.assertEqual(self.fake.named("upload_file_v2"), [])
        self.assertIn("holds the QDC key", self.record(job)["error"])

    def test_an_interrupt_aborts_every_open_job(self):
        self.fake.targets = [target(13, "SM8750"), target(14, "SM8650")]
        jobs = [self.job(1, "SM8750"), self.job(2, "SM8650")]
        self.fake.states[1001] = ["Running"]
        self.fake.states[1002] = ["Submitted", "Completed"]

        def interrupt(job_id, polls):
            if polls == 5:
                raise KeyboardInterrupt()

        self.fake.on_status = interrupt
        self.assertEqual(self.main("run", "--manifest", self.manifest(jobs)), 130)
        self.assertEqual(self.fake.named("abort_job"), [{"job_id": 1001}])
        self.assertEqual(self.record(jobs[0])["aborted"], "the submitter was interrupted")
        self.assertIsNone(self.record(jobs[1])["aborted"], "a job that already ended isn't aborted")
        self.assertIn("Interrupted", self.stderr)
        self.assertEqual(json.loads(self.stdout)["jobs"][0]["aborted"], "the submitter was interrupted")

    def test_qdc_that_stops_answering_stops_the_batch_and_aborts(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        self.fake.states[1001] = ["Running", Exception("[try_call] Call to `get_jobs_job_id` failed due to exception: timed out")]
        self.assertEqual(self.main("run", "--manifest", self.manifest([job])), 1)
        self.assertEqual(self.fake.named("abort_job"), [{"job_id": 1001}])
        self.assertIn("didn't answer", self.stderr)
        self.assertIn(f"{submit.MAX_CALL_ERRORS} times in a row", self.record(job)["aborted"])

    def test_a_job_that_waits_too_long_for_a_phone_is_aborted(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750")
        self.fake.states[1001] = ["Submitted"]
        self.fake.abort_sets = "Canceled"
        self.happy()
        self.assertEqual(self.main("run", "--manifest", self.manifest([job], queueMinutes=2)), 1)
        record = self.record(job)
        self.assertEqual(record["aborted"], "no phone after 2 minutes in QDC's queue")
        self.assertEqual(record["state"], "Canceled")
        self.assertEqual(record["subjects"], [SUBJECT], "its logs still come down")

    def test_a_job_that_runs_past_its_timeout_is_aborted(self):
        self.fake.targets = [target(13, "SM8750")]
        job = self.job(1, "SM8750", timeout=10)
        self.fake.states[1001] = ["Setup", "Running"]
        self.assertEqual(self.main("run", "--manifest", self.manifest([job], pollSeconds=60)), 1)
        record = self.record(job)
        self.assertEqual(record["aborted"], f"still running {10 + submit.RUN_GRACE_MINUTES} minutes after it started")
        polls = len(self.fake.named("get_job_status"))
        self.assertGreaterEqual(polls, 10 + submit.RUN_GRACE_MINUTES + submit.ABORT_SETTLE_POLLS)
        self.assertEqual(self.fake.named("get_job_log_files"), [], "no logs are read from a job that never ended")


class FetchTests(Base):
    def test_fetch_waits_then_downloads_with_qdc_details(self):
        self.fake.states[1001] = ["Running", "Completed"]
        self.fake.details[1001] = models.JobType0(
            job_id=1001,
            job_name=f"mm SM8750 {STAMP}",
            external_job_id=f"{STAMP}-SM8750-1",
            state=models.JobState.COMPLETED,
            result=models.JobResult.SUCCESSFUL,
            log_upload_status=models.LogUploadStatus.COMPLETED,
            user_name="someone@example.com",
            org_id=4242,
            targets=[models.JobTargetLiteType0(chipset="SM8750", chipset_marketing_name="Snapdragon 8 Elite")],
        )
        self.fake.log_states[1001] = ["Completed"]
        self.fake.log_files[1001] = [[log("jobs/1001/logs.zip")]]
        self.fake.downloads["jobs/1001/logs.zip"] = [kit_logs()]
        out = os.path.join(self.tmp, "fetched")
        self.assertEqual(self.main("fetch", "--job", "1001", "--out", out, "--poll-seconds", "5"), 0, self.stderr)
        with open(os.path.join(out, "job.json"), encoding="utf-8") as f:
            text = f.read()
        record = json.loads(text)
        self.assertEqual(record["key"], f"{STAMP}-SM8750-1")
        self.assertEqual(record["chipset"], "SM8750")
        self.assertEqual(record["marketingName"], "Snapdragon 8 Elite")
        self.assertEqual(record["result"], "Successful")
        self.assertEqual(record["subjects"], [SUBJECT])
        self.assertNotIn("someone", text, "no user name in job.json")
        self.assertNotIn("4242", text, "no org id in job.json")
        self.assertEqual(self.time.sleeps, [5])
        self.assert_no_key_anywhere()

    def test_fetch_gives_up_on_a_job_still_running(self):
        self.fake.states[1001] = ["Running"]
        out = os.path.join(self.tmp, "fetched")
        self.assertEqual(self.main("fetch", "--job", "1001", "--out", out, "--wait-minutes", "1", "--poll-seconds", "30"), 1)
        self.assertIn("fetch it later", self.stderr)
        self.assertEqual(self.main("fetch", "--job", "12; rm", "--out", out), 2, "a job id is a number")

    def test_abort_one_job(self):
        self.assertEqual(self.main("abort", "--job", "1001"), 0)
        self.assertEqual(json.loads(self.stdout), {"jobId": 1001, "result": "Aborted"})


class UnpackTests(Base):
    def test_members_that_leave_the_folder_are_skipped(self):
        inner = zipped({"mm__s__run.txt.log": b"kit=1\n"})
        path = os.path.join(self.tmp, "logs.zip")
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("../evil.txt", b"x")
            zf.writestr("/abs.txt", b"x")
            zf.writestr("C:/win.txt", b"x")
            zf.writestr("ok/a.txt", b"a")
            zf.writestr("ok/inner.zip", inner)
        dest = os.path.join(self.tmp, "logs.zip.d")
        files, skipped = submit.unpack(path, dest)
        self.assertEqual((files, skipped), (3, 3))
        self.assertTrue(os.path.isfile(os.path.join(dest, "ok", "inner.zip.d", "mm__s__run.txt.log")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "evil.txt")))

    def test_flat_names_become_kit_folders(self):
        logs = os.path.join(self.tmp, "logs")
        os.makedirs(os.path.join(logs, "01-logs.zip.d", "QDC_logs"))
        for name in ["mm__a-1__run.txt.log", "mm__a-1__answer-cpu-sum.txt.log", "mm__b_2__kit.log.log", "mm__carrier.log", "other.log"]:
            with open(os.path.join(logs, "01-logs.zip.d", "QDC_logs", name), "w", encoding="utf-8") as f:
                f.write(name)
        with open(os.path.join(logs, "02-mm__a-1__steps.txt.log"), "w", encoding="utf-8") as f:
            f.write("steps")
        subjects, carrier = submit.unflatten(logs, self.tmp)
        self.assertEqual((subjects, carrier), (["a-1", "b_2"], True))
        self.assertEqual(sorted(os.listdir(os.path.join(self.tmp, "out", "a-1"))), ["answer-cpu-sum.txt", "run.txt", "steps.txt"])
        self.assertEqual(os.listdir(os.path.join(self.tmp, "out", "b_2")), ["kit.log"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
