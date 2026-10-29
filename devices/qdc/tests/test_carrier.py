"""The QDC carrier (devices/qdc/carrier/tests/mm_carrier.py) against a fake adb (tests/fakes/fake_adb.py, where a folder
stands in for the phone) and a stand-in kit: the adb command sequence (state, push, chmod, start, polls, collection,
host.txt, cleanup), the flat QDC_logs names, a plan that is missing or broken, a push that fails, a phone that is
offline, polls that drop, a kit that refuses its inputs and one that runs past its limits. Also conftest.py's Appium
session, with a fake Appium client.

    /opt/homebrew/bin/python3.12 -I devices/qdc/tests/test_carrier.py
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CARRIER_TESTS = os.path.join(os.path.dirname(HERE), "carrier", "tests")
sys.path[:0] = [os.path.join(HERE, "fakes", "py"), CARRIER_TESTS]

import mm_carrier  # noqa: E402

SMOKE = "smoke-smollm2-135m-q4_0"
BASE = "bartowski-iq2_xxs"

# Writes some of the kit's files under $FAKE_ROOT$MM_OUT (the fake phone) and prints progress, as FAKE_KIT asks.
FAKE_KIT = """#!/bin/sh
out="$FAKE_ROOT$MM_OUT"
case "$FAKE_KIT" in
  bad) echo "run.sh: MM_MODEL is not set" >&2; exit 2 ;;
esac
mkdir -p "$out"
printf 'kit=1\\nsubject=%s\\n' "$MM_SUBJECT" > "$out/run.txt"
printf 'platform=android\\nram_kb=11765432\\n' > "$out/device.txt"
echo "22:15:00 kit 1: $MM_SUBJECT"
case "$FAKE_KIT" in
  slow) exec sleep 60 ;;
esac
printf 'name=check backend=- prompt=- start=1 seconds=1 limit=600 rc=0 end=ok why=-\\n' > "$out/steps.txt"
printf 'finished=2\\nseconds=1\\nstatus=done\\n' >> "$out/run.txt"
echo "22:15:01 finished: status=done"
"""


def env_lines(subject, limits=None):
    root = "/data/local/tmp/mm"
    lines = {
        "MM_OUT": f"{root}/out/{subject}",
        "MM_SUBJECT": subject,
        "MM_MODEL": f"{root}/model/{subject}.gguf",
        "MM_MODEL_BYTES": "91893088",
        "MM_MODEL_SHA256": "bcc3af2849ad6095af57e9b5cd43775256efdc66e306acb529172f92d0c04b03",
        "MM_MODEL_URL": "https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/09816acd/x.gguf",
        "MM_SYSTEM_FILE": f"{root}/plan/{subject}.system",
        "MM_BACKENDS": "cpu,gpu,npu",
        **(limits or {}),
    }
    return "".join(f"{k}={v}\n" for k, v in lines.items())


class FakeTime:
    def __init__(self):
        self.now = 0.0

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class CarrierTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mm-qdc-carrier-")
        self.phone = os.path.join(self.tmp, "phone")
        os.makedirs(os.path.join(self.phone, "data", "local", "tmp"))
        self.log = os.path.join(self.tmp, "adb.log")
        self.state = os.path.join(self.tmp, "adb-state.json")
        self.saved = dict(os.environ)
        os.environ.update(FAKE_ADB_ROOT=self.phone, FAKE_ADB_LOG=self.log, FAKE_ADB_STATE=self.state, FAKE_KIT="")
        self.adb = os.path.join(self.tmp, "adb")
        with open(self.adb, "w", encoding="utf-8") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" -I "{os.path.join(HERE, "fakes", "fake_adb.py")}" "$@"\n')
        os.chmod(self.adb, 0o755)
        self.mm = os.path.join(self.tmp, "zip", "mm")
        self.time = FakeTime()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, rel, text, mode=0o644):
        path = os.path.join(self.mm, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(path, mode)

    def make_mm(self, subjects=(SMOKE,), limits=None, plan=True):
        self.write("kit/run.sh", FAKE_KIT)
        self.write("kit/prompts/sum.txt", "What is 17 + 25? Answer with the number only.")
        for tool in mm_carrier.TOOLS[:4]:
            self.write(tool, "#!/bin/sh\nexit 0\n")
        self.write("llama-snapdragon/lib/libllama.so", "not really a library")
        if plan:
            self.write("plan/run.env", f"MM_PLAN_VERSION=1\nMM_RUN=20261028T221500Z-SM8750-1\nMM_SUBJECTS={','.join(subjects)}\n")
            for sid in subjects:
                self.write(f"plan/{sid}.env", env_lines(sid, limits))
                self.write(f"plan/{sid}.system", "You are a helpful AI assistant.\n\nReasoning strength: low.")

    def knobs(self, **values):
        with open(self.state, "w", encoding="utf-8") as f:
            json.dump(values, f)

    def run_carrier(self):
        out = io.StringIO()
        carrier = mm_carrier.Carrier(self.mm, adb=self.adb, sleep=self.time.sleep, clock=self.time.clock, out=out)
        code = carrier.run()
        self.output = out.getvalue()
        return code

    def calls(self):
        with open(self.log, encoding="utf-8") as f:
            return [json.loads(line)["argv"] for line in f]

    def qdc_logs(self):
        folder = os.path.join(self.phone, "data", "local", "tmp", "QDC_logs")
        return sorted(os.listdir(folder)) if os.path.isdir(folder) else []

    def read_log(self, name):
        with open(os.path.join(self.phone, "data", "local", "tmp", "QDC_logs", name), encoding="utf-8") as f:
            return f.read()

    def test_two_subjects_run_and_their_files_are_collected_flat(self):
        self.make_mm((SMOKE, BASE))
        self.assertEqual(self.run_carrier(), 0, self.output)
        logs = self.qdc_logs()
        for sid in (SMOKE, BASE):
            for name in ("run.txt", "device.txt", "steps.txt", "host.txt", "stdout.txt"):
                self.assertIn(f"mm__{sid}__{name}.log", logs)
        self.assertIn("mm__carrier.log", logs)
        host = dict(line.split("=", 1) for line in self.read_log(f"mm__{SMOKE}__host.txt.log").splitlines())
        self.assertEqual(host["kit_exit"], "0")
        self.assertEqual(host["stopped"], "0")
        self.assertEqual(host["files"], "3")
        self.assertEqual(host["run"], "20261028T221500Z-SM8750-1")
        self.assertIn("status=done", self.read_log(f"mm__{BASE}__run.txt.log"))
        self.assertIn("finished: status=done", self.read_log(f"mm__{SMOKE}__stdout.txt.log"))
        self.assertIn(f"{SMOKE}: 22:15:00 kit 1: {SMOKE}", self.output, "the kit's lines are echoed as they come")
        self.assertFalse(os.path.exists(os.path.join(self.phone, "data", "local", "tmp", "mm")), "the phone is cleaned")

        calls = self.calls()
        self.assertEqual(calls[0], ["get-state"])
        self.assertEqual(calls[1], ["shell", "rm -rf /data/local/tmp/mm; mkdir -p /data/local/tmp/QDC_logs"])
        self.assertEqual(calls[2], ["push", self.mm, "/data/local/tmp/mm"])
        chmod = calls[3][1]
        for tool in mm_carrier.TOOLS:
            self.assertIn(f"/data/local/tmp/mm/{tool}", chmod)
        self.assertTrue(chmod.startswith("chmod 755 "))
        starts = [c[1] for c in calls if c[0] == "shell" and "kit/run.sh </dev/null" in c[1]]
        self.assertEqual(len(starts), 2)
        self.assertIn("trap '' HUP", starts[0])
        self.assertIn(f". ./plan/{SMOKE}.env", starts[0])
        self.assertTrue(calls[-1][0] == "push" and calls[-1][2] == "/data/local/tmp/QDC_logs/mm__carrier.log")
        self.assertIn(["shell", "rm -rf /data/local/tmp/mm/model; mkdir -p /data/local/tmp/mm/model"], calls)
        self.assertFalse(any("token" in " ".join(c).lower() for c in calls), "no token goes to the phone")

    def test_polls_that_drop_are_waited_out(self):
        self.make_mm()
        self.knobs(drop_polls=3)
        self.assertEqual(self.run_carrier(), 0, self.output)
        host = dict(line.split("=", 1) for line in self.read_log(f"mm__{SMOKE}__host.txt.log").splitlines())
        self.assertEqual(host["adb_errors"], "3")
        self.assertIn("the kit keeps running on the phone", self.output)

    def test_a_kit_that_refuses_its_inputs_fails_the_test(self):
        self.make_mm()
        os.environ["FAKE_KIT"] = "bad"
        self.assertEqual(self.run_carrier(), 1)
        self.assertIn("MM_MODEL is not set", self.read_log(f"mm__{SMOKE}__stdout.txt.log"))
        self.assertIn("the kit couldn't run", self.read_log("mm__carrier.log"))

    def test_a_kit_past_its_limits_is_stopped_and_collected(self):
        self.make_mm(limits={"MM_LIMIT_FETCH": "1", "MM_LIMIT_CHECK": "1", "MM_LIMIT_TOTAL": "1"})
        os.environ["FAKE_KIT"] = "slow"
        self.assertEqual(self.run_carrier(), 0, self.output)
        host = dict(line.split("=", 1) for line in self.read_log(f"mm__{SMOKE}__host.txt.log").splitlines())
        self.assertEqual(host["stopped"], "1")
        self.assertEqual(host["kit_exit"], "none")
        self.assertEqual(host["limit_seconds"], str(3 + mm_carrier.MARGIN_SECONDS))
        self.assertIn(f"mm__{SMOKE}__run.txt.log", self.qdc_logs())
        self.assertIn("past the kit's limits", self.output)
        kills = [c[1] for c in self.calls() if c[0] == "shell" and c[1].startswith("kill -")]
        self.assertEqual(len(kills), 2)

    def test_a_push_that_fails_is_reported(self):
        self.make_mm()
        self.knobs(push_fail=True)
        self.assertEqual(self.run_carrier(), 1)
        self.assertIn("adb push failed", self.output)

    def test_an_offline_phone_is_reported(self):
        self.make_mm()
        self.knobs(offline=True)
        self.assertEqual(self.run_carrier(), 1)
        self.assertIn("No phone over adb.", self.output)
        self.assertIn(["wait-for-device"], self.calls())

    def test_a_missing_or_broken_plan_is_reported(self):
        self.make_mm(plan=False)
        self.assertEqual(self.run_carrier(), 1)
        self.assertIn("No usable plan: no plan/run.env", self.output)
        self.assertIn("mm__carrier.log", self.qdc_logs())
        self.make_mm()
        self.write(f"plan/{SMOKE}.env", "MM_OUT=/data/local/tmp/mm/out/x; rm -rf /\n")
        self.assertEqual(self.run_carrier(), 1)
        self.assertIn("a line the kit can't take", self.output)
        self.write(f"plan/{SMOKE}.env", env_lines(BASE))
        self.assertEqual(self.run_carrier(), 1)
        self.assertIn(f"plan/{SMOKE}.env is for {BASE}", self.output)
        self.assertFalse(any(c[0] == "push" and c[2] == "/data/local/tmp/mm" for c in self.calls()), "nothing was pushed")
        self.write("plan/run.env", "MM_PLAN_VERSION=2\nMM_SUBJECTS=x\n")
        self.assertEqual(self.run_carrier(), 1)
        self.assertIn("isn't plan version 1", self.output)

    def test_the_limit_comes_from_the_env_file(self):
        self.assertEqual(mm_carrier.kit_limit({}), 3600 + 600 + 2400 + mm_carrier.MARGIN_SECONDS)
        self.assertEqual(mm_carrier.kit_limit({"MM_LIMIT_FETCH": "600", "MM_LIMIT_CHECK": "x"}), 600 + 600 + 2400 + 300)


class ConftestTests(unittest.TestCase):
    def setUp(self):
        import appium.webdriver

        self.webdriver = appium.webdriver
        self.webdriver.OPENED.clear()
        self.saved = dict(os.environ)
        import conftest

        self.conftest = conftest

    def tearDown(self):
        self.webdriver.ALLOW = False
        os.environ.clear()
        os.environ.update(self.saved)

    def test_no_appium_server_is_not_a_failure(self):
        self.webdriver.ALLOW = False
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIsNone(self.conftest.open_session())
        self.assertIn("No Appium session (ConnectionRefusedError)", out.getvalue())

    def test_the_session_asks_for_what_llama_cpp_asks_for(self):
        self.webdriver.ALLOW = True
        os.environ["ANDROID_DEVICE_VERSION"] = "SM8750-QRD"
        session = self.conftest.appium_session()
        driver = next(session)
        self.assertEqual(driver.url, "http://127.0.0.1:4723/wd/hub")
        self.assertEqual(
            driver.capabilities,
            {
                "platformName": "Android",
                "appium:automationName": "UiAutomator2",
                "appium:deviceName": "SM8750-QRD",
                "appium:newCommandTimeout": 9000,
            },
        )
        with self.assertRaises(StopIteration):
            next(session)
        self.assertTrue(driver.quit_called)


if __name__ == "__main__":
    unittest.main(verbosity=1)
