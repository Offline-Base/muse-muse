"""Keeps an Appium session open for the job's length, as llama.cpp's own QDC jobs do (docs/DEVICES.md). The kit doesn't
use it: QDC starts an Appium server for every Appium job, and whether a job needs a session at all is an open question.
So a session that fails to start is reported and the job goes on. It asks for what llama.cpp's jobs ask for [R]: the
UiAutomator2 driver on Android, the device QDC names in ANDROID_DEVICE_VERSION, and a long idle timeout.
"""

import os

import pytest

APPIUM_URL = "http://127.0.0.1:4723/wd/hub"
# Seconds Appium keeps an idle session: longer than any job (QDC_MAX_TIMEOUT_MINUTES in lib/devices/qdc.ts).
IDLE_SECONDS = 150 * 60


def open_session():
    """An Appium session, or None with the reason printed."""
    try:
        from appium import webdriver
        from appium.options.common import AppiumOptions

        options = AppiumOptions()
        options.set_capability("platformName", "Android")
        options.set_capability("automationName", "UiAutomator2")
        device = os.environ.get("ANDROID_DEVICE_VERSION", "").strip()
        if device:
            options.set_capability("deviceName", device)
        options.set_capability("newCommandTimeout", IDLE_SECONDS)
        return webdriver.Remote(command_executor=APPIUM_URL, options=options)
    except Exception as e:
        print(f"[mm] No Appium session ({type(e).__name__}); the kit doesn't need one.", flush=True)
        return None


@pytest.fixture(scope="session", autouse=True)
def appium_session():
    driver = open_session()
    yield driver
    if driver is not None:
        try:
            driver.quit()
        except Exception:
            pass
