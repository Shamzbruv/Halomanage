import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { AppraisalCycleForm } from "@/components/AppraisalCycleForm";
import { LaunchCycleButton } from "@/components/LaunchCycleButton";
import { PerformanceCycleResolution } from "@/components/PerformanceActions";
import { RewardsPagination as Pagination } from "@/components/rewards/RewardsPagination";
import { performancePage, type PerformanceCycle } from "@/lib/performance";
import { todayIn } from "@/lib/timezone";
type Cycle = PerformanceCycle & {
  total: number;
  instances: {
    id: string;
    employee_name: string;
    status: string;
    query_status: string;
    current_role: string | null;
    due_date: string | null;
    reviewer_name: string | null;
    reviewer_blocked: boolean;
  }[];
};
export default async function PerformanceCyclePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (
    !session.organizationId ||
    !sessionCan(session, "appraisal.manage_cycles")
  )
    redirect("/dashboard");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const p = await searchParams,
    page = performancePage(p.page),
    q = (p.q ?? "").slice(0, 120),
    db = await createClient(),
    { data, error } = await db.rpc("get_performance_cycle", {
      p_cycle_id: id,
      p_page: page,
      p_query: q,
    });
  if (error || !data)
    return (
      <div className="card">
        <h1>Cycle unavailable</h1>
        <p role="alert">{error?.message ?? "Cycle not found."}</p>
        <Link className="btn-secondary" href="/admin/appraisals">
          Back
        </Link>
      </div>
    );
  const c = data as Cycle;
  const [t, ppl, d, pos] =
    c.status === "draft"
      ? await Promise.all([
          db
            .from("appraisal_templates")
            .select("id,name")
            .eq("organization_id", session.organizationId)
            .eq("is_active", true)
            .order("name"),
          db.rpc("list_performance_people", {
            p_organization_id: session.organizationId,
          }),
          db
            .from("org_units")
            .select("id,name")
            .eq("organization_id", session.organizationId),
          db
            .from("positions")
            .select("id,title")
            .eq("organization_id", session.organizationId),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  return (
    <div className="space-y-6">
      <Link className="btn-secondary" href="/admin/appraisals">
        Back to performance administration
      </Link>
      <div className="page-intro">
        <span className="eyebrow">Review cycle · {c.status}</span>
        <h1>{c.name}</h1>
        <p>
          Performance period {c.review_period_start || "not recorded"} to{" "}
          {c.review_period_end || "not recorded"} · Opens {c.start_date}
        </p>
      </div>
      {c.status === "draft" ? (
        <>
          <section className="card space-y-3">
            <h2 className="font-semibold">Draft settings</h2>
            <AppraisalCycleForm
              key={c.revision}
              organizationId={session.organizationId}
              initial={c}
              today={todayIn(session.organization?.timezone)}
              templates={(t.data ?? []).map(
                (x: { id: string; name: string }) => ({
                  id: x.id,
                  label: x.name,
                }),
              )}
              people={ppl.data ?? []}
              departments={(d.data ?? []).map(
                (x: { id: string; name: string }) => ({
                  id: x.id,
                  label: x.name,
                }),
              )}
              positions={(pos.data ?? []).map(
                (x: { id: string; title: string }) => ({
                  id: x.id,
                  label: x.title,
                }),
              )}
            />
          </section>
          <section className="card">
            <LaunchCycleButton cycleId={c.id} />
          </section>
        </>
      ) : (
        <section className="card space-y-3">
          <h2 className="font-semibold">Employee checkpoints</h2>
          <form className="flex flex-wrap items-end gap-3">
            <label className="label">
              Employee name
              <input
                name="q"
                className="input"
                defaultValue={q}
                maxLength={120}
              />
            </label>
            <button className="btn-secondary">Search</button>
          </form>
          {c.instances.map((i) => (
            <article key={i.id} className="border rounded-xl p-4 space-y-2">
              <Link
                className="font-semibold underline"
                href={`/appraisals/${i.id}`}
              >
                {i.employee_name}
              </Link>
              <p>
                {i.status.replaceAll("_", " ")} · HR query {i.query_status}
              </p>
              {i.current_role && (
                <p>
                  With {i.reviewer_name || "HR assignment needed"} ·{" "}
                  {i.current_role}
                  {i.due_date ? ` · Due ${i.due_date}` : ""}
                </p>
              )}
              {i.reviewer_blocked && (
                <p className="alert-error">
                  Review the account, role permission or management scope before
                  continuing.
                </p>
              )}
            </article>
          ))}
          {!c.instances.length && <p>No matching checkpoints.</p>}
          <Pagination
            page={page}
            total={c.total}
            size={25}
            href={(n) =>
              `/admin/appraisals/cycles/${id}?${new URLSearchParams({ q, page: String(n) })}`
            }
          />
        </section>
      )}
      {!["closed", "cancelled"].includes(c.status) && (
        <section className="card">
          <PerformanceCycleResolution cycleId={c.id} />
        </section>
      )}
    </div>
  );
}
