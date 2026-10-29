"""The 0.2.3 wheel's qdc_api functions that submit.py calls, with the same signatures (positional names included), answering
from `fake`, a FakeQdc that each test sets up with reset(). Nothing here opens a socket.

Scripted answers are lists, used in order, with the last one repeated. An Exception in a list is raised. For job
states, "dict:<state>" stands for a state the real SDK can't parse: its helper then fails on the plain dict it got
(AttributeError) and GET /jobs/{id} (api/jobs/get_jobs_job_id) answers with that dict.
"""

import os

from ..types import Response


class FakeClient:
    def __init__(self, headers, timeout=None):
        self.headers = headers
        self.timeout = timeout

    def with_timeout(self, timeout):
        """Like the wheel's attrs evolve: a new client with the same headers."""
        fake.timeouts.append(timeout)
        return FakeClient(self.headers, timeout)


class FakeQdc:
    def __init__(self):
        self.calls = []
        self.targets = []
        self.total = None
        self.page_size = None
        self.uploads = []
        self.submits = []
        self.states = {}
        self.log_states = {}
        self.log_files = {}
        self.downloads = {}
        self.details = {}
        self.raw = {}
        self.on_status = None
        self.status_polls = 0
        self.next_artifact = 0
        self.next_job = 1000
        self.timeouts = []
        # The state a job takes once abort_job is called for it (None leaves its scripted states alone).
        self.abort_sets = None

    def call(self, name, **args):
        self.calls.append((name, args))

    def named(self, name):
        return [args for n, args in self.calls if n == name]


fake = FakeQdc()


def reset():
    global fake
    fake = FakeQdc()
    return fake


def take(queue):
    if not queue:
        return None
    item = queue.pop(0) if len(queue) > 1 else queue[0]
    if isinstance(item, BaseException):
        raise item
    return item


def get_public_api_client_using_api_key(app_name_header, on_behalf_of_header, client_type_header, api_key_header):
    fake.call(
        "client",
        app_name_header=app_name_header,
        on_behalf_of_header=on_behalf_of_header,
        client_type_header=client_type_header,
        api_key_header=api_key_header,
    )
    return FakeClient({"Authorization": api_key_header, "X-QCOM-TokenType": "apikey"})


def get_client_with_headers_added(client):
    return client


def try_call(func):
    """Like the wheel's: anything but a 200 raises."""
    try:
        result = func()
    except Exception as e:
        raise Exception(f"[try_call] Call failed due to exception: {e}") from e
    if getattr(result, "status_code", None) == 200:
        return result
    raise Exception(f"[try_call] Call failed with status code {getattr(result, 'status_code', 'unknown')}")


def upload_file_v2(public_api_client, file_path, artifact_type):
    fake.call("upload_file_v2", file_path=file_path, artifact_type=artifact_type, exists=os.path.isfile(file_path))
    if fake.uploads:
        return take(fake.uploads)
    fake.next_artifact += 1
    return f"artifact-{fake.next_artifact}"


def submit_job(
    public_api_client,
    target_id,
    job_name,
    external_job_id,
    job_type,
    job_mode,
    timeout,
    test_framework,
    entry_script,
    job_artifacts,
    monkey_events,
    monkey_session_timeout,
    job_parameters=None,
):
    fake.call(
        "submit_job",
        target_id=target_id,
        job_name=job_name,
        external_job_id=external_job_id,
        job_type=job_type,
        job_mode=job_mode,
        timeout=timeout,
        test_framework=test_framework,
        entry_script=entry_script,
        job_artifacts=job_artifacts,
        monkey_events=monkey_events,
        monkey_session_timeout=monkey_session_timeout,
        job_parameters=job_parameters,
    )
    if fake.submits:
        return take(fake.submits)
    fake.next_job += 1
    return fake.next_job


def _state(table, job_id, field):
    item = take(table.get(job_id, []))
    if isinstance(item, str) and item.startswith("dict:"):
        fake.raw.setdefault(job_id, {})[field] = item[len("dict:"):]
        raise AttributeError(f"'dict' object has no attribute '{field}'")
    return item


def get_job_status(public_api_client, job_id):
    fake.status_polls += 1
    fake.call("get_job_status", job_id=job_id)
    if fake.on_status:
        fake.on_status(job_id, fake.status_polls)
    return _state(fake.states, job_id, "state")


def get_job_log_upload_status(public_api_client, job_id):
    fake.call("get_job_log_upload_status", job_id=job_id)
    return _state(fake.log_states, job_id, "logUploadStatus")


def get_job_log_files(public_api_client, job_id):
    fake.call("get_job_log_files", job_id=job_id)
    return take(fake.log_files.get(job_id, [[]]))


def download_job_log_files_v2(public_api_client, file_path, local_zip_file):
    fake.call("download_job_log_files_v2", file_path=file_path, local_zip_file=local_zip_file)
    data = take(fake.downloads.get(file_path, [Exception(f"error during downloading: {file_path}: 404")]))
    with open(local_zip_file, "wb") as f:
        f.write(data)


def abort_job(public_api_client, job_id):
    fake.call("abort_job", job_id=job_id)
    if fake.abort_sets is not None:
        fake.states[job_id] = [fake.abort_sets]
    return "Aborted"


def get_target_id(public_api_client, target_name):
    fake.call("get_target_id", target_name=target_name)
    for t in fake.targets:
        if getattr(t, "chipset_name", None) == target_name:
            return t.target_id
    return None


def _response(parsed):
    return Response(200, parsed)
