import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Server client for Server Components / Route Handlers — reads the user's
// session from cookies and still runs every query under their JWT, so RLS
// applies identically to the browser client. This is NOT a service-role
// client; it has no elevated privileges over what the signed-in user
// already has.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
