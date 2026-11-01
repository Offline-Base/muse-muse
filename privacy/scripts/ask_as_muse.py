"""Call the running connector on this laptop the way Muse does, to try the approval page and /how.

    uv run python -m scripts.ask_as_muse "QUERY" "PURPOSE"

scripts/start.sh must be running. It calls search_documents, then get_result until the job ends,
and prints only the statuses. It reads the connector token from BASE_HOME and never prints it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

import httpx
from mcp import Client
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

from base.config import load_settings

ENDED = ("shared", "refused", "failed", "done", "waiting")


def status(result) -> dict:
    """A job comes back as JSON with a status; a result shared at once is the tagged text itself."""
    text = result.content[0].text if result.content else ""
    try:
        return json.loads(text)
    except ValueError:
        return {"status": "failed" if result.is_error else "shared"}


async def ask(query: str, purpose: str, poll: float = 3.0) -> str:
    settings = load_settings()
    token = settings.paths.connector_token.read_text().strip()
    http = create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
    url = f"http://127.0.0.1:{settings.connector_port}/mcp"
    async with Client(streamable_http_client(url, http_client=http)) as c:
        out = status(await c.call_tool("search_documents", {"query": query, "purpose": purpose}))
        print("search_documents:", out.get("status"))
        while out.get("job_id") and out.get("status") not in ENDED:
            await asyncio.sleep(poll)
            out = status(await c.call_tool("get_result", {"job_id": out["job_id"]}))
            print("get_result:", out.get("status"))
    return str(out.get("status"))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("query")
    p.add_argument("purpose", nargs="?", default="")
    args = p.parse_args()
    settings = load_settings()
    try:
        httpx.get(f"http://127.0.0.1:{settings.connector_port}/health", timeout=3).raise_for_status()
    except httpx.HTTPError:
        print("The connector isn't running. Start it with scripts/start.sh first.", file=sys.stderr)
        return 1
    asyncio.run(ask(args.query, args.purpose))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
