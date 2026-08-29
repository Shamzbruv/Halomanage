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

// A Server Component can't persist a refreshed session back to the browser
// (only middleware/Route Handlers/Server Actions can set cookies — see the
// comment in lib/supabase/server.ts), so a token that expires mid-render,
// or a refresh middleware already rotated a moment earlier, can leave one
// of the queries below holding a stale JWT even though supabase.auth.
// getUser() just succeeded. PostgREST reports that as PGRST301 ("JWT
// expired"); treat it as "not signed in" (a clean bounce to /login where
// the person just signs in again) rather than as a data error — the
// alternative was surfacing "we couldn't load your organization data,
// try again" for what is really just an expired session, a confusing
// dead end that "try again" wouldn't actually fix since the same stale
// cookie is still sitting in the browser.
function isExpiredSessionError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST301") return true;
  const message = error.message?.toLowerCase() ?? "";
  return message.includes("jwt expired") || message.includes("invalid refresh token") || message.includes("refresh_token_not_found");
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
    supabase
      .from("role_assignments")
      .select("organization_id, role, valid_from, valid_until")
      .eq("user_id", user.id),
  ]);

  if (isExpiredSessionError(employeeResult.error) || isExpiredSessionError(roleResult.error)) {
    return null;
  }

  if (employeeResult.error || roleResult.error) {
    console.error("session: failed to resolve workspace membership", {
      employeeCode: employeeResult.error?.code,
      roleCode: roleResult.error?.code,
    });
  }

  const employee = employeeResult.data;
  // Role assignments are effective-dated. Keep the browser shell aligned
  // with get_effective_permissions()/RLS instead of retaining every role the
  // member has ever held (the previous behaviour made a demoted admin still
  // look like an admin in navigation indefinitely).
  const now = Date.now();
  const roleRows = (roleResult.data ?? []).filter((row) => {
    const validFrom = new Date(row.valid_from).getTime();
    const validUntil = row.valid_until ? new Date(row.valid_until).getTime() : null;
    return validFrom <= now && (validUntil === null || validUntil > now);
  });

  const roles = [...new Set(roleRows.map((r) => r.role as AppRole))];
  const organizationId = employee?.organization_id ?? roleRows?.[0]?.organization_id ?? null;

  let permissions: AppPermission[] = [];
  let permissionsError = false;
  if (organizationId) {
    const permissionResult = await supabase.rpc("get_effective_permissions", { p_org_id: organizationId });
    if (isExpiredSessionError(permissionResult.error)) {
      return null;
    }
    if (permissionResult.error) {
      permissionsError = true;
      console.error("session: failed to resolve effective permissions", { code: permissionResult.error.code });
    } else {
      // PostgREST returns a `returns setof <scalar enum>` RPC as a bare
      // JSON array of the enum's string values (verified directly against
      // the live REST endpoint) — not one {get_effective_permissions: ...}
      // object per row the way a `returns table (...)`/composite-type RPC
      // would. Every sessionCan() check silently failed until this was
      // fixed: mapping a plain string through `.get_effective_permissions`
      // yields undefined, not the value, with no error anywhere to catch it.
      permissions = (permissionResult.data ?? []) as AppPermission[];
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
    if (isExpiredSessionError(result.error)) {
      return null;
    }
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
