"""Tests for the training tools in server.py and for train.py. They need no torch, no GPU and no board.

  python -m unittest

A small script stands in for train.py where the server starts a run, and stubs stand in for torch where train.py itself runs.
"""
import io
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock

import server
import train

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLE = {"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]}
BAD_NAMES = ["", ".", "..", "../up", "a/b", "a\\b", ".hidden", "-flag", "a b", "a\n", "a\0b", None, 5]

# What FAKE_TRAIN_MODE asks for: "hold" trains until signalled, "die" exits without a word, "finish" succeeds at once.
FAKE_TRAIN = """
import argparse, json, os, signal, sys, time
parser = argparse.ArgumentParser()
for name in ("model", "dataset", "out", "status", "gguf-out", "converter", "steps", "rank", "lr", "max-length"):
    parser.add_argument("--" + name)
options = parser.parse_args()
def write(**fields):
    with open(options.status + ".part", "w") as f:
        json.dump({"pid": os.getpid(), "steps": int(options.steps), **fields}, f)
    os.replace(options.status + ".part", options.status)
def stopped(*_):
    write(state="stopped", step=1, seconds=1)
    sys.exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN if os.environ["FAKE_TRAIN_MODE"] == "ignore" else stopped)
mode = os.environ["FAKE_TRAIN_MODE"]
if mode == "die":
    print("last words in the log")
    sys.exit(3)
if mode == "finish":
    with open(options.gguf_out, "w") as f:
        f.write("GGUF")
    write(state="done", step=int(options.steps), loss=0.5, seconds=2, peak_gpu_gib=3.1, adapter=os.path.basename(options.gguf_out))
    sys.exit(0)
write(state="training", step=1, loss=1.5, seconds=1)
time.sleep(60)
"""

# Runs the real train.py with torch, peft and transformers replaced, because only its flow is under test here.
STUBBED_TRAIN = """
import json, os, signal, sys
from unittest.mock import MagicMock
torch, peft, transformers = MagicMock(), MagicMock(), MagicMock()
sys.modules.update(torch=torch, peft=peft, transformers=transformers)
torch.cuda.max_memory_reserved.return_value = 2**31
parameter = MagicMock(requires_grad=True)
parameter.numel.return_value = 8
model = peft.get_peft_model.return_value
model.parameters.return_value = [parameter]
torch.nn.functional.cross_entropy.return_value.item.return_value = 1.5
def save(folder):
    os.makedirs(folder)
    open(os.path.join(folder, "adapter_model.safetensors"), "w").close()
model.save_pretrained.side_effect = save
if os.environ.get("STUB_SIGTERM_IN_TRAINING"):
    torch.optim.AdamW.return_value.step.side_effect = lambda: signal.raise_signal(signal.SIGTERM)
tokenizer = transformers.AutoTokenizer.from_pretrained.return_value
tokenizer.apply_chat_template.return_value = "prompt"
tokenizer.side_effect = lambda text, **_: {"input_ids": [1] * len(text)}
torch.cuda.get_device_properties.return_value.total_memory = 8 * 2**30
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(sys.argv[0]))
import train
if os.environ.get("STUB_MEMORY_GIB"):
    readings = iter(json.loads(os.environ["STUB_MEMORY_GIB"]))
    train.available_gib = lambda: next(readings)
train.main()
"""


CONVERTER_THAT_WORKS = """
    import sys
    open(sys.argv[sys.argv.index("--outfile") + 1], "w").write("GGUF")
"""


def text(result):
    return result["content"][0]["text"]


def call(tool, /, **arguments):
    """Calls a tool as a client would. Returns (is_error, its text)."""
    result = server.handle_rpc("tools/call", {"name": tool, "arguments": arguments})
    return bool(result.get("isError")), text(result)


def wait_for(condition, seconds=20):
    deadline = time.time() + seconds
    while not condition():
        if time.time() > deadline:
            raise AssertionError("Timed out waiting.")
        time.sleep(0.05)


class FakeDownload(io.BytesIO):
    def __init__(self, data, length=None):
        super().__init__(data)
        self.headers = {"Content-Length": length}


class TrainingTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        train = os.path.join(self.home, "train")
        fake = os.path.join(self.home, "fake_train.py")
        with open(fake, "w") as f:
            f.write(FAKE_TRAIN)
        converter = os.path.join(train, "llama.cpp", "convert_lora_to_gguf.py")
        base = os.path.join(train, "models", server.DEFAULT_BASE)
        os.makedirs(os.path.dirname(converter))
        os.makedirs(base)
        open(converter, "w").close()
        with open(os.path.join(base, "model.safetensors"), "wb") as f:
            f.write(b"0" * 1024)
        constants = {
            "MODEL_DIR": os.path.join(self.home, "models"),
            "TRAIN_DIR": train,
            "TRAIN_PYTHON": sys.executable,
            "TRAIN_SCRIPT": fake,
            "CONVERTER": converter,
            "BASE_DIR": os.path.join(train, "models"),
            "DATASET_DIR": os.path.join(train, "datasets"),
            "RUN_DIR": os.path.join(train, "runs"),
            # A real model on this machine's port must not change the result.
            "MODEL_PORT": 1,
            "train_process": None,
            "model_process": None,
            "model_loaded": None,
        }
        for name, value in constants.items():
            patcher = mock.patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        os.makedirs(server.MODEL_DIR)
        open(os.path.join(server.MODEL_DIR, f"{server.DEFAULT_BASE}-Q4_K_M.gguf"), "w").close()
        # So a download's address check needs no network.
        addresses = mock.patch.object(server, "addresses_of", return_value={"93.184.216.34"})
        addresses.start()
        self.addCleanup(addresses.stop)
        memory = mock.patch.object(server, "meminfo_gib", return_value=4.4)
        self.memory = memory.start()
        self.addCleanup(memory.stop)
        self.addCleanup(self.end_child)
        self.set_mode("hold")

    def set_mode(self, mode):
        patcher = mock.patch.dict(os.environ, {"FAKE_TRAIN_MODE": mode})
        patcher.start()
        self.addCleanup(patcher.stop)

    def end_child(self):
        if server.train_process:
            server.train_process.kill()
            server.train_process.wait()

    def save(self, name="data"):
        self.assertEqual(call("save_dataset", name=name, examples=[EXAMPLE]), (False, json.dumps({"name": name, "examples": 1})))

    def start(self, name="run1", **arguments):
        self.save()
        error, reply = call("train_model", dataset="data", name=name, steps=10, **arguments)
        self.assertFalse(error, reply)
        self.assertEqual(json.loads(reply), {"run": name, "state": "loading"})

    def status(self, **arguments):
        error, reply = call("training_status", **arguments)
        self.assertFalse(error, reply)
        return json.loads(reply)

    def wait_for_state(self, state, **arguments):
        wait_for(lambda: self.status(**arguments)["state"] == state)
        if state not in server.ACTIVE_STATES:
            server.train_process.wait(20)

    def assert_refused(self, words, tool, /, **arguments):
        error, reply = call(tool, **arguments)
        self.assertTrue(error, reply)
        self.assertIn(words, reply)

    def test_version_and_tools_are_offered(self):
        self.assertEqual(server.VERSION, "0.4.0")
        names = [tool["name"] for tool in server.handle_rpc("tools/list", {})["tools"]]
        for name in ("save_dataset", "train_model", "training_status", "stop_training"):
            self.assertIn(name, names)

    def test_names_cannot_escape_their_folder(self):
        before = sorted(os.listdir(self.home))
        for bad in BAD_NAMES:
            with self.subTest(name=bad):
                self.assert_refused("must be a name", "save_dataset", name=bad, examples=[EXAMPLE])
                self.assert_refused("must be a name", "train_model", name=bad, dataset="data")
                self.assert_refused("must be a name", "train_model", name="ok", dataset=bad)
                if bad is not None:
                    self.assert_refused("must be a name", "train_model", name="ok", dataset="data", base=bad)
                    self.assert_refused("must be a name", "training_status", run=bad)
                    self.assert_refused("must be a name", "stop_training", run=bad)
        self.assertEqual(sorted(os.listdir(self.home)), before)
        self.assertFalse(os.path.exists(server.DATASET_DIR))

    def test_good_names_are_taken(self):
        for good in ("a", "Qwen3.5-0.8B", "run_1.v2-final"):
            self.save(good)

    def test_examples_must_end_in_an_answer(self):
        user = {"role": "user", "content": "Hi"}
        answer = {"role": "assistant", "content": "Hello"}
        for examples in (
            [],
            "text",
            None,
            ["text"],
            [{}],
            [{"messages": "text"}],
            [{"messages": []}],
            [{"messages": [user]}],
            [{"messages": [answer]}],
            [{"messages": [answer, user]}],
            [{"messages": [user, {"role": "assistant", "content": "  "}]}],
            [{"messages": [user, {"role": "assistant"}]}],
            [{"messages": [user, {"role": "assistant", "content": 5}]}],
            [{"messages": ["text", answer]}],
            [EXAMPLE, {"messages": [user]}],
        ):
            with self.subTest(examples=examples):
                error, _ = call("save_dataset", name="data", examples=examples)
                self.assertTrue(error)
        self.assertFalse(os.path.exists(os.path.join(server.DATASET_DIR, "data.jsonl")))
        self.assert_refused("examples[1]", "save_dataset", name="data", examples=[EXAMPLE, {"messages": [user]}])

    def test_save_dataset_replaces_and_appends(self):
        path = os.path.join(server.DATASET_DIR, "data.jsonl")
        unicode_example = {"messages": [{"role": "user", "content": "line\none \u00e9"}, {"role": "assistant", "content": "\u2713"}]}
        self.assertEqual(json.loads(call("save_dataset", name="data", examples=[EXAMPLE, EXAMPLE])[1])["examples"], 2)
        self.assertEqual(json.loads(call("save_dataset", name="data", examples=[unicode_example], append=True)[1]), {"name": "data", "examples": 3})
        with open(path, encoding="utf-8") as f:
            rows = [json.loads(line) for line in f]
        self.assertEqual(rows, [EXAMPLE, EXAMPLE, unicode_example])
        self.assertEqual(json.loads(call("save_dataset", name="data", examples=[unicode_example])[1])["examples"], 1)
        self.assertEqual(json.loads(call("save_dataset", name="data", examples=[EXAMPLE], append=False)[1])["examples"], 1)
        with open(path, encoding="utf-8") as f:
            self.assertEqual([json.loads(line) for line in f], [EXAMPLE])
        self.assertEqual(os.listdir(server.DATASET_DIR), ["data.jsonl"])
        self.assert_refused("append", "save_dataset", name="data", examples=[EXAMPLE], append="yes")

    def test_a_board_without_setup_says_so(self):
        shutil.rmtree(server.TRAIN_DIR)
        for name, arguments in (
            ("save_dataset", {"name": "data", "examples": [EXAMPLE]}),
            ("train_model", {"name": "run1", "dataset": "data"}),
            ("training_status", {}),
            ("stop_training", {}),
        ):
            with self.subTest(tool=name):
                self.assert_refused("setup-train.sh", name, **arguments)
        self.assertFalse(call("list_models")[0])
        self.assertFalse(os.path.exists(server.TRAIN_DIR))

    def test_missing_parts_are_refused(self):
        self.assert_refused("no training runs", "training_status")
        self.assert_refused("no training runs", "stop_training")
        self.assert_refused("no training run called", "training_status", run="never")
        self.assert_refused("no dataset called", "train_model", name="run1", dataset="never")
        self.save()
        self.assert_refused("isn't in", "train_model", name="run1", dataset="data", base="never")
        os.remove(server.CONVERTER)
        self.assert_refused("setup-train.sh", "train_model", name="run1", dataset="data")

    def test_bad_settings_are_refused(self):
        self.save()
        for settings in ({"max_length": 63}, {"max_length": 4097}, {"steps": 0}, {"steps": 1.5}, {"steps": True}, {"rank": 0}, {"rank": 65}, {"lr": 0}, {"lr": -1}, {"lr": "fast"}, {"lr": True}, {"lr": 0.5}):
            with self.subTest(settings=settings):
                self.assertTrue(call("train_model", name="run1", dataset="data", **settings)[0])
        self.assertEqual(server.run_names(), [])

    def test_too_little_disk_or_memory_is_refused(self):
        self.save()
        self.memory.return_value = 1.0
        self.assert_refused("free memory", "train_model", name="run1", dataset="data")
        self.memory.return_value = None
        Usage = type("Usage", (), {"free": 2**20})
        with mock.patch.object(server.shutil, "disk_usage", return_value=Usage):
            self.assert_refused("free disk", "train_model", name="run1", dataset="data")
        self.assertEqual(server.run_names(), [])

    def test_memory_needed_grows_with_the_base(self):
        self.save()
        with mock.patch.object(server.os.path, "getsize", return_value=5 * 2**30):
            self.assert_refused("6.0 GiB", "train_model", name="run1", dataset="data")

    def test_a_running_model_is_refused(self):
        self.save()
        with mock.patch.object(server, "model_process", mock.Mock(poll=mock.Mock(return_value=None))):
            self.assert_refused("stop_model", "train_model", name="run1", dataset="data")
        self.assertEqual(server.run_names(), [])

    def test_a_model_left_from_before_a_restart_is_refused(self):
        self.save()
        with mock.patch.object(server.socket, "create_connection"):
            self.assert_refused("before this server restarted", "train_model", name="run1", dataset="data")

    def test_a_run_finishes_and_reports(self):
        self.set_mode("finish")
        self.start()
        self.wait_for_state("done")
        self.assertEqual(
            self.status(),
            {"run": "run1", "state": "done", "step": 10, "steps": 10, "loss": 0.5, "seconds": 2, "peak_gpu_gib": 3.1, "error": None, "adapter": "run1.gguf", "examples": None, "skipped": None},
        )
        self.assertIn("run1.gguf", server.model_files())
        self.assert_refused("isn't active", "stop_training")

    def test_a_finished_adapter_is_not_replaced(self):
        self.set_mode("finish")
        self.start()
        self.wait_for_state("done")
        self.assert_refused("already in", "train_model", name="run1", dataset="data")

    def test_max_length_reaches_the_child(self):
        self.set_mode("finish")
        with mock.patch.object(server.subprocess, "Popen", wraps=subprocess.Popen) as popen:
            self.start(max_length=1024)
        command = popen.call_args.args[0]
        self.assertEqual(command[command.index("--max-length") + 1], "1024")
        self.wait_for_state("done")

    def test_a_dataset_in_use_cannot_be_changed(self):
        self.start()
        self.wait_for_state("training")
        path = os.path.join(server.DATASET_DIR, "data.jsonl")
        self.assert_refused("is using dataset data", "save_dataset", name="data", examples=[EXAMPLE, EXAMPLE])
        self.assert_refused("is using dataset data", "save_dataset", name="data", examples=[EXAMPLE, EXAMPLE], append=True)
        self.assertEqual(server.count_examples(path), 1)
        # Any other dataset can still be saved, and this one can once the run has ended.
        self.save("other")
        self.assertFalse(call("stop_training")[0])
        self.assertEqual(json.loads(call("save_dataset", name="data", examples=[EXAMPLE, EXAMPLE])[1])["examples"], 2)

    def test_no_base_gguf_is_refused_before_training(self):
        self.save()
        os.remove(os.path.join(server.MODEL_DIR, f"{server.DEFAULT_BASE}-Q4_K_M.gguf"))
        self.assert_refused("no GGUF", "train_model", name="run1", dataset="data")
        self.assertEqual(server.run_names(), [])

    def test_a_busy_model_lock_refuses_instead_of_queueing(self):
        self.save()
        with server.model_lock, mock.patch.object(server, "MODEL_LOCK_WAIT_S", 0.01):
            self.assert_refused("Try again", "train_model", name="run1", dataset="data")
            self.assert_refused("Try again", "stop_model")
            open(os.path.join(server.MODEL_DIR, "base.gguf"), "w").close()
            with mock.patch.object(server, "find_llama_server", return_value=("llama-server", {})):
                self.assert_refused("Try again", "start_model", model="base.gguf")
        self.assertEqual(server.run_names(), [])

    def test_a_full_disk_still_reports_a_dead_run_as_failed(self):
        self.set_mode("die")
        self.start()
        wait_for(lambda: server.train_process.poll() is not None)
        with mock.patch.object(server, "write_json", side_effect=OSError(28, "No space left on device")):
            self.assertEqual(self.status()["state"], "failed")
            self.assertIsNone(server.active_run())

    def test_a_dead_run_leaves_no_partial_gguf(self):
        self.set_mode("die")
        self.start()
        part = os.path.join(server.MODEL_DIR, "run1.gguf.part")
        open(part, "w").close()
        wait_for(lambda: server.train_process.poll() is not None)
        self.assertEqual(self.status()["state"], "failed")
        self.assertFalse(os.path.exists(part))

    def test_stopping_leaves_no_partial_gguf(self):
        self.start()
        self.wait_for_state("training")
        part = os.path.join(server.MODEL_DIR, "run1.gguf.part")
        open(part, "w").close()
        self.assertFalse(call("stop_training")[0])
        self.assertFalse(os.path.exists(part))

    def test_a_new_run_clears_an_old_partial_gguf(self):
        self.set_mode("finish")
        part = os.path.join(server.MODEL_DIR, "run1.gguf.part")
        open(part, "w").close()
        self.start()
        self.assertFalse(os.path.exists(part))
        self.wait_for_state("done")

    def install(self, data=b"GGUF data", length=None, name="new.gguf"):
        with mock.patch.object(server.DOWNLOADS, "open", return_value=FakeDownload(data, length)):
            return call("install_model", url="https://models.example/new.gguf", name=name)

    def test_install_model_saves_a_gguf(self):
        error, reply = self.install()
        self.assertFalse(error, reply)
        self.assertIn("new.gguf", server.model_files())

    def test_install_model_does_not_replace_a_file(self):
        base = f"{server.DEFAULT_BASE}-Q4_K_M.gguf"
        error, reply = self.install(name=base)
        self.assertTrue(error)
        self.assertIn("already in", reply)
        self.assertEqual(os.path.getsize(os.path.join(server.MODEL_DIR, base)), 0)

    def test_install_model_refuses_during_a_run(self):
        self.start()
        self.wait_for_state("training")
        error, reply = self.install()
        self.assertTrue(error)
        self.assertIn("needs this board's disk", reply)
        self.assertNotIn("new.gguf", server.model_files())

    def test_install_model_refuses_what_will_not_fit(self):
        Usage = type("Usage", (), {"free": 2**30 + 4})
        with mock.patch.object(server.shutil, "disk_usage", return_value=Usage):
            # By its stated size, and by what actually arrives when no size is stated or the size lies.
            for length in ("5", None, "2"):
                with self.subTest(length=length):
                    error, reply = self.install(data=b"GGUF data", length=length)
                    self.assertTrue(error)
                    self.assertIn("doesn't fit", reply)
        with mock.patch.object(server, "MODEL_MAX_BYTES", 4):
            self.assertIn("doesn't fit", self.install()[1])
        self.assertNotIn("new.gguf", server.model_files())
        self.assertEqual([name for name in os.listdir(server.MODEL_DIR) if name.endswith(".part")], [])

    def test_only_one_download_runs_at_a_time(self):
        # Each download works out its room alone, so several together could fill the disk, and same-name ones share a .part.
        server.install_lock.acquire()
        try:
            error, reply = self.install()
        finally:
            server.install_lock.release()
        self.assertTrue(error)
        self.assertIn("Another download", reply)
        self.assertNotIn("new.gguf", server.model_files())
        self.assertFalse(self.install()[0])

    def test_a_run_cannot_start_during_a_download(self):
        self.save()
        server.install_lock.acquire()
        try:
            self.assert_refused("download", "train_model", name="run1", dataset="data")
        finally:
            server.install_lock.release()
        self.assertEqual(server.run_names(), [])

    def test_save_dataset_leaves_the_disk_its_reserve(self):
        self.save("data")
        size = os.path.getsize(os.path.join(server.DATASET_DIR, "data.jsonl"))
        Usage = type("Usage", (), {"free": server.INSTALL_RESERVE_GIB * 2**30 + 1})
        with mock.patch.object(server.shutil, "disk_usage", return_value=Usage):
            self.assert_refused("doesn't fit", "save_dataset", name="data", examples=[EXAMPLE], append=True)
        self.assertEqual(os.path.getsize(os.path.join(server.DATASET_DIR, "data.jsonl")), size)

    def test_a_dataset_has_a_largest_size(self):
        self.save("data")
        size = os.path.getsize(os.path.join(server.DATASET_DIR, "data.jsonl"))
        with mock.patch.object(server, "DATASET_MAX_BYTES", size + 1):
            self.assert_refused("too large", "save_dataset", name="data", examples=[EXAMPLE], append=True)
            # Replacing it doesn't count what's there.
            self.assertFalse(call("save_dataset", name="data", examples=[EXAMPLE])[0])
        self.assertEqual(os.path.getsize(os.path.join(server.DATASET_DIR, "data.jsonl")), size)

    def test_install_model_refuses_this_board_and_its_network(self):
        for address in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "fe80::1"):
            with self.subTest(address=address), mock.patch.object(server, "addresses_of", return_value={address}):
                error, reply = self.install()
                self.assertTrue(error)
                self.assertIn("public address", reply)
        self.assertNotIn("new.gguf", server.model_files())

    def test_a_redirect_cannot_reach_this_board_or_its_network(self):
        handler = server.HttpsOnlyRedirect()
        request = server.urllib.request.Request("https://models.example/x.gguf")
        with mock.patch.object(server, "addresses_of", return_value={"127.0.0.1"}), self.assertRaises(server.ToolError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://internal.example:8766/x.gguf")

    def test_a_failed_download_does_not_say_how_it_failed(self):
        # The difference between "connection refused" and a TLS error would tell a caller which ports are open.
        for failure in (server.urllib.error.URLError("[Errno 61] Connection refused"), server.urllib.error.URLError("WRONG_VERSION_NUMBER")):
            with self.subTest(failure=failure), mock.patch.object(server.DOWNLOADS, "open", side_effect=failure):
                error, reply = call("install_model", url="https://models.example/new.gguf", name="new.gguf")
                self.assertTrue(error)
                self.assertEqual(reply, server.DOWNLOAD_FAILED)
        with mock.patch.object(server, "addresses_of", side_effect=OSError("Name or service not known")):
            self.assertEqual(self.install()[1], server.DOWNLOAD_FAILED)

    def test_errors_say_home_rather_than_the_home_folder(self):
        with mock.patch.dict(os.environ, {"HOME": self.home}):
            self.save()
            error, reply = call("train_model", name="run1", dataset="data", base="nope")
            self.assertTrue(error)
            self.assertNotIn(self.home, reply)
            self.assertIn("~/train/models", reply)
            with mock.patch.object(server.shutil, "disk_usage", side_effect=OSError(f"No such file: {self.home}/x")):
                error, reply = call("list_models")
            self.assertTrue(error)
            self.assertEqual(reply, "list_models failed: No such file: ~/x")

    def test_a_redirect_must_stay_https(self):
        handler = server.HttpsOnlyRedirect()
        request = server.urllib.request.Request("https://models.example/x.gguf")
        for target in ("http://127.0.0.1:8766/health", "ftp://models.example/x.gguf", "file:///etc/passwd"):
            with self.subTest(target=target), self.assertRaises(server.ToolError):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        self.assertEqual(handler.redirect_request(request, None, 302, "Found", {}, "https://cdn.example/x.gguf").full_url, "https://cdn.example/x.gguf")

    def test_the_child_gets_the_paths_and_settings(self):
        self.set_mode("finish")
        with mock.patch.object(server.subprocess, "Popen", wraps=subprocess.Popen) as popen:
            self.start(rank=4, lr=0.001)
        command = popen.call_args.args[0]
        self.assertEqual(popen.call_args.kwargs["start_new_session"], True)
        self.assertEqual(command[:2], [server.TRAIN_PYTHON, server.TRAIN_SCRIPT])
        settings = dict(zip(command[2::2], command[3::2]))
        self.assertEqual(settings["--model"], os.path.join(server.BASE_DIR, server.DEFAULT_BASE))
        self.assertEqual(settings["--dataset"], os.path.join(server.DATASET_DIR, "data.jsonl"))
        self.assertEqual(settings["--gguf-out"], os.path.join(server.MODEL_DIR, "run1.gguf"))
        self.assertEqual(settings["--converter"], server.CONVERTER)
        self.assertEqual((settings["--steps"], settings["--rank"], settings["--lr"], settings["--max-length"]), ("10", "4", "0.001", "512"))
        self.wait_for_state("done")
        config = server.read_json(server.run_file("run1", "config.json"))
        self.assertEqual((config["rank"], config["lr"], config["base"]), (4, 0.001, server.DEFAULT_BASE))

    def test_a_model_that_will_not_fit_in_memory_is_refused(self):
        # A failed GPU allocation has frozen and rebooted these boards (train.py), so this is checked before llama-server starts.
        model = f"{server.DEFAULT_BASE}-Q4_K_M.gguf"
        self.memory.return_value = 0.1
        with mock.patch.object(server, "find_llama_server", return_value=("/fake/llama-server", {})), mock.patch.object(server.subprocess, "Popen") as started:
            self.assert_refused("free memory", "start_model", model=model)
            started.assert_not_called()

    def test_memory_needed_for_a_model_grows_with_its_files_and_context(self):
        small = server.model_memory_gib([], 4096)
        self.assertGreater(server.model_memory_gib([], 32768), small)
        path = os.path.join(server.MODEL_DIR, "big.gguf")
        with open(path, "wb") as f:
            f.truncate(2**30)
        self.assertAlmostEqual(server.model_memory_gib([path], 4096), small + 1, places=3)

    def test_a_model_with_room_starts(self):
        model = f"{server.DEFAULT_BASE}-Q4_K_M.gguf"
        self.memory.return_value = 4.4
        with mock.patch.object(server, "find_llama_server", return_value=("/fake/llama-server", {})), mock.patch.object(server.subprocess, "Popen", side_effect=OSError("stop here")) as started:
            self.assertTrue(call("start_model", model=model)[0])
            started.assert_called_once()

    def test_a_second_run_is_refused(self):
        self.start()
        self.wait_for_state("training")
        self.assert_refused("still going", "train_model", name="run2", dataset="data")
        self.assert_refused("still going", "train_model", name="run1", dataset="data")
        self.assertEqual(server.run_names(), ["run1"])

    def test_a_model_cannot_start_during_training(self):
        self.start()
        self.wait_for_state("training")
        with open(os.path.join(os.makedirs(server.MODEL_DIR, exist_ok=True) or server.MODEL_DIR, "base.gguf"), "w") as f:
            f.write("GGUF")
        with mock.patch.object(server, "find_llama_server", return_value=("llama-server", {})), mock.patch.object(server.subprocess, "Popen") as popen:
            self.assert_refused("stop_training", "start_model", model="base.gguf")
            popen.assert_not_called()

    def test_status_of_a_dead_process_is_failed(self):
        self.set_mode("die")
        self.start()
        wait_for(lambda: server.train_process.poll() is not None)
        status = self.status()
        self.assertEqual(status["state"], "failed")
        self.assertIn("died", status["error"])
        self.assertIn("last words", status["error"])
        # It's written down, so the answer stays the same, and a new run can start.
        self.assertEqual(server.read_json(server.run_file("run1", "status.json"))["state"], "failed")
        self.set_mode("hold")
        self.start("run2")
        self.wait_for_state("training")

    def test_status_after_a_restart_with_a_dead_process_is_failed(self):
        self.start()
        self.wait_for_state("training")
        process = server.train_process
        process.kill()
        process.wait()
        server.train_process = None  # What a restarted server knows.
        self.assertEqual(self.status()["state"], "failed")

    def test_a_failed_run_can_be_tried_again(self):
        self.set_mode("die")
        self.start()
        self.wait_for_state("failed")
        self.set_mode("finish")
        self.start()
        self.wait_for_state("done")
        self.assertIsNone(self.status()["error"])

    def test_status_defaults_to_the_newest_run(self):
        self.set_mode("finish")
        self.start("run1")
        self.wait_for_state("done", run="run1")
        self.start("run2")
        self.wait_for_state("done", run="run2")
        self.assertEqual(self.status()["run"], "run2")
        self.assertEqual(self.status(run="run1")["adapter"], "run1.gguf")
        # A refused run doesn't count as one.
        self.assertTrue(call("train_model", name="run3", dataset="never")[0])
        self.assertEqual(self.status()["run"], "run2")

    def test_seconds_count_up_while_active(self):
        self.start()
        self.wait_for_state("training")
        config = server.read_json(server.run_file("run1", "config.json"))
        config["started"] -= 100
        server.write_json(server.run_file("run1", "config.json"), config)
        self.assertGreaterEqual(self.status()["seconds"], 100)

    def test_stop_ends_a_run(self):
        self.start()
        self.wait_for_state("training")
        error, reply = call("stop_training")
        self.assertFalse(error, reply)
        self.assertEqual(json.loads(reply)["state"], "stopped")
        self.assertIsNotNone(server.train_process.poll())
        self.assertEqual(self.status()["state"], "stopped")
        self.assert_refused("isn't active", "stop_training", run="run1")
        self.start("run1")
        self.wait_for_state("training")

    def test_stop_right_after_starting(self):
        self.start()
        error, reply = call("stop_training", run="run1")
        self.assertFalse(error, reply)
        self.assertEqual(json.loads(reply)["state"], "stopped")

    @unittest.skipUnless(os.path.isdir("/proc/self"), "needs /proc")
    def test_a_restarted_server_still_finds_and_stops_a_live_run(self):
        self.start()
        self.wait_for_state("training")
        process = server.train_process
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        server.train_process = None
        self.assertEqual(self.status()["state"], "training")
        self.assert_refused("still going", "train_model", name="run2", dataset="data")
        # Nothing reaps it now, so it stays a zombie, whose /proc entry has no command line.
        self.assertEqual(json.loads(call("stop_training")[1])["state"], "stopped")

    @unittest.skipUnless(os.path.isdir("/proc/self"), "needs /proc")
    def test_a_reused_pid_is_not_mistaken_for_the_run(self):
        self.start()
        self.wait_for_state("training")
        process = server.train_process
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        server.train_process = None
        config = server.read_json(server.run_file("run1", "config.json"))
        config["pid"] = os.getpid()
        server.write_json(server.run_file("run1", "config.json"), config)
        self.assertEqual(self.status()["state"], "failed")

    @unittest.skipUnless(hasattr(os, "killpg"), "needs POSIX signals")
    def test_a_run_that_ignores_the_signal_is_killed(self):
        self.set_mode("ignore")
        self.start()
        self.wait_for_state("training")
        with mock.patch.object(server, "STOP_TIMEOUT_S", 0.5):
            self.assertEqual(json.loads(call("stop_training")[1])["state"], "stopped")
        self.assertEqual(server.train_process.poll(), -signal.SIGKILL)


class TrainMemoryTests(unittest.TestCase):
    def fake_torch(self):
        torch = mock.Mock()
        torch.cuda.get_device_properties.return_value.total_memory = 8 * 2**30
        return torch

    def test_the_gpu_cap_leaves_the_reserve_free(self):
        torch = self.fake_torch()
        with mock.patch.object(train, "available_gib", return_value=4.4):
            train.limit_gpu_memory(torch)
        fraction = torch.cuda.set_per_process_memory_fraction.call_args.args[0]
        self.assertAlmostEqual(fraction * 8, 4.4 - train.GPU_RESERVE_GIB)

    def test_too_little_memory_for_any_cap_fails(self):
        with mock.patch.object(train, "available_gib", return_value=0.4), self.assertRaises(MemoryError):
            train.limit_gpu_memory(self.fake_torch())

    def test_no_meminfo_means_no_cap(self):
        torch = self.fake_torch()
        with mock.patch.object(train, "available_gib", return_value=None):
            train.limit_gpu_memory(torch)
            train.check_memory()
        torch.cuda.set_per_process_memory_fraction.assert_not_called()

    def test_meminfo_is_read(self):
        with mock.patch("builtins.open", mock.mock_open(read_data="MemTotal: 8 kB\nMemAvailable:    2097152 kB\n")):
            self.assertEqual(train.available_gib(), 2.0)


class TrainScriptTests(unittest.TestCase):
    """The real train.py's flow: states, conversion and stopping."""

    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        self.path = lambda name: os.path.join(self.folder, name)
        with open(self.path("stubbed.py"), "w") as f:
            f.write(STUBBED_TRAIN)
        with open(self.path("data.jsonl"), "w") as f:
            f.write(json.dumps(EXAMPLE) + "\n")

    def run_train(self, converter, *arguments, **env):
        with open(self.path("converter.py"), "w") as f:
            f.write(textwrap.dedent(converter))
        return subprocess.run(
            [sys.executable, self.path("stubbed.py"), os.path.join(HERE, "train.py"), "--model", self.path("base"), "--dataset", self.path("data.jsonl"), "--out", self.path("adapter"),
             "--status", self.path("status.json"), "--gguf-out", self.path("run1.gguf"), "--converter", self.path("converter.py"), "--steps", "7", *arguments],
            capture_output=True, text=True, env={**os.environ, **env}, timeout=60,
        )

    def status(self):
        with open(self.path("status.json")) as f:
            return json.load(f)

    def test_success_ends_with_the_gguf(self):
        done = self.run_train("""
            import sys
            arguments = sys.argv[1:]
            open(arguments[arguments.index("--outfile") + 1], "w").write("GGUF " + " ".join(arguments[:1] + arguments[1:3]))
        """)
        self.assertEqual(done.returncode, 0, done.stderr)
        status = self.status()
        self.assertEqual((status["state"], status["step"], status["steps"], status["adapter"], status["loss"], status["peak_gpu_gib"]), ("done", 7, 7, "run1.gguf", 1.5, 2.0))
        self.assertNotIn("error", status)
        with open(self.path("run1.gguf")) as f:
            self.assertEqual(f.read(), f"GGUF {self.path('adapter')} --base {self.path('base')}")
        self.assertFalse(os.path.exists(self.path("run1.gguf.part")))

    def test_the_converter_runs_after_converting_is_recorded(self):
        done = self.run_train(f"""
            import json, sys
            print(json.load(open({self.path("status.json")!r}))["state"])
            sys.exit(1)
        """)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("converting", self.status()["error"])

    def test_a_failed_conversion_keeps_the_adapter_and_reports_its_output(self):
        done = self.run_train("""
            import sys
            print("the start of a long output " + "x" * 3000)
            print("KeyError: unknown tensor")
            open(sys.argv[sys.argv.index("--outfile") + 1], "w").write("partial")
            sys.exit(2)
        """)
        self.assertNotEqual(done.returncode, 0)
        status = self.status()
        self.assertEqual(status["state"], "failed")
        self.assertIn("KeyError: unknown tensor", status["error"])
        self.assertIn("exited with 2", status["error"])
        self.assertLessEqual(len(status["error"]), 1500)
        self.assertIsNone(status.get("adapter"))
        self.assertTrue(os.path.exists(self.path("adapter/adapter_model.safetensors")))
        self.assertFalse(os.path.exists(self.path("run1.gguf")))
        self.assertFalse(os.path.exists(self.path("run1.gguf.part")))

    def test_sigterm_while_training_ends_as_stopped(self):
        done = self.run_train("", STUB_SIGTERM_IN_TRAINING="1")
        self.assertEqual(done.returncode, 0, done.stderr)
        status = self.status()
        self.assertEqual(status["state"], "stopped")
        self.assertIsNone(status.get("adapter"))
        self.assertFalse(os.path.exists(self.path("adapter")))

    def write_dataset(self, *answers):
        with open(self.path("data.jsonl"), "w") as f:
            for answer in answers:
                f.write(json.dumps({"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": answer}]}) + "\n")

    def test_examples_over_the_limit_are_skipped_and_counted(self):
        self.write_dataset("Hello", "x" * 600, "Bye")
        done = self.run_train(CONVERTER_THAT_WORKS, "--max-length", "100")
        self.assertEqual(done.returncode, 0, done.stderr)
        status = self.status()
        self.assertEqual((status["state"], status["examples"], status["skipped"]), ("done", 2, 1))

    def test_only_over_long_examples_fail_with_the_remedy(self):
        self.write_dataset("x" * 600)
        self.assertNotEqual(self.run_train("", "--max-length", "100").returncode, 0)
        status = self.status()
        self.assertEqual(status["state"], "failed")
        self.assertIn("Raise max_length", status["error"])

    def test_the_memory_floor_ends_a_run_with_a_clear_error(self):
        done = self.run_train("", STUB_MEMORY_GIB="[4.4, 4.0, 3.5, 0.4]")
        self.assertNotEqual(done.returncode, 0)
        status = self.status()
        self.assertEqual(status["state"], "failed")
        self.assertIn("available memory fell to 0.40 GiB", status["error"])
        self.assertFalse(os.path.exists(self.path("adapter")))

    def test_a_status_that_cannot_be_written_does_not_hide_the_failure(self):
        with mock.patch.object(train, "write_status", side_effect=OSError(28, "No space left on device")):
            train.write_last_status(self.path("status.json"), state="failed")
        self.assertFalse(os.path.exists(self.path("status.json")))

    def test_a_bad_dataset_fails_with_its_reason(self):
        with open(self.path("data.jsonl"), "w") as f:
            f.write(json.dumps({"messages": [{"role": "user", "content": "Hi"}]}) + "\n")
        self.assertNotEqual(self.run_train("").returncode, 0)
        self.assertIn("assistant", self.status()["error"])


class TokenTests(unittest.TestCase):
    """A token that is empty or can't be read would let "Bearer " or "Bearer None" through, so the server won't start on one."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        patcher = mock.patch.dict(os.environ, {"HOME": self.home})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.path = os.path.join(self.home, ".muse-device", "token")

    def write(self, text):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w") as f:
            f.write(text)

    def test_first_start_makes_a_long_private_token(self):
        token = server.load_token()
        self.assertGreaterEqual(len(token), server.MIN_TOKEN_CHARS)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertEqual(server.load_token(), token)

    def test_a_token_that_is_empty_or_short_stops_the_start(self):
        for text in ("", "   \n", "short"):
            with self.subTest(text=text):
                self.write(text)
                with self.assertRaises(SystemExit):
                    server.load_token()

    @unittest.skipIf(os.geteuid() == 0, "root reads a file whatever its mode")
    def test_a_token_that_cannot_be_read_stops_the_start(self):
        self.write("x" * 64)
        os.chmod(self.path, 0)
        with self.assertRaises(SystemExit):
            server.load_token()

    def test_a_failed_write_leaves_no_token_behind(self):
        with mock.patch.object(server.secrets, "token_urlsafe", side_effect=OSError("No space left on device")):
            with self.assertRaises(OSError):
                server.load_token()
        self.assertEqual(os.listdir(os.path.dirname(self.path)), [])

    def test_no_token_means_no_request_is_authorized(self):
        handler = server.Handler.__new__(server.Handler)
        handler.token = ""
        handler.headers = {"Authorization": "Bearer "}
        self.assertFalse(handler.authorized())


class CaptureTests(unittest.TestCase):
    """A caller that gives up must not leave a queue of recordings behind it, with the microphone on and nobody waiting."""

    def setUp(self):
        for name, found in (("find_cameras", [{"device": "/dev/video0", "name": "cam"}]), ("find_microphones", [{"device": "plughw:1,0", "name": "mic"}])):
            patcher = mock.patch.object(server, name, return_value=found)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_a_busy_capture_refuses_instead_of_queueing(self):
        for tool in ("record_audio", "capture_image"):
            with self.subTest(tool=tool), mock.patch.object(server, "CAPTURE_LOCK_WAIT_S", 0.05), mock.patch.object(server.subprocess, "run") as started:
                results = []
                server.capture_lock.acquire()
                try:
                    waiter = threading.Thread(target=lambda: results.append(call(tool)), daemon=True)
                    waiter.start()
                    waiter.join(2)
                    self.assertFalse(waiter.is_alive(), "still waiting for the lock")
                finally:
                    server.capture_lock.release()
                waiter.join(5)
                self.assertTrue(results[0][0], results[0])
                self.assertIn("busy", results[0][1])
                started.assert_not_called()

    def test_a_failed_capture_frees_the_lock(self):
        with mock.patch.object(server.subprocess, "run", side_effect=OSError("no gst-launch")):
            self.assertTrue(call("capture_image")[0])
        self.assertFalse(server.capture_lock.locked())


class ConnectionTests(unittest.TestCase):
    """The server on loopback: nothing here needs a token, so half-sent requests can't be allowed to pile up."""

    def serve(self, **attributes):
        board = server.BoardServer(("127.0.0.1", 0), server.Handler)
        for name, value in attributes.items():
            setattr(board, name, value)
        threading.Thread(target=board.serve_forever, daemon=True).start()
        self.addCleanup(board.server_close)
        self.addCleanup(board.shutdown)
        return board.server_address

    def half_sent(self, address):
        connection = socket.create_connection(address, timeout=5)
        self.addCleanup(connection.close)
        connection.sendall(b"POST /mcp HTTP/1.1\r\n")
        return connection

    def assert_dropped(self, connection):
        try:
            self.assertEqual(connection.recv(100), b"")
        except ConnectionError:
            pass

    def test_requests_have_a_time_limit(self):
        self.assertEqual(server.Handler.timeout, server.REQUEST_TIMEOUT_S)

    def test_a_half_sent_request_is_dropped(self):
        with mock.patch.object(server.Handler, "timeout", 0.2):
            self.assert_dropped(self.half_sent(self.serve()))

    def test_connections_past_the_limit_are_dropped_and_their_slots_come_back(self):
        slots = threading.BoundedSemaphore(2)
        address = self.serve(slots=slots)
        held = [self.half_sent(address), self.half_sent(address)]
        wait_for(lambda: slots._value == 0)
        self.assert_dropped(self.half_sent(address))
        for connection in held:
            connection.close()
        wait_for(lambda: slots._value == 2)


class SetupScriptTests(unittest.TestCase):
    """What setup-train.sh installs runs on the board with its GPU and this server's files, so all of it is pinned and checked."""

    def read(self, name):
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            return f.read()

    def test_every_package_is_pinned_with_a_hash(self):
        requirements = re.split(r"\n(?=\S)", re.sub(r"^\s*#.*\n", "", self.read("requirements-train.lock"), flags=re.M).strip())
        names = [line.split("==")[0] for line in requirements]
        for wanted in ("torch", "transformers", "peft", "accelerate", "safetensors", "numpy", "huggingface-hub", "pyyaml", "tqdm", "requests", "sentencepiece"):
            self.assertIn(wanted, names)
        for requirement in requirements:
            self.assertRegex(requirement, r"^[A-Za-z0-9._-]+==\S+ \\\n", requirement)
            self.assertIn("--hash=sha256:", requirement, requirement)

    def test_the_script_installs_only_from_the_lock(self):
        script = self.read("setup-train.sh")
        installs = [line for line in script.splitlines() if "uv pip install" in line]
        self.assertEqual(len(installs), 1, installs)
        self.assertIn("--require-hashes", installs[0])
        self.assertIn('-r "$LOCK"', installs[0])
        self.assertIn('/requirements-train.lock"', script)


if __name__ == "__main__":
    unittest.main()
