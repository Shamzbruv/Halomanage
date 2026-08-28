import { createClient } from "@/lib/supabase/server";

export type PlatformRole = "owner" | "admin" | "support" | "billing" | "developer" | "security";

export type PlatformSession = {
  userId: string;
  email: string | null;
  role: PlatformRole;
  displayName: string | null;
  canManageStaff: boolean;
};

// Deliberately independent of lib/session.ts. Platform access is never
// derived from an organization's role_assignments — it exists only as a
// row in platform_staff, checked here with the same RLS-scoped client any
// signed-in user gets. See supabase/migrations/20260828160000_platform_console.sql.
export async function getPlatformSession(): Promise<PlatformSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("platform_staff")
    .select("role, display_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) return null;

  const role = data.role as PlatformRole;
  return {
    userId: user.id,
    email: user.email ?? null,
    role,
    displayName: data.display_name,
    canManageStaff: role === "owner" || role === "admin",
  };
}
