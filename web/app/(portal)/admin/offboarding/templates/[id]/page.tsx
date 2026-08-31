import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { OffboardingStepForm } from "@/components/OffboardingStepForm";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function OffboardingTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const [{ data: template }, { data: steps }] = await Promise.all([
    supabase
      .from("offboarding_templates")
      .select("id, name, is_default, is_active")
      .eq("id", id)
      .eq("organization_id", session.organizationId)
      .maybeSingle(),
    supabase
      .from("offboarding_template_steps")
      .select("id, title, description, assignee_type, sequence, due_offset_days, required")
      .eq("template_id", id)
      .order("sequence"),
  ]);

  if (!template) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/offboarding" className="text-xs font-semibold text-royal-700 hover:underline">← Offboarding</Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-bold text-stone-900">{template.name}</h1>
          {template.is_default && <span className="badge badge-gold">Default</span>}
          {!template.is_active && <span className="badge badge-neutral">Inactive</span>}
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-500">Tasks are copied into each employee exit, preserving the checklist even if this template changes later.</p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,.8fr)]">
        <section className="card">
          <div className="panel-heading">
            <div><span className="panel-icon"><Icon name="onboarding" size={17} /></span><div><h3>Checklist steps</h3><p>{steps?.length ?? 0} configured</p></div></div>
          </div>
          <ol className="divide-y divide-stone-100">
            {(steps ?? []).length === 0 && (
              <li className="context-empty">
                <span><Icon name="document" /></span>
                <div><strong>No steps yet</strong><p>Add the first task so this template is ready to use.</p></div>
              </li>
            )}
            {(steps ?? []).map((step) => (
              <li key={step.id} className="grid gap-3 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mint-100 text-xs font-bold text-royal-700">{step.sequence}</span>
                <div>
                  <strong className="text-sm text-stone-900">{step.title}</strong>
                  {step.description && <p className="mt-1 text-xs leading-5 text-stone-500">{step.description}</p>}
                  <p className="mt-1.5 text-xs capitalize text-stone-400">{step.assignee_type === "hr" ? "HR / admin" : step.assignee_type} · due {step.due_offset_days === 0 ? "on start" : `${step.due_offset_days} day${step.due_offset_days === 1 ? "" : "s"} after start`}</p>
                </div>
                <span className={`badge ${step.required ? "badge-emerald" : "badge-neutral"}`}>{step.required ? "Required" : "Optional"}</span>
              </li>
            ))}
          </ol>
        </section>

        <OffboardingStepForm templateId={template.id} nextSequence={(steps?.length ?? 0) + 1} />
      </div>
    </div>
  );
}
