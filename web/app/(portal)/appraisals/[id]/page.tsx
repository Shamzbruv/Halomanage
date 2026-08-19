import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { AppraisalReviewForm } from "@/components/AppraisalReviewForm";
import { AcknowledgeAppraisalButton } from "@/components/AcknowledgeAppraisalButton";
import { statusBadgeClass } from "@/lib/ui";

export default async function AppraisalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const supabase = await createClient();

  const { data: instance } = await supabase.from("appraisal_instances").select("*").eq("id", id).single();
  if (!instance) notFound();

  const { data: template } = await supabase.from("appraisal_templates").select("*").eq("id", instance.template_id).single();
  const { data: sections } = await supabase.from("appraisal_sections").select("*").eq("template_id", instance.template_id).order("sequence");
  const sectionIds = (sections ?? []).map((s) => s.id);
  const { data: questions } = sectionIds.length
    ? await supabase.from("appraisal_questions").select("*").in("section_id", sectionIds).order("sequence")
    : { data: [] as any[] };

  const { data: reviewers } = await supabase.from("appraisal_reviewers").select("*").eq("instance_id", id).order("sequence");
  const myReviewerRow = (reviewers ?? []).find((r) => r.reviewer_user_id === session.userId && r.status === "pending");

  const reviewerIds = (reviewers ?? []).map((r) => r.id);
  const { data: responses } = reviewerIds.length
    ? await supabase.from("appraisal_responses").select("*").in("reviewer_id", reviewerIds)
    : { data: [] as any[] };

  const sectionsWithQuestions = (sections ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    sequence: s.sequence,
    questions: (questions ?? []).filter((q) => q.section_id === s.id),
  }));

  const myExisting: Record<string, { response_text: string | null; response_numeric: number | null }> = {};
  if (myReviewerRow) {
    for (const r of responses ?? []) {
      if (r.reviewer_id === myReviewerRow.id) myExisting[r.question_id] = r;
    }
  }

  const isSubject = instance.employee_id === session.employee?.id;
  const canAcknowledge = isSubject && instance.status === "employee_acknowledgement";
  const questionById = new Map((questions ?? []).map((q) => [q.id, q]));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/appraisals" className="text-xs text-royal-700 hover:text-royal-800">← Performance checkpoints</Link>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="font-display text-xl font-bold text-stone-900">{instance.label ?? template?.name}</h1>
          <span className={`badge ${statusBadgeClass(instance.status)}`}>{instance.status.replace(/_/g, " ")}</span>
        </div>
      </div>

      {myReviewerRow && (
        <div className="card">
          <h2 className="mb-4 text-sm font-semibold text-stone-900">
            Your {myReviewerRow.role === "self" ? "self-review" : `${myReviewerRow.role} review`}
          </h2>
          <AppraisalReviewForm
            instanceId={id}
            reviewerId={myReviewerRow.id}
            sections={sectionsWithQuestions}
            ratingScale={(template?.rating_scale as any[]) ?? []}
            existingResponses={myExisting}
          />
        </div>
      )}

      {canAcknowledge && (
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Acknowledge</h2>
          <p className="mb-3 text-xs text-stone-500">All review stages are complete. Acknowledging closes this checkpoint.</p>
          <AcknowledgeAppraisalButton instanceId={id} />
        </div>
      )}

      {(responses ?? []).length > 0 && (
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Responses so far</h2>
          <div className="space-y-4">
            {(reviewers ?? []).map((r) => {
              const rResponses = (responses ?? []).filter((resp) => resp.reviewer_id === r.id);
              if (rResponses.length === 0) return null;
              return (
                <div key={r.id}>
                  <h3 className="mb-1 text-xs font-semibold uppercase text-stone-400">{r.role}</h3>
                  <ul className="space-y-1 text-sm">
                    {rResponses.map((resp) => (
                      <li key={resp.id}>
                        <span className="text-stone-500">{questionById.get(resp.question_id)?.prompt}:</span>{" "}
                        <span className="font-medium text-stone-900">{resp.response_text ?? resp.response_numeric}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!myReviewerRow && !canAcknowledge && (responses ?? []).length === 0 && (
        <div className="card text-sm text-stone-400">Nothing to action here right now.</div>
      )}
    </div>
  );
}
