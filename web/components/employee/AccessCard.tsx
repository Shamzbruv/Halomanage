import { EmployeeAccessSetup } from "@/components/EmployeeAccessSetup";
import { ReportingScopeForm } from "@/components/ReportingScopeForm";
import { RoleAssignmentForm } from "@/components/RoleAssignmentForm";
import { accountLabel, type SetupReadiness } from "@/lib/employeeSetup";
import { permissionLabel } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/timezone";
import type { EmployeeRecord } from "@/components/employee/types";

function formatWhen(value: string | null | undefined, timezone: string | undefined) {
  return value ? formatDateTime(value, timezone, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

// Before an account exists: prepare the role the invitation will apply.
// After: the live role (set_member_role()) and, for team leads, whose
// records they can see.
export async function AccessCard({
  employee,
  organizationId,
  viewerUserId,
  readiness,
  timezone,
}: {
  employee: EmployeeRecord;
  organizationId: string;
  viewerUserId: string;
  readiness: SetupReadiness | null;
  timezone: string | undefined;
}) {
  const supabase = await createClient();
  const [{ data: customRoles }, { data: customRolePermissions }] = await Promise.all([
    supabase.from("organization_roles").select("id, name").eq("organization_id", organizationId).eq("is_active", true).order("name"),
    supabase.from("role_permissions").select("organization_id, custom_role_id, role, permission").or(`organization_id.eq.${organizationId},organization_id.is.null`),
  ]);

  const account = readiness?.account;
  const accountPanel = (
    <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
      <div><dt className="text-xs uppercase text-stone-400">Account</dt><dd>{accountLabel(account)}</dd></div>
      <div><dt className="text-xs uppercase text-stone-400">Invitation sent</dt><dd>{formatWhen(account?.invited_at, timezone)}</dd></div>
      <div><dt className="text-xs uppercase text-stone-400">Last sign-in</dt><dd>{formatWhen(account?.last_sign_in_at, timezone)}</dd></div>
      <div><dt className="text-xs uppercase text-stone-400">Access applied</dt><dd>{formatWhen(readiness?.access.applied_at, timezone)}</dd></div>
    </dl>
  );

  if (!employee.user_id) {
    const pendingCustom = (customRoles ?? []).find((r) => r.id === readiness?.access.pending_custom_role_id);
    // Mirrors role_grants_permission(): an organization's override rows for
    // a built-in role replace the global defaults entirely.
    const pendingRole = readiness?.access.pending_role ?? "employee";
    const builtInRows = (customRolePermissions ?? []).filter((rp) => !rp.custom_role_id && rp.role === pendingRole);
    const hasOverride = builtInRows.some((rp) => rp.organization_id === organizationId);
    const pendingPermissions = (pendingCustom
      ? (customRolePermissions ?? []).filter((rp) => rp.custom_role_id === pendingCustom.id)
      : builtInRows.filter((rp) => (hasOverride ? rp.organization_id === organizationId : rp.organization_id === null))
    ).map((rp) => rp.permission as Parameters<typeof permissionLabel>[0]);
    return (
      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Portal access</h2>
        <p className="mb-4 text-xs text-stone-500">
          {employee.first_name} doesn&apos;t have a sign-in account yet. Choose their access now; it&apos;s applied automatically in the same step that creates their account, so they never start with the wrong permissions.
        </p>
        {accountPanel}
        <EmployeeAccessSetup
          employeeId={employee.id}
          pendingRole={readiness?.access.pending_role ?? null}
          pendingCustomRoleId={readiness?.access.pending_custom_role_id ?? null}
          configuredAt={readiness?.access.configured_at ?? null}
          timezone={timezone}
          customRoles={customRoles ?? []}
        />
        {pendingPermissions.length > 0 && (
          <details className="mt-4 text-xs text-stone-600">
            <summary className="cursor-pointer">Permissions summary ({[...new Set(pendingPermissions)].length})</summary>
            <p className="mt-2 leading-relaxed">{[...new Set(pendingPermissions)].map((p) => `${p.split(".")[0]}: ${permissionLabel(p)}`).join(" · ")}</p>
          </details>
        )}
      </section>
    );
  }

  const [{ data: roleRows }, { data: employees }, { data: orgAssignments }] = await Promise.all([
    supabase.from("role_assignments").select("role, custom_role_id, valid_from, valid_until").eq("organization_id", organizationId).eq("user_id", employee.user_id).order("valid_from", { ascending: false }),
    supabase.from("employees").select("id, first_name, last_name, employee_number, status").eq("organization_id", organizationId).order("last_name"),
    supabase.from("employee_assignments").select("employee_id, supervisor_employee_id, manager_employee_id").eq("organization_id", organizationId).is("end_date", null),
  ]);
  const now = new Date();
  const currentRow = (roleRows ?? []).find((row) => new Date(row.valid_from) <= now && (!row.valid_until || new Date(row.valid_until) > now));
  const currentRole = (currentRow?.role ?? null) as "employee" | "supervisor" | "manager" | "admin" | null;
  const currentCustomRoleId = currentRow?.custom_role_id ?? null;
  const isSelf = employee.user_id === viewerUserId;
  const customPermissions = new Set((customRolePermissions ?? []).filter((rp) => rp.custom_role_id && rp.custom_role_id === currentCustomRoleId).map((rp) => rp.permission));
  const canLeadTeam = currentRole === "supervisor" || currentRole === "manager" || currentRole === "admin"
    || (currentCustomRoleId !== null && (customPermissions.has("employee.read_team") || customPermissions.has("employee.read_org")));
  const assignmentByEmployeeId = new Map((orgAssignments ?? []).map((a) => [a.employee_id, a]));
  const candidates = (employees ?? [])
    .filter((e) => e.id !== employee.id && e.status !== "terminated")
    .map((e) => ({
      id: e.id,
      label: `${e.first_name} ${e.last_name}`,
      employeeNumber: e.employee_number,
      supervisorEmployeeId: assignmentByEmployeeId.get(e.id)?.supervisor_employee_id ?? null,
      managerEmployeeId: assignmentByEmployeeId.get(e.id)?.manager_employee_id ?? null,
    }));

  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">Role &amp; access</h2>
      <p className="mb-4 text-xs text-stone-500">Controls what {employee.first_name} can see and manage across the organization. Takes effect immediately.</p>
      {accountPanel}
      <RoleAssignmentForm employeeId={employee.id} currentRole={currentRole} currentCustomRoleId={currentCustomRoleId} customRoles={customRoles ?? []} isSelf={isSelf} />
      {!isSelf && (
        <>
          <h3 className="mb-1 mt-5 text-xs font-semibold uppercase text-stone-400">Direct reports</h3>
          <p className="mb-3 text-xs text-stone-500">
            A Supervisor/Manager role (or a custom role with team-visibility permissions) grants the capability to see a team — this list decides whose records actually show up in {employee.first_name}&apos;s Team hub.
          </p>
          <ReportingScopeForm leaderEmployeeId={employee.id} currentRole={currentRole} canLead={canLeadTeam} candidates={candidates} />
        </>
      )}
    </section>
  );
}
