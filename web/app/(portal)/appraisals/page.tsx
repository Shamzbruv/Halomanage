import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { performancePage, performanceStatus } from "@/lib/performance";
import { RewardsPagination as Pagination } from "@/components/rewards/RewardsPagination";
type Work = {
  total: number;
  active_count: number;
  ready_count: number;
  items: {
    id: string;
    label: string;
    employee_name: string;
    status: string;
    is_subject: boolean;
    my_role: string | null;
    due_date: string | null;
    review_period_start: string | null;
    review_period_end: string | null;
    query_status: string;
  }[];
};
export default async function AppraisalsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  const p = await searchParams,
    view = ["active", "history", "all"].includes(p.view ?? "")
      ? p.view!
      : "active",
    page = performancePage(p.page),
    { data, error } = await (
      await createClient()
    ).rpc("list_performance_work", {
      p_organization_id: session.organizationId,
      p_view: view,
      p_page: page,
    }),
    work = data as Work | null;
  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Performance</span>
        <h1>Reflect, discuss and develop.</h1>
        <p>
          Keep self-reflection, evidence, feedback and development goals
          connected. Acknowledgement records receipt and allows disagreement.
        </p>
      </div>
      {work && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="metric-card">
            <div>
              <small>My active checkpoints</small>
              <strong>{work.active_count}</strong>
            </div>
          </div>
          <div className="metric-card">
            <div>
              <small>Review stages ready for me</small>
              <strong>{work.ready_count}</strong>
            </div>
          </div>
        </div>
      )}
      <nav className="flex flex-wrap gap-3" aria-label="Performance view">
        {[
          ["active", "Active"],
          ["history", "History"],
          ["all", "All checkpoints"],
        ].map(([key, label]) => (
          <Link
            className="btn-secondary"
            key={key}
            href={`/appraisals?view=${key}`}
            aria-current={key === view ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
        {sessionCan(session, "appraisal.manage_cycles") && (
          <Link className="btn-secondary" href="/admin/appraisals">
            Performance administration
          </Link>
        )}
      </nav>
      {error && (
        <div className="card">
          <p role="alert">{error.message}</p>
          <Link className="btn-secondary" href="/settings">
            Account security
          </Link>
        </div>
      )}
      {work?.items.map((i) => (
        <article className="card space-y-2" key={i.id}>
          <Link
            href={`/appraisals/${i.id}`}
            className="font-semibold underline"
          >
            {i.label || "Performance checkpoint"}
          </Link>
          <p>
            {i.is_subject ? "My checkpoint" : i.employee_name} ·{" "}
            {performanceStatus(i.status)}
          </p>
          <p className="text-sm">
            {i.review_period_start && i.review_period_end
              ? `Review period ${i.review_period_start} to ${i.review_period_end}`
              : "Historical review period not recorded"}
            {i.my_role ? ` · My ${i.my_role} stage` : ""}
            {i.due_date ? ` · Due ${i.due_date}` : ""}
          </p>
          {i.query_status === "open" && <p>HR follow-up requested</p>}
        </article>
      ))}
      {work && !work.items.length && (
        <div className="card">
          <h2>No checkpoints in this view</h2>
          <p>
            HR schedules the review period and participants. Check History for
            completed reviews.
          </p>
        </div>
      )}
      {work && (
        <Pagination
          page={page}
          total={work.total}
          size={20}
          href={(n) => `/appraisals?view=${view}&page=${n}`}
        />
      )}
    </div>
  );
}
