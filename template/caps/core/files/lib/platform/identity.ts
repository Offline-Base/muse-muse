import { randomBytes } from "node:crypto";
import { clientIpHeaders, type RequestLike } from "@/lib/meta/client";

/**
 * Who a request comes from, as the gateway needs to hear it. Products have no sign-in yet:
 * - mm_vid is a random id for one browser. It's weak, so it only names the person for limits and Meta's safety id.
 * - mm_owner is a session the platform signed for the product's owner. The gateway checks the signature, not this file.
 * Both cookies are HttpOnly, so page scripts never see them and only this server can send them on.
 */

export const VISITOR_COOKIE = "mm_vid";
export const OWNER_COOKIE = "mm_owner";
export const VISITOR_HEADER = "x-musemuse-visitor";
export const OWNER_HEADER = "x-musemuse-owner";

const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** os1.<product>.<owner>.<exp>.<sig>: only characters a cookie and a header can carry. The gateway checks the rest. */
const OWNER_SESSION = /^[A-Za-z0-9._~-]{16,512}$/;
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const OWNER_SECONDS = 12 * 60 * 60;

function cookieHeader(from?: RequestLike | null): string {
  if (!from) return "";
  const headers = "get" in from && typeof from.get === "function" ? from : (from as { headers: { get(name: string): string | null } }).headers;
  return headers.get("cookie") ?? "";
}

function readCookie(from: RequestLike | null | undefined, name: string): string | null {
  for (const part of cookieHeader(from).split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** This browser's visitor id, or null when it has none yet. agentResponse gives it one on its first run. */
export function visitorId(from?: RequestLike | null): string | null {
  const id = readCookie(from, VISITOR_COOKIE);
  return id && VISITOR_ID.test(id) ? id : null;
}

export function newVisitorId(): string {
  return randomBytes(18).toString("base64url");
}

/** The owner session this browser holds, if any. It says nothing about whether it's valid: only the gateway knows. */
export function ownerSession(from?: RequestLike | null): string | null {
  const session = readCookie(from, OWNER_COOKIE);
  return session && OWNER_SESSION.test(session) ? session : null;
}

/**
 * Who that session names, from os1.<product>.<subject>.<exp>.<sig>, or "" for anyone without one. A renewed session
 * names the same owner. Like ownerSession it proves nothing: it's for telling one person's run from another's.
 */
export function ownerSubject(from?: RequestLike | null): string {
  return ownerSession(from)?.split(".")[2] ?? "";
}

export function isOwnerSession(session: unknown): session is string {
  return typeof session === "string" && OWNER_SESSION.test(session);
}

/** The headers every gateway call in an agent run carries. `visitor` is for a browser whose cookie was only just set. */
export function identityHeaders(from?: RequestLike | null, visitor?: string | null): Record<string, string> {
  const vid = visitor ?? visitorId(from);
  const owner = ownerSession(from);
  return {
    ...clientIpHeaders(from),
    ...(vid ? { [VISITOR_HEADER]: vid } : {}),
    ...(owner ? { [OWNER_HEADER]: owner } : {}),
  };
}

export function visitorCookie(id: string): string {
  return `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=${YEAR_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function ownerCookie(session: string): string {
  return `${OWNER_COOKIE}=${session}; Path=/; Max-Age=${OWNER_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOwnerCookie(): string {
  return `${OWNER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** A path on this site to send the browser back to, or "/" for anything that could leave it. */
export function samePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://this-site.invalid");
    // The parser can tidy "/.//x" into "//x", which a browser reads as another site.
    return url.origin === "https://this-site.invalid" && !url.pathname.startsWith("//") ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}
