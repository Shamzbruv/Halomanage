import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { OnboardingTemplateForm } from "@/components/OnboardingTemplateForm";
import { StartOnboardingForm } from "@/components/StartOnboardingForm";

export default async function OnboardingAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: templates }, { data: employees }, { data: progress }] = await Promise.all([
    supabase.from("onboarding_templates").select("id, name, is_default").eq("organization_id", orgId).order("name"),
    supabase.from("employees").select("id, first_name, last_name").eq("organization_id", orgId).order("last_name"),
    // onboarding_progress_v is an aggregate view with no foreign-key
    // relationship for PostgREST to embed employees(...) through (see the
    // same note on employee_assignments in admin/employees/[id]/page.tsx)
    // — fetched flat and joined against the employees list below instead.
    supabase.from("onboarding_progress_v").select("*").eq("organization_id", orgId),
  ]);

  const employeeById = new Map((employees ?? []).map((e) => [e.id, e]));

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Workflow design</span><h1>Turn every first day into a reliable plan.</h1><p>Build reusable onboarding templates, then start the right version for each new hire.</p></div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Templates</h2>
        <ul className="mb-4 divide-y divide-stone-100">
          {(templates ?? []).length === 0 && <li className="py-2 text-sm text-stone-400">No templates yet — create one below.</li>}
          {(templates ?? []).map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2 text-sm">
              <Link href={`/admin/onboarding/templates/${t.id}`} className="font-medium text-royal-700 hover:text-royal-800 hover:underline">
                {t.name}
              </Link>
              {t.is_default && <span className="badge badge-gold">Default</span>}
            </li>
          ))}
        </ul>
        <OnboardingTemplateForm organizationId={orgId} />
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Start onboarding</h2>
        <StartOnboardingForm
          employees={(employees ?? []).map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }))}
          templates={(templates ?? []).map((t) => ({ id: t.id, label: t.name }))}
        />
      </div>

      <div className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">In progress</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
              <th className="pb-2">Employee</th>
              <th className="pb-2">Progress</th>
              <th className="pb-2">Overdue</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(progress ?? []).length === 0 && (
              <tr><td colSpan={4} className="py-4 text-stone-400">No onboarding runs yet.</td></tr>
            )}
            {(progress ?? []).map((p: any) => (
              <tr key={p.run_id}>
                <td className="py-2">
                  {employeeById.get(p.employee_id)
                    ? `${employeeById.get(p.employee_id)!.first_name} ${employeeById.get(p.employee_id)!.last_name}`
                    : "—"}
                </td>
                <td className="py-2">{p.completed_tasks}/{p.total_tasks} ({p.percent_complete ?? 0}%)</td>
                <td className="py-2">{p.overdue_tasks > 0 ? <span className="badge badge-ruby">{p.overdue_tasks} overdue</span> : "—"}</td>
                <td className="py-2"><span className={`badge ${p.status === "completed" ? "badge-emerald" : "badge-gold"}`}>{p.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
