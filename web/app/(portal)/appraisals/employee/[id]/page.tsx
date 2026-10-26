import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { performancePage } from "@/lib/performance";
import { RewardsPagination as Pagination } from "@/components/rewards/RewardsPagination";
export default async function EmployeePerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const page = performancePage((await searchParams).page),
    { data, error } = await (
      await createClient()
    ).rpc("list_employee_performance", { p_employee_id: id, p_page: page });
  const h = data as {
    employee_name: string;
    total: number;
    items: {
      id: string;
      label: string;
      status: string;
      review_period_start: string | null;
      review_period_end: string | null;
      query_status: string;
    }[];
  } | null;
  return (
    <div className="space-y-5">
      <Link className="btn-secondary" href="/appraisals">
        Back to Performance
      </Link>
      <h1 className="text-xl font-semibold">
        {h?.employee_name || "Employee"} — checkpoint history
      </h1>
      {error && <p role="alert">{error.message}</p>}
      {h?.items.map((i) => (
        <article key={i.id} className="card space-y-2">
          <Link
            className="font-semibold underline"
            href={`/appraisals/${i.id}`}
          >
            {i.label}
          </Link>
          <p>
            {i.status.replaceAll("_", " ")} · HR query {i.query_status}
          </p>
          <p>
            Review period {i.review_period_start || "not recorded"} to{" "}
            {i.review_period_end || "not recorded"}
          </p>
        </article>
      ))}
      {h && !h.items.length && <p className="card">No recorded checkpoints.</p>}
      {h && (
        <Pagination
          page={page}
          total={h.total}
          size={20}
          href={(n) => `/appraisals/employee/${id}?page=${n}`}
        />
      )}
    </div>
  );
}
