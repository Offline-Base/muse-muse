// For the drill tests' tiny product servers: the board status route and a page with the board status line, as
// app/api/board-status/route.ts and components/BoardStatus.tsx give a real product. Not a test file itself.
import { boardStatus } from "../../lib/meta/board-status";

/** What components/BoardStatus.tsx renders on the server, before its check comes back. */
export const BOARD_PAGE = '<!doctype html><main><div class="row" role="status" data-board-status="checking"><span class="chip">Checking for a board</span></div></main>';

/** Answers GET /api/board-status and GET / and returns true, or returns false for any other request. */
export async function serveBoard(req, res, { page = BOARD_PAGE } = {}) {
  const url = new URL(req.url ?? "/", "http://product.test");
  if (req.method !== "GET") return false;
  if (url.pathname === "/api/board-status") {
    const status = await boardStatus({ looks: url.searchParams.get("looks") === "1", timeoutMs: 1_000 });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(status));
    return true;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
    return true;
  }
  return false;
}
