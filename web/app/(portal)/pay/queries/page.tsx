import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import {
  NewPayQuery,
  PayQueryThread,
  type PayQuery,
} from "@/components/PayQueries";
export const dynamic = "force-dynamic";
export default async function Queries({
  searchParams,
}: {
  searchParams: Promise<{ payslip?: string; page?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/dashboard");
  const canComp = sessionCan(session, "compensation.read_self"),
    canPay = sessionCan(session, "payroll.read_self");
  if (!canComp && !canPay) redirect("/dashboard");
  const params = await searchParams,
    page = Math.max(1, Math.min(10000, Math.trunc(Number(params.page)) || 1)),
    supabase = await createClient();
  const { data, error, count } = await supabase
    .from("pay_queries")
    .select("*,pay_query_messages(id,body,is_hr,created_at)", {
      count: "exact",
    })
    .eq("employee_id", session.employee.id)
    .order("updated_at", { ascending: false })
    .range((page - 1) * 20, page * 20 - 1);
  const payslip =
    params.payslip && /^[0-9a-f-]{36}$/i.test(params.payslip)
      ? params.payslip
      : undefined;
  return (
    <div className="pay-workspace space-y-6">
      <div className="page-intro">
        <Link href="/pay">← My pay</Link>
        <h1>My pay queries</h1>
        <p>
          Follow HR’s response here. Pay changes require the normal compensation
          or payroll approval process.
        </p>
      </div>
      <NewPayQuery canComp={canComp} canPay={canPay} payslipId={payslip} />
      {error && (
        <p role="alert" className="alert-error">
          Your pay queries could not be loaded. Please try again.
        </p>
      )}
      {(data ?? []).map((q) => (
        <PayQueryThread key={q.id} query={q as PayQuery} hr={false} />
      ))}
      {!error && !data?.length && <p>No pay queries yet.</p>}
      <nav className="flex gap-4">
        {page > 1 && (
          <Link href={`/pay/queries?page=${page - 1}`}>Previous page</Link>
        )}
        {(count ?? 0) > page * 20 && (
          <Link href={`/pay/queries?page=${page + 1}`}>Next page</Link>
        )}
      </nav>
    </div>
  );
}
