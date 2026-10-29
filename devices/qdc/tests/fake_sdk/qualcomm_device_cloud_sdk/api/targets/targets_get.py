"""GET /targets, answered from qdc_api.fake.targets (in pages when fake.page_size is set)."""

from ...models import PaginatedTargetsType0
from ...types import UNSET, Response
from .. import qdc_api


def sync_detailed(*, client, page_number=UNSET, page_size=UNSET):
    fake = qdc_api.fake
    fake.call("targets_get", page_number=page_number, page_size=page_size)
    items = list(fake.targets)
    size = fake.page_size or len(items) or 1
    page = 0 if page_number is UNSET else page_number
    data = items[page * size:(page + 1) * size]
    total = len(items) if fake.total is None else fake.total
    return Response(200, PaginatedTargetsType0(page_number=page, page_size=size, total=total, data=data))
