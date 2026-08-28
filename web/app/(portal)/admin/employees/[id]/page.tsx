import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { ChangeAssignmentForm } from "@/components/ChangeAssignmentForm";
import { GrantLeaveBalanceForm } from "@/components/GrantLeaveBalanceForm";
import { InviteButton } from "@/components/InviteButton";
import { RoleAssignmentForm } from "@/components/RoleAssignmentForm";
import { TerminateEmployeeButton } from "@/components/TerminateEmployeeButton";
import { statusBadgeClass } from "@/lib/ui";

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId || !session.organization) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [
    { data: employee },
    { data: currentAssignment },
    { data: history },
    { data: orgUnits },
    { data: positions },
    { data: locations },
    { data: employees },
    { data: leaveTypes },
    { data: balances },
  ] = await Promise.all([
    supabase.from("employees").select("*").eq("id", id).single(),
    // Query the real employee_assignments table directly rather than
    // employee_current_assignment_v: PostgREST's automatic relationship
    // embedding (org_units(name), etc.) is driven by real foreign-key
    // constraints, which the underlying table has and the view doesn't —
    // same pitfall already hit and fixed once for leave_balance_v.
    supabase.from("employee_assignments").select("*, org_units(name), positions(title), locations(name)").eq("employee_id", id).is("end_date", null).maybeSingle(),
    supabase.from("employee_assignments").select("*, org_units(name), positions(title)").eq("employee_id", id).order("start_date", { ascending: false }),
    supabase.from("org_units").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("positions").select("id, title").eq("organization_id", orgId).order("title"),
    supabase.from("locations").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("employees").select("id, first_name, last_name").eq("organization_id", orgId).order("last_name"),
    supabase.from("leave_types").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("leave_balance_v").select("balance, leave_type_name").eq("employee_id", id),
  ]);

  if (!employee) notFound();

  // role_assignments is select-only under RLS now (see
  // 20260828110000_lifecycle_rbac_hardening.sql) — every mutation goes
  // through set_member_role(). Only meaningful once the employee has a
  // linked account; a prehire with no user_id can't hold a role yet.
  const { data: roleRows } = employee.user_id
    ? await supabase
        .from("role_assignments")
        .select("role, valid_from, valid_until")
        .eq("organization_id", orgId)
        .eq("user_id", employee.user_id)
        .order("valid_from", { ascending: false })
    : { data: null };
  const now = new Date();
  const currentRole =
    (roleRows ?? []).find(
      (row) => new Date(row.valid_from) <= now && (!row.valid_until || new Date(row.valid_until) > now),
    )?.role ?? null;
  const isSelf = employee.user_id === session.userId;

  const supervisorName = currentAssignment?.supervisor_employee_id
    ? employees?.find((e) => e.id === currentAssignment.supervisor_employee_id)
    : null;
  const managerName = currentAssignment?.manager_employee_id
    ? employees?.find((e) => e.id === currentAssignment.manager_employee_id)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/admin/employees" className="text-xs text-royal-700 hover:text-royal-800">← All employees</Link>
          <h1 className="mt-1 font-display text-xl font-bold text-stone-900">
            {employee.first_name} {employee.last_name}
          </h1>
          <p className="text-sm text-stone-500">
            {employee.employee_number} · {employee.work_email ?? "no email on file"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${statusBadgeClass(employee.status)}`}>{employee.status}</span>
          <InviteButton employeeId={employee.id} alreadyInvited={!!employee.user_id} portalSlug={session.organization.slug} />
          {employee.status !== "terminated" && (
            <TerminateEmployeeButton
              employeeId={employee.id}
              employeeName={`${employee.first_name} ${employee.last_name}`}
              isSelf={isSelf}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Current assignment</h2>
          {currentAssignment ? (
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs uppercase text-stone-400">Department</dt><dd>{currentAssignment.org_units?.name ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Position</dt><dd>{currentAssignment.positions?.title ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Location</dt><dd>{currentAssignment.locations?.name ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Supervisor</dt><dd>{supervisorName ? `${supervisorName.first_name} ${supervisorName.last_name}` : "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Manager</dt><dd>{managerName ? `${managerName.first_name} ${managerName.last_name}` : "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Employment type</dt><dd>{currentAssignment.employment_type ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Since</dt><dd>{currentAssignment.start_date}</dd></div>
            </dl>
          ) : (
            <p className="text-sm text-stone-400">No assignment yet — set one below.</p>
          )}

          {history && history.length > 1 && (
            <>
              <h3 className="mb-2 mt-5 text-xs font-semibold uppercase text-stone-400">History</h3>
              <ul className="space-y-1 text-xs text-stone-500">
                {history.slice(1).map((h) => (
                  <li key={h.id}>
                    {h.start_date} → {h.end_date ?? "—"}: {h.org_units?.name ?? "—"} / {h.positions?.title ?? "—"}
                    {h.change_reason ? ` — ${h.change_reason}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="card lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Change assignment</h2>
          <ChangeAssignmentForm
            employeeId={employee.id}
            orgUnits={(orgUnits ?? []).map((o) => ({ id: o.id, label: o.name }))}
            positions={(positions ?? []).map((p) => ({ id: p.id, label: p.title }))}
            locations={(locations ?? []).map((l) => ({ id: l.id, label: l.name }))}
            employees={(employees ?? []).map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }))}
          />
        </div>
      </div>

      {employee.user_id && (
        <div className="card">
          <h2 className="mb-1 text-sm font-semibold text-stone-900">Role &amp; access</h2>
          <p className="mb-4 text-xs text-stone-500">
            Controls what {employee.first_name} can see and manage across the organization. Takes effect immediately.
          </p>
          <RoleAssignmentForm employeeId={employee.id} currentRole={currentRole as "employee" | "supervisor" | "manager" | "admin" | null} isSelf={isSelf} />
        </div>
      )}

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Leave balances</h2>
        <ul className="mb-4 flex flex-wrap gap-4 text-sm">
          {(balances ?? []).length === 0 && <li className="text-stone-400">No balances recorded yet.</li>}
          {(balances ?? []).map((b: any) => (
            <li key={b.leave_type_name} className="rounded-lg bg-cream-100 px-3 py-1.5">
              <span className="text-stone-600">{b.leave_type_name}:</span>{" "}
              <span className="font-semibold text-stone-900">{b.balance} days</span>
            </li>
          ))}
        </ul>
        <GrantLeaveBalanceForm organizationId={orgId} employeeId={employee.id} leaveTypes={leaveTypes ?? []} />
      </div>
    </div>
  );
}
