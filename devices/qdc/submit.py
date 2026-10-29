"""Muse Muse device tests on Qualcomm Device Cloud: the only code that talks to QDC (docs/DEVICES.md, "On Qualcomm
Device Cloud" and "How to run > QDC").

scripts/devices/qdc.ts runs it in a uv venv outside the repo: Python 3.12, the SDK wheel from Qualcomm's zip (both
hash-checked against QDC_SDK in lib/devices/subjects.ts) and submit-requirements.txt installed with --require-hashes.

    python -I devices/qdc/submit.py check                          is there a usable key (no QDC call)
    python -I devices/qdc/submit.py targets                        QDC's targets, as JSON
    python -I devices/qdc/submit.py run --manifest <file>          upload, submit, wait for and download a batch
    python -I devices/qdc/submit.py fetch --job <id> --out <dir>   wait for one job, then download its logs
    python -I devices/qdc/submit.py abort --job <id>

The key is QDC_API_KEY from the environment, else the QDC_API_KEY= line of ~/.config/qdc/api.env, which is refused
when its group or others can use it. It goes only into the SDK's Authorization header. Every line this prints passes
through scrub(), which writes "[QDC key]" for the key and cuts the query off every URL (the SDK's presigned upload and
download URLs are credentials while they last). No file this writes holds the key, a URL with a query or account data:
job.json keeps the job's id, name, target, states and log files, never QDC's user name or org id.

A batch (run): every zip is uploaded with upload_file_v2 as a TESTSCRIPT and submitted with submit_job as an Appium
job on the chipset's Android phone target. Then each job's state is read every pollSeconds until it is Completed or
Canceled, its log upload until Completed, Failed or NoLogs, and every log file is downloaded with
download_job_log_files_v2. Some come back zipped and some raw; a zip is unpacked (no path may leave its folder). Files
named mm__<subject id>__<file>.log (the carrier's flat names) become <outDir>/out/<subject id>/<file> again, the kit's
own output folder, and mm__carrier.log becomes <outDir>/carrier.log; QDC's own logs stay in <outDir>/logs/.

A job still waiting for a phone after queueMinutes, or still running RUN_GRACE_MINUTES past its timeout, is aborted.
When this script fails or is interrupted (Ctrl-C or SIGTERM), it aborts every job it started that hasn't ended.

stdout carries one JSON document for the runner; progress goes to stderr. Exit codes: 0 every job ended and its logs
came down (a kit that failed on the phone is data, not an error here), 1 a job failed to submit, end or download,
2 bad input or no key, 130 interrupted.
"""

import argparse
import datetime
import json
import logging
import os
import re
import shutil
import signal
import sys
import time
import zipfile

KEY_FILE = os.path.join("~", ".config", "qdc", "api.env")
# The SDK's X-QCOM-AppName and X-QCOM-OnBehalfOf headers: the tool, not a person.
APP_NAME = "muse-muse-devices"
MANIFEST_VERSION = 1
JOB_RECORD_VERSION = 1
# QDC wants job names under 32 characters (the SDK's submit_job docstring).
JOB_NAME_MAX = 31
TIMEOUT_MAX_MINUTES = 150
SAFE_KEY = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
SAFE_CHIPSET = re.compile(r"^[A-Za-z0-9_-]{1,40}$")

# JobState values in the 0.2.3 wheel: Submitted, Dispatched, Setup, Running, Completed, Canceled, Undefined. QDC's
# job-result page also names Aborted, Successful, Unsuccessful and Error as end states, so those end a job too.
TERMINAL_STATES = ("Completed", "Canceled")
END_WORDS = ("cancelled", "aborted", "successful", "unsuccessful", "error", "failed")
STARTED_STATES = ("Setup", "Running")
# LogUploadStatus values: InProgress, Completed, Failed, NoLogs, Undefined.
LOGS_SETTLED = ("Completed", "Failed", "NoLogs")
# Calls that fail this many times in a row stop the batch (and abort its jobs).
MAX_CALL_ERRORS = 5
# The 0.2.3 SDK makes its httpx client with no timeout and sends its presigned uploads and downloads with requests and
# no timeout, so one stalled connection would hang this script for good. Seconds per API call, and for the presigned
# transfers the connect and read timeouts (between bytes, not for the whole file).
CALL_SECONDS = 120
TRANSFER_SECONDS = (30, 300)
DOWNLOAD_TRIES = 3
# A running job past its own timeout by this much is aborted; QDC should have ended it already.
RUN_GRACE_MINUTES = 20
# After an abort, polls to wait for Canceled before giving up on the job.
ABORT_SETTLE_POLLS = 10
# Unpacking limits for downloaded log zips: the kit's files are capped at 256 KiB, QDC's own logs can be large.
MEMBER_MAX_BYTES = 512 * 1024 * 1024
TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024
NESTED_ZIP_DEPTH = 2

LOG_NAME = re.compile(r"(?:^|[^A-Za-z0-9])mm__([a-z0-9][a-z0-9._-]*?)__([A-Za-z0-9][A-Za-z0-9._-]*)\.log$")
CARRIER_LOG = re.compile(r"(?:^|[^A-Za-z0-9])mm__carrier\.log$")
URL_QUERY = re.compile(r"((?:https?://|/)[^\s?'\"<>]*)\?[^\s'\"<>]*")

# Test hooks: tests replace these instead of waiting.
clock = time.monotonic
sleep = time.sleep

_secret = None


class Refusal(Exception):
    """Bad input or no usable key: nothing was sent to QDC. Exit code 2."""


class JobError(Exception):
    """One job failed (its upload, submission or logs); the others go on."""


class QdcDown(Exception):
    """QDC kept failing; the batch stops and aborts what it started."""


def scrub(value):
    """The text with the key replaced and every URL's query cut off."""
    text = str(value)
    if _secret:
        text = text.replace(_secret, "[QDC key]")
    return URL_QUERY.sub(r"\1?[query removed]", text)


def say(message):
    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[qdc {stamp}] {scrub(message)}", file=sys.stderr, flush=True)


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def raise_interrupt(signum, frame):
    raise KeyboardInterrupt()


# ---------------------------------------------------------------------------------------------------------------
# The key and the SDK


def read_key_file(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):].strip()
            name, sep, value = line.partition("=")
            if sep and name.strip() == "QDC_API_KEY":
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1].strip()
                return value
    return ""


def load_key(environ=None, path=None):
    """(key, "environment" or "file"). Refuses a missing key, a key file others can use, or a key with spaces."""
    global _secret
    environ = os.environ if environ is None else environ
    path = os.path.expanduser(KEY_FILE) if path is None else path
    key = environ.get("QDC_API_KEY", "").strip()
    source = "environment"
    if not key:
        source = "file"
        try:
            st = os.stat(path)
        except FileNotFoundError:
            raise Refusal(
                "No QDC key: set QDC_API_KEY, or save it in ~/.config/qdc/api.env "
                "(docs/DEVICES.md, What the owner does once)."
            ) from None
        if st.st_mode & 0o077:
            raise Refusal(f"{path} can be read by other users: run chmod 600 {path} first.")
        if hasattr(os, "getuid") and st.st_uid != os.getuid():
            raise Refusal(f"{path} belongs to another user.")
        key = read_key_file(path)
        if not key:
            raise Refusal(f"{path} has no QDC_API_KEY= line.")
    if len(key) > 4096 or not key.isprintable() or any(c.isspace() for c in key):
        where = "QDC_API_KEY" if source == "environment" else path
        raise Refusal(
            f"The QDC key in {where} has spaces or characters a key doesn't have: save the key from QDC's "
            "Users, Settings, API Keys there (docs/DEVICES.md, What the owner does once)."
        )
    _secret = key
    return key, source


def sdk():
    """The SDK's modules, imported only when a command talks to QDC."""
    try:
        from qualcomm_device_cloud_sdk import models
        from qualcomm_device_cloud_sdk.api import qdc_api
        from qualcomm_device_cloud_sdk.api.targets import targets_get
    except ImportError as e:
        raise Refusal(f"The QDC SDK isn't installed ({e}). Run this through scripts/devices/qdc.ts, which makes its venv.") from None
    bound_transfers()
    return qdc_api, targets_get, models


def bound_transfers():
    """Gives every requests call without a timeout TRANSFER_SECONDS (the SDK's presigned PUTs and GETs pass none)."""
    try:
        import requests.sessions
    except ImportError:
        return
    session = requests.sessions.Session
    if getattr(session.request, "_mm_bounded", False):
        return
    original = session.request

    def request(self, method, url, **kwargs):
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = TRANSFER_SECONDS
        return original(self, method, url, **kwargs)

    request._mm_bounded = True
    session.request = request


def client_for(key):
    qdc_api, _, _ = sdk()
    client = qdc_api.get_public_api_client_using_api_key(
        app_name_header=APP_NAME,
        on_behalf_of_header=APP_NAME,
        client_type_header="Python",
        api_key_header=key,
    )
    # httpx takes a number as the timeout for connect, read, write and pool; with_timeout keeps the headers.
    return client.with_timeout(CALL_SECONDS)


def field(obj, snake, camel=None):
    """An attribute of an SDK model, or a key of the plain dict the SDK returns when its parsing failed. Unset is None."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        value = obj.get(camel or snake, obj.get(snake))
    else:
        value = getattr(obj, snake, None)
    if value is None or type(value).__name__ == "Unset":
        return None
    return value


def text(value):
    """An SDK enum's value ("Completed"), or the value as text; "" for None and Unset."""
    if value is None or type(value).__name__ == "Unset":
        return ""
    return str(getattr(value, "value", value))


def raw_job_field(client, job_id, snake, camel):
    """One field of GET /jobs/{id}, for when the SDK's own parsing failed (a state its enums lack) and its helpers
    raise on the plain dict it hands back."""
    from qualcomm_device_cloud_sdk.api.jobs import get_jobs_job_id

    qdc_api, _, _ = sdk()
    response = qdc_api.try_call(
        lambda: get_jobs_job_id.sync_detailed(job_id=job_id, client=qdc_api.get_client_with_headers_added(client))
    )
    return text(field(getattr(response, "parsed", None), snake, camel))


def ended(state):
    """True for Completed or Canceled, and for the end words QDC's job-result page uses, which the 0.2.3 enums lack."""
    return state in TERMINAL_STATES or state.lower() in END_WORDS


class ScrubbedLog(logging.Handler):
    """Shows the SDK's and the HTTP libraries' warnings and errors through say(), so they are scrubbed too."""

    def emit(self, record):
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)
        say(f"{record.name}: {message}")


# ---------------------------------------------------------------------------------------------------------------
# Targets


def target_row(item):
    return {
        "targetId": text(field(item, "target_id", "targetId")),
        "chipset": text(field(item, "chipset_name", "chipsetName")),
        "marketingName": text(field(item, "chipset_marketing_name", "chipsetMarketingName")),
        "platformName": text(field(item, "chipset_platform_name", "chipsetPlatformName")),
        "category": text(field(item, "chipset_category", "chipsetCategory")),
        "os": text(field(item, "os")),
        "osVersion": text(field(item, "os_version", "osVersion")),
        "state": text(field(item, "state")),
    }


def list_targets(client):
    """Every target, through the same GET /targets the SDK's get_target_id reads, with more pages when there are any."""
    qdc_api, targets_get, _ = sdk()
    rows, seen = [], set()
    page = None
    for _ in range(20):
        params = {"page_size": 200} if page is None else {"page_size": 200, "page_number": page}
        response = qdc_api.try_call(
            lambda: targets_get.sync_detailed(client=qdc_api.get_client_with_headers_added(client), **params)
        )
        parsed = getattr(response, "parsed", None)
        added = 0
        for item in field(parsed, "data") or []:
            row = target_row(item)
            if row["targetId"] and row["targetId"] not in seen:
                seen.add(row["targetId"])
                rows.append(row)
                added += 1
        total = field(parsed, "total")
        if added == 0 or not isinstance(total, int) or len(rows) >= total:
            break
        page = 1 if page is None else page + 1
    return rows


def pick_target(targets, chipset):
    """The chipset's Android phone target, one that is available now first. None when QDC has none."""
    rank = {"availablenow": 0, "devicesbusy": 1}
    rows = [
        t
        for t in targets
        if t["chipset"] == chipset and t["os"].lower() == "android" and t["category"].lower() == "mobile"
    ]
    rows.sort(key=lambda t: rank.get(t["state"].lower(), 2))
    return rows[0] if rows else None


# ---------------------------------------------------------------------------------------------------------------
# Jobs


class Track:
    """One job of a batch, as far as this script has followed it."""

    def __init__(self, job):
        self.job = job
        self.out = job["outDir"]
        self.target = None
        self.job_id = None
        self.state = ""
        self.result = ""
        self.log_status = ""
        self.submitted_at = None
        self.started_at = None
        self.finished_at = None
        self.submitted_clock = None
        self.started_clock = None
        self.terminal = False
        self.aborted = None
        self.abort_polls = 0
        self.errors = 0
        self.error = None
        self.logs = []
        self.subjects = []
        self.carrier_log = False
        self.fetched = False

    def label(self):
        return f"{self.job.get('name') or 'job'} ({self.job_id if self.job_id is not None else 'not submitted'})"

    def record(self):
        target = self.target or {}
        return {
            "version": JOB_RECORD_VERSION,
            "key": self.job.get("key"),
            "chipset": self.job.get("chipset"),
            "name": self.job.get("name"),
            "targetId": target.get("targetId"),
            "marketingName": target.get("marketingName"),
            "jobId": self.job_id,
            "submittedAt": self.submitted_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "state": self.state or None,
            "result": self.result or None,
            "logStatus": self.log_status or None,
            "aborted": self.aborted,
            "error": self.error,
            "logs": self.logs,
            "subjects": self.subjects,
            "carrierLog": self.carrier_log,
        }

    def ok(self):
        return (
            self.job_id is not None
            and ended(self.state)
            and self.error is None
            and self.aborted is None
            and self.fetched
            and not any(entry["kind"] == "failed" for entry in self.logs)
        )


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def save(track):
    os.makedirs(track.out, exist_ok=True)
    write_json(os.path.join(track.out, "job.json"), track.record())


def read_manifest(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise Refusal(f"Can't read the manifest {path}: {e}") from None
    if not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION:
        raise Refusal(f"The manifest isn't version {MANIFEST_VERSION}.")
    jobs = data.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise Refusal("The manifest has no jobs.")
    keys = set()
    for job in jobs:
        if not isinstance(job, dict):
            raise Refusal("A manifest job isn't an object.")
        key, chipset, name = job.get("key"), job.get("chipset"), job.get("name")
        if not isinstance(key, str) or not SAFE_KEY.match(key) or key in keys:
            raise Refusal(f"A job's key is missing, unsafe or repeated: {key!r}")
        keys.add(key)
        if not isinstance(chipset, str) or not SAFE_CHIPSET.match(chipset):
            raise Refusal(f"{key}: bad chipset {chipset!r}")
        if not isinstance(name, str) or not name or len(name) > JOB_NAME_MAX:
            raise Refusal(f"{key}: the job name must be 1 to {JOB_NAME_MAX} characters.")
        timeout = job.get("timeoutMinutes")
        if not isinstance(timeout, int) or not 1 <= timeout <= TIMEOUT_MAX_MINUTES:
            raise Refusal(f"{key}: timeoutMinutes must be a whole number from 1 to {TIMEOUT_MAX_MINUTES}.")
        if not isinstance(job.get("zip"), str) or not os.path.isfile(job["zip"]):
            raise Refusal(f"{key}: the zip {job.get('zip')!r} isn't there.")
        if not isinstance(job.get("outDir"), str) or not os.path.isabs(job["outDir"]):
            raise Refusal(f"{key}: outDir must be an absolute path.")
    settings = {"pollSeconds": 30, "queueMinutes": 360, "logWaitMinutes": 30}
    for name, default in settings.items():
        value = data.get(name, default)
        if not isinstance(value, int) or value < 0:
            raise Refusal(f"The manifest's {name} must be a whole number.")
        settings[name] = value
    return {"jobs": jobs, **settings}


def holds_key(path):
    """True when the zip, or any file in it, holds the key: then it is never uploaded."""
    if not _secret:
        return False
    needle = _secret.encode("utf-8")
    with open(path, "rb") as f:
        if needle in f.read():
            return True
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if not info.is_dir():
                with zf.open(info) as member:
                    if needle in member.read():
                        return True
    return False


def upload_and_submit(client, track):
    qdc_api, _, models = sdk()
    job = track.job
    if holds_key(job["zip"]):
        raise JobError("the zip holds the QDC key, so it wasn't uploaded")
    size = os.path.getsize(job["zip"])
    say(f"{job['name']}: uploading its zip ({size / 1e6:.0f} MB)")
    artifact = qdc_api.upload_file_v2(client, job["zip"], models.ArtifactType.TESTSCRIPT)
    if not artifact:
        raise JobError("QDC didn't take the zip.")
    job_id = qdc_api.submit_job(
        public_api_client=client,
        target_id=track.target["targetId"],
        job_name=job["name"],
        external_job_id=job["key"],
        job_type=models.JobType.AUTOMATED,
        job_mode=models.JobMode.APPLICATION,
        timeout=job["timeoutMinutes"],
        test_framework=models.TestFramework.APPIUM,
        entry_script=None,
        job_artifacts=[artifact],
        monkey_events=None,
        monkey_session_timeout=None,
        job_parameters=[models.JobSubmissionParameter.WIFIENABLED, models.JobSubmissionParameter.SCREENALWAYSON],
    )
    if job_id is None:
        raise JobError("QDC didn't take the job.")
    return job_id


def abort(client, track, reason):
    qdc_api, _, _ = sdk()
    say(f"{track.label()}: aborting it, {reason}")
    track.aborted = reason
    try:
        qdc_api.abort_job(client, track.job_id)
    except Exception as e:
        say(f"{track.label()}: the abort failed: {e}")
    save(track)


def abort_open(client, tracks, reason):
    """Aborts every started job that hasn't ended. A second Ctrl-C can't cut this short."""
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        for track in tracks:
            if track.job_id is not None and not track.terminal:
                abort(client, track, reason)
                track.terminal = True
    finally:
        signal.signal(signal.SIGINT, previous)


def poll_state(client, track):
    """The job's state now, or None when QDC didn't answer (MAX_CALL_ERRORS in a row raises QdcDown)."""
    qdc_api, _, _ = sdk()
    try:
        try:
            state = text(qdc_api.get_job_status(client, track.job_id))
        except (AttributeError, TypeError):
            state = raw_job_field(client, track.job_id, "state", "state")
    except Exception as e:
        track.errors += 1
        say(f"{track.label()}: QDC didn't answer ({track.errors} of {MAX_CALL_ERRORS}): {e}")
        if track.errors >= MAX_CALL_ERRORS:
            raise QdcDown(f"QDC didn't answer about job {track.job_id} {MAX_CALL_ERRORS} times in a row.") from None
        return None
    track.errors = 0
    return state


def follow(client, tracks, poll_seconds, queue_minutes):
    """Reads every open job's state until all have ended (or were aborted, or given up on)."""
    while True:
        open_tracks = [t for t in tracks if not t.terminal]
        if not open_tracks:
            return
        for track in open_tracks:
            state = poll_state(client, track)
            if state is None:
                continue
            now = clock()
            if state != track.state:
                say(f"{track.label()} on {track.job.get('chipset') or 'QDC'}: {state or 'no state yet'}")
                track.state = state
                save(track)
            if state in STARTED_STATES and track.started_clock is None:
                track.started_clock = now
                track.started_at = iso_now()
            if ended(state):
                track.terminal = True
                track.finished_at = iso_now()
                save(track)
                continue
            if track.aborted:
                track.abort_polls += 1
                if track.abort_polls >= ABORT_SETTLE_POLLS:
                    say(f"{track.label()}: still {state} after the abort; not waiting any longer.")
                    track.terminal = True
                    track.finished_at = iso_now()
                    save(track)
                continue
            if track.started_clock is None and now - track.submitted_clock > queue_minutes * 60:
                abort(client, track, f"no phone after {queue_minutes} minutes in QDC's queue")
            elif track.started_clock is not None:
                limit = track.job["timeoutMinutes"] + RUN_GRACE_MINUTES
                if now - track.started_clock > limit * 60:
                    abort(client, track, f"still running {limit} minutes after it started")
        if any(not t.terminal for t in tracks):
            sleep(poll_seconds)


def job_details(client, job_id):
    """The job's name, external id, states and first target, from GET /jobs/{id}. Best effort: {} on any failure."""
    try:
        from qualcomm_device_cloud_sdk.api.jobs import get_jobs_job_id

        qdc_api, _, _ = sdk()
        response = qdc_api.try_call(
            lambda: get_jobs_job_id.sync_detailed(job_id=job_id, client=qdc_api.get_client_with_headers_added(client))
        )
        job = getattr(response, "parsed", None)
        targets = field(job, "targets") or []
        first = targets[0] if targets else None
        created = field(job, "created_on", "createdOn")
        return {
            "name": text(field(job, "job_name", "jobName")),
            "externalId": text(field(job, "external_job_id", "externalJobId")),
            "state": text(field(job, "state")),
            "result": text(field(job, "result")),
            "logStatus": text(field(job, "log_upload_status", "logUploadStatus")),
            "createdOn": created.isoformat() if hasattr(created, "isoformat") else text(created),
            "chipset": text(field(first, "chipset")),
            "marketingName": text(field(first, "chipset_marketing_name", "chipsetMarketingName")),
        }
    except Exception as e:
        say(f"job {job_id}: no details from QDC ({e})")
        return {}


# ---------------------------------------------------------------------------------------------------------------
# Logs


def safe_name(remote):
    base = re.split(r"[/\\]", remote)[-1]
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base).strip("._") or "log"
    return base[-120:]


def storage_error(path):
    """True when a download holds a storage service's error page (download_job_log_files_v2 doesn't check the status)."""
    try:
        with open(path, "rb") as f:
            head = f.read(1024)
    except OSError:
        return True
    return head.lstrip().startswith(b"<?xml") and b"<Error>" in head


def download(client, remote, local, entry, wait_seconds):
    qdc_api, _, _ = sdk()
    part = local + ".part"
    for attempt in range(1, DOWNLOAD_TRIES + 1):
        try:
            qdc_api.download_job_log_files_v2(client, remote, part)
            if storage_error(part):
                raise JobError("the storage answered with an error page, not the file")
            os.replace(part, local)
            entry["bytes"] = os.path.getsize(local)
            entry["error"] = None
            return True
        except Exception as e:
            entry["error"] = scrub(e)
            if os.path.exists(part):
                os.remove(part)
            say(f"{entry['name']}: download failed (try {attempt} of {DOWNLOAD_TRIES}): {e}")
            if attempt < DOWNLOAD_TRIES:
                sleep(wait_seconds)
    return False


def unpack(path, dest, depth=0):
    """Unpacks a log zip into dest. Members that would leave dest, or are too large, are skipped. Returns (files, skipped)."""
    files = skipped = total = 0
    os.makedirs(dest, exist_ok=True)
    root = os.path.realpath(dest)
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace("\\", "/")
            parts = [p for p in name.split("/") if p not in ("", ".")]
            bad = not parts or name.startswith("/") or ".." in parts or ":" in parts[0]
            too_big = info.file_size > MEMBER_MAX_BYTES or total + info.file_size > TOTAL_MAX_BYTES
            target = os.path.join(dest, *parts) if parts else dest
            if bad or too_big or not os.path.realpath(target).startswith(root + os.sep):
                skipped += 1
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            total += info.file_size
            files += 1
            if depth + 1 < NESTED_ZIP_DEPTH and zipfile.is_zipfile(target):
                more, more_skipped = unpack(target, target + ".d", depth + 1)
                files += more
                skipped += more_skipped
    return files, skipped


def unflatten(logs_dir, out_dir):
    """Puts the carrier's flat files back: mm__<id>__<file>.log is out/<id>/<file>, mm__carrier.log is carrier.log."""
    out_root = os.path.join(out_dir, "out")
    if os.path.isdir(out_root):
        shutil.rmtree(out_root)
    subjects, carrier = set(), False
    for root, dirs, files in os.walk(logs_dir):
        dirs.sort()
        for name in sorted(files):
            src = os.path.join(root, name)
            m = LOG_NAME.search(name)
            if m:
                folder = os.path.join(out_root, m.group(1))
                os.makedirs(folder, exist_ok=True)
                shutil.copyfile(src, os.path.join(folder, m.group(2)))
                subjects.add(m.group(1))
            elif CARRIER_LOG.search(name):
                shutil.copyfile(src, os.path.join(out_dir, "carrier.log"))
                carrier = True
    return sorted(subjects), carrier


def fetch_logs(client, track, poll_seconds, log_wait_minutes):
    """Waits for QDC's log upload, downloads every file, unpacks the zips and rebuilds out/<id>/."""
    qdc_api, _, _ = sdk()
    deadline = clock() + log_wait_minutes * 60
    status, errors, said = "", 0, None
    while True:
        try:
            try:
                status = text(qdc_api.get_job_log_upload_status(client, track.job_id))
            except (AttributeError, TypeError):
                status = raw_job_field(client, track.job_id, "log_upload_status", "logUploadStatus")
            errors = 0
        except Exception as e:
            errors += 1
            say(f"{track.label()}: no log status ({errors} of {MAX_CALL_ERRORS}): {e}")
            if errors >= MAX_CALL_ERRORS:
                break
        if status in LOGS_SETTLED or clock() >= deadline:
            break
        if status != said:
            say(f"{track.label()}: QDC is uploading its logs ({status or 'not started'})")
            said = status
        sleep(poll_seconds)
    track.log_status = status or "Undefined"
    if status == "NoLogs":
        track.error = "QDC kept no logs for this job."
        return
    files = None
    for attempt in range(1, DOWNLOAD_TRIES + 1):
        try:
            files = qdc_api.get_job_log_files(client, track.job_id)
            break
        except Exception as e:
            say(f"{track.label()}: no list of log files (try {attempt} of {DOWNLOAD_TRIES}): {e}")
            if attempt < DOWNLOAD_TRIES:
                sleep(poll_seconds)
    if files is None:
        track.error = "QDC didn't list the job's log files."
        return
    logs_dir = os.path.join(track.out, "logs")
    if os.path.isdir(logs_dir):
        shutil.rmtree(logs_dir)
    os.makedirs(logs_dir)
    track.logs = []
    for i, item in enumerate(files):
        remote = text(field(item, "filename"))
        if not remote:
            continue
        local = os.path.join(logs_dir, f"{i + 1:02d}-{safe_name(remote)}")
        entry = {"name": os.path.basename(local), "bytes": None, "kind": "failed", "error": None}
        if download(client, remote, local, entry, poll_seconds):
            if zipfile.is_zipfile(local):
                try:
                    count, skipped = unpack(local, local + ".d")
                    entry.update(kind="zip", files=count, skipped=skipped)
                except (zipfile.BadZipFile, OSError) as e:
                    entry.update(kind="raw", error=f"unpacking failed: {scrub(e)}")
            else:
                entry["kind"] = "raw"
        track.logs.append(entry)
    track.subjects, track.carrier_log = unflatten(logs_dir, track.out)
    track.fetched = True
    failed = [e["name"] for e in track.logs if e["kind"] == "failed"]
    if failed:
        say(f"{track.label()}: {len(failed)} log file(s) didn't download: {', '.join(failed)}")
    say(f"{track.label()}: logs in {logs_dir}; kit output for {', '.join(track.subjects) or 'no subject'}")


# ---------------------------------------------------------------------------------------------------------------
# Commands


def summary(tracks):
    print(json.dumps({"version": JOB_RECORD_VERSION, "jobs": [t.record() for t in tracks]}, indent=2))


def cmd_check(args):
    _, source = load_key()
    print(json.dumps({"ok": True, "source": source}))
    return 0


def cmd_targets(args):
    key, _ = load_key()
    print(json.dumps(list_targets(client_for(key)), indent=2))
    return 0


def cmd_abort(args):
    key, _ = load_key()
    qdc_api, _, _ = sdk()
    result = qdc_api.abort_job(client_for(key), args.job)
    print(json.dumps({"jobId": args.job, "result": text(result) or None}))
    return 0


def cmd_run(args):
    manifest = read_manifest(args.manifest)
    key, _ = load_key()
    client = client_for(key)
    tracks = [Track(job) for job in manifest["jobs"]]
    previous_term = signal.signal(signal.SIGTERM, raise_interrupt)
    try:
        targets = list_targets(client)
        for track in tracks:
            chipset = track.job["chipset"]
            track.target = pick_target(targets, chipset)
            if not track.target:
                track.error = f"QDC has no Android phone target named {chipset}."
                track.terminal = True
                say(f"{track.job['name']}: {track.error}")
                save(track)
                continue
            try:
                track.job_id = upload_and_submit(client, track)
            except Exception as e:
                track.error = scrub(e)
                track.terminal = True
                say(f"{track.job['name']}: not submitted: {e}")
                save(track)
                continue
            track.state = "Submitted"
            track.submitted_at = iso_now()
            track.submitted_clock = clock()
            save(track)
            say(f"{track.label()}: submitted to {chipset} (target {track.target['targetId']}, {track.job['timeoutMinutes']} min timeout)")
        started = [t for t in tracks if t.job_id is not None]
        follow(client, started, manifest["pollSeconds"], manifest["queueMinutes"])
        for track in started:
            details = job_details(client, track.job_id)
            track.result = details.get("result", "")
            if track.aborted and not ended(track.state):
                save(track)
                continue
            fetch_logs(client, track, manifest["pollSeconds"], manifest["logWaitMinutes"])
            save(track)
    except KeyboardInterrupt:
        say("Interrupted: aborting every job this batch started that hasn't ended.")
        abort_open(client, tracks, "the submitter was interrupted")
        for track in tracks:
            save(track)
        summary(tracks)
        return 130
    except Exception as e:
        say(f"Stopped: {e}")
        abort_open(client, tracks, f"the submitter stopped: {scrub(e)}")
        for track in tracks:
            if track.error is None and not track.ok():
                track.error = f"The submitter stopped: {scrub(e)}"
            save(track)
        summary(tracks)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_term)
    summary(tracks)
    return 0 if all(t.ok() for t in tracks) else 1


def cmd_fetch(args):
    out = os.path.abspath(args.out)
    key, _ = load_key()
    client = client_for(key)
    track = Track({"key": None, "chipset": None, "name": None, "outDir": out, "timeoutMinutes": TIMEOUT_MAX_MINUTES})
    track.job_id = args.job
    track.submitted_clock = clock()
    give_up = clock() + args.wait_minutes * 60
    while True:
        state = poll_state(client, track)
        if state is not None:
            track.state = state
            if ended(state):
                break
        if clock() >= give_up:
            say(f"Job {args.job} is still {track.state or 'unknown'} after {args.wait_minutes} minutes; fetch it later.")
            save(track)
            summary([track])
            return 1
        say(f"Job {args.job}: {track.state or 'no state yet'}; waiting")
        sleep(args.poll_seconds)
    details = job_details(client, args.job)
    track.job.update(key=details.get("externalId") or None, chipset=details.get("chipset") or None, name=details.get("name") or None)
    track.target = {"targetId": None, "marketingName": details.get("marketingName") or None}
    track.result = details.get("result", "")
    track.submitted_at = details.get("createdOn") or None
    fetch_logs(client, track, args.poll_seconds, args.log_wait_minutes)
    save(track)
    summary([track])
    return 0 if track.ok() else 1


def job_id_arg(value):
    if not re.match(r"^[0-9]{1,20}$", value):
        raise argparse.ArgumentTypeError("a QDC job id is a number")
    return int(value)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="submit.py", description="Muse Muse device tests on Qualcomm Device Cloud.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="is there a usable key (no QDC call)")
    sub.add_parser("targets", help="QDC's targets, as JSON")
    run = sub.add_parser("run", help="upload, submit, wait for and download a batch")
    run.add_argument("--manifest", required=True)
    fetch = sub.add_parser("fetch", help="wait for one job, then download its logs")
    fetch.add_argument("--job", required=True, type=job_id_arg)
    fetch.add_argument("--out", required=True)
    fetch.add_argument("--wait-minutes", type=int, default=240)
    fetch.add_argument("--poll-seconds", type=int, default=30)
    fetch.add_argument("--log-wait-minutes", type=int, default=30)
    abort_cmd = sub.add_parser("abort", help="abort one job")
    abort_cmd.add_argument("--job", required=True, type=job_id_arg)
    args = parser.parse_args(argv)
    root = logging.getLogger()
    if not any(isinstance(h, ScrubbedLog) for h in root.handlers):
        root.addHandler(ScrubbedLog(level=logging.WARNING))
    commands = {"check": cmd_check, "targets": cmd_targets, "run": cmd_run, "fetch": cmd_fetch, "abort": cmd_abort}
    try:
        return commands[args.command](args)
    except Refusal as e:
        say(str(e))
        return 2
    except KeyboardInterrupt:
        say("Interrupted.")
        return 130
    except Exception as e:
        say(f"Failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
