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
  const isPublicAuthRoute = pathname === "/login" || pathname === "/signup" || pathname.startsWith("/auth/");

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
  if (pathname === "/login" || pathname === "/signup" || pathname === "/auth/error" || isPublicPortalRoute) {
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
      console.error("middleware: Supabase auth check failed", error.message);
      if (isSetupPage) return NextResponse.next({ request });
      const url = new URL("/setup-required", request.url);
      url.searchParams.set("reason", "error");
      url.searchParams.set("detail", error.message);
      return NextResponse.rewrite(url);
    }

    if (!user && !isPublicAuthRoute && !isPublicAsset) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
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
