# Platform file (Muse Muse platform services). Don't edit.
# The live check loads it after deploy and verify's checks run it on the build machine. It says that this product's
# Python functions run where it is deployed, and nothing more. It reads no setting and makes no call.
import json
import platform
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"ok": True, "python": platform.python_version()}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass
