/** The try routes' shared parts: who the visitor is, and who may use a real board's page. */
import { createHash, randomBytes } from "node:crypto";
import { tryBoard } from "@/lib/board-loop/boards";
import { tryStore } from "@/lib/board-loop/store";
import type { TryDeps } from "@/lib/board-loop/try";
import { docsClientIp } from "@/lib/docs/proxy/limits";
import { cookieValue } from "@/lib/drive/logic";
import { env } from "@/lib/env";
import { currentUser } from "@/lib/queries";
import type { LoopRow } from "@/lib/board-loop/logic";

export const TRY_COOKIE = "mm_board_try";
const COOKIE_DAYS = 7;
const COOKIE_RE = /^[A-Za-z0-9_-]{32}$/;

export const tryDeps: TryDeps = { store: tryStore, board: (loop) => tryBoard(loop.target), now: () => new Date() };

/** The visitor's hash and IP key, and the cookie to set when they're new. The database only ever sees the hash. */
export function tryVisitor(req: Request): { visitor: string; ip: string; setCookie: string | null } {
  const held = cookieValue(req.headers.get("cookie"), TRY_COOKIE);
  const value = held && COOKIE_RE.test(held) ? held : randomBytes(24).toString("base64url");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return {
    visitor: createHash("sha256").update(value).digest("hex"),
    ip: docsClientIp(req.headers),
    setCookie: value === held ? null : `${TRY_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_DAYS * 86_400}; HttpOnly; SameSite=Lax${secure}`,
  };
}

/** A simulated board's canned text is open to anyone. A real board's model is open to admins until BOARD_TRY_PUBLIC. */
export async function mayTry(loop: LoopRow): Promise<boolean> {
  if (loop.target === "simulated" || env.boardTryPublic) return true;
  return (await currentUser())?.isAdmin === true;
}
