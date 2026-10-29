"""The carrier Device Farm's upload check needs for an APPIUM_WEB_PYTHON test package.

The check unzips the package, installs requirements.txt from wheelhouse/ and runs `pytest --collect-only tests`. The
test spec (devices/devicefarm/testspec.yml) never runs pytest: it runs mm/host.sh, which does the work on the phone.
"""


def test_carrier():
    """Nothing to test here; the device tests run from mm/host.sh."""
