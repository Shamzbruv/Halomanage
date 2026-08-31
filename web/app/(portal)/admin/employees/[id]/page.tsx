import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { ActivateEmployeeButton } from "@/components/ActivateEmployeeButton";
import { ChangeAssignmentForm } from "@/components/ChangeAssignmentForm";
import { ChangeCompensationForm } from "@/components/ChangeCompensationForm";
import { GrantLeaveBalanceForm } from "@/components/GrantLeaveBalanceForm";
import { InviteButton } from "@/components/InviteButton";
import { ReportingScopeForm } from "@/components/ReportingScopeForm";
import { RoleAssignmentForm } from "@/components/RoleAssignmentForm";
import { TerminateEmployeeButton } from "@/components/TerminateEmployeeButton";
import { statusBadgeClass } from "@/lib/ui";

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId || !session.organization) redirect("/dashboard");
  // Compensation access is a separate grant from ordinary employee
  // management (see 20260829110000_compensation_pay_administration.sql) —
  // an admin whose org has revoked compensation.read_org still manages
  // this employee's assignment/role/leave normally, just without this section.
  const canReadCompensation = sessionCan(session, "compensation.read_org");
  const canManageCompensation = sessionCan(session, "compensation.manage") || sessionCan(session, "compensation.approve");

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
    { data: compensationHistory },
    { data: payGroups },
    { data: payGrades },
    { data: changeReasons },
    { data: orgAssignments },
    { data: customRoles },
    { data: customRolePermissions },
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
    supabase.from("employees").select("id, first_name, last_name, employee_number, status").eq("organization_id", orgId).order("last_name"),
    supabase.from("leave_types").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("leave_balance_v").select("balance, leave_type_name").eq("employee_id", id),
    supabase.from("employee_compensation").select("*").eq("employee_id", id).order("start_date", { ascending: false }),
    supabase.from("pay_groups").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("pay_grades").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("compensation_change_reasons").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    // Every other org member's current reporting line, so ReportingScopeForm
    // can pre-check whoever already reports to this person.
    supabase.from("employee_assignments").select("employee_id, supervisor_employee_id, manager_employee_id").eq("organization_id", orgId).is("end_date", null),
    supabase.from("organization_roles").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("role_permissions").select("custom_role_id, permission").eq("organization_id", orgId).not("custom_role_id", "is", null),
  ]);

  if (!employee) notFound();

  // role_assignments is select-only under RLS now (see
  // 20260828110000_lifecycle_rbac_hardening.sql) — every mutation goes
  // through set_member_role(). Only meaningful once the employee has a
  // linked account; a prehire with no user_id can't hold a role yet.
  const { data: roleRows } = employee.user_id
    ? await supabase
        .from("role_assignments")
        .select("role, custom_role_id, valid_from, valid_until")
        .eq("organization_id", orgId)
        .eq("user_id", employee.user_id)
        .order("valid_from", { ascending: false })
    : { data: null };
  const now = new Date();
  const currentAssignmentRow = (roleRows ?? []).find(
    (row) => new Date(row.valid_from) <= now && (!row.valid_until || new Date(row.valid_until) > now),
  );
  const currentRole = currentAssignmentRow?.role ?? null;
  const currentCustomRoleId = currentAssignmentRow?.custom_role_id ?? null;
  const isSelf = employee.user_id === session.userId;

  // Does whatever this person currently holds carry team-visibility
  // permissions? Built-in supervisor/manager/admin, or a custom role
  // explicitly granted employee.read_team/employee.read_org — mirrors
  // set_employee_reporting_scope()'s server-side check.
  const currentCustomRolePermissions = new Set(
    (customRolePermissions ?? [])
      .filter((rp) => rp.custom_role_id === currentCustomRoleId)
      .map((rp) => rp.permission),
  );
  const canLeadTeam =
    currentRole === "supervisor" || currentRole === "manager" || currentRole === "admin" ||
    (currentCustomRoleId !== null && (currentCustomRolePermissions.has("employee.read_team") || currentCustomRolePermissions.has("employee.read_org")));

  const assignmentByEmployeeId = new Map((orgAssignments ?? []).map((a) => [a.employee_id, a]));
  const reportingCandidates = (employees ?? [])
    .filter((e) => e.id !== employee.id && e.status !== "terminated")
    .map((e) => ({
      id: e.id,
      label: `${e.first_name} ${e.last_name}`,
      employeeNumber: e.employee_number,
      supervisorEmployeeId: assignmentByEmployeeId.get(e.id)?.supervisor_employee_id ?? null,
      managerEmployeeId: assignmentByEmployeeId.get(e.id)?.manager_employee_id ?? null,
    }));

  const supervisorName = currentAssignment?.supervisor_employee_id
    ? employees?.find((e) => e.id === currentAssignment.supervisor_employee_id)
    : null;
  const managerName = currentAssignment?.manager_employee_id
    ? employees?.find((e) => e.id === currentAssignment.manager_employee_id)
    : null;

  const today = new Date().toISOString().slice(0, 10);
  const currentCompensation = (compensationHistory ?? []).find(
    (c) => c.start_date <= today && (!c.end_date || c.end_date >= today),
  ) ?? null;
  const payGroupName = payGroups?.find((g) => g.id === currentCompensation?.pay_group_id)?.name ?? null;
  const payGradeName = payGrades?.find((g) => g.id === currentCompensation?.pay_grade_id)?.name ?? null;

  let nextPayDate: string | null = null;
  if (canReadCompensation && currentCompensation?.pay_group_id) {
    const { data: group } = await supabase.from("pay_groups").select("pay_calendar_id").eq("id", currentCompensation.pay_group_id).maybeSingle();
    if (group?.pay_calendar_id) {
      const { data: nextPeriod } = await supabase
        .from("pay_periods")
        .select("pay_date")
        .eq("pay_calendar_id", group.pay_calendar_id)
        .gte("pay_date", today)
        .order("pay_date", { ascending: true })
        .limit(1)
        .maybeSingle();
      nextPayDate = nextPeriod?.pay_date ?? null;
    }
  }

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
          {(employee.status === "prehire" || employee.status === "leave" || employee.status === "suspended") && (
            <ActivateEmployeeButton employeeId={employee.id} />
          )}
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
          <RoleAssignmentForm
            employeeId={employee.id}
            currentRole={currentRole as "employee" | "supervisor" | "manager" | "admin" | null}
            currentCustomRoleId={currentCustomRoleId}
            customRoles={customRoles ?? []}
            isSelf={isSelf}
          />

          {!isSelf && (
            <>
              <h3 className="mb-1 mt-5 text-xs font-semibold uppercase text-stone-400">Direct reports</h3>
              <p className="mb-3 text-xs text-stone-500">
                A Supervisor/Manager role (or a custom role with team-visibility permissions) grants the capability to see a
                team — this list decides whose records actually show up in {employee.first_name}&apos;s Team hub.
              </p>
              <ReportingScopeForm
                leaderEmployeeId={employee.id}
                currentRole={currentRole as "employee" | "supervisor" | "manager" | "admin" | null}
                canLead={canLeadTeam}
                candidates={reportingCandidates}
              />
            </>
          )}
        </div>
      )}

      {canReadCompensation && (
        <div className="card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-stone-900">Compensation</h2>
              <p className="text-xs text-stone-500">Gross rate only — Halomanage never calculates tax, deductions, or net pay.</p>
            </div>
            {canManageCompensation && (
              <ChangeCompensationForm
                employeeId={employee.id}
                payGroups={payGroups ?? []}
                payGrades={payGrades ?? []}
                reasons={changeReasons ?? []}
              />
            )}
          </div>

          {currentCompensation ? (
            <>
              {currentCompensation.needs_review && (
                <p className="alert-error mb-3 text-xs">
                  This record was carried over from an earlier schema version and its pay type/rate unit were inferred —
                  please confirm or correct it with Change compensation.
                </p>
              )}
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div><dt className="text-xs uppercase text-stone-400">Pay type</dt><dd>{currentCompensation.pay_type === "other" ? currentCompensation.pay_type_other_label : currentCompensation.pay_type ?? "—"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Rate</dt><dd>{currentCompensation.currency} {Number(currentCompensation.amount).toLocaleString()}{currentCompensation.rate_unit ? ` / ${currentCompensation.rate_unit}` : ""}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Pay frequency</dt><dd>{currentCompensation.pay_frequency ?? "—"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Pay group</dt><dd>{payGroupName ?? "—"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Next pay date</dt><dd>{nextPayDate ?? "—"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Pay grade</dt><dd>{payGradeName ?? "—"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Standard weekly hours</dt><dd>{currentCompensation.standard_weekly_hours ?? "—"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">FTE</dt><dd>{currentCompensation.fte ?? "—"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Overtime eligible</dt><dd>{currentCompensation.overtime_eligible === null ? "—" : currentCompensation.overtime_eligible ? "Yes" : "No"}</dd></div>
                <div><dt className="text-xs uppercase text-stone-400">Effective since</dt><dd>{currentCompensation.start_date}</dd></div>
              </dl>
            </>
          ) : (
            <p className="text-sm text-stone-400">No compensation on record yet.</p>
          )}

          {compensationHistory && compensationHistory.length > 1 && (
            <>
              <h3 className="mb-2 mt-5 text-xs font-semibold uppercase text-stone-400">History</h3>
              <ul className="space-y-1 text-xs text-stone-500">
                {compensationHistory.filter((c) => c.end_date !== null).map((c) => (
                  <li key={c.id}>
                    {c.start_date} → {c.end_date}: {c.currency} {Number(c.amount).toLocaleString()} ({c.pay_type ?? "unspecified"})
                  </li>
                ))}
              </ul>
            </>
          )}
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
