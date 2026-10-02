import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { OnboardingResponsibilitiesForm } from "@/components/OnboardingResponsibilitiesForm";
import { OnboardingTemplateForm } from "@/components/OnboardingTemplateForm";
import { StartOnboardingForm } from "@/components/StartOnboardingForm";
import { statusBadgeClass } from "@/lib/ui";
import { dateIn } from "@/lib/timezone";

const VIEWS = [
  { key: "in_progress", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
] as const;

// A dashboard over permanent onboarding records: finished and cancelled
// runs stay listed and open to their full record (./runs/[id]).
export default async function OnboardingAdminPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: requestedView } = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const canManageTemplates = sessionCan(session, "onboarding.manage_templates");
  if (!canManageTemplates && !sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");
  const view = VIEWS.find((v) => v.key === requestedView)?.key ?? "in_progress";

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: templates }, { data: employees }, { data: runs }, { data: progress }, { data: responsibilities }] = await Promise.all([
    supabase.from("onboarding_templates").select("id, name, is_default, is_active").eq("organization_id", orgId).order("name"),
    supabase.from("employees").select("id, first_name, last_name, employee_number, status").eq("organization_id", orgId).order("last_name"),
    supabase.from("onboarding_runs").select("id, employee_id, status, started_at, completed_at, cancelled_at, onboarding_template_versions(version_number, onboarding_templates(name))").eq("organization_id", orgId).order("started_at", { ascending: false }),
    // Aggregate view without FK relationships for PostgREST embedding —
    // fetched flat and joined in memory.
    supabase.from("onboarding_progress_v").select("*").eq("organization_id", orgId),
    supabase.from("onboarding_responsibilities").select("assignee_type, employee_id").eq("organization_id", orgId),
  ]);
  const activePeople = (employees ?? []).filter((e) => e.status !== "terminated").map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }));
  const responsibleByType = Object.fromEntries((responsibilities ?? []).map((r) => [r.assignee_type, r.employee_id]));

  const employeeById = new Map((employees ?? []).map((e) => [e.id, e]));
  const progressByRun = new Map((progress ?? []).map((p: any) => [p.run_id, p]));
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, (runs ?? []).filter((r) => v.key === "all" || r.status === v.key).length]));
  const visible = (runs ?? []).filter((r) => view === "all" || r.status === view);

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Onboarding</span><h1>Turn every first day into a reliable plan.</h1><p>Every onboarding is kept permanently — open any run to see exactly which steps were done, by whom, and when.</p></div>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-stone-900">Onboarding records</h2>
          <nav className="filter-chips" aria-label="Filter onboarding">
            {VIEWS.map((v) => (
              <Link key={v.key} href={`/admin/onboarding?view=${v.key}`} aria-current={view === v.key ? "page" : undefined} className={view === v.key ? "active" : ""}>{v.label} <span>{counts[v.key]}</span></Link>
            ))}
          </nav>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
              <th className="pb-2">Employee</th><th className="pb-2">Plan</th><th className="pb-2">Started</th><th className="pb-2">Progress</th><th className="pb-2">Overdue</th><th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {visible.length === 0 && <tr><td colSpan={6} className="py-4 text-stone-400">No onboarding records in this view.</td></tr>}
            {visible.map((run: any) => {
              const employee = employeeById.get(run.employee_id);
              const p = progressByRun.get(run.id);
              return (
                <tr key={run.id}>
                  <td className="py-2">
                    <Link className="font-medium text-royal-700 hover:underline" href={`/admin/onboarding/runs/${run.id}`}>{employee ? `${employee.first_name} ${employee.last_name}` : "—"}</Link>
                    <span className="ml-2 font-mono text-xs text-stone-400">{employee?.employee_number}</span>
                  </td>
                  <td className="py-2">{run.onboarding_template_versions?.onboarding_templates?.name ?? "—"} <span className="text-xs text-stone-400">v{run.onboarding_template_versions?.version_number}</span></td>
                  <td className="py-2">{dateIn(run.started_at, session.organization?.timezone)}</td>
                  <td className="py-2">{p ? `${p.completed_tasks}/${p.total_tasks} (${p.percent_complete ?? 0}%)` : "—"}</td>
                  <td className="py-2">{p?.overdue_tasks > 0 ? <span className="badge badge-ruby">{p.overdue_tasks} overdue</span> : "—"}</td>
                  <td className="py-2"><span className={`badge ${statusBadgeClass(run.status)}`}>{run.status.replace("_", " ")}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Who handles HR and IT steps</h2>
        <p className="mb-3 text-xs text-stone-500">These steps go to this person&apos;s dashboard and onboarding list automatically. A template step can name a different person, and you can reassign any single step from its onboarding record.</p>
        <OnboardingResponsibilitiesForm organizationId={orgId} people={activePeople} current={responsibleByType} />
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Start onboarding</h2>
        <p className="mb-3 text-xs text-stone-500">For new hires, choose the plan during <Link className="text-royal-700 hover:underline" href="/admin/employees">Prepare &amp; invite</Link> instead — it starts automatically with the invitation. Use this for existing employees (for example after a role change).</p>
        <StartOnboardingForm
          employees={(employees ?? []).filter((e) => e.status !== "terminated").map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }))}
          templates={(templates ?? []).filter((t) => t.is_active).map((t) => ({ id: t.id, label: t.name }))}
        />
      </div>

      {canManageTemplates && (
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Templates</h2>
          <ul className="mb-4 divide-y divide-stone-100">
            {(templates ?? []).length === 0 && <li className="py-2 text-sm text-stone-400">No templates yet — create one below.</li>}
            {(templates ?? []).map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <Link href={`/admin/onboarding/templates/${t.id}`} className="font-medium text-royal-700 hover:text-royal-800 hover:underline">{t.name}</Link>
                <span className="flex gap-1">
                  {t.is_default && <span className="badge badge-gold">Default</span>}
                  {!t.is_active && <span className="badge badge-neutral">Disabled</span>}
                </span>
              </li>
            ))}
          </ul>
          <OnboardingTemplateForm organizationId={orgId} />
        </div>
      )}
    </div>
  );
}
