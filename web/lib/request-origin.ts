import type { NextRequest } from "next/server";

// Route handlers construct absolute redirect URLs from request.url — and
// behind Railway's proxy, that reflects the *internal* address Railway
// forwards the request to, not the domain a real visitor actually used.
// Confirmed directly: a bare GET to /auth/confirm on the live site
// produced a redirect Location of https://localhost:8080/auth/error, not
// the real domain — every invite/reset/confirmation link that routed
// through these handlers landed on a dead address no matter what Site URL
// or the link itself said, since the handler's own next-hop redirect was
// already broken before it ever looked at Site URL.
//
// Middleware (proxy.ts / lib/supabase/middleware.ts) never hit this: it
// runs on the Edge Runtime, which Next.js gives a request object already
// resolved to the real external URL regardless of internal proxying —
// that's exactly why every other redirect in this app (the /login and
// /dashboard bounces, /setup-required) has worked correctly all along
// while these two Node-runtime route handlers, which build their own
// absolute URLs from the raw incoming request instead, did not.
//
// Standard reverse-proxy convention — which Railway follows — is to carry
// the original request's real host/protocol in X-Forwarded-Host and
// X-Forwarded-Proto specifically so the app behind it can reconstruct
// this correctly. Trust those first; only fall back to the request's own
// (here, unreliable) origin if whatever's in front genuinely isn't
// setting them.
export function resolveOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  return request.nextUrl.origin;
}
