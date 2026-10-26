import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { AppraisalTemplateForm } from "@/components/AppraisalTemplateForm";
import { AppraisalCycleForm } from "@/components/AppraisalCycleForm";
import { RewardsPagination as Pagination } from "@/components/rewards/RewardsPagination";
import { performancePage, type PerformanceCycle } from "@/lib/performance";
import { todayIn } from "@/lib/timezone";
export default async function AppraisalsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (
    !session.organizationId ||
    !sessionCan(session, "appraisal.manage_cycles")
  )
    redirect("/dashboard");
  const p = await searchParams,
    page = performancePage(p.page),
    db = await createClient(),
    org = session.organizationId;
  const [state, t, ppl, d, pos] = await Promise.all([
    db.rpc("get_performance_admin", { p_organization_id: org, p_page: page }),
    db
      .from("appraisal_templates")
      .select("id,name,is_active")
      .eq("organization_id", org)
      .order("name"),
    db.rpc("list_performance_people", { p_organization_id: org }),
    db
      .from("org_units")
      .select("id,name")
      .eq("organization_id", org)
      .order("name"),
    db
      .from("positions")
      .select("id,title")
      .eq("organization_id", org)
      .order("title"),
  ]);
  const work = state.data as {
    total: number;
    cycles: PerformanceCycle[];
  } | null;
  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Performance administration</span>
        <h1>Set clear expectations and follow through.</h1>
        <p>
          Choose the period, target the right employees, and preserve the
          questions used for each review. Private drafts, independent assessment
          and the employee’s response stay separate.
        </p>
      </div>
      {[state.error, t.error, ppl.error].filter(Boolean).map((e, i) => (
        <p key={i} role="alert" className="alert-error">
          {e?.message}
        </p>
      ))}
      <section className="card space-y-3">
        <h2 className="font-semibold">Review cycles</h2>
        {work?.cycles.map((c) => (
          <article key={c.id} className="border rounded-xl p-4 space-y-2">
            <Link
              className="font-semibold underline"
              href={`/admin/appraisals/cycles/${c.id}`}
            >
              {c.name}
            </Link>
            <p>
              {c.status} · Opens {c.start_date} · Period{" "}
              {c.review_period_start || "not recorded"} to{" "}
              {c.review_period_end || "not recorded"}
            </p>
            <p>
              {c.completed_instances}/{c.total_instances} complete ·{" "}
              {c.cancelled_instances} cancelled · {c.open_queries} open HR
              queries · {c.blocked_reviewers} assignments need attention
            </p>
          </article>
        ))}
        {work && !work.cycles.length && (
          <p>No cycles yet. Create a draft below and preview its roster.</p>
        )}
        {work && (
          <Pagination
            page={page}
            total={work.total}
            size={20}
            href={(n) => `/admin/appraisals?page=${n}`}
          />
        )}
      </section>
      <section className="card space-y-3">
        <h2 className="font-semibold">Create a draft cycle</h2>
        <AppraisalCycleForm
          organizationId={org}
          today={todayIn(session.organization?.timezone)}
          templates={(t.data ?? [])
            .filter((x) => x.is_active)
            .map((x) => ({ id: x.id, label: x.name }))}
          people={ppl.data ?? []}
          departments={(d.data ?? []).map((x) => ({ id: x.id, label: x.name }))}
          positions={(pos.data ?? []).map((x) => ({
            id: x.id,
            label: x.title,
          }))}
        />
      </section>
      <section className="card space-y-3">
        <h2 className="font-semibold">Checkpoint templates</h2>
        {(t.data ?? []).map((x) => (
          <p key={x.id}>
            <Link
              className="underline"
              href={`/admin/appraisals/templates/${x.id}`}
            >
              {x.name}
            </Link>
            {!x.is_active ? " · Archived" : ""}
          </p>
        ))}
        <AppraisalTemplateForm organizationId={org} />
      </section>
    </div>
  );
}
