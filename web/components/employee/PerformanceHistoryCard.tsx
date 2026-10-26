import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
export async function PerformanceHistoryCard({
  employeeId,
}: {
  employeeId: string;
}) {
  const { data, error } = await (
    await createClient()
  ).rpc("list_employee_performance", { p_employee_id: employeeId, p_page: 1 });
  const history = data as {
    total: number;
    items: {
      id: string;
      label: string;
      status: string;
      review_period_end: string | null;
    }[];
  } | null;
  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">Performance checkpoints</h2>
      {error && (
        <p role="alert">
          Performance history is unavailable to this account or scope.
        </p>
      )}
      {history?.items.slice(0, 5).map((i) => (
        <p key={i.id}>
          <Link className="underline" href={`/appraisals/${i.id}`}>
            {i.label}
          </Link>{" "}
          · {i.status.replaceAll("_", " ")}
          {i.review_period_end ? ` · Period ends ${i.review_period_end}` : ""}
        </p>
      ))}
      {history && !history.items.length && <p>No checkpoints recorded.</p>}
      {history && (
        <Link
          className="btn-secondary"
          href={`/appraisals/employee/${employeeId}`}
        >
          View all {history.total} checkpoints
        </Link>
      )}
    </section>
  );
}
