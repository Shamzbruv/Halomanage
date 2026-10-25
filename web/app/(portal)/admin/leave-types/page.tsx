import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { LeaveAccrualPolicyForm } from "@/components/LeaveAccrualPolicyForm";
import { todayIn } from "@/lib/timezone";
import { LeaveTypeForm } from "@/components/LeaveTypeForm";

export default async function LeaveTypesAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "leave.manage_policies")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const { data: leaveTypes, error } = await supabase
    .from("leave_types")
    .select("*")
    .eq("organization_id", session.organizationId)
    .order("name");

  const { data: policies, error: policyError } = await supabase.from("leave_policies").select("leave_type_id, accrual_method, accrual_amount, automated_accrual, first_accrual_date").eq("organization_id", session.organizationId).eq("is_default", true).eq("is_active", true);

  return (
    <div className="space-y-6">
      <div className="admin-page-head">
        <div className="page-intro"><span className="eyebrow">Policy configuration</span><h1>Make leave rules clear and consistent.</h1><p>Create the paid, unpaid, balance, notice, and approval rules your organization uses.</p></div>
        <LeaveTypeForm organizationId={session.organizationId} />
      </div>

      {(error || policyError) && <p className="alert-error" role="alert">Leave setup could not load: {error?.message ?? policyError?.message}</p>}
      <section className="card"><h2 className="font-semibold mb-2">Review the employer policy before activating leave</h2><p>Configure working-day or calendar-day counting, balances, service eligibility, medical evidence, notice and independent approvals. Use separate paid/unpaid types for entitlements with different pay phases. Existing employer entitlements are preserved.</p><div className="flex gap-4 mt-3"><a className="table-action" href="https://laws.moj.gov.jm/legislation/subsids/H/The%20Holidays%20with%20Pay%20Act.pdf" target="_blank" rel="noreferrer">Jamaica: Consolidated Holidays with Pay Order</a><a className="table-action" href="https://www.mlss.gov.jm/wp-content/uploads/2018/02/Employment-Flexible-Work-Arrangements-Miscellaneous-Provisions-Act-2014.pdf" target="_blank" rel="noreferrer">2014 flexible-work amendments</a><a className="table-action" href="https://www.mlss.gov.jm/wp-content/uploads/2017/11/Maternity-Leave-Act.pdf" target="_blank" rel="noreferrer">Jamaica: Maternity Leave Act</a></div></section>
      {(leaveTypes ?? []).map(t => <section key={t.id} className="card space-y-3"><h2 className="font-semibold">{t.name} ({t.code}) · {t.is_active ? "Active" : "Inactive"}</h2><p>{t.is_paid ? "Paid" : "Unpaid"} · {t.balance_tracked ? "Balance tracked" : "No balance limit"} · {t.day_count_basis === "calendar_days" ? "Calendar days" : "Scheduled working days"} · {t.requires_approval ? "Independent approval" : "Automatic approval"}</p><LeaveTypeForm organizationId={session.organizationId!} initial={t} />{t.balance_tracked && <LeaveAccrualPolicyForm organizationId={session.organizationId!} leaveTypeId={t.id} initial={policies?.find(p => p.leave_type_id === t.id) ?? null} today={todayIn(session.organization?.timezone)} />}</section>)}

    </div>
  );
}
