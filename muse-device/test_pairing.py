"""Tests for pairing, TLS and the /v1 routes in server.py, against sim_board.py over real TLS. Needs openssl, no board.

  python3 -m unittest test_pairing
"""
import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class PairingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = tempfile.mkdtemp()
        cls.port = free_port()
        cls.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "sim_board.py"), "--state", cls.state, "--port", str(cls.port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("the simulated board didn't start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait()
        shutil.rmtree(cls.state)

    def request(self, method, path, body=None, token=None, headers=None):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        conn = http.client.HTTPSConnection("127.0.0.1", self.port, context=context, timeout=10)
        sent = {"Content-Type": "application/json", **(headers or {})}
        if token:
            sent["Authorization"] = f"Bearer {token}"
        conn.request(method, path, json.dumps(body) if body is not None else None, sent)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, json.loads(data) if data else None, None

    def pair_output(self):
        out = subprocess.run([sys.executable, os.path.join(HERE, "sim_board.py"), "--state", self.state, "pair"], capture_output=True, text=True, check=True).stdout
        return re.search(r"Pairing code: (\S+)", out).group(1), re.search(r"Check number: (\d{6})", out).group(1)

    def pair(self):
        code, _check = self.pair_output()
        status, body, _ = self.request("POST", "/pair", {"code": code})
        self.assertEqual(status, 200)
        return body["token"]

    def test_code_is_eight_characters_from_the_clear_alphabet(self):
        code, check = self.pair_output()
        self.assertRegex(code, r"^[2-9A-HJ-NP-Z]{8}$")
        self.assertRegex(check, r"^\d{6}$")

    def test_a_code_works_once_and_its_token_opens_the_board(self):
        code, _ = self.pair_output()
        status, body, _ = self.request("POST", "/pair", {"code": code})
        self.assertEqual(status, 200)
        self.assertGreaterEqual(len(body["token"]), 32)
        self.assertEqual(self.request("POST", "/pair", {"code": code})[0], 401, "single use")
        self.assertEqual(self.request("GET", "/v1/models", token=body["token"])[0], 200)
        self.assertEqual(self.request("GET", "/v1/models")[0], 401)
        self.assertEqual(self.request("GET", "/v1/models", token="x" * 43)[0], 401)

    def test_five_wrong_tries_burn_the_code(self):
        code, _ = self.pair_output()
        for _ in range(5):
            self.assertEqual(self.request("POST", "/pair", {"code": "WRONGWRG"})[0], 401)
        self.assertEqual(self.request("POST", "/pair", {"code": code})[0], 401)

    def test_only_a_hash_of_the_token_stays_on_the_board(self):
        token = self.pair()
        with open(os.path.join(self.state, ".muse-device", "paired-tokens.json")) as f:
            saved = f.read()
        self.assertNotIn(token, saved)
        self.assertIn(hashlib.sha256(token.encode()).hexdigest(), saved)

    def test_browsers_are_refused(self):
        self.assertEqual(self.request("POST", "/pair", {"code": "x"}, headers={"Origin": "https://evil.example"})[0], 403)

    def test_unpair_ends_the_token(self):
        token = self.pair()
        self.assertEqual(self.request("POST", "/unpair", {}, token=token)[0], 200)
        self.assertEqual(self.request("GET", "/v1/models", token=token)[0], 401)

    def test_the_check_number_comes_from_the_certificate_the_site_sees(self):
        import server
        _, check = self.pair_output()
        with tempfile.NamedTemporaryFile("w", suffix=".pem") as f:
            f.write(ssl.get_server_certificate(("127.0.0.1", self.port)))
            f.flush()
            self.assertEqual(server.pair_check_number(server.certificate_spki_sha256(f.name)), check)

    def test_the_same_check_number_as_the_platform(self):
        # lib/caps/hardware/__tests__/pairing.test.ts holds the same vector.
        import server
        self.assertEqual(server.pair_check_number("a" * 64), "489031")

    def test_inference_passes_to_the_model(self):
        token = self.pair()
        status, body, _ = self.request("POST", "/v1/chat/completions", {"model": "x", "messages": [{"role": "user", "content": "soil 22, temp 25"}]}, token=token)
        self.assertEqual(status, 200)
        self.assertIn("[simulated muse-glimmer-30b-IQ1_S]", body["choices"][0]["message"]["content"])
        self.assertIn("pump", body["choices"][0]["message"]["content"])

    def mcp(self, token, name, arguments=None):
        status, body, _ = self.request("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}}, token=token)
        self.assertEqual(status, 200)
        return body["result"]

    def test_robot_limits_and_hard_stop(self):
        token = self.pair()
        self.assertFalse(self.mcp(token, "robot_action", {"action": "pump_run", "args": {"seconds": 3}}).get("isError"))
        self.assertTrue(self.mcp(token, "robot_action", {"action": "pump_run", "args": {"seconds": 6}})["isError"], "over the limit")
        self.assertTrue(self.mcp(token, "robot_action", {"action": "flamethrower", "args": {}})["isError"], "not on the list")
        self.mcp(token, "hard_stop")
        refused = self.mcp(token, "robot_action", {"action": "fan_run", "args": {"seconds": 1}})
        self.assertTrue(refused["isError"])
        self.assertIn("hard stop", refused["content"][0]["text"])
        self.mcp(token, "clear_stop")
        self.assertFalse(self.mcp(token, "robot_action", {"action": "fan_run", "args": {"seconds": 1}}).get("isError"))


if __name__ == "__main__":
    unittest.main()
