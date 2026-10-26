import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { PerformanceTemplateSettings } from "@/components/PerformanceTemplateSettings";
import { AppraisalSectionForm } from "@/components/AppraisalSectionForm";
import { AppraisalQuestionForm } from "@/components/AppraisalQuestionForm";

export default async function AppraisalTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "appraisal.manage_cycles")) redirect("/dashboard");

  const supabase = await createClient();
  const { data: template } = await supabase
    .from("appraisal_templates")
    .select("*")
    .eq("id", id)
    .eq("organization_id", session.organizationId)
    .single();
  if (!template) notFound();

  const { data: sections } = await supabase
    .from("appraisal_sections")
    .select("*")
    .eq("template_id", id)
    .order("sequence");
  const sectionIds = (sections ?? []).map((s) => s.id);
  const { data: questions } = sectionIds.length
    ? await supabase
        .from("appraisal_questions")
        .select("*")
        .in("section_id", sectionIds)
        .order("sequence")
    : { data: [] as any[] };

  const questionsBySection = new Map<string, any[]>();
  for (const q of questions ?? []) {
    if (!questionsBySection.has(q.section_id))
      questionsBySection.set(q.section_id, []);
    questionsBySection.get(q.section_id)!.push(q);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/appraisals"
          className="text-xs text-royal-700 hover:text-royal-800"
        >
          ← Appraisals
        </Link>
        <h1 className="mt-1 font-display text-xl font-bold text-stone-900">
          {template.name}
        </h1>
      </div>

      <section className="card">
        <PerformanceTemplateSettings template={template} />
      </section>
      <div className="space-y-4">
        {(sections ?? []).map((s) => (
          <div key={s.id} className="card">
            <h2 className="mb-3 text-sm font-semibold text-stone-900">
              {s.sequence}. {s.title} · {s.is_active ? "Active" : "Archived"}
            </h2>
            <details className="mb-3">
              <summary>Edit future section</summary>
              <AppraisalSectionForm
                templateId={id}
                nextSequence={s.sequence}
                initial={s}
              />
            </details>
            <ul className="mb-3 space-y-1 pl-4">
              {(questionsBySection.get(s.id) ?? []).length === 0 && (
                <li className="text-sm text-stone-400">No questions yet.</li>
              )}
              {(questionsBySection.get(s.id) ?? []).map((q) => (
                <li key={q.id} className="text-sm text-stone-700">
                  <details>
                    <summary>
                      {q.sequence}. {q.prompt} ·{" "}
                      {q.is_active ? "Active" : "Archived"}
                    </summary>
                    <AppraisalQuestionForm
                      sectionId={s.id}
                      nextSequence={q.sequence}
                      initial={q}
                    />
                  </details>
                </li>
              ))}
            </ul>
            <AppraisalQuestionForm
              sectionId={s.id}
              nextSequence={
                Math.max(
                  0,
                  ...(questionsBySection.get(s.id) ?? []).map(
                    (q) => q.sequence,
                  ),
                ) + 1
              }
            />
          </div>
        ))}
      </div>

      <div className="card">
        <AppraisalSectionForm
          templateId={id}
          nextSequence={
            Math.max(0, ...(sections ?? []).map((s) => s.sequence)) + 1
          }
        />
      </div>
    </div>
  );
}
