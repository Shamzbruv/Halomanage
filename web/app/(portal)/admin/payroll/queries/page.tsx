import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { PayQueryThread, type PayQuery } from "@/components/PayQueries";
export const dynamic = "force-dynamic";
export default async function Queries({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  if (
    !s.organizationId ||
    !["payroll.import", "compensation.manage", "compensation.approve"].some(
      (p) =>
        sessionCan(
          s,
          p as
            "payroll.import" | "compensation.manage" | "compensation.approve",
        ),
    )
  )
    redirect("/dashboard");
  const p = await searchParams,
    status = ["open", "in_review", "resolved"].includes(p.status ?? "")
      ? p.status!
      : "open",
    page = Math.max(1, Math.min(10000, Math.trunc(Number(p.page)) || 1));
  const { data, error, count } = await (
    await createClient()
  )
    .from("pay_queries")
    .select("*,pay_query_messages(id,body,is_hr,created_at)", {
      count: "exact",
    })
    .eq("organization_id", s.organizationId)
    .eq("status", status)
    .order("updated_at")
    .range((page - 1) * 20, page * 20 - 1);
  return (
    <div className="pay-workspace space-y-6">
      <div className="page-intro">
        <Link href="/admin/payroll">← Pay records</Link>
        <h1>Employee pay queries</h1>
        <p>
          Investigate the source payroll result, leave and approved timesheets
          where relevant. Explain the outcome. Publish corrections through a
          replacement batch; record compensation changes through HR’s
          effective-dated workflow.
        </p>
      </div>
      <form className="flex gap-3">
        <label>
          Status
          <select className="input" name="status" defaultValue={status}>
            <option value="open">Open</option>
            <option value="in_review">In review</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <button className="btn-secondary">Filter</button>
      </form>
      {error && <p className="alert-error">Pay queries could not be loaded.</p>}
      {(data ?? []).map((q) => (
        <PayQueryThread key={q.id} query={q as PayQuery} hr />
      ))}
      {!error && !data?.length && (
        <p>No {status.replace(/_/g, " ")} queries are waiting.</p>
      )}
      <nav className="flex gap-4">
        {page > 1 && (
          <Link
            href={`/admin/payroll/queries?status=${status}&page=${page - 1}`}
          >
            Previous page
          </Link>
        )}
        {(count ?? 0) > page * 20 && (
          <Link
            href={`/admin/payroll/queries?status=${status}&page=${page + 1}`}
          >
            Next page
          </Link>
        )}
      </nav>
    </div>
  );
}
