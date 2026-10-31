// Platform file (Muse Muse trust). Don't edit, and don't add a middleware.ts: Next takes one proxy, and this is it.
//
// Two checks before any page or route runs:
//   1. Restricted territories (musemuse.trust.json "geo"): Meta's terms don't allow its models there, so a request
//      from one gets a short 451 page. Vercel sets the country headers; a local run has none, so nothing is blocked.
//   2. The age gate (musemuse.trust.json "ageGate"): a page visit with no mm_age cookie for these terms goes to /age
//      first. One tap, remembered in the browser. Off while the platform's tests run (MUSEMUSE_BUILD=1 in .env.local).
import { NextResponse, type NextRequest } from "next/server";
import { AGE_COOKIE, geoBlocked, TRUST, UNGATED_PATHS } from "@/lib/platform/trust";

const UNAVAILABLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not available here</title><style>:root{color-scheme:light dark}body{margin:0;font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:64px 16px}h1{font-size:24px;line-height:1.25}p{opacity:.75}</style></head><body><main><h1>This app isn't available where you are</h1><p>It uses Meta's models, and Meta's terms don't allow them to be used from this country or region.</p><p>Built with Muse Muse. Not an official Meta product.</p></main></body></html>`;

function isPageVisit(req: NextRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/") || UNGATED_PATHS.includes(path)) return false;
  return (req.headers.get("accept") ?? "").includes("text/html");
}

export function proxy(req: NextRequest) {
  if (geoBlocked(TRUST.geo, (name) => req.headers.get(name))) {
    return new NextResponse(UNAVAILABLE, { status: 451, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (TRUST.ageGate && process.env.MUSEMUSE_BUILD !== "1" && isPageVisit(req) && req.cookies.get(AGE_COOKIE)?.value !== TRUST.termsVersion) {
    const to = req.nextUrl.clone();
    to.pathname = "/age";
    to.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(to, 307);
  }
  return NextResponse.next();
}

export const config = {
  // Everything but Next's own files and static assets, which carry nothing a person reads.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|map|woff2?|ttf|txt|xml|webmanifest|glb|wasm|onnx|mp3|mp4|wav)$).*)"],
};
