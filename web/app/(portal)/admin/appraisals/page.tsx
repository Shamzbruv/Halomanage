import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { AppraisalTemplateForm } from "@/components/AppraisalTemplateForm";
import { AppraisalCycleForm } from "@/components/AppraisalCycleForm";
import { LaunchCycleButton } from "@/components/LaunchCycleButton";
import { statusBadgeClass } from "@/lib/ui";

export default async function AppraisalsAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: templates }, { data: cycles }] = await Promise.all([
    supabase.from("appraisal_templates").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("appraisal_cycles").select("*").eq("organization_id", orgId).order("start_date", { ascending: false }),
  ]);

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Performance configuration</span><h1>Design checkpoints that fit the moment.</h1><p>Create templates for probation, quarterly conversations, annual reviews, or any development rhythm you need.</p></div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Checkpoint templates</h2>
        <ul className="mb-4 divide-y divide-stone-100">
          {(templates ?? []).length === 0 && <li className="py-2 text-sm text-stone-400">None yet.</li>}
          {(templates ?? []).map((t) => (
            <li key={t.id} className="py-2 text-sm">
              <Link href={`/admin/appraisals/templates/${t.id}`} className="font-medium text-royal-700 hover:text-royal-800 hover:underline">
                {t.name}
              </Link>
            </li>
          ))}
        </ul>
        <AppraisalTemplateForm organizationId={orgId} />
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Cycles</h2>
        <ul className="mb-4 divide-y divide-stone-100">
          {(cycles ?? []).length === 0 && <li className="py-2 text-sm text-stone-400">None yet — 30/60/90-day checkpoints, quarterly reviews, PIPs, etc. are all just cycles built from a template.</li>}
          {(cycles ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <span className="font-medium text-stone-900">{c.name}</span>{" "}
                <span className="text-xs text-stone-400">starts {c.start_date}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`badge ${statusBadgeClass(c.status)}`}>{c.status}</span>
                {c.status === "draft" && <LaunchCycleButton cycleId={c.id} />}
              </div>
            </li>
          ))}
        </ul>
        <AppraisalCycleForm organizationId={orgId} templates={(templates ?? []).map((t) => ({ id: t.id, label: t.name }))} />
      </div>
    </div>
  );
}
