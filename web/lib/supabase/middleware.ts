import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseEnv } from "@/lib/supabase/env";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Refreshes the Supabase auth session on every request and redirects
// signed-out users away from the portal. This is a convenience redirect for
// UX only — it is NOT the security boundary. The security boundary is
// Postgres RLS (see docs/ARCHITECTURE.md); this middleware never grants
// data access, it only decides which page to render.
//
// This function must never throw. Middleware runs before Next.js has even
// chosen a route to render, so a thrown error here can't reach any
// page-level error boundary (app/error.tsx doesn't apply — that's only for
// errors inside the App Router's own render tree) or the setup-required
// rewrite below it — Next.js falls back to its lowest-level generic 500,
// which is what a first attempt at this fix (env vars entirely absent)
// didn't fully cover: env vars can also be *present but wrong* (a typo, a
// stale/rotated key, a paused or deleted Supabase project), which still
// makes createServerClient()/getUser() throw or reject. Both cases now
// degrade to the same setup-required page instead of crashing.
export async function updateSession(request: NextRequest) {
  const isSetupPage = request.nextUrl.pathname.startsWith("/setup-required");
  const isPublicAsset = request.nextUrl.pathname.startsWith("/_next");

  if (!hasSupabaseEnv()) {
    if (isSetupPage || isPublicAsset) return NextResponse.next({ request });
    return NextResponse.rewrite(new URL("/setup-required", request.url));
  }

  try {
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
      error,
    } = await supabase.auth.getUser();

    // getUser() itself resolves (doesn't throw) for most auth failures —
    // this branch is specifically for a broken/unreachable project (wrong
    // URL, paused project, network failure to Supabase), which surfaces as
    // an error result here rather than a rejected promise.
    if (error && error.name !== "AuthSessionMissingError") {
      console.error("middleware: Supabase auth check failed", error.message);
      if (isSetupPage) return NextResponse.next({ request });
      return NextResponse.rewrite(new URL("/setup-required", request.url));
    }

    const isAuthRoute = request.nextUrl.pathname.startsWith("/login");

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
  } catch (err) {
    console.error("middleware: unexpected error building the Supabase session", err);
    if (isSetupPage) return NextResponse.next({ request });
    return NextResponse.rewrite(new URL("/setup-required", request.url));
  }
}
