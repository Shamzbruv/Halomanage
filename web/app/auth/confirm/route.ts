import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { resolveOrigin } from "@/lib/request-origin";
import { requireSupabaseEnv } from "@/lib/supabase/env";

// `next` normally arrives as a bare relative path ("/update-password").
// It can also arrive as a full URL now that Halomanage's own email
// templates (supabase/email-templates/templates.mjs) build this link
// themselves using {{ .RedirectTo }} — whatever full redirectTo/
// emailRedirectTo URL the calling code (LoginForm, InviteButton,
// CreateOrganizationForm) originally passed to Supabase Auth. A full URL
// is only honored when its origin matches this request's *real* origin
// (resolveOrigin, not the request's raw, proxy-unreliable one) — exactly
// as permissive as the relative-path case (same destination space), never
// enough to redirect anywhere Halomanage doesn't already control.
function resolveNext(requestedNext: string | null, origin: string): string {
  if (!requestedNext) return "/dashboard";
  if (requestedNext.startsWith("/") && !requestedNext.startsWith("//")) return requestedNext;
  try {
    const parsed = new URL(requestedNext);
    if (parsed.origin === origin) return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    // Not a valid absolute URL either — fall through to the safe default.
  }
  return "/dashboard";
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const origin = resolveOrigin(request);
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const type = requestUrl.searchParams.get("type") as EmailOtpType | null;
  const next = resolveNext(requestUrl.searchParams.get("next"), origin);

  if (tokenHash && type) {
    const { url, anonKey } = requireSupabaseEnv();

    // Collect cookies that the Supabase client needs to set during
    // verifyOtp(). We do NOT use the `cookies()` API from next/headers
    // here because it mutates a shared response object that
    // NextResponse.redirect() doesn't inherit — on mobile in-app
    // browsers (Gmail, iOS Mail) and some WebViews the session cookies
    // were silently dropped from the 302 redirect, so the target page
    // saw either no session or a stale session. Instead, we buffer
    // pending Set-Cookie headers and stamp them onto the redirect
    // response ourselves.
    const cookiesToSet: { name: string; value: string; options: CookieOptions }[] = [];

    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookies) {
          cookiesToSet.length = 0;
          cookies.forEach((c) => cookiesToSet.push(c));
        },
      },
    });

    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

    if (!error) {
      const response = NextResponse.redirect(new URL(next, origin));
      // Stamp every session cookie onto the redirect response so the
      // browser receives them in the same 302 hop — critical on mobile
      // where the cookie jar doesn't survive a cross-response handoff
      // through `cookies()`.
      for (const { name, value, options } of cookiesToSet) {
        response.cookies.set(name, value, options);
      }
      return response;
    }
  }

  return NextResponse.redirect(new URL("/auth/error", origin));
}
