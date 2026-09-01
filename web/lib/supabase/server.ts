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
      global: {
        // Marks every query this server makes on a signed-in user's behalf
        // as already having passed proxy.ts's per-request network-access
        // check for this exact request (see
        // 20260901100000_network_access_control.sql's private.network_policy_ok()).
        // Only this server ever sets it — a request straight from a
        // browser to Supabase never carries it, which is what lets the
        // database tell the two cases apart.
        headers: { "x-halomanage-server-relay": "1" },
      },
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
