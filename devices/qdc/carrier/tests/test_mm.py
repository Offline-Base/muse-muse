"""The one test QDC runs (docs/DEVICES.md, "On Qualcomm Device Cloud"): the carrier, mm_carrier.py. It fails only when
the kit couldn't run. A model that fails its check, or a backend that crashes or is killed, is data in the kit's
output, which the runner reads from the job's logs, not a failed test.
"""

import mm_carrier


def test_mm():
    assert mm_carrier.main() == 0, "The kit couldn't run on this phone; see mm__carrier.log in the job's logs."
