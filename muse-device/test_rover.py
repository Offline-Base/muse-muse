"""Tests for the rover kit (rover/, docs/ROVER.md). None needs the board, a microcontroller or a router.

  python -m unittest test_rover

The MessagePack codec, the router client against a fake router, the rover's tools in server.py against a fake sketch,
rover.json and its config header, the camera check, the self-test through the real tools, and setup-rover.sh with every
board command stubbed. Windows has no Unix sockets and no su, so the tests that need them skip there.
"""
import contextlib
import io
import json
import math
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import server
from rover import bridge_client, rover_config, selftest

HERE = os.path.dirname(os.path.abspath(__file__))
ROVER = os.path.join(HERE, "rover")
ON_LINUX = sys.platform.startswith("linux")
PIN_MAP = {
    "pwma": "D5", "ain1": "D4", "ain2": "D8", "pwmb": "D6", "bin1": "D12", "bin2": "D13", "stby": "A0",
    "enc_left": "D2", "enc_right": "D3", "servo_pan": "D9", "servo_tilt": "D10",
    "xshut_front": "A1", "xshut_left": "A2", "xshut_right": "A3",
}


def text(result):
    return result["content"][0]["text"]


def call(tool, /, **arguments):
    """Calls a tool as a client would. Returns (is_error, its text)."""
    result = server.handle_rpc("tools/call", {"name": tool, "arguments": arguments})
    return bool(result.get("isError")), text(result)


class MsgpackTests(unittest.TestCase):
    """The board's python3 has no msgpack module, so bridge_client has its own codec."""

    KNOWN = [
        (None, b"\xc0"), (False, b"\xc2"), (True, b"\xc3"),
        (0, b"\x00"), (127, b"\x7f"), (128, b"\xcc\x80"), (255, b"\xcc\xff"), (256, b"\xcd\x01\x00"),
        (65536, b"\xce\x00\x01\x00\x00"), (2**32, b"\xcf\x00\x00\x00\x01\x00\x00\x00\x00"),
        (-1, b"\xff"), (-32, b"\xe0"), (-33, b"\xd0\xdf"), (-129, b"\xd1\xff\x7f"), (-255, b"\xd1\xff\x01"),
        (-(2**31), b"\xd2\x80\x00\x00\x00"), (-(2**31) - 1, b"\xd3\xff\xff\xff\xff\x7f\xff\xff\xff"),
        (1.5, b"\xcb" + struct.pack(">d", 1.5)),
        ("", b"\xa0"), ("a", b"\xa1a"), ("x" * 32, b"\xd9\x20" + b"x" * 32), ("é", b"\xa2\xc3\xa9"),
        (b"", b"\xc4\x00"), (b"\x01\x02", b"\xc4\x02\x01\x02"),
        ([], b"\x90"), ([1, 2], b"\x92\x01\x02"), ({"a": 1}, b"\x81\xa1a\x01"),
        ([0, 7, "drive", [120, -120, 500]], b"\x94\x00\x07\xa5drive\x93\x78\xd0\x88\xcd\x01\xf4"),
    ]

    def test_values_encode_as_the_spec_says(self):
        for value, packed in self.KNOWN:
            with self.subTest(value=value):
                self.assertEqual(bridge_client.packb(value), packed)
                self.assertEqual(bridge_client.unpackb(packed), value)

    def test_every_size_round_trips(self):
        values = [
            2**8 - 1, 2**16 - 1, 2**16, 2**32 - 1, 2**64 - 1, -(2**7), -(2**15), -(2**15) - 1, -(2**63),
            0.0, -2.5, 1e300, float("inf"),
            "x" * 31, "x" * 255, "x" * 256, "x" * 65536, "snow ☃ and 🤖",
            b"\x00" * 255, b"\x00" * 256, b"\xff" * 65536,
            list(range(15)), list(range(16)), list(range(65536)),
            {str(i): i for i in range(15)}, {str(i): i for i in range(16)}, {1: "one", None: [True, {"b": b"\x01"}]},
            bridge_client.Ext(5, b"\x01"), bridge_client.Ext(-1, b"\x00" * 8), bridge_client.Ext(9, b"\x00" * 3),
        ]
        for value in values:
            with self.subTest(value=repr(value)[:40]):
                self.assertEqual(bridge_client.unpackb(bridge_client.packb(value)), value)
        self.assertEqual(bridge_client.unpackb(bridge_client.packb((1, "two"))), [1, "two"])
        self.assertTrue(math.isnan(bridge_client.unpackb(bridge_client.packb(float("nan")))))

    def test_float32_and_ext_from_others_decode(self):
        self.assertEqual(bridge_client.unpackb(b"\xca" + struct.pack(">f", 0.25)), 0.25)
        self.assertEqual(bridge_client.unpackb(b"\xd4\x01\x09"), bridge_client.Ext(1, b"\x09"))
        self.assertEqual(bridge_client.unpackb(b"\xc7\x03\xff\x01\x02\x03"), bridge_client.Ext(-1, b"\x01\x02\x03"))

    def test_every_cut_short_value_is_incomplete(self):
        for value, packed in self.KNOWN:
            for end in range(len(packed)):
                with self.subTest(value=value, end=end), self.assertRaises(bridge_client.Incomplete):
                    bridge_client.unpackb(packed[:end])

    def test_bad_bytes_are_refused(self):
        for data in (b"\xc1", b"\x01\x02", b"\x81\x91\x01\x02", b"\x91" * 40 + b"\x00"):
            with self.subTest(data=data[:4]), self.assertRaises(bridge_client.MsgpackError):
                bridge_client.unpackb(data)

    def test_a_made_up_count_costs_nothing(self):
        start = time.monotonic()
        for data in (b"\xdd\xff\xff\xff\xff", b"\xdf\xff\xff\xff\xff\x01", b"\xdb\xff\xff\xff\xff"):
            with self.assertRaises(bridge_client.Incomplete):
                bridge_client.unpackb(data)
        self.assertLess(time.monotonic() - start, 0.5)

    def test_what_messagepack_cannot_hold_is_refused(self):
        deep = []
        for _ in range(40):
            deep = [deep]
        for value in (2**64, -(2**63) - 1, object(), {1, 2}, bridge_client.Ext(200, b""), deep):
            with self.subTest(value=repr(value)[:30]), self.assertRaises(bridge_client.MsgpackError):
                bridge_client.packb(value)

    def test_a_stream_gives_whole_values_as_they_arrive(self):
        stream = bridge_client.packb([2, "log", ["hi"]]) + bridge_client.packb([1, 3, None, "done"])
        unpacker = bridge_client.Unpacker()
        got = []
        for byte in stream:
            unpacker.feed(bytes([byte]))
            got += list(unpacker.values())
        self.assertEqual(got, [[2, "log", ["hi"]], [1, 3, None, "done"]])


class FakeRouter:
    """Stands in for arduino-router on one end of a connection. reply(msgid, method, params) gives the bytes to send back,
    as a list of chunks, or None to say nothing."""

    def __init__(self, reply):
        self.reply = reply
        self.requests = []
        self.threads = []

    def serve(self, sock):
        unpacker = bridge_client.Unpacker()
        with sock:
            while True:
                try:
                    data = sock.recv(4096)
                except OSError:
                    return
                if not data:
                    return
                unpacker.feed(data)
                for message in unpacker.values():
                    self.requests.append(message)
                    chunks = self.reply(message[1], message[2], message[3])
                    if chunks is None:
                        continue
                    if chunks == "close":
                        return
                    try:
                        for chunk in chunks:
                            sock.sendall(chunk)
                            time.sleep(0.001)
                    except OSError:
                        return

    def start(self, sock):
        thread = threading.Thread(target=self.serve, args=(sock,), daemon=True)
        thread.start()
        self.threads.append(thread)

    def open_socket(self, _path, timeout):
        """bridge_client.open_socket's stand-in: a connected pair, the far end served here."""
        near, far = socket.socketpair()
        near.settimeout(timeout)
        self.start(far)
        return near


def answer(msgid, result=None, error=None):
    return [bridge_client.packb([1, msgid, error, result])]


class RouterClientTests(unittest.TestCase):
    """bridge_client.call against a fake router, through a socket pair, so these run anywhere."""

    def router(self, reply):
        fake = FakeRouter(reply)
        patcher = mock.patch.object(bridge_client, "open_socket", fake.open_socket)
        patcher.start()
        self.addCleanup(patcher.stop)
        return fake

    def test_a_call_sends_a_request_and_gets_its_result(self):
        fake = self.router(lambda msgid, method, params: answer(msgid, '{"ok":true}'))
        self.assertEqual(bridge_client.call("drive", (120, -120, 500)), '{"ok":true}')
        self.assertEqual(fake.requests[0][0], 0)
        self.assertEqual(fake.requests[0][2:], ["drive", [120, -120, 500]])

    def test_each_call_has_its_own_id(self):
        fake = self.router(lambda msgid, method, params: answer(msgid, msgid))
        first, second = bridge_client.call("status"), bridge_client.call("status")
        self.assertNotEqual(first, second)
        self.assertEqual([request[1] for request in fake.requests], [first, second])

    def test_an_error_comes_back_in_words(self):
        self.router(lambda msgid, method, params: answer(msgid, error=[1, "method drive not available"]))
        with self.assertRaises(bridge_client.BridgeError) as caught:
            bridge_client.call("drive", (1, 1, 1))
        self.assertIn("The router answered drive with an error: method drive not available", str(caught.exception))
        for error, words in (("plain", "plain"), (b"bytes", "bytes"), ({"message": "dict"}, "dict"), ([7], "7")):
            self.assertEqual(bridge_client.describe_error(error), words)

    def test_notifications_and_other_answers_are_passed_over(self):
        def reply(msgid, method, params):
            return [bridge_client.packb([2, "log", ["booting"]]), bridge_client.packb([1, msgid + 1, None, "not this"]), bridge_client.packb([0, 99, "ask", []])] + answer(msgid, "this")

        self.router(reply)
        self.assertEqual(bridge_client.call("ranges"), "this")

    def test_an_answer_that_arrives_a_byte_at_a_time(self):
        self.router(lambda msgid, method, params: [bytes([b]) for b in answer(msgid, {"front": 123, "left": -1})[0]])
        self.assertEqual(bridge_client.call("ranges"), {"front": 123, "left": -1})

    def test_no_answer_times_out_in_time(self):
        self.router(lambda msgid, method, params: None)
        start = time.monotonic()
        with self.assertRaises(bridge_client.BridgeError) as caught:
            bridge_client.call("status", timeout=0.3)
        self.assertIn("No answer to status within 0.3 seconds", str(caught.exception))
        self.assertLess(time.monotonic() - start, 2)

    def test_a_trickle_of_other_messages_still_times_out(self):
        self.router(lambda msgid, method, params: [bridge_client.packb([2, "tick", []])] * 50)
        with self.assertRaises(bridge_client.BridgeError):
            bridge_client.call("status", timeout=0.03)

    def test_a_router_that_hangs_up_or_talks_nonsense(self):
        self.router(lambda msgid, method, params: "close")
        with self.assertRaises(bridge_client.BridgeError) as caught:
            bridge_client.call("status")
        self.assertIn("closed the connection without answering status", str(caught.exception))
        self.router(lambda msgid, method, params: [b"\xc1"])
        with self.assertRaises(bridge_client.BridgeError) as caught:
            bridge_client.call("status")
        self.assertIn("isn't MessagePack", str(caught.exception))

    def test_the_command_line_prints_the_result_or_why_not(self):
        self.router(lambda msgid, method, params: answer(msgid, f"{method} {params}"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(bridge_client.main(["drive", "120", "-5", "fast"]), 0)
        self.assertEqual(out.getvalue().strip(), "drive [120, -5, 'fast']")
        self.router(lambda msgid, method, params: answer(msgid, error="no"))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(bridge_client.main(["status"]), 1)
        self.assertIn("with an error: no", err.getvalue())


@unittest.skipUnless(hasattr(socket, "AF_UNIX"), "needs Unix sockets")
class RouterSocketTests(unittest.TestCase):
    """The real open_socket, against a fake router listening on a Unix socket as arduino-router does."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = os.path.join(self.dir, "arduino-router.sock")

    def listen(self, reply):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(self.path)
        listener.listen()
        self.addCleanup(listener.close)
        fake = FakeRouter(reply)

        def accept():
            while True:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    return
                fake.start(conn)

        threading.Thread(target=accept, daemon=True).start()
        return fake

    def test_a_call_through_a_unix_socket(self):
        self.listen(lambda msgid, method, params: answer(msgid, params[0] * 2))
        self.assertEqual(bridge_client.call("double", [21], path=self.path), 42)

    def test_no_socket_says_the_router_is_not_running(self):
        with self.assertRaises(bridge_client.BridgeError) as caught:
            bridge_client.call("status", path=self.path)
        self.assertIn("arduino-router isn't running", str(caught.exception))

    def test_a_socket_nobody_listens_on(self):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(self.path)
        listener.close()
        with self.assertRaises(bridge_client.BridgeError) as caught:
            bridge_client.call("status", path=self.path)
        self.assertIn("Nothing is listening", str(caught.exception))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root opens a socket whatever its mode")
    def test_a_socket_this_user_may_not_open_says_which_group(self):
        self.listen(lambda msgid, method, params: answer(msgid, "no"))
        os.chmod(self.path, 0)
        with self.assertRaises(bridge_client.BridgeError) as caught:
            bridge_client.call("status", path=self.path)
        self.assertIn("setup-rover.sh adds", str(caught.exception))


class FakeSketch:
    """Answers as sketch.ino does, from made-up hardware: two wheels with encoders, a mount that tilts only 45 degrees each
    way, and three distance sensors."""

    def __init__(self, ranges=None, blocked="", right_encoder=True):
        self.calls = []
        self.ranges = ranges or {"front": 400, "left": 250, "right": 8190}
        self.blocked = blocked
        self.right_encoder = right_encoder
        self.ticks = {"left": 0, "right": 0}
        self.pan = self.tilt = 0
        self.last_stop = "nothing has driven yet"
        self.fail = None

    def call(self, method, params=(), path=None, timeout=None):
        params = list(params)
        self.calls.append((method, params))
        if self.fail:
            raise self.fail
        if method == "drive":
            left, right, ms = params
            if left > 0 and right > 0 and self.blocked:
                return json.dumps({"ok": False, "why": self.blocked})
            for side, speed in (("left", left), ("right", right)):
                if speed and (side == "left" or self.right_encoder):
                    self.ticks[side] += 12 if speed > 0 else -12
            self.last_stop = f"the drive's {ms} ms were up"
            return json.dumps({"ok": True, "left": left, "right": right, "ms": ms})
        if method == "stop":
            self.last_stop = "stop was called"
            return '{"ok":true}'
        if method == "look":
            self.pan, self.tilt = max(-90, min(90, params[0])), max(-45, min(45, params[1]))
            return json.dumps({"ok": True, "pan": self.pan, "tilt": self.tilt})
        if method == "ranges":
            return json.dumps(self.ranges)
        if method == "ticks":
            return json.dumps(self.ticks)
        if method == "status":
            present = {side: self.ranges[side] != -1 for side in ("front", "left", "right")}
            return json.dumps({"version": "muse-rover 1", "driving": False, "left": 0, "right": 0, "ms_left": 0, "last_stop": self.last_stop,
                               "front_block": self.blocked, "stop_mm": 150, "max_drive_ms": 3000, "pan": self.pan, "tilt": self.tilt,
                               "servos_on": False, "late_pulses": 0, "sensors": present, "uptime_ms": 1000})
        raise bridge_client.BridgeError(f"The router answered {method} with an error: method not available.")


class RoverToolTests(unittest.TestCase):
    """The rover's tools in server.py, against a fake sketch. The limits are the server's as well as the sketch's."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.sketch = FakeSketch()
        self.sleeps = []
        patches = [
            mock.patch.object(server, "ROVER_FILE", os.path.join(self.dir, "rover.json")),
            mock.patch.object(server.bridge_client, "call", side_effect=lambda *a, **k: self.sketch.call(*a, **k)),
            mock.patch.object(server.time, "sleep", side_effect=self.sleeps.append),
            mock.patch.dict(server.TOOLS),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        with open(server.ROVER_FILE, "w") as f:
            json.dump(rover_config.DEFAULT, f)
        self.assertTrue(server.offer_rover_tools())

    def sent(self, method):
        return [params for name, params in self.sketch.calls if name == method]

    def test_the_tools_are_offered_only_where_rover_json_is(self):
        tools = {tool["name"]: tool for tool in server.handle_rpc("tools/list", {})["tools"]}
        for name in ("drive", "stop", "look", "ranges", "rover_status", "capture_image"):
            self.assertIn(name, tools)
        self.assertTrue(tools["ranges"]["annotations"]["readOnlyHint"])
        self.assertTrue(tools["rover_status"]["annotations"]["readOnlyHint"])
        self.assertNotIn("annotations", tools["drive"])
        self.assertIn("3000 ms", tools["drive"]["description"])
        os.remove(server.ROVER_FILE)
        with mock.patch.dict(server.TOOLS, clear=False):
            for name in server.ROVER_TOOLS:
                server.TOOLS.pop(name)
            self.assertFalse(server.offer_rover_tools())
            self.assertNotIn("drive", server.TOOLS)

    def test_the_server_offers_them_without_tls_only(self):
        for argv, offered in ((["server.py"], True), (["server.py", "--tls"], False)):
            with self.subTest(argv=argv), mock.patch.dict(server.TOOLS, clear=False), mock.patch.object(sys, "argv", argv), mock.patch.object(server, "serve"):
                for name in server.ROVER_TOOLS:
                    server.TOOLS.pop(name, None)
                server.main()
                self.assertEqual("drive" in server.TOOLS, offered)

    def test_speeds_are_clamped_and_the_time_capped(self):
        error, reply = call("drive", left=300, right=-999, ms=5000)
        self.assertFalse(error, reply)
        self.assertEqual(self.sent("drive"), [[255, -255, 3000]])
        reply = json.loads(reply)
        self.assertEqual((reply["left"], reply["right"], reply["ms"]), (255, -255, 3000))
        self.assertEqual(reply["clamped"], ["left 300 became 255", "right -999 became -255", "ms 5000 became 3000"])
        self.assertEqual(self.sleeps, [3000 / 1000 + server.ROVER_STOP_SETTLE_S])

    def test_a_drive_waits_and_says_why_it_stopped(self):
        reply = json.loads(call("drive", left=120, right=120, ms=400)[1])
        self.assertEqual(reply["stopped_because"], "the drive's 400 ms were up")
        self.assertEqual(reply["ticks"], {"left": 12, "right": 12})
        self.assertFalse(reply["driving"])
        self.assertNotIn("clamped", reply)
        self.assertEqual(self.sent("drive"), [[120, 120, 400]])

    def test_without_wait_it_returns_at_once(self):
        reply = json.loads(call("drive", left=-80.4, right=80.6, wait=False)[1])
        self.assertEqual(self.sent("drive"), [[-80, 81, 500]])
        self.assertEqual(self.sleeps, [])
        self.assertNotIn("ticks", reply)
        self.assertEqual(len(self.sketch.calls), 1)

    def test_values_that_are_not_numbers_are_refused_before_the_rover_moves(self):
        for arguments in ({"left": "fast", "right": 1}, {"left": True, "right": 1}, {"right": 1}, {"left": 1, "right": float("nan")},
                          {"left": 1, "right": float("inf")}, {"left": 1, "right": 1, "ms": [5]}, {"left": 1, "right": 1, "wait": "yes"}):
            with self.subTest(arguments=arguments):
                error, reply = call("drive", **arguments)
                self.assertTrue(error, reply)
                self.assertRegex(reply, r"must be|is needed")
        self.assertEqual(self.sketch.calls, [])

    def test_a_drive_the_rover_refuses_is_an_error_with_its_reason(self):
        self.sketch.blocked = "something is 120 mm ahead, closer than the 150 mm stop distance"
        error, reply = call("drive", left=150, right=150)
        self.assertTrue(error)
        self.assertIn("The rover didn't move: something is 120 mm ahead, closer than the 150 mm stop distance.", reply)
        self.assertIn("Backing up and turning on the spot still work", reply)
        self.assertFalse(call("drive", left=-150, right=-150)[0])

    def test_a_bridge_that_fails_is_a_plain_error(self):
        self.sketch.fail = bridge_client.BridgeError("There is no router socket at /var/run/arduino-router.sock, so arduino-router isn't running on this board.")
        for tool, arguments in (("drive", {"left": 1, "right": 1}), ("stop", {}), ("look", {"pan": 1, "tilt": 1}), ("ranges", {}), ("rover_status", {})):
            with self.subTest(tool=tool):
                error, reply = call(tool, **arguments)
                self.assertTrue(error)
                self.assertTrue(reply.startswith(f"The rover didn't answer {tool if tool != 'rover_status' else 'status'}. There is no router socket"), reply)
                self.assertIn("setup-rover.sh starts it", reply)
                self.assertNotIn("Traceback", reply)

    def test_an_answer_the_server_cannot_read(self):
        for bad in ("not json", "[1, 2]", None, 5):
            with self.subTest(bad=bad), mock.patch.object(server.bridge_client, "call", return_value=bad):
                error, reply = call("ranges")
                self.assertTrue(error)
                self.assertIn("isn't one this server can read", reply)

    def test_stop(self):
        self.assertEqual(call("stop"), (False, '{"stopped": true}'))
        self.assertEqual(self.sent("stop"), [[]])

    def test_look_holds_to_the_mount_and_keeps_the_axis_not_given(self):
        error, reply = call("look", pan=40, tilt=-10)
        self.assertFalse(error, reply)
        self.assertEqual(json.loads(reply), {"pan": 40, "tilt": -10})
        self.assertEqual(self.sleeps, [server.ROVER_LOOK_SETTLE_S])
        reply = json.loads(call("look", tilt=80)[1])
        self.assertEqual(self.sent("look")[-1], [40, 80])
        self.assertEqual((reply["pan"], reply["tilt"]), (40, 45))
        self.assertEqual(reply["clamped"], ["the mount's limits in rover.json held it to pan 40 and tilt 45"])
        reply = json.loads(call("look", pan=-200)[1])
        self.assertEqual(self.sent("look")[-1], [-90, 45])
        self.assertIn("pan -200 became -90", reply["clamped"])
        error, reply = call("look")
        self.assertTrue(error)
        self.assertIn("Give pan, tilt or both", reply)

    def test_ranges_say_which_sensor_is_missing_and_which_sees_nothing(self):
        self.sketch.ranges = {"front": 123, "left": -1, "right": 8190}
        reply = json.loads(call("ranges")[1])
        self.assertEqual(reply, {"front_mm": 123, "left_mm": None, "right_mm": None, "sensors": {"front": "ok", "left": "missing", "right": "clear"}})
        self.assertEqual(server.range_report({"front": "x", "left": True})["sensors"], {"front": "missing", "left": "missing", "right": "missing"})

    def test_rover_status_has_the_ticks_and_ranges_too(self):
        call("drive", left=-100, right=0, ms=200)
        reply = json.loads(call("rover_status")[1])
        self.assertEqual(reply["ticks"], {"left": -12, "right": 0})
        self.assertEqual(reply["ranges"]["front_mm"], 400)
        self.assertEqual(reply["stop_mm"], 150)
        self.assertEqual(reply["last_stop"], "the drive's 200 ms were up")


class CameraTests(unittest.TestCase):
    """capture_image picks the first video node that captures. On the UNO Q, video0 and video1 are the codec's."""

    @staticmethod
    def fake_ioctl(caps_by_fd):
        def ioctl(fd, request, buffer):
            if request != server.VIDIOC_QUERYCAP:
                raise OSError("unexpected ioctl")
            capabilities, device_caps = caps_by_fd[fd]
            struct.pack_into("=II", buffer, 84, capabilities, device_caps)
        return mock.Mock(ioctl=ioctl)

    def test_a_codec_is_not_a_camera(self):
        nodes = {"/dev/video0": 10, "/dev/video1": 11, "/dev/video2": 12, "/dev/video4": 14}
        caps = {
            10: (server.V4L2_CAP_DEVICE_CAPS | 0x4000 | 0x04000000, 0x4000 | 0x04000000),  # memory to memory, streaming
            11: (server.V4L2_CAP_DEVICE_CAPS | 0x4000, 0x4000),
            12: (server.V4L2_CAP_DEVICE_CAPS | 0x1 | 0x00800000, 0x1 | 0x04000000),  # a UVC camera's capture node
            14: (0x1, 0),  # an old driver with no device caps
        }
        with mock.patch.object(server, "fcntl", self.fake_ioctl(caps)), mock.patch.object(server.os, "open", side_effect=lambda path, flags: nodes[path]), mock.patch.object(server.os, "close"):
            self.assertEqual([server.captures_video(node) for node in nodes], [False, False, True, True])

    def test_a_node_it_cannot_open_or_ask_counts_as_before(self):
        with mock.patch.object(server, "fcntl", mock.Mock(ioctl=mock.Mock(side_effect=OSError("no")))), mock.patch.object(server.os, "open", return_value=3), mock.patch.object(server.os, "close"):
            self.assertTrue(server.captures_video("/dev/video0"))
        with mock.patch.object(server, "fcntl", mock.Mock()), mock.patch.object(server.os, "open", side_effect=PermissionError("not in video")):
            self.assertTrue(server.captures_video("/dev/video0"))
        with mock.patch.object(server, "fcntl", None):
            self.assertTrue(server.captures_video("/dev/video0"))

    def test_find_cameras_skips_the_codec(self):
        nodes = ["/sys/class/video4linux/video0", "/sys/class/video4linux/video1", "/sys/class/video4linux/video2", "/sys/class/video4linux/video3"]
        index = {"video0": "0", "video1": "0", "video2": "0", "video3": "1"}
        with mock.patch.object(server.glob, "glob", return_value=nodes), \
                mock.patch.object(server, "read_text", side_effect=lambda path: index[path.split("/")[-2]] if path.endswith("index") else "HD Pro Webcam C920"), \
                mock.patch.object(server, "captures_video", side_effect=lambda device: device == "/dev/video2"):
            self.assertEqual(server.find_cameras(), [{"device": "/dev/video2", "name": "HD Pro Webcam C920"}])


class ConfigTests(unittest.TestCase):
    """rover.json and rover_config.h: one config, checked before anything uses it."""

    def test_the_defaults_are_the_wiring_in_the_docs(self):
        self.assertEqual(rover_config.DEFAULT["pins"], PIN_MAP)
        self.assertEqual(rover_config.DEFAULT["driver"], "tb6612")
        self.assertEqual(rover_config.DEFAULT["stop_mm"], 150)
        self.assertEqual(rover_config.build(), rover_config.DEFAULT)

    def test_flags_change_only_what_they_name(self):
        config = rover_config.build(pins=["PWMA=d9", "servo_pan = D5"], stop_mm=200, invert=["right", "tilt"])
        self.assertEqual(config["pins"], {**PIN_MAP, "pwma": "D9", "servo_pan": "D5"})
        self.assertEqual(config["stop_mm"], 200)
        self.assertEqual(config["invert"], {"left": False, "right": True, "pan": False, "tilt": True})

    def test_a_run_again_keeps_what_an_earlier_one_set_unless_reset(self):
        earlier = rover_config.build(pins=["stby=A5"], stop_mm=300)
        self.assertEqual(rover_config.build(earlier)["pins"]["stby"], "A5")
        self.assertEqual(rover_config.build(earlier)["stop_mm"], 300)
        self.assertEqual(rover_config.build(earlier, reset=True), rover_config.DEFAULT)
        self.assertEqual(rover_config.build({"driver": "l298n"}), rover_config.DEFAULT)

    def test_a_config_that_cannot_drive_the_rover_is_refused(self):
        for kwargs, words in (
            ({"pins": ["wheel=D5"]}, "no pin role called wheel"),
            ({"pins": ["stby=D0"]}, "D0 and D1 are the header's serial port"),
            ({"pins": ["stby=D14"]}, "must be D2 to D13 or A0 to A5"),
            ({"pins": ["stby=A6"]}, "must be D2 to D13 or A0 to A5"),
            ({"pins": ["stby=5"]}, "must be D2 to D13 or A0 to A5"),
            ({"pins": ["pwma=D4"]}, "pwma is D4, which has no PWM"),
            ({"pins": ["ain1=D5"]}, "pwma and ain1 are both on D5"),
            ({"stop_mm": 10}, "stop_mm must be"),
            ({"stop_mm": True}, "stop_mm must be"),
            ({"invert": ["wheels"]}, "nothing called wheels"),
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(rover_config.ConfigError) as caught:
                rover_config.build(**kwargs)
            self.assertIn(words, str(caught.exception))
        for key, value in (("pan_deg", [10, 10]), ("tilt_deg", [-100, 0]), ("servo_us", [500]), ("servo_hold_ms", -1), ("need_front_sensor", 1)):
            with self.subTest(key=key), self.assertRaises(rover_config.ConfigError):
                rover_config.check({**rover_config.DEFAULT, key: value})

    def test_the_committed_header_is_the_defaults(self):
        with open(os.path.join(ROVER, "app", "sketch", "rover_config.h"), encoding="utf-8") as f:
            self.assertEqual(f.read(), rover_config.render_header(rover_config.DEFAULT))

    def test_the_header_names_each_pin_as_the_core_does(self):
        header = rover_config.render_header(rover_config.build(pins=["stby=D7"], stop_mm=220, invert=["left"]))
        self.assertIn("#define ROVER_PIN_STBY 7  // D7\n", header)
        self.assertIn("#define ROVER_PIN_XSHUT_FRONT A1\n", header)
        self.assertIn("#define ROVER_STOP_MM 220\n", header)
        self.assertIn("#define ROVER_LEFT_INVERT 1\n", header)
        self.assertIn("#define ROVER_MAX_DRIVE_MS 3000\n", header)
        self.assertIn("#define ROVER_TILT_MIN_DEG (-45)\n", header)
        # Every name the sketch uses is defined.
        with open(os.path.join(ROVER, "app", "sketch", "sketch.ino"), encoding="utf-8") as f:
            sketch = f.read()
        for name in set(re.findall(r"\bROVER_[A-Z_]+\b", sketch)) - {"ROVER_VERSION"}:
            self.assertIn(f"#define {name} ", header, name)

    def test_the_command_line_writes_both_files(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        config, header = os.path.join(folder, "rover.json"), os.path.join(folder, "rover_config.h")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(rover_config.main(["write", config, "--pin", "enc_left=D7", "--stop-mm", "180"]), 0)
            self.assertEqual(rover_config.main(["write", config, "--invert", "pan"]), 0)
            self.assertEqual(rover_config.main(["header", config, header]), 0)
        saved = rover_config.read_config(config)
        self.assertEqual((saved["pins"]["enc_left"], saved["stop_mm"], saved["invert"]["pan"]), ("D7", 180, True))
        with open(header, encoding="utf-8") as f:
            self.assertIn("#define ROVER_PIN_ENC_LEFT 7", f.read())
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(rover_config.main(["write", config, "--pin", "pwmb=A0"]), 1)
            self.assertEqual(rover_config.main(["header", os.path.join(folder, "none.json"), header]), 1)
        self.assertIn("pwmb is A0, which has no PWM", err.getvalue())
        self.assertEqual(rover_config.read_config(config)["pins"]["pwmb"], "D6")


class InProcessBoard(selftest.Board):
    """selftest's Board, calling this server's handle_rpc directly rather than over HTTP."""

    def rpc(self, method, params=None):
        return server.handle_rpc(method, params or {})


class SelfTestTests(unittest.TestCase):
    """selftest.py through the real rover tools, with a fake sketch behind them."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.sketch = FakeSketch()
        self.cameras = []
        patches = [
            mock.patch.object(server, "ROVER_FILE", os.path.join(self.dir, "rover.json")),
            mock.patch.object(server.bridge_client, "call", side_effect=lambda *a, **k: self.sketch.call(*a, **k)),
            mock.patch.object(server.time, "sleep"),
            mock.patch.object(server, "find_cameras", side_effect=lambda: self.cameras),
            mock.patch.dict(server.TOOLS),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        with open(server.ROVER_FILE, "w") as f:
            json.dump(rover_config.DEFAULT, f)
        server.offer_rover_tools()

    def run_test(self):
        return selftest.run(InProcessBoard(8765, "x" * 43))

    def test_a_working_rover_passes_and_skips_the_photo_without_a_camera(self):
        checks, seen = self.run_test()
        self.assertTrue(selftest.passed(checks), checks)
        self.assertEqual(checks["photo"], "skipped: no camera is attached")
        self.assertEqual((seen["left_ticks"], seen["right_ticks"]), ({"left": 12, "right": 0}, {"left": 0, "right": 12}))
        drives = [params for name, params in self.sketch.calls if name == "drive"]
        self.assertEqual(drives, [[selftest.WHEEL_SPEED, 0, selftest.WHEEL_MS], [0, selftest.WHEEL_SPEED, selftest.WHEEL_MS]])
        self.assertIn(("look", [0, 0]), self.sketch.calls)
        self.assertEqual(self.sketch.calls[-1][0], "stop")

    def test_a_camera_takes_a_photo(self):
        self.cameras = [{"device": "/dev/video2", "name": "HD Pro Webcam C920"}]
        photo = {"content": [{"type": "image", "data": "AAEC", "mimeType": "image/jpeg"}]}
        with mock.patch.dict(server.TOOLS, {"capture_image": (lambda args: photo, server.TOOLS["capture_image"][1])}):
            checks, seen = self.run_test()
        self.assertEqual(checks["photo"], "ok")
        self.assertEqual((seen["photo_bytes"], seen["camera"]), (3, "HD Pro Webcam C920"))

    def test_what_fails_says_what_to_check(self):
        self.sketch = FakeSketch(ranges={"front": 300, "left": -1, "right": 500}, right_encoder=False)
        checks, _ = self.run_test()
        self.assertFalse(selftest.passed(checks))
        self.assertIn("left distance sensor isn't answering", checks["ranges"])
        self.assertIn("no encoder ticks while the right wheel was driven", checks["right_wheel"])
        self.assertEqual(checks["left_wheel"], "ok")

    def test_swapped_encoders_are_named(self):
        board = InProcessBoard(8765, "x")
        with mock.patch.object(board, "tool", return_value=(True, json.dumps({"ticks": {"left": 0, "right": 9}}), [])):
            result, moved = selftest.wheel_check(board, "left", {"left": 0, "right": 0})
        self.assertIn("encoder wires look swapped", result)
        self.assertEqual(moved, {"left": 0, "right": 9})

    def test_no_sketch_or_no_rover_tools(self):
        self.sketch.fail = bridge_client.BridgeError("No answer to status within 3 seconds.")
        checks, _ = self.run_test()
        self.assertIn("No answer to status within 3 seconds", checks["sketch"])
        self.assertNotIn("left_wheel", checks)
        for name in server.ROVER_TOOLS:
            server.TOOLS.pop(name)
        checks, _ = self.run_test()
        self.assertIn("the server doesn't offer drive, stop, look, ranges, rover_status", checks["rover_tools"])

    def test_main_prints_one_line_and_never_the_token(self):
        token_file = os.path.join(self.dir, "token")
        token = "s3cret-" + "t" * 40
        with open(token_file, "w") as f:
            f.write(token + "\n")
        out = io.StringIO()
        with mock.patch.object(selftest, "TOKEN_FILE", token_file), mock.patch.object(selftest, "Board", InProcessBoard), contextlib.redirect_stdout(out):
            self.assertEqual(selftest.main([]), 0)
        self.assertNotIn(token, out.getvalue())
        self.assertEqual(len(out.getvalue().splitlines()), 1)
        self.assertTrue(json.loads(out.getvalue())["ok"])
        out = io.StringIO()
        with mock.patch.object(selftest, "TOKEN_FILE", os.path.join(self.dir, "none")), contextlib.redirect_stdout(out):
            self.assertEqual(selftest.main([]), 1)
        self.assertIn("no readable ~/.muse-device/token", out.getvalue())

    def test_a_server_that_is_not_up_and_a_sketch_asked_directly(self):
        with mock.patch.object(selftest, "SERVER_WAIT_S", 0), mock.patch.object(selftest.bridge_client, "call", side_effect=selftest.bridge_client.BridgeError("There is no router socket.")):
            checks, _ = selftest.run(selftest.Board(1, "x"))
        self.assertIn("the server isn't answering on http://127.0.0.1:1/mcp", checks["server"])
        self.assertEqual(checks["sketch"], "There is no router socket.")


class SetupScriptTextTests(unittest.TestCase):
    """What setup-rover.sh may and may not touch, read from the script itself."""

    def setUp(self):
        with open(os.path.join(ROVER, "setup-rover.sh"), encoding="utf-8") as f:
            self.script = f.read()
        self.code = "\n".join(line for line in self.script.splitlines() if not line.lstrip().startswith("#"))

    def test_it_never_reads_the_token_or_touches_what_it_must_not(self):
        self.assertNotIn("token", self.code)
        for word in ("docker", "jetson", "systemctl restart", "systemctl stop", "arduino-router.service", "/etc/systemd"):
            self.assertNotIn(word, self.code, word)

    def test_it_reports_one_marked_line_and_runs_user_work_as_the_user(self):
        self.assertIn('print("MUSE_ROVER_REPORT " + json.dumps(', self.code)
        self.assertIn('su - "$ROVER_USER" -c', self.code)
        self.assertIn("properties set default", self.code)
        self.assertIn("app start", self.code)
        self.assertNotIn("chown", self.code)

    def test_every_time_limit_goes_through_the_runs_deadline(self):
        limited = [line.strip() for line in self.code.splitlines() if re.search(r"\btimeout\s+[-\d\"$]", line)]
        self.assertEqual(limited, ['timeout -k 10 "$limit" "$@"'])

    @unittest.skipUnless(shutil.which("bash") and ON_LINUX, "needs bash on Linux")
    def test_bash_reads_it(self):
        subprocess.run(["bash", "-n", os.path.join(ROVER, "setup-rover.sh")], check=True)


@unittest.skipUnless(shutil.which("g++"), "needs g++")
class SketchOnHostTests(unittest.TestCase):
    """sketch.ino's own setup() and loop() on this computer, through rover/host_check: a made-up clock, pins and three VL53L0X
    sensors. It checks the sketch's logic, the safety stop above all, and nothing about the board's own APIs."""

    def test_the_sketch_builds_and_its_checks_pass(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        check = os.path.join(ROVER, "host_check")
        program = os.path.join(folder, "sketch_sim")
        # The compiler's own folder first, so on Windows it loads its own DLLs rather than another toolchain's.
        compiler = shutil.which("g++")
        env = {**os.environ, "PATH": os.path.dirname(compiler) + os.pathsep + os.environ.get("PATH", "")}
        built = subprocess.run([compiler, "-std=gnu++17", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-I", check, "-I", os.path.join(ROVER, "app", "sketch"),
                                os.path.join(check, "sketch_sim.cpp"), "-o", program], capture_output=True, text=True, timeout=180, env=env)
        self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
        done = subprocess.run([program], capture_output=True, text=True, timeout=60, env=env)
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertNotIn("FAIL", done.stdout)
        self.assertTrue(done.stdout.strip().endswith("ALL PASSED"), done.stdout)


STUBS = {
    # Root only for the script itself: what it runs as the user gets the real id.
    "id": '[ "$1" = -u ] && [ -n "${FAKE_ROOT:-}" ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"',
    "getent": '[ "$1" = passwd ] && { echo "$2:x:1000:1000::$FAKE_HOME:/bin/bash"; exit 0; }\nexec /usr/bin/getent "$@"',
    # autostart.sh puts PATH back to the system's, so its install would reach this machine's real crontab: the stub adds the
    # line itself and runs the check alone.
    "su": (
        'if [[ "$4" == *"autostart.sh install"* ]]; then\n'
        '  line="* * * * * /bin/bash $FAKE_HOME/muse-device/autostart.sh"\n'
        '  grep -qxF "$line" "$FAKE_HOME/crontab" 2>/dev/null || echo "$line" >> "$FAKE_HOME/crontab"\n'
        'fi\n'
        'cd "$FAKE_HOME" && exec env -u FAKE_ROOT HOME="$FAKE_HOME" /bin/bash -c "${4/autostart.sh install/autostart.sh}"'
    ),
    "usermod": 'echo "usermod $*" >> "$FAKE_LOG"',
    "apt-get": 'echo "apt-get $*" >> "$FAKE_LOG"',
    "systemctl": 'echo "systemctl $*" >> "$FAKE_LOG"',
    "crontab": '[ "$1" = -l ] && { cat "$FAKE_HOME/crontab" 2>/dev/null || { echo "no crontab for you" >&2; exit 1; }; exit 0; }\n[ "$1" = - ] && cat > "$FAKE_HOME/crontab"',
    "arduino-app-cli": (
        'echo "arduino-app-cli $*" >> "$FAKE_LOG"\n'
        '[ "$1 $2" = "app start" ] && [ -n "${FAKE_APP_START_S:-}" ] && { echo "Building the sketch"; sleep "$FAKE_APP_START_S"; }\n'
        '[ "$1 $2" = "app start" ] && { echo "Error: no microcontroller here"; exit 1; }\n'
        '[ "$1 $2" = "properties get" ] && echo user:muse-rover\nexit 0'
    ),
}
SERVER_PATTERN = r"^python3 server\.py --host 0\.0\.0\.0 --port 8765"


@unittest.skipUnless(ON_LINUX and shutil.which("bash") and shutil.which("flock") and shutil.which("pgrep"), "needs Linux with bash, flock and pgrep")
class SetupScriptRunTests(unittest.TestCase):
    """setup-rover.sh end to end, with the board's commands stubbed: su runs as this user in a made-up home, and
    arduino-app-cli can't start the app, since there's no microcontroller. The real autostart.sh starts the real server.py
    on port 8765, and the real self-test finds no router behind it."""

    def setUp(self):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", 8765)) == 0:
                self.skipTest("port 8765 is in use here")
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.home = os.path.join(self.dir, "home")
        bin_dir = os.path.join(self.dir, "bin")
        os.makedirs(self.home)
        os.makedirs(bin_dir)
        for name, body in STUBS.items():
            path = os.path.join(bin_dir, name)
            with open(path, "w") as f:
                f.write("#!/bin/bash\n" + body + "\n")
            os.chmod(path, 0o755)
        self.log = os.path.join(self.dir, "log")
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_ROOT": "1", "FAKE_HOME": self.home, "FAKE_LOG": self.log,
                    "MUSE_ROVER_USER": subprocess.run(["/usr/bin/id", "-un"], capture_output=True, text=True).stdout.strip(),
                    "MUSE_ROVER_LOCK": os.path.join(self.dir, "lock")}
        self.addCleanup(self.stop_servers)

    def stop_servers(self):
        found = subprocess.run(["pgrep", "-u", str(os.getuid()), "-f", SERVER_PATTERN], capture_output=True, text=True).stdout.split()
        for pid in found:
            with contextlib.suppress(OSError):
                if os.readlink(f"/proc/{pid}/cwd").startswith(self.home):
                    os.kill(int(pid), 15)
        # Until the port is free, so the next test doesn't find it in use and skip.
        for _ in range(50):
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", 8765)) != 0:
                    return
            time.sleep(0.1)

    def setup(self, *flags):
        done = subprocess.run(["bash", os.path.join(ROVER, "setup-rover.sh"), *flags], capture_output=True, text=True, env=self.env, timeout=300)
        last = done.stdout.strip().splitlines()[-1]
        self.assertTrue(last.startswith("MUSE_ROVER_REPORT "), done.stdout + done.stderr)
        return done, json.loads(last[len("MUSE_ROVER_REPORT "):])

    def test_it_sets_up_what_it_can_reports_each_step_and_runs_again_the_same(self):
        for run in (1, 2):
            with self.subTest(run=run):
                done, report = self.setup("--pin", "stby=A5")
                steps = report["steps"]
                self.assertEqual(done.returncode, 1, done.stdout)
                self.assertFalse(report["ok"])
                for name in ("tools", "user", "config", "packages", "files", "autostart", "server"):
                    self.assertEqual(steps[name], "ok", (name, done.stdout))
                self.assertIn("there is no router socket at /var/run/arduino-router.sock", steps["groups"])
                self.assertIn("arduino-app-cli couldn't start user:muse-rover: Error: no microcontroller here", steps["app"])
                self.assertEqual(steps["default_app"], "not tried, since the app didn't start")
                self.assertIn("sketch: The rover didn't answer status. There is no router socket", steps["self_test"])
                self.assertEqual(report["self_test"]["checks"]["server"], "ok")
                self.assertEqual(report["self_test"]["checks"]["rover_tools"], "ok")
                with open(os.path.join(self.home, ".muse-device", "token")) as f:
                    self.assertNotIn(f.read().strip(), done.stdout + done.stderr)
        with open(os.path.join(self.home, "crontab")) as f:
            self.assertEqual(f.read().count("autostart.sh"), 1)
        config = rover_config.read_config(os.path.join(self.home, ".muse-device", "rover.json"))
        self.assertEqual(config["pins"], {**PIN_MAP, "stby": "A5"})
        with open(os.path.join(self.home, "ArduinoApps", "muse-rover", "sketch", "rover_config.h")) as f:
            self.assertIn("#define ROVER_PIN_STBY A5\n", f.read())
        for path in ("muse-device/server.py", "muse-device/rover/bridge_client.py", "muse-device/rover/selftest.py", "ArduinoApps/muse-rover/app.yaml", "ArduinoApps/muse-rover/python/main.py"):
            self.assertTrue(os.path.exists(os.path.join(self.home, path)), path)
        with open(self.log) as f:
            log = f.read()
        self.assertIn("arduino-app-cli app stop user:muse-rover", log)
        self.assertNotIn("properties set", log)

    def test_a_bad_pin_changes_nothing_and_says_why(self):
        done, report = self.setup("--pin", "pwma=D4")
        self.assertEqual(report["steps"]["config"], "pwma is D4, which has no PWM. Use one of D2, D3, D5, D6, D7, D8, D9, D10, D11, D12, D13.")
        self.assertNotIn("files", report["steps"])
        self.assertFalse(os.path.exists(os.path.join(self.home, "muse-device")))
        done, report = self.setup("--wheels")
        self.assertEqual(report["steps"], {"flags": "there is no flag --wheels: the top of setup-rover.sh lists them"})
        self.assertEqual(done.returncode, 1)

    def test_it_must_be_root(self):
        self.env.pop("FAKE_ROOT")
        done, report = self.setup("--no-test")
        self.assertEqual(report["steps"], {"root": "run this as root, which a fleet exec is"})

    def test_the_deadline_cuts_a_slow_step_and_the_report_still_comes_in_time(self):
        # 60 seconds of the deadline are its margin, which leaves the steps 20: the app's start, which would take 120, is cut.
        self.env.update(MUSE_ROVER_DEADLINE_S="80", FAKE_APP_START_S="120")
        started = time.monotonic()
        done, report = self.setup()
        self.assertLess(time.monotonic() - started, 80)
        steps = report["steps"]
        self.assertEqual(done.returncode, 1, done.stdout)
        for name in ("config", "files", "autostart", "server"):
            self.assertEqual(steps[name], "ok", (name, done.stdout))
        self.assertTrue(steps["app"].startswith("arduino-app-cli ran out of time starting user:muse-rover, at 900 seconds or the run's deadline: Building the sketch"), steps["app"])
        self.assertEqual(steps["default_app"], "not tried, since the app didn't start")
        self.assertEqual(steps["self_test"], "not tried: the run's 80-second deadline (MUSE_ROVER_DEADLINE_S) was up")
        self.assertIsNone(report["self_test"])

    def test_a_deadline_that_is_not_a_number_is_refused(self):
        self.env["MUSE_ROVER_DEADLINE_S"] = "soon"
        done, report = self.setup()
        self.assertEqual(report["steps"], {"flags": "MUSE_ROVER_DEADLINE_S is soon, which isn't a whole number of seconds"})
        self.assertEqual(done.returncode, 1)


if __name__ == "__main__":
    unittest.main()
