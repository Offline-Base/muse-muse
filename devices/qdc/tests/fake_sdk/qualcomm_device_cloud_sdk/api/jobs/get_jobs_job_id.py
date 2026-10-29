"""GET /jobs/{id}, answered from qdc_api.fake: its details for the job, or the plain dict a state the SDK can't parse
leaves (see qdc_api's "dict:" states)."""

from ...types import Response
from .. import qdc_api


def sync_detailed(job_id, *, client):
    fake = qdc_api.fake
    fake.call("get_jobs_job_id", job_id=job_id)
    if job_id in fake.raw:
        return Response(200, dict(fake.raw[job_id]))
    if job_id in fake.details:
        return Response(200, fake.details[job_id])
    return Response(404, None)
