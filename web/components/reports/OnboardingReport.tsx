import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type Person = { id: string; first_name: string; last_name: string };

function PeopleList({ people, hrefFor }: { people: Person[]; hrefFor: (p: Person) => string }) {
  if (people.length === 0) return <p className="text-xs text-stone-400">No one.</p>;
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {people.slice(0, 25).map((p) => <li key={p.id}><Link className="text-royal-700 hover:underline" href={hrefFor(p)}>{p.first_name} {p.last_name}</Link></li>)}
      {people.length > 25 && <li className="text-stone-400">+{people.length - 25} more</li>}
    </ul>
  );
}

// Onboarding reporting (blueprint §25). Every figure can be expanded to the
// employees behind it. All reads go through the caller's RLS.
export async function OnboardingReport({ organizationId }: { organizationId: string }) {
  const supabase = await createClient();
  const today = new Date().toLocaleDateString("en-CA");
  // eslint-disable-next-line react-hooks/purity
  const in30 = new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA");

  const [{ data: runs }, { data: tasks }, { data: employees }, { data: assignments }] = await Promise.all([
    supabase.from("onboarding_runs").select("id, employee_id, status, started_at, completed_at").eq("organization_id", organizationId),
    supabase.from("onboarding_tasks").select("id, run_id, employee_id, title, status, due_date, completed_at, required, step_type, phase").eq("organization_id", organizationId),
    supabase.from("employees").select("id, first_name, last_name, status, probation_end_date").eq("organization_id", organizationId),
    supabase.from("employee_assignments").select("employee_id, org_units(name)").eq("organization_id", organizationId).is("end_date", null),
  ]);

  const personById = new Map((employees ?? []).map((e) => [e.id, e]));
  const peopleFor = (ids: Iterable<string>) => [...new Set(ids)].map((id) => personById.get(id)).filter(Boolean) as Person[];
  const runById = new Map((runs ?? []).map((r) => [r.id, r]));
  const activeRuns = (runs ?? []).filter((r) => r.status === "in_progress");
  const activeTasks = (tasks ?? []).filter((t) => runById.get(t.run_id)?.status === "in_progress");
  const isOpen = (t: { status: string }) => t.status !== "completed" && t.status !== "skipped";

  const completedRuns = (runs ?? []).filter((r) => r.status === "completed" && r.completed_at);
  const avgDays = completedRuns.length
    ? Math.round(completedRuns.reduce((sum, r) => sum + (new Date(r.completed_at!).getTime() - new Date(r.started_at).getTime()) / 86400000, 0) / completedRuns.length)
    : null;

  const overdue = activeTasks.filter((t) => isOpen(t) && t.due_date && t.due_date < today);

  // Most often late: still-open overdue steps plus steps completed after their due date.
  const lateByTitle = new Map<string, number>();
  for (const t of tasks ?? []) {
    const late = t.due_date && ((isOpen(t) && t.due_date < today && runById.get(t.run_id)?.status === "in_progress")
      || (t.status === "completed" && t.completed_at && String(t.completed_at).slice(0, 10) > t.due_date));
    if (late) lateByTitle.set(t.title, (lateByTitle.get(t.title) ?? 0) + 1);
  }
  const mostLate = [...lateByTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const departmentOf = new Map((assignments ?? []).map((a: any) => [a.employee_id, a.org_units?.name ?? "No department"]));
  const byDepartment = new Map<string, { total: number; done: number }>();
  for (const t of activeTasks) {
    const dept = departmentOf.get(t.employee_id) ?? "No department";
    const row = byDepartment.get(dept) ?? { total: 0, done: 0 };
    row.total += 1;
    if (!isOpen(t)) row.done += 1;
    byDepartment.set(dept, row);
  }

  const checkpointTasks = (tasks ?? []).filter((t) => t.phase === "first_30_days" || t.phase === "probation");
  const checkpointDue = checkpointTasks.filter((t) => t.due_date && t.due_date <= today);
  const checkpointDone = checkpointDue.filter((t) => !isOpen(t));

  const probationSoon = (employees ?? []).filter((e) => e.status !== "terminated" && e.probation_end_date && e.probation_end_date >= today && e.probation_end_date <= in30);
  const missingDocs = activeTasks.filter((t) => t.required && isOpen(t) && (t.step_type === "document_upload" || t.step_type === "signature"));

  const runHref = (employeeId: string) => {
    const run = activeRuns.find((r) => r.employee_id === employeeId) ?? (runs ?? []).find((r) => r.employee_id === employeeId);
    return run ? `/admin/onboarding/runs/${run.id}` : `/admin/employees/${employeeId}?tab=onboarding`;
  };

  const tile = (label: string, value: React.ReactNode, detail: React.ReactNode) => (
    <details className="card report-tile">
      <summary><small>{label}</small><strong>{value}</strong></summary>
      <div className="mt-2">{detail}</div>
    </details>
  );

  return (
    <section className="space-y-4">
      <div><h2 className="text-lg font-semibold text-stone-900">Onboarding</h2><p className="text-xs text-stone-500">Click a figure to see the people behind it.</p></div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tile("Currently onboarding", activeRuns.length, <PeopleList people={peopleFor(activeRuns.map((r) => r.employee_id))} hrefFor={(p) => runHref(p.id)} />)}
        {tile("Average time to complete", avgDays === null ? "—" : `${avgDays} days`, <p className="text-xs text-stone-500">Across {completedRuns.length} completed onboarding{completedRuns.length === 1 ? "" : "s"}.</p>)}
        {tile("Overdue steps", overdue.length, <PeopleList people={peopleFor(overdue.map((t) => t.employee_id))} hrefFor={(p) => runHref(p.id)} />)}
        {tile("30/60/90-day checkpoints done", checkpointDue.length ? `${Math.round((checkpointDone.length / checkpointDue.length) * 100)}%` : "—",
          <PeopleList people={peopleFor(checkpointDue.filter(isOpen).map((t) => t.employee_id))} hrefFor={(p) => runHref(p.id)} />)}
        {tile("Probation ending in 30 days", probationSoon.length, <PeopleList people={probationSoon} hrefFor={(p) => `/admin/employees/${p.id}`} />)}
        {tile("Missing mandatory documents", missingDocs.length, <PeopleList people={peopleFor(missingDocs.map((t) => t.employee_id))} hrefFor={(p) => `/admin/employees/${p.id}?tab=documents`} />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h3 className="mb-2 text-sm font-semibold text-stone-900">Steps most often late</h3>
          {mostLate.length === 0 ? <p className="text-sm text-stone-400">Nothing late yet.</p> : (
            <ul className="space-y-1 text-sm">{mostLate.map(([title, count]) => <li key={title} className="flex justify-between"><span>{title}</span><span className="badge badge-ruby">{count}</span></li>)}</ul>
          )}
        </div>
        <div className="card">
          <h3 className="mb-2 text-sm font-semibold text-stone-900">Active onboarding completion by department</h3>
          {byDepartment.size === 0 ? <p className="text-sm text-stone-400">No active onboarding.</p> : (
            <ul className="space-y-2 text-sm">
              {[...byDepartment.entries()].map(([dept, row]) => {
                const pct = row.total ? Math.round((row.done / row.total) * 100) : 0;
                return <li key={dept}><div className="flex justify-between"><span>{dept}</span><span>{pct}%</span></div><div className="setup-progress small"><span style={{ width: `${pct}%` }} /></div></li>;
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
