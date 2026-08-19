import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseEnv } from "@/lib/supabase/env";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Refreshes the Supabase auth session on every request and redirects
// signed-out users away from the portal. This is a convenience redirect for
// UX only — it is NOT the security boundary. The security boundary is
// Postgres RLS (see docs/ARCHITECTURE.md); this middleware never grants
// data access, it only decides which page to render.
export async function updateSession(request: NextRequest) {
  const isSetupPage = request.nextUrl.pathname.startsWith("/setup-required");

  // Middleware runs on every matched request, before any page renders. If
  // the Supabase env vars aren't set, createServerClient() throws
  // immediately — that used to crash every single route (including "/")
  // with a bare, unexplained 500, since a thrown middleware error never
  // reaches a page-level error boundary. Rewrite to a real, static,
  // zero-Supabase-dependency page that says exactly what's missing instead.
  if (!hasSupabaseEnv()) {
    if (isSetupPage) return NextResponse.next({ request });
    return NextResponse.rewrite(new URL("/setup-required", request.url));
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthRoute = request.nextUrl.pathname.startsWith("/login");
  const isPublicAsset = request.nextUrl.pathname.startsWith("/_next");

  if (!user && !isAuthRoute && !isPublicAsset) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return response;
}
