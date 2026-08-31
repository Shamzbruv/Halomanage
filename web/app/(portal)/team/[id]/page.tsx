import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";

function fullName(person: { first_name?: string | null; last_name?: string | null; preferred_name?: string | null }) {
  const first = person.preferred_name || person.first_name;
  return [first, person.last_name].filter(Boolean).join(" ") || "Team member";
}

function initials(person: { first_name?: string | null; last_name?: string | null }) {
  return `${person.first_name?.[0] ?? ""}${person.last_name?.[0] ?? ""}`.toUpperCase() || "TM";
}

// Read-only profile for Team Hub — deliberately no edit forms here.
// employee.read_team/read_org (checked below) is a weaker grant than
// employee.manage, which is what admin/employees/[id] requires to change
// anything; this page only ever displays what RLS already lets the viewer
// see. A cross-org or out-of-scope id simply returns no row from every
// query below (RLS-filtered, not an error), rendered as notFound() so an
// unauthorized lookup can't distinguish "doesn't exist" from "not yours to see".
export default async function TeamMemberProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee || !session.organizationId) redirect("/signup/complete?repair=1");

  const canReadTeam = sessionCan(session, "employee.read_team") || sessionCan(session, "employee.read_org");
  if (!canReadTeam) redirect("/dashboard");

  const supabase = await createClient();
  // Compensation visibility is its own grant, separate from general team
  // visibility (see 20260829110000_compensation_pay_administration.sql) —
  // a Manager with employee.read_team but no compensation.read_team sees
  // everything else on this page, just not pay.
  const canReadCompensation = sessionCan(session, "compensation.read_team") || sessionCan(session, "compensation.read_org");
  const canManage = sessionCan(session, "employee.manage");

  const [{ data: employee }, { data: assignment }, { data: balances }, { data: scheduleAssignment }] = await Promise.all([
    supabase.from("employees").select("*").eq("id", id).maybeSingle(),
    supabase.from("employee_assignments").select("*, org_units(name), positions(title), locations(name)").eq("employee_id", id).is("end_date", null).maybeSingle(),
    supabase.from("leave_balance_v").select("balance, leave_type_name").eq("employee_id", id),
    supabase.from("schedule_assignments").select("schedule_id, work_schedules(name)").eq("employee_id", id).is("end_date", null).maybeSingle(),
  ]);

  if (!employee) notFound();

  const leaderIds = [assignment?.supervisor_employee_id, assignment?.manager_employee_id].filter(Boolean) as string[];
  let supervisorName: string | null = null;
  let managerName: string | null = null;
  if (leaderIds.length > 0) {
    const { data: leaders } = await supabase.from("employees").select("id, first_name, last_name, preferred_name").in("id", leaderIds);
    const leaderById = new Map((leaders ?? []).map((leader) => [leader.id, leader]));
    supervisorName = assignment?.supervisor_employee_id
      ? (assignment.supervisor_employee_id === session.employee.id ? "You" : fullName(leaderById.get(assignment.supervisor_employee_id) ?? {}))
      : null;
    managerName = assignment?.manager_employee_id
      ? (assignment.manager_employee_id === session.employee.id ? "You" : fullName(leaderById.get(assignment.manager_employee_id) ?? {}))
      : null;
  }

  let currentCompensation: any = null;
  if (canReadCompensation) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: comp } = await supabase
      .from("employee_compensation")
      .select("*")
      .eq("employee_id", id)
      .lte("start_date", today)
      .or(`end_date.is.null,end_date.gte.${today}`)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    currentCompensation = comp;
  }

  let avatarUrl: string | null = null;
  if (employee.avatar_url) {
    const { data } = await supabase.storage.from("employee-avatars").createSignedUrl(employee.avatar_url, 3600);
    avatarUrl = data?.signedUrl ?? null;
  }

  const embeddedSchedule = scheduleAssignment?.work_schedules as { name: string } | { name: string }[] | null | undefined;
  const scheduleName = Array.isArray(embeddedSchedule) ? embeddedSchedule[0]?.name : embeddedSchedule?.name;
  const positionTitle = (Array.isArray(assignment?.positions) ? assignment.positions[0]?.title : assignment?.positions?.title) ?? null;
  const departmentName = (Array.isArray(assignment?.org_units) ? assignment.org_units[0]?.name : assignment?.org_units?.name) ?? null;
  const locationName = (Array.isArray(assignment?.locations) ? assignment.locations[0]?.name : assignment?.locations?.name) ?? null;

  return (
    <div className="space-y-6">
      <Link href="/team" className="text-xs text-royal-700 hover:text-royal-800">← Team hub</Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
          ) : (
            <span className="user-avatar" style={{ width: 56, height: 56, fontSize: 20 }}>{initials(employee)}</span>
          )}
          <div>
            <h1 className="font-display text-xl font-bold text-stone-900">{fullName(employee)}</h1>
            <p className="text-sm text-stone-500">{employee.employee_number}{positionTitle ? ` · ${positionTitle}` : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${statusBadgeClass(employee.status)}`}>{employee.status}</span>
          {canManage && <Link href={`/admin/employees/${employee.id}`} className="btn-secondary">Open full record</Link>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Position &amp; reporting</h2>
          {assignment ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div><dt className="text-xs uppercase text-stone-400">Position</dt><dd>{positionTitle ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Department</dt><dd>{departmentName ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Location</dt><dd>{locationName ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Employment type</dt><dd className="capitalize">{assignment.employment_type?.replace(/_/g, " ") ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Supervisor</dt><dd>{supervisorName ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Manager</dt><dd>{managerName ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Working schedule</dt><dd>{scheduleName ?? <span className="text-amber-700">Not assigned</span>}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Assigned since</dt><dd>{assignment.start_date ?? "—"}</dd></div>
            </dl>
          ) : (
            <p className="text-sm text-stone-400">No current assignment on record.</p>
          )}
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Contact &amp; tenure</h2>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-xs uppercase text-stone-400">Work email</dt><dd>{employee.work_email ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Work phone</dt><dd>{employee.work_phone ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Hire date</dt><dd>{employee.hire_date ?? "—"}</dd></div>
          </dl>
        </div>
      </div>

      {canReadCompensation && (
        <div className="card">
          <h2 className="mb-1 text-sm font-semibold text-stone-900">Compensation</h2>
          <p className="mb-3 text-xs text-stone-500">Gross rate only — Halomanage never calculates tax, deductions, or net pay.</p>
          {currentCompensation ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <div><dt className="text-xs uppercase text-stone-400">Pay type</dt><dd>{currentCompensation.pay_type === "other" ? currentCompensation.pay_type_other_label : currentCompensation.pay_type ?? "—"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Rate</dt><dd>{currentCompensation.currency} {Number(currentCompensation.amount).toLocaleString()}{currentCompensation.rate_unit ? ` / ${currentCompensation.rate_unit}` : ""}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Pay frequency</dt><dd>{currentCompensation.pay_frequency ?? "—"}</dd></div>
            </dl>
          ) : (
            <p className="text-sm text-stone-400">No compensation on record.</p>
          )}
        </div>
      )}

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Leave balances</h2>
        <ul className="flex flex-wrap gap-4 text-sm">
          {(balances ?? []).length === 0 && <li className="text-stone-400">No balances recorded yet.</li>}
          {(balances ?? []).map((b: any) => (
            <li key={b.leave_type_name} className="rounded-lg bg-cream-100 px-3 py-1.5">
              <span className="text-stone-600">{b.leave_type_name}:</span>{" "}
              <span className="font-semibold text-stone-900">{Number(b.balance).toLocaleString(undefined, { maximumFractionDigits: 1 })} days</span>
            </li>
          ))}
        </ul>
      </div>

      {!canManage && (
        <p className="flex items-center gap-1.5 text-xs text-stone-400"><Icon name="shield" size={14} /> Some details (compensation, documents) may be hidden based on your permissions.</p>
      )}
    </div>
  );
}
