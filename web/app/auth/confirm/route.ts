import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveOrigin } from "@/lib/request-origin";

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
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  return NextResponse.redirect(new URL("/auth/error", origin));
}
