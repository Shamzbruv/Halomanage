import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireSupabaseEnv } from "@/lib/supabase/env";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Server client for Server Components / Route Handlers — reads the user's
// session from cookies and still runs every query under their JWT, so RLS
// applies identically to the browser client. This is NOT a service-role
// client; it has no elevated privileges over what the signed-in user
// already has.
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = requireSupabaseEnv();

  return createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component that can't set cookies — safe
            // to ignore as long as middleware.ts is refreshing the session.
          }
        },
      },
    },
  );
}
