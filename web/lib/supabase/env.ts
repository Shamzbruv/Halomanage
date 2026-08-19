// Central place to read/validate the Supabase env vars every client
// creator needs. Exists so a missing/misconfigured deployment fails with a
// clear, on-brand explanation (see app/setup-required/) instead of a bare
// "500 Internal Server Error" — which is what happened when middleware
// (lib/supabase/middleware.ts) threw @supabase/ssr's raw constructor error
// on every single request before any page ever got a chance to render.

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export class SupabaseConfigError extends Error {
  constructor() {
    super(
      "Halomanage isn't connected to a Supabase project yet — " +
        "NEXT_PUBLIC_SUPABASE_URL and/or NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.",
    );
    this.name = "SupabaseConfigError";
  }
}

// Throws SupabaseConfigError (rather than letting @supabase/ssr throw its
// own constructor error) when called somewhere middleware's
// setup-required rewrite didn't already intercept — e.g. a future Route
// Handler or Server Action that bypasses the standard middleware matcher.
export function requireSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new SupabaseConfigError();
  }
  return { url, anonKey };
}
