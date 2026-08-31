import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { BuiltInRoleEditor } from "@/components/roles/BuiltInRoleEditor";
import { CustomRoleCard } from "@/components/roles/CustomRoleCard";
import { NewCustomRoleForm } from "@/components/roles/NewCustomRoleForm";
import type { AppPermission, AppRole } from "@/lib/supabase/types";

const BUILT_IN_ROLES: AppRole[] = ["employee", "supervisor", "manager", "admin"];

// Ref: 20260831100000_custom_organization_roles.sql. Every write on this
// page goes through an audited RPC (role_assignments/role_permissions are
// select-only under RLS) — this page only resolves what to show.
export default async function RolesAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "roles.manage")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [
    { data: globalDefaults },
    { data: orgOverrides },
    { data: customRolePermissions },
    { data: customRoles },
    { data: activeAssignments },
  ] = await Promise.all([
    supabase.from("role_permissions").select("role, permission").is("organization_id", null),
    supabase.from("role_permissions").select("role, permission").eq("organization_id", orgId).not("role", "is", null),
    supabase.from("role_permissions").select("custom_role_id, permission").eq("organization_id", orgId).not("custom_role_id", "is", null),
    supabase.from("organization_roles").select("*").eq("organization_id", orgId).order("name"),
    supabase.from("role_assignments").select("role, custom_role_id, valid_from, valid_until").eq("organization_id", orgId),
  ]);

  const now = new Date();
  const currentAssignments = (activeAssignments ?? []).filter(
    (a) => new Date(a.valid_from) <= now && (!a.valid_until || new Date(a.valid_until) > now),
  );

  const overriddenRoles = new Set((orgOverrides ?? []).map((r) => r.role));
  function effectivePermissionsFor(role: AppRole): AppPermission[] {
    const source = overriddenRoles.has(role)
      ? (orgOverrides ?? []).filter((r) => r.role === role)
      : (globalDefaults ?? []).filter((r) => r.role === role);
    return source.map((r) => r.permission as AppPermission);
  }
  function holderCountFor(role: AppRole): number {
    return currentAssignments.filter((a) => a.role === role).length;
  }
  function customRoleHolderCount(roleId: string): number {
    return currentAssignments.filter((a) => a.custom_role_id === roleId).length;
  }
  function customRolePermissionsFor(roleId: string): AppPermission[] {
    return (customRolePermissions ?? []).filter((rp) => rp.custom_role_id === roleId).map((rp) => rp.permission as AppPermission);
  }

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Roles &amp; permissions</span>
        <h1>Decide what each role can do.</h1>
        <p>Adjust the 4 built-in roles for your organization, or create your own — an HR Manager, a Payroll Specialist, anything your org chart needs — each with its own hand-picked set of permissions.</p>
      </div>

      <section className="card space-y-4">
        <div><h2 className="text-sm font-semibold text-stone-900">Built-in roles</h2><p className="text-xs text-stone-500">Every organization starts with these four. Customizing one changes it for everyone who holds it here — it never affects other organizations.</p></div>
        <div className="space-y-3">
          {BUILT_IN_ROLES.map((role) => (
            <BuiltInRoleEditor
              key={role}
              organizationId={orgId}
              role={role}
              initialPermissions={effectivePermissionsFor(role)}
              isOverridden={overriddenRoles.has(role)}
              holderCount={holderCountFor(role)}
            />
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold text-stone-900">Custom roles</h2><p className="text-xs text-stone-500">Your organization&apos;s own named roles, assignable from any employee&apos;s Role &amp; access section.</p></div>
          <NewCustomRoleForm organizationId={orgId} />
        </div>
        <div className="space-y-3">
          {(customRoles ?? []).length === 0 && <p className="text-sm text-stone-400">No custom roles yet.</p>}
          {(customRoles ?? []).map((role) => (
            <CustomRoleCard
              key={role.id}
              roleId={role.id}
              name={role.name}
              description={role.description}
              isActive={role.is_active}
              holderCount={customRoleHolderCount(role.id)}
              initialPermissions={customRolePermissionsFor(role.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
