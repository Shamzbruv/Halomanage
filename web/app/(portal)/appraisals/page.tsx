import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";

export default async function AppraisalsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  const supabase = await createClient();
  const [{ data: own }, { data: reviewing }] = await Promise.all([
    supabase.from("appraisal_instances").select("*").eq("employee_id", session.employee.id).order("created_at", { ascending: false }),
    supabase.from("appraisal_reviewers").select("*, appraisal_instances(*)").eq("reviewer_user_id", session.userId).eq("status", "pending"),
  ]);
  const reviewingOthers = (reviewing ?? []).filter((row: any) => row.appraisal_instances?.employee_id !== session.employee!.id);
  const active = (own ?? []).filter((item) => !["completed", "acknowledged", "cancelled"].includes(item.status)).length;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Growth & performance</span><h1>Clear conversations, not annual surprises.</h1><p>Keep self-reflection, manager feedback, and acknowledgement connected across every checkpoint.</p></div>
      <div className="performance-summary">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="performance" /></span><div><small>My active checkpoints</small><strong>{active}</strong><em>in progress</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="team" /></span><div><small>Reviews to complete</small><strong>{reviewingOthers.length}</strong><em>for your team</em></div></div>
      </div>
      {(own ?? []).length === 0 && reviewingOthers.length === 0 && session.roles.includes("admin") && (
        <div className="workspace-nudge"><span className="metric-icon sun"><Icon name="spark" /></span><div><strong>Your growth framework is ready to shape</strong><p>Review the starter quarterly template, adjust the questions, then launch the first checkpoint when your team is ready.</p></div><Link className="btn-secondary" href="/admin/appraisals">Open performance setup</Link></div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="performance" /></span><div><h3>My checkpoints</h3><p>Your current and previous performance conversations.</p></div></div></div>
          <div className="checkpoint-list">
            {(own ?? []).length === 0 && <div className="list-empty">No checkpoints scheduled yet.</div>}
            {(own ?? []).map((item) => <Link href={`/appraisals/${item.id}`} key={item.id}><span className="metric-icon mint small"><Icon name="performance" size={16} /></span><div><strong>{item.label ?? "Performance checkpoint"}</strong><small>{item.created_at ? new Date(item.created_at).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : "Checkpoint"}</small></div><span className={`badge ${statusBadgeClass(item.status)}`}>{item.status.replace(/_/g, " ")}</span></Link>)}
          </div>
        </section>
        <section className="card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="team" /></span><div><h3>Awaiting your review</h3><p>Checkpoints where your perspective is the next step.</p></div></div></div>
          <div className="checkpoint-list">
            {reviewingOthers.length === 0 && <div className="list-empty">You have no team reviews waiting.</div>}
            {reviewingOthers.map((row: any) => <Link href={`/appraisals/${row.appraisal_instances.id}`} key={row.id}><span className="metric-icon sun small"><Icon name="profile" size={16} /></span><div><strong>{row.appraisal_instances.label ?? "Performance checkpoint"}</strong><small>Your {row.role.replace(/_/g, " ")} review</small></div><Icon name="arrow-right" size={16} /></Link>)}
          </div>
        </section>
      </div>
    </div>
  );
}
