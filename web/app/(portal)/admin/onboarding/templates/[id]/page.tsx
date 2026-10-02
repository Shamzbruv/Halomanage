import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { DeleteOnboardingTemplateButton } from "@/components/DeleteOnboardingTemplateButton";
import { OnboardingStepForm, type TemplateStep } from "@/components/OnboardingStepForm";
import { OnboardingStepList, OnboardingTemplateSettings } from "@/components/OnboardingTemplateEditor";
import { dateIn } from "@/lib/timezone";

export default async function OnboardingTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "onboarding.manage_templates")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: template }, { data: versions }, { data: orgUnits }, { data: positions }, { data: locations }, { data: employees }] = await Promise.all([
    supabase.from("onboarding_templates").select("*").eq("id", id).eq("organization_id", orgId).maybeSingle(),
    supabase.from("onboarding_template_versions").select("id, version_number, is_current, published_at").eq("template_id", id).order("version_number", { ascending: false }),
    supabase.from("org_units").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("positions").select("id, title").eq("organization_id", orgId).order("title"),
    supabase.from("locations").select("id, name").eq("organization_id", orgId).order("name"),
    supabase.from("employees").select("id, first_name, last_name").eq("organization_id", orgId).neq("status", "terminated").order("last_name"),
  ]);
  if (!template) notFound();
  const people = (employees ?? []).map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }));
  const version = (versions ?? []).find((v) => v.is_current) ?? null;

  const [{ data: steps }, { count: runsOnCurrent }] = version
    ? await Promise.all([
        supabase.from("onboarding_template_steps").select("*").eq("template_version_id", version.id).order("sequence"),
        supabase.from("onboarding_runs").select("id", { count: "exact", head: true }).eq("template_version_id", version.id),
      ])
    : [{ data: [] as TemplateStep[] }, { count: 0 }];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href="/admin/onboarding" className="text-xs text-royal-700 hover:text-royal-800">← Onboarding</Link>
          <h1 className="mt-1 font-display text-xl font-bold text-stone-900">{template.name}</h1>
          <p className="text-sm text-stone-500">
            Version {version?.version_number ?? "—"}
            {template.is_default && " · Default template"}
            {!template.is_active && " · Disabled"}
          </p>
        </div>
        <DeleteOnboardingTemplateButton templateId={template.id} templateName={template.name} />
      </div>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Template settings</h2>
        <OnboardingTemplateSettings
          template={template}
          departments={(orgUnits ?? []).map((o) => ({ id: o.id, label: o.name }))}
          positions={(positions ?? []).map((p) => ({ id: p.id, label: p.title }))}
          locations={(locations ?? []).map((l) => ({ id: l.id, label: l.name }))}
        />
      </section>

      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Steps</h2>
        <p className="mb-3 text-xs text-stone-500">
          {(runsOnCurrent ?? 0) > 0
            ? `${runsOnCurrent} onboarding run${runsOnCurrent === 1 ? " has" : "s have"} used version ${version?.version_number}. Your next change creates version ${(version?.version_number ?? 0) + 1} — existing records keep the version they started with.`
            : "No one has been onboarded with this version yet, so changes apply to it directly."}
        </p>
        <OnboardingStepList templateId={template.id} steps={(steps ?? []) as TemplateStep[]} people={people} />
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Add a step</h2>
        <OnboardingStepForm templateId={template.id} existingSteps={(steps ?? []).map((s) => ({ id: s.id, title: s.title }))} people={people} />
      </section>

      {(versions ?? []).length > 1 && (
        <section className="card">
          <h2 className="mb-2 text-sm font-semibold text-stone-900">Version history</h2>
          <ul className="space-y-1 text-sm text-stone-600">
            {(versions ?? []).map((v) => (
              <li key={v.id}>Version {v.version_number} · published {dateIn(v.published_at, session.organization?.timezone)}{v.is_current ? " · current" : ""}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
