import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { OnboardingStepForm } from "@/components/OnboardingStepForm";

export default async function OnboardingTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");

  const supabase = await createClient();

  const { data: template } = await supabase.from("onboarding_templates").select("*").eq("id", id).single();
  if (!template) notFound();

  const { data: version } = await supabase
    .from("onboarding_template_versions")
    .select("id, version_number")
    .eq("template_id", id)
    .eq("is_current", true)
    .maybeSingle();

  const { data: steps } = version
    ? await supabase
        .from("onboarding_template_steps")
        .select("*")
        .eq("template_version_id", version.id)
        .order("sequence")
    : { data: [] as any[] };

  const stepById = new Map((steps ?? []).map((s) => [s.id, s]));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/onboarding" className="text-xs text-royal-700 hover:text-royal-800">← Onboarding</Link>
        <h1 className="mt-1 font-display text-xl font-bold text-stone-900">{template.name}</h1>
        <p className="text-sm text-stone-500">Version {version?.version_number ?? "—"} {template.is_default && "· Default template"}</p>
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Steps</h2>
        <ol className="space-y-2">
          {(steps ?? []).length === 0 && <li className="text-sm text-stone-400">No steps yet — add the first one below.</li>}
          {(steps ?? []).map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-3 rounded-lg bg-cream-100 px-3 py-2 text-sm">
              <div>
                <span className="font-medium text-stone-900">{s.sequence}. {s.title}</span>
                <p className="text-xs text-stone-500">
                  {s.step_type.replace(/_/g, " ")} · assigned to {s.assignee_type} · due {s.due_offset_days}d after start
                  {!s.required && " · optional"}
                </p>
                {s.dependency_step_ids?.length > 0 && (
                  <p className="text-xs text-stone-400">
                    depends on: {s.dependency_step_ids.map((d: string) => stepById.get(d)?.title).filter(Boolean).join(", ")}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {version && (
        <OnboardingStepForm
          templateVersionId={version.id}
          nextSequence={(steps?.length ?? 0) + 1}
          existingSteps={(steps ?? []).map((s) => ({ id: s.id, title: s.title }))}
        />
      )}
    </div>
  );
}
