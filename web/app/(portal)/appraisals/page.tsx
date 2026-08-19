import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";

export default async function AppraisalsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) return null;

  const supabase = await createClient();

  const [{ data: own }, { data: reviewing }] = await Promise.all([
    supabase.from("appraisal_instances").select("*").eq("employee_id", session.employee.id).order("created_at", { ascending: false }),
    supabase
      .from("appraisal_reviewers")
      .select("*, appraisal_instances(*)")
      .eq("reviewer_user_id", session.userId)
      .eq("status", "pending"),
  ]);

  const reviewingOthers = (reviewing ?? []).filter((r: any) => r.appraisal_instances?.employee_id !== session.employee!.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold text-stone-900">Performance checkpoints</h1>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">My checkpoints</h2>
        <ul className="divide-y divide-stone-100">
          {(own ?? []).length === 0 && <li className="py-3 text-sm text-stone-400">Nothing scheduled yet.</li>}
          {(own ?? []).map((i) => (
            <li key={i.id} className="flex items-center justify-between py-3 text-sm">
              <Link href={`/appraisals/${i.id}`} className="font-medium text-royal-700 hover:text-royal-800 hover:underline">
                {i.label ?? "Performance checkpoint"}
              </Link>
              <span className={`badge ${statusBadgeClass(i.status)}`}>{i.status.replace(/_/g, " ")}</span>
            </li>
          ))}
        </ul>
      </div>

      {reviewingOthers.length > 0 && (
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Awaiting your review</h2>
          <ul className="divide-y divide-stone-100">
            {reviewingOthers.map((r: any) => (
              <li key={r.id} className="flex items-center justify-between py-3 text-sm">
                <Link href={`/appraisals/${r.appraisal_instances.id}`} className="font-medium text-royal-700 hover:text-royal-800 hover:underline">
                  {r.appraisal_instances.label ?? "Performance checkpoint"}
                </Link>
                <span className="badge badge-gold">Your {r.role} review</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
