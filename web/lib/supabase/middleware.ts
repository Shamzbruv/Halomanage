import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseEnv } from "@/lib/supabase/env";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isSetupPage = pathname.startsWith("/setup-required");
  // proxy.ts's matcher excludes _next/static, _next/image, favicon.ico, and
  // literal image-extension file paths — but Next's file-based
  // icon/apple-icon/opengraph-image/twitter-image/manifest routes
  // (app/icon.tsx etc.) are served at clean, extension-less paths, so the
  // matcher's regex can't tell them apart from a real page and this ran
  // for them too. Without this, every one of them 307-redirected an
  // unauthenticated request to /login — meaning a link shared by a signed-
  // out visitor's browser, or any Slack/WhatsApp/LinkedIn preview fetch
  // (which is never authenticated), would get a login-page redirect
  // instead of the actual icon or social-preview image. Found by actually
  // curling these routes after adding them, not by inspection.
  const isPublicAsset =
    pathname.startsWith("/_next") ||
    pathname === "/icon" ||
    pathname === "/apple-icon" ||
    pathname === "/opengraph-image" ||
    pathname === "/twitter-image" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.ico";
  const isHomeRoute = pathname === "/";
  const isPublicPortalRoute = pathname.startsWith("/portal/");
  const isPlatformRoute = pathname.startsWith("/platform");
  const isPublicAuthRoute =
    pathname === "/login" || pathname === "/signup" || pathname.startsWith("/auth/") || pathname === "/platform/login";

  // The public product page is intentionally backend-independent. It stays
  // available while a deployment is being configured or Supabase is down.
  if (isHomeRoute) return NextResponse.next({ request });

  if (!hasSupabaseEnv()) {
    if (isSetupPage || isPublicAsset) return NextResponse.next({ request });
    return NextResponse.rewrite(new URL("/setup-required?reason=missing", request.url));
  }

  // These entry screens do not need a server-side session lookup to render.
  // Keeping them independent means a transient Auth outage can still show a
  // useful sign-in or signup screen (the form itself will report submission
  // errors), and it keeps the public account story fast.
  //
  // /auth/confirm and /auth/callback perform their own token verification
  // (verifyOtp / exchangeCodeForSession) and must never be blocked by a
  // stale session cookie. Without this bypass the middleware's getUser()
  // call could fail on a leftover JWT (e.g. "User from sub claim in JWT
  // does not exist") and redirect to setup-required before the route
  // handler ever gets a chance to establish the real session.
  if (isPublicAuthRoute || isPublicPortalRoute) {
    return NextResponse.next({ request });
  }

  try {
    let response = NextResponse.next({ request });
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return request.cookies.getAll(); },
          setAll(cookiesToSet: CookieToSet[]) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
            response = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          },
        },
      },
    );

    const { data: { user }, error } = await supabase.auth.getUser();

    if (error && error.name !== "AuthSessionMissingError") {
      // "User from sub claim in JWT does not exist" (and similar stale-JWT
      // errors) means there is a leftover cookie whose user was deleted or
      // belongs to a different project. This is NOT a deployment
      // configuration problem — clear the poisoned cookies and treat it as
      // an unauthenticated request so the user can sign in fresh.
      const isStaleJwt = error.message.includes("User from sub claim in JWT does not exist");
      if (isStaleJwt) {
        console.warn("middleware: stale JWT detected, clearing session cookies", error.message);
        const cleared = NextResponse.next({ request });
        for (const cookie of request.cookies.getAll()) {
          if (cookie.name.startsWith("sb-")) {
            cleared.cookies.delete(cookie.name);
          }
        }
        if (!isPublicAsset) {
          const url = request.nextUrl.clone();
          url.pathname = "/login";
          url.search = "";
          return NextResponse.redirect(url);
        }
        return cleared;
      }

      console.error("middleware: Supabase auth check failed", error.message);
      if (isSetupPage) return NextResponse.next({ request });
      const url = new URL("/setup-required", request.url);
      url.searchParams.set("reason", "error");
      url.searchParams.set("detail", error.message);
      return NextResponse.rewrite(url);
    }

    if (!user && !isPublicAuthRoute && !isPublicAsset) {
      const url = request.nextUrl.clone();
      // /platform/* is a separate console with its own sign-in and its own
      // platform_staff trust boundary (see lib/platform-session.ts) —
      // sending an unauthenticated visitor there to the tenant /login would
      // sign them into the wrong system entirely.
      url.pathname = isPlatformRoute ? "/platform/login" : "/login";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // The completion and callback routes must remain reachable after a new
    // session is established, so only the two entry screens redirect here.
    if (user && (pathname === "/login" || pathname === "/signup")) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // Per-organization network access control (see
    // 20260901100000_network_access_control.sql) — checked on every
    // request, not just at sign-in, since that's what "only usable from
    // our office network" actually has to mean to be worth anything.
    // /platform/* is a separate, cross-tenant console; platform staff
    // aren't subject to any tenant's network policy. Skipped for orgs that
    // never configured this (check_network_access() returns allowed:true
    // immediately in that case), so this is a no-op extra round-trip for
    // the overwhelming majority of requests today.
    if (user && !isPlatformRoute && pathname !== "/network-restricted") {
      // Railway's edge sets this authoritatively — verified directly
      // against this project's own deployment that a client-supplied
      // X-Real-IP is discarded, never forwarded as sent.
      const realIp = request.headers.get("x-real-ip");
      if (realIp) {
        try {
          const { data, error: networkError } = await supabase.rpc("check_network_access", { p_ip: realIp });
          if (networkError) {
            // Fail open: a bug or outage in this check must never be able
            // to take the whole app down for every signed-in user. This is
            // a defense-in-depth control layered on top of real
            // authentication/RLS, not itself the primary security boundary.
            console.error("middleware: network access check failed, allowing through", networkError.message);
          } else if (data && data.allowed === false) {
            return NextResponse.rewrite(new URL("/network-restricted", request.url));
          }
        } catch (networkErr) {
          console.error("middleware: unexpected error during network access check, allowing through", networkErr);
        }
      }
    }

    return response;
  } catch (err) {
    console.error("middleware: unexpected error building the Supabase session", err);
    if (isSetupPage) return NextResponse.next({ request });
    const url = new URL("/setup-required", request.url);
    url.searchParams.set("reason", "error");
    url.searchParams.set("detail", err instanceof Error ? err.message : String(err));
    return NextResponse.rewrite(url);
  }
}
