"""HTTP side of the heavy-step queue, mounted on the Jetson's approval server. See docs/CONTRACTS.md.

The laptop's worker dials out to these routes; nothing here ever connects to the laptop.

    POST /heavy/hello               the worker says it is present
    GET  /heavy/next                long poll (up to 25 s): {id, kind, messages, schema} or 204
    POST /heavy/{step_id}/result    {"result": {...}} or {"error": "..."}

Every route needs `Authorization: Bearer <worker token>`. The token lives in
`settings.home / "heavy_token"` (0600, created on first use). Print it for pairing with
`python -m base.heavy.routes`, or replace it with `python -m base.heavy.routes rotate`.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sys
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from base.config import Settings, load_settings
from base.heavy.queue import MAX_NEXT_WAIT, HeavyQueue

TOKEN_FILE = "heavy_token"
STEP_ID = re.compile(r"^[0-9a-f]{32}$")


def token_path(settings: Settings) -> Path:
    return settings.home / TOKEN_FILE


def load_token(settings: Settings) -> str:
    """Read the worker token, creating it (0600) the first time."""
    path = token_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        os.chmod(path, 0o600)
        token = path.read_text().strip()
        if token:
            return token
        fd = os.open(path, os.O_WRONLY | os.O_TRUNC, 0o600)
    token = secrets.token_urlsafe(32)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    return token


def rotate_token(settings: Settings) -> str:
    """Replace the worker token (a copied or sniffed one stops working at the next restart)."""
    token_path(settings).unlink(missing_ok=True)
    return load_token(settings)


def print_token(settings: Settings | None = None, *, rotate: bool = False) -> None:
    """Print the worker token and the laptop command that uses it (for pairing)."""
    settings = settings or load_settings()
    token = rotate_token(settings) if rotate else load_token(settings)
    print("Heavy-step worker token for this device:" if not rotate else "New heavy-step worker token:")
    print(f"  {token}")
    if rotate:
        print("Restart muse-privacy.service so the old token stops working.")
    print("On the laptop, run:")
    if settings.approval_tls:
        digest = hashlib.sha256(_pem_der(settings.approval_tls_cert)).hexdigest()
        print("  python -m base.heavy.worker --jetson-url https://<this device's approval address>:"
              f"{settings.approval_port} --token <the token above> --ca-cert <a copy of {settings.approval_tls_cert.name}>")
        print(f"Certificate SHA-256 (check the copy matches): {digest}")
    else:
        print("  python -m base.heavy.worker --jetson-url http://<this device's approval address>:"
              f"{settings.approval_port} --token <the token above> --allow-plain-http")
        print("This device serves plain http, so essays cross your network unencrypted. Set APPROVAL_TLS_CERT")
        print("and APPROVAL_TLS_KEY (install.sh makes a certificate) to fix that.")


def _pem_der(path: Path) -> bytes:
    import ssl

    return ssl.PEM_cert_to_DER_cert(Path(path).read_text())


class TokenGate:
    """Plain ASGI middleware: /heavy/ requests without the worker token get 401 before any body is
    read or parsed. The routes check the token again with their own dependency."""

    def __init__(self, app: Any, token: str) -> None:
        self.app, self._token = app, token.encode()

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "http" and scope.get("path", "").startswith("/heavy/"):
            headers = dict(scope.get("headers") or [])
            scheme, _, given = headers.get(b"authorization", b"").decode("latin-1").partition(" ")
            if scheme.lower() != "bearer" or not hmac.compare_digest(given.strip().encode(), self._token):
                body = b'{"detail": "bad worker token"}'
                await send({"type": "http.response.start", "status": 401, "headers": [
                    (b"content-type", b"application/json"), (b"www-authenticate", b"Bearer"),
                    (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


class Hello(BaseModel):
    worker: str = Field(default="worker", max_length=64)
    cloud: bool = False


class StepResult(BaseModel):
    result: dict[str, Any] | None = None
    error: str | None = Field(default=None, max_length=200)


def make_router(queue: HeavyQueue, token: str) -> APIRouter:
    """Build the /heavy routes for one queue and one worker token."""
    expected = token.encode()

    def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
        scheme, _, given = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(given.strip().encode(), expected):
            raise HTTPException(status_code=401, detail="bad worker token", headers={"WWW-Authenticate": "Bearer"})

    router = APIRouter(prefix="/heavy", tags=["heavy"], dependencies=[Depends(require_token)])

    @router.post("/hello")
    def hello(body: Hello | None = None) -> dict:
        body = body or Hello()
        queue.hello(body.worker, body.cloud)
        return {"ok": True, "wait_seconds": queue.wait_seconds}

    @router.get("/next")
    def next_step(
        worker: Annotated[str, Query(max_length=64)] = "worker",
        cloud: bool = False,
        wait: Annotated[float, Query(ge=0, le=MAX_NEXT_WAIT)] = MAX_NEXT_WAIT,
    ) -> Response:
        step = queue.next(worker=worker, cloud=cloud, wait=wait)
        if step is None:
            return Response(status_code=204)
        return JSONResponse(step)

    @router.post("/{step_id}/result")
    def post_result(step_id: str, body: StepResult) -> JSONResponse:
        if not STEP_ID.match(step_id):
            raise HTTPException(status_code=404, detail="unknown step")
        if body.result is None and body.error is None:
            raise HTTPException(status_code=422, detail="send a result or an error")
        if queue.submit(step_id, result=body.result, error=body.error):
            return JSONResponse({"accepted": True})
        return JSONResponse({"accepted": False, "detail": "step is no longer waiting"}, status_code=409)

    return router


def router_for(settings: Settings, queue: HeavyQueue | None = None) -> APIRouter:
    """The /heavy routes for this device, with the queue in its own db and the stored token."""
    queue = queue or HeavyQueue(settings.paths.db)
    return make_router(queue, load_token(settings))


if __name__ == "__main__":
    print_token(rotate=sys.argv[1:] == ["rotate"])
