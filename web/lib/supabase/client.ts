"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser client — carries the user's own session/JWT. Every query made
// with this client is subject to Postgres RLS exactly as documented in
// docs/ARCHITECTURE.md; there is no service-role/bypass path in this file
// and there must never be one (that key belongs only in Edge Functions and
// other trusted server environments — see supabase/functions/README.md).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
