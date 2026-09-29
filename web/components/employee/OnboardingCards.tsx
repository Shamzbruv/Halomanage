import Link from "next/link";
import { OnboardingTemplateRecommendation, type OnboardingRecommendation } from "@/components/OnboardingTemplateRecommendation";
import { createClient } from "@/lib/supabase/server";
import { statusBadgeClass } from "@/lib/ui";
import type { SetupReadiness } from "@/lib/employeeSetup";
import type { EmployeeRecord } from "@/components/employee/types";

export async function OnboardingPlanCard({ employee, organizationId, readiness }: { employee: EmployeeRecord; organizationId: string; readiness: SetupReadiness | null }) {
  const supabase = await createClient();
  const [{ data: templates }, { data: recommendation }, { data: activeRun }] = await Promise.all([
    supabase.from("onboarding_templates").select("id, name, onboarding_template_versions!inner(is_current)").eq("organization_id", organizationId).eq("is_active", true).eq("onboarding_template_versions.is_current", true).order("name"),
    supabase.rpc("recommend_onboarding_template", { p_employee_id: employee.id }),
    supabase.from("onboarding_runs").select("id, onboarding_template_versions(onboarding_templates(name))").eq("employee_id", employee.id).eq("status", "in_progress").order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">Onboarding plan</h2>
      <p className="mb-4 text-xs text-stone-500">
        Choose the plan {employee.first_name} will follow. It starts automatically when the invitation is sent, with every task dated from their start date.
      </p>
      <OnboardingTemplateRecommendation
        employeeId={employee.id}
        templates={(templates ?? []).map((t) => ({ id: t.id, name: t.name }))}
        recommendation={(recommendation as OnboardingRecommendation) ?? null}
        selectedTemplateId={readiness?.access.onboarding_template_id ?? null}
        wasRecommended={readiness?.access.onboarding_was_recommended ?? false}
        hasAccount={!!employee.user_id}
        activeRun={activeRun ? { id: activeRun.id, templateName: (activeRun as any).onboarding_template_versions?.onboarding_templates?.name ?? "Onboarding" } : null}
      />
    </section>
  );
}

// Every onboarding this person has ever had — in progress, completed and
// cancelled. Runs are never deleted; each links to its permanent record.
export async function OnboardingHistoryCard({ employeeId }: { employeeId: string }) {
  const supabase = await createClient();
  const [{ data: runs }, { data: progress }] = await Promise.all([
    supabase.from("onboarding_runs").select("id, status, started_at, completed_at, cancelled_at, onboarding_template_versions(version_number, onboarding_templates(name))").eq("employee_id", employeeId).order("started_at", { ascending: false }),
    supabase.from("onboarding_progress_v").select("run_id, total_tasks, completed_tasks, overdue_tasks, percent_complete").eq("employee_id", employeeId),
  ]);
  const progressByRun = new Map((progress ?? []).map((p: any) => [p.run_id, p]));

  return (
    <section className="card overflow-x-auto">
      <h2 className="mb-3 text-sm font-semibold text-stone-900">Onboarding history</h2>
      <table className="w-full text-sm">
        <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Plan</th><th className="pb-2">Version</th><th className="pb-2">Started</th><th className="pb-2">Finished</th><th className="pb-2">Progress</th><th className="pb-2">Status</th></tr></thead>
        <tbody className="divide-y divide-stone-100">
          {(runs ?? []).length === 0 && <tr><td colSpan={6} className="py-4 text-stone-400">No onboarding yet.</td></tr>}
          {(runs ?? []).map((run: any) => {
            const p = progressByRun.get(run.id);
            return (
              <tr key={run.id}>
                <td className="py-2"><Link className="font-medium text-royal-700 hover:underline" href={`/admin/onboarding/runs/${run.id}`}>{run.onboarding_template_versions?.onboarding_templates?.name ?? "Onboarding"}</Link></td>
                <td className="py-2">v{run.onboarding_template_versions?.version_number ?? "?"}</td>
                <td className="py-2">{String(run.started_at).slice(0, 10)}</td>
                <td className="py-2">{run.completed_at ? String(run.completed_at).slice(0, 10) : run.cancelled_at ? String(run.cancelled_at).slice(0, 10) : "—"}</td>
                <td className="py-2">{p ? `${p.completed_tasks}/${p.total_tasks}` : "—"}{p?.overdue_tasks > 0 && <span className="badge badge-ruby ml-2">{p.overdue_tasks} overdue</span>}</td>
                <td className="py-2"><span className={`badge ${statusBadgeClass(run.status)}`}>{run.status.replace("_", " ")}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
