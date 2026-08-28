import { createClient } from "@/lib/supabase/server";
import type { AppPermission, AppRole, Employee } from "@/lib/supabase/types";

export type CurrentSession = {
  userId: string;
  email: string | null;
  employee: Employee | null;
  roles: AppRole[];
  permissions: AppPermission[];
  organizationId: string | null;
  organization: {
    id: string;
    name: string;
    slug: string;
    settings: Record<string, unknown>;
  } | null;
  dataError: boolean;
};

// Roles answer "what can this person broadly do"; permissions answer the
// actual question every route guard and RLS policy checks. Every admin
// page used to gate on session.roles.includes("admin") even where the
// underlying RPC enforced a narrower permission (payroll.import, now
// compensation.*) — an org that customizes role_permissions to grant that
// permission to a non-admin role, or revoke it from admin, would get a
// route guard that disagrees with the database. session.can(...) is the
// fix: it asks the same question the database would.
export function sessionCan(session: Pick<CurrentSession, "permissions">, permission: AppPermission): boolean {
  return session.permissions.includes(permission);
}

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

  const [employeeResult, roleResult] = await Promise.all([
    supabase.from("employees").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.from("role_assignments").select("organization_id, role").eq("user_id", user.id),
  ]);

  if (employeeResult.error || roleResult.error) {
    console.error("session: failed to resolve workspace membership", {
      employeeCode: employeeResult.error?.code,
      roleCode: roleResult.error?.code,
    });
  }

  const employee = employeeResult.data;
  const roleRows = roleResult.data;

  const roles = [...new Set((roleRows ?? []).map((r) => r.role as AppRole))];
  const organizationId = employee?.organization_id ?? roleRows?.[0]?.organization_id ?? null;

  let permissions: AppPermission[] = [];
  let permissionsError = false;
  if (organizationId) {
    const permissionResult = await supabase.rpc("get_effective_permissions", { p_org_id: organizationId });
    if (permissionResult.error) {
      permissionsError = true;
      console.error("session: failed to resolve effective permissions", { code: permissionResult.error.code });
    } else {
      permissions = (permissionResult.data ?? []).map((row: { get_effective_permissions: AppPermission }) => row.get_effective_permissions);
    }
  }
  let organization: CurrentSession["organization"] = null;
  let organizationError = false;

  if (organizationId) {
    const result = await supabase
      .from("organizations")
      .select("id, name, slug, settings")
      .eq("id", organizationId)
      .maybeSingle();
    organizationError = Boolean(result.error);
    if (result.error) {
      console.error("session: failed to resolve organization", { code: result.error.code });
    } else if (result.data) {
      organization = {
        id: result.data.id,
        name: result.data.name,
        slug: String(result.data.slug),
        settings: (result.data.settings as Record<string, unknown>) ?? {},
      };
    }
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    employee: (employee as Employee) ?? null,
    roles,
    permissions,
    organizationId,
    organization,
    dataError: Boolean(employeeResult.error || roleResult.error || organizationError || permissionsError),
  };
}

export function highestRole(roles: AppRole[]): AppRole | null {
  const order: AppRole[] = ["admin", "manager", "supervisor", "employee"];
  for (const r of order) {
    if (roles.includes(r)) return r;
  }
  return null;
}
