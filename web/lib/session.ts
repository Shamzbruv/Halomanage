import { createClient } from "@/lib/supabase/server";
import type { AppRole, Employee } from "@/lib/supabase/types";

export type CurrentSession = {
  userId: string;
  email: string | null;
  employee: Employee | null;
  roles: AppRole[];
  organizationId: string | null;
};

// Everything the portal shell needs to decide what to show — one place so
// every page/layout asks the same question the same way. Every query here
// still goes through the user's own RLS-scoped client (lib/supabase/server)
// — this file has no elevated access, it just gathers what the signed-in
// user is already allowed to see about themselves.
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: employee } = await supabase
    .from("employees")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: roleRows } = await supabase
    .from("role_assignments")
    .select("organization_id, role")
    .eq("user_id", user.id);

  const roles = (roleRows ?? []).map((r) => r.role as AppRole);
  const organizationId = employee?.organization_id ?? roleRows?.[0]?.organization_id ?? null;

  return {
    userId: user.id,
    email: user.email ?? null,
    employee: (employee as Employee) ?? null,
    roles,
    organizationId,
  };
}

export function highestRole(roles: AppRole[]): AppRole | null {
  const order: AppRole[] = ["admin", "manager", "supervisor", "employee"];
  for (const r of order) {
    if (roles.includes(r)) return r;
  }
  return null;
}
