"""HTTP side of the heavy-step queue, mounted on the Jetson's approval server. See docs/CONTRACTS.md.

The laptop's worker dials out to these routes; nothing here ever connects to the laptop.

    POST /heavy/hello               the worker says it is present
    GET  /heavy/next                long poll (up to 25 s): {id, kind, messages, schema} or 204
    POST /heavy/{step_id}/result    {"result": {...}} or {"error": "..."}

Every route needs `Authorization: Bearer <worker token>`. The token lives in
`settings.home / "heavy_token"` (0600, created on first use). Print it for pairing with
`python -m base.heavy.routes`.
"""

from __future__ import annotations

import hmac
import os
import re
import secrets
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


def print_token(settings: Settings | None = None) -> None:
    """Print the worker token and the laptop command that uses it (for pairing)."""
    settings = settings or load_settings()
    token = load_token(settings)
    print("Heavy-step worker token for this device:")
    print(f"  {token}")
    print("On the laptop, run:")
    print("  python -m base.heavy.worker --jetson-url http://<this device's approval address>:"
          f"{settings.approval_port} --token <the token above>")


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
    print_token()
