"""Laptop side of heavy steps: dial out to the Jetson, run steps on the laptop's Glimmer, post results.

    python -m base.heavy.worker --jetson-url URL --token TOKEN [--synthetic]

The worker only makes outgoing HTTP requests; it never listens on a port. `--jetson-url` falls back
to JETSON_URL and `--token` to HEAVY_TOKEN. When the laptop's Glimmer backend is a cloud endpoint
(GLIMMER_BACKEND=openrouter) the worker refuses to start without `--synthetic`, and even then the
Jetson only hands it steps marked synthetic.
"""

from __future__ import annotations

import argparse
import logging
import os
import random
import sys
import threading
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import httpx

from base.config import REPO_ROOT, load_settings, read_dotenv
from base.heavy.queue import MAX_NEXT_WAIT

log = logging.getLogger("base.heavy.worker")

MAX_BACKOFF = 60.0


class TokenRejected(RuntimeError):
    """The Jetson answered 401 or 403: the token is wrong or was replaced."""


class Worker:
    """One dial-out worker. `llm` needs `chat_json(messages, schema, **kw) -> dict`."""

    def __init__(
        self,
        jetson_url: str,
        token: str,
        llm: Any,
        *,
        synthetic: bool = False,
        cloud: bool = False,
        client: httpx.Client | None = None,
        max_tokens: int = 4000,
        wait: float = MAX_NEXT_WAIT,
        sleep: Callable[[float], Any] | None = None,
    ) -> None:
        self.base = jetson_url.rstrip("/")
        self.llm = llm
        self.synthetic = synthetic
        self.cloud = cloud
        self.max_tokens = max_tokens
        self.wait = wait
        self.worker_id = "laptop-" + uuid.uuid4().hex[:8]
        self.headers = {"Authorization": f"Bearer {token}"}
        self.client = client or httpx.Client(timeout=httpx.Timeout(10.0, read=wait + 15.0))
        self.stop = threading.Event()
        self.sleep = sleep or self.stop.wait

    def _check(self, response: httpx.Response) -> httpx.Response:
        if response.status_code in (401, 403):
            raise TokenRejected("the Jetson rejected the worker token")
        response.raise_for_status()
        return response

    def hello(self) -> None:
        self._check(
            self.client.post(
                f"{self.base}/heavy/hello",
                json={"worker": self.worker_id, "cloud": self.cloud},
                headers=self.headers,
            )
        )

    def next_step(self) -> dict | None:
        response = self._check(
            self.client.get(
                f"{self.base}/heavy/next",
                params={"worker": self.worker_id, "cloud": str(self.cloud).lower(), "wait": self.wait},
                headers=self.headers,
            )
        )
        return None if response.status_code == 204 else response.json()

    def run_step(self, step: dict) -> dict:
        """Run one step on the laptop's Glimmer. Errors are reported by type only, never content."""
        if self.cloud and not step.get("synthetic"):
            return {"error": "CloudBackendRefused"}
        try:
            result = self.llm.chat_json(
                step["messages"], step.get("schema"), synthetic=self.synthetic, max_tokens=self.max_tokens
            )
            if not isinstance(result, dict):
                raise TypeError("result is not a JSON object")
            return {"result": result}
        except Exception as exc:  # report and keep serving; the Jetson falls back to its own Glimmer
            log.warning("heavy step %s failed: %s", step.get("kind"), type(exc).__name__)
            return {"error": type(exc).__name__}

    def post_result(self, step_id: str, payload: dict) -> bool:
        response = self.client.post(f"{self.base}/heavy/{step_id}/result", json=payload, headers=self.headers)
        if response.status_code in (404, 409):
            log.info("the Jetson stopped waiting for step %s; result dropped", step_id[:8])
            return False
        self._check(response)
        return True

    def run_once(self) -> bool:
        """Hello, take one step if there is one, run it, post it. True when a step was handled."""
        self.hello()
        step = self.next_step()
        if step is None:
            return False
        log.info("running heavy step %s", step.get("kind"))
        self.post_result(step["id"], self.run_step(step))
        return True

    def run_forever(self) -> None:
        """Loop until `stop` is set, backing off (1 s doubling to 60 s) while the Jetson is unreachable."""
        delay = 1.0
        while not self.stop.is_set():
            try:
                self.run_once()
                delay = 1.0
            except TokenRejected:
                raise
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                log.warning("cannot reach the Jetson (%s); trying again in %.0f s", type(exc).__name__, delay)
                self.sleep(delay + random.uniform(0, delay / 4))
                delay = min(delay * 2, MAX_BACKOFF)


def _token_from_env() -> str | None:
    return os.environ.get("HEAVY_TOKEN") or read_dotenv(REPO_ROOT / ".env").get("HEAVY_TOKEN") or None


def _plain_http_off_loopback(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme == "http" and parts.hostname not in ("127.0.0.1", "localhost", "::1")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m base.heavy.worker",
        description="Run heavy steps for a Jetson on this laptop's Glimmer. Dials out only.",
    )
    parser.add_argument("--jetson-url", help="the Jetson's approval page URL (default: JETSON_URL)")
    parser.add_argument("--token", help="worker token from 'python -m base.heavy.routes' on the Jetson (default: HEAVY_TOKEN)")
    parser.add_argument("--synthetic", action="store_true",
                        help="required when this laptop's Glimmer is a cloud endpoint: the data is invented")
    parser.add_argument("--max-tokens", type=int, default=4000, help="max tokens per step, reasoning included")
    parser.add_argument("--once", action="store_true", help="handle at most one step, then exit")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")

    settings = load_settings()
    if settings.device != "laptop":
        parser.exit(2, "The heavy-step worker runs on the laptop. Set BASE_DEVICE=laptop.\n")
    if settings.is_cloud_backend and not args.synthetic:
        parser.exit(
            2,
            "This laptop's Glimmer is a cloud endpoint (GLIMMER_BACKEND=openrouter) and heavy steps carry "
            "document text. Pass --synthetic to confirm the Jetson only holds invented data, or switch to "
            "GLIMMER_BACKEND=llama_server.\n",
        )
    url = args.jetson_url or settings.jetson_url
    if not url:
        parser.exit(2, "Pass --jetson-url or set JETSON_URL to the Jetson's approval page.\n")
    token = args.token or _token_from_env()
    if not token:
        parser.exit(2, "Pass --token or set HEAVY_TOKEN. Print it on the Jetson with: python -m base.heavy.routes\n")
    if _plain_http_off_loopback(url):
        log.warning("The Jetson URL uses plain http. Heavy steps carry document text; use it only on your own network.")

    from base.local_llm import LocalLLM  # imported late so the checks above work without a model client

    worker = Worker(url, token, LocalLLM(settings, "answer"), synthetic=args.synthetic,
                    cloud=settings.is_cloud_backend, max_tokens=args.max_tokens)
    log.info("heavy-step worker %s dialing out to the Jetson", worker.worker_id)
    try:
        if args.once:
            worker.run_once()
        else:
            worker.run_forever()
    except TokenRejected:
        print("The Jetson rejected the token. Print it again on the Jetson with: python -m base.heavy.routes",
              file=sys.stderr)
        return 2
    except httpx.HTTPError as exc:  # only reached with --once; the loop retries on its own
        print(f"Cannot reach the Jetson ({type(exc).__name__}).", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
