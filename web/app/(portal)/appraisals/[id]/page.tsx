import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { AppraisalReviewForm } from "@/components/AppraisalReviewForm";
import { AcknowledgeAppraisalButton } from "@/components/AcknowledgeAppraisalButton";
import {
  PerformanceMessageForm,
  ReviewerResolutionForm,
  PerformanceGoalForm,
} from "@/components/PerformanceActions";
import {
  performanceAnswer,
  performanceStatus,
  type PerformanceCheckpoint,
} from "@/lib/performance";
import { formatDateTime } from "@/lib/timezone";
export default async function AppraisalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient(),
    { data, error } = await db.rpc("get_performance_checkpoint", {
      p_instance_id: id,
    });
  if (error || !data)
    return (
      <div className="card">
        <h1>Performance record unavailable</h1>
        <p role="alert">{error?.message ?? "Record not found."}</p>
        <Link href="/appraisals" className="btn-secondary">
          Back to Performance
        </Link>
        <Link href="/settings" className="btn-secondary">
          Account security
        </Link>
      </div>
    );
  const c = data as PerformanceCheckpoint,
    { data: people } = c.can_admin
      ? await db.rpc("list_performance_people", {
          p_organization_id: c.organization_id,
        })
      : { data: [] },
    mine = c.reviewers.find((r) => r.is_mine && r.can_edit),
    timezone = session.organization?.timezone,
    questions = c.form_snapshot.sections.flatMap((s) => s.questions);
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <Link href="/appraisals" className="btn-secondary">
        Back to Performance
      </Link>
      <div className="page-intro">
        <span className="eyebrow">{c.employee_name}</span>
        <h1>{c.label || c.form_snapshot.name}</h1>
        <p>
          {performanceStatus(c.status)} ·{" "}
          {c.review_period_start && c.review_period_end
            ? `${c.review_period_start} to ${c.review_period_end}`
            : "Historical review period not recorded"}
        </p>
        <p>
          Opens {c.opening_date || "not recorded"} · Employee response due{" "}
          {c.acknowledgement_due || "not set"}
        </p>
        {c.previous && (
          <Link className="btn-secondary" href={`/appraisals/${c.previous.id}`}>
            Previous released checkpoint: {c.previous.label}
          </Link>
        )}
      </div>
      {c.status === "cancelled" && (
        <p className="alert-error">
          Cancelled:{" "}
          {c.cancel_reason || "Contact HR for the retained decision."}
        </p>
      )}
      <section className="card space-y-3">
        <h2 className="font-semibold">Review stages</h2>
        <p className="text-sm">
          Drafts are private to their author. Submitted earlier stages are
          available to later assigned reviewers and HR; employees receive the
          combined feedback after independent review.
        </p>
        {c.reviewers.map((r) => (
          <div key={r.id} className="border rounded-xl p-3 space-y-2">
            <p>
              <strong>{r.role}</strong> ·{" "}
              {r.reviewer_name || "HR must assign an eligible reviewer"} ·{" "}
              {r.status}
              {r.id === c.current_stage_id ? " · Current stage" : ""}
              {r.due_date ? ` · Due ${r.due_date}` : ""}
            </p>
            {r.status === "pending" && !r.eligible && (
              <p className="alert-error">
                HR needs to review this assignment, account eligibility or
                performance permission.
              </p>
            )}
            {r.resolution_reason && <p>HR decision: {r.resolution_reason}</p>}
            {c.can_admin &&
              !c.is_subject &&
              r.status === "pending" &&
              c.status !== "cancelled" && (
                <ReviewerResolutionForm
                  reviewerId={r.id}
                  people={people ?? []}
                />
              )}
          </div>
        ))}
      </section>
      {mine && (
        <section className="card space-y-4">
          <h2 className="font-semibold">Your {mine.role} review</h2>
          <AppraisalReviewForm key={mine.id} checkpoint={c} reviewer={mine} />
        </section>
      )}
      {!mine &&
        c.reviewers.some((r) => r.is_mine && r.status === "pending") &&
        c.status !== "cancelled" && (
          <p className="card">
            Your stage is waiting for an earlier review, the cycle opening date,
            or HR to restore the assignment’s eligibility.
          </p>
        )}
      <section className="card space-y-4">
        <h2 className="font-semibold">Available review records</h2>
        {c.reviewers
          .filter((r) => c.responses.some((a) => a.reviewer_id === r.id))
          .map((r) => (
            <article key={r.id} className="border rounded-xl p-4 space-y-3">
              <h3 className="font-semibold">
                {r.reviewer_name || r.role} · {r.role} ·{" "}
                {r.status === "pending" ? "Your private draft" : "Submitted"}
              </h3>
              {c.responses
                .filter((a) => a.reviewer_id === r.id)
                .map((a) => (
                  <div key={a.id}>
                    <strong>
                      {questions.find((q) => q.id === a.question_id)?.prompt ||
                        "Recorded question"}
                    </strong>
                    <p className="whitespace-pre-wrap">
                      {performanceAnswer(a.response_json)}
                    </p>
                  </div>
                ))}
            </article>
          ))}
        {!c.responses.length && (
          <p>
            No review responses are available to your account at this stage.
          </p>
        )}
      </section>
      {c.is_subject && c.status === "employee_acknowledgement" && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Record receipt and your response</h2>
          <AcknowledgeAppraisalButton instanceId={c.id} />
        </section>
      )}
      {c.signoffs.length > 0 && (
        <section className="card">
          <h2 className="font-semibold">Employee receipt</h2>
          {c.signoffs.map((s) => (
            <div key={s.id}>
              <p>
                {s.disposition.replaceAll("_", " ")} ·{" "}
                {formatDateTime(s.signed_at, timezone)}
              </p>
              <p className="whitespace-pre-wrap">{s.note}</p>
            </div>
          ))}
        </section>
      )}
      {c.released_at && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Shared comments and HR follow-up</h2>
          <p>Query status: {c.query_status}</p>
          {c.messages.map((m) => (
            <article className="border rounded-xl p-3" key={m.id}>
              <strong>
                {m.actor_name} · {m.kind.replaceAll("_", " ")}
              </strong>
              <p className="whitespace-pre-wrap">{m.body}</p>
              <small>{formatDateTime(m.created_at, timezone)}</small>
            </article>
          ))}
          {(c.is_subject || c.can_admin) && (
            <PerformanceMessageForm
              instanceId={c.id}
              hr={c.can_admin && !c.is_subject}
            />
          )}
        </section>
      )}
      <section className="card space-y-4">
        <h2 className="font-semibold">Development goals and follow-through</h2>
        <p>
          Goals submitted in a self-review become proposals. An independent
          leader agrees the success criteria and confirms achievement. Progress
          does not change a historical rating, pay, leave or probation status.
        </p>
        {c.goals.map((g) => (
          <article className="border rounded-xl p-4 space-y-2" key={g.id}>
            <h3 className="font-semibold">
              {g.title} · {g.status}
            </h3>
            <p className="whitespace-pre-wrap">Success: {g.measure}</p>
            <p>
              Target {g.target_date} · Progress {g.progress}%
            </p>
            <p className="whitespace-pre-wrap">
              Support: {g.support || "Not specified"}
            </p>
            <details>
              <summary>Goal history</summary>
              {g.events.map((e) => (
                <div key={e.id}>
                  <p>
                    {e.actor_name} · {e.kind} · {e.progress}% ·{" "}
                    {formatDateTime(e.created_at, timezone)}
                  </p>
                  <p className="whitespace-pre-wrap">{e.note}</p>
                  {e.kind === "edit" && e.prior_values && (
                    <p className="whitespace-pre-wrap text-sm">
                      Previous terms: {e.prior_values.title} · Success:{" "}
                      {e.prior_values.measure} · Target:{" "}
                      {e.prior_values.target_date} · Support:{" "}
                      {e.prior_values.support || "Not specified"}
                    </p>
                  )}
                </div>
              ))}
            </details>
            {c.status !== "cancelled" && (
              <PerformanceGoalForm
                key={`${g.id}-${g.version}`}
                instanceId={c.id}
                goal={g}
                lead={c.can_lead}
                subject={c.is_subject}
                creator={g.created_by === session.userId}
              />
            )}
          </article>
        ))}
        {c.status !== "cancelled" && (
          <PerformanceGoalForm
            instanceId={c.id}
            lead={c.can_lead}
            subject={c.is_subject}
          />
        )}
      </section>
    </div>
  );
}
