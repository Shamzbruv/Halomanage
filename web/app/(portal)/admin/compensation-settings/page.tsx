import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { NewPayGroupForm } from "@/components/compensation/NewPayGroupForm";
import { NewPayGradeForm } from "@/components/compensation/NewPayGradeForm";
import { NewCompensationComponentForm } from "@/components/compensation/NewCompensationComponentForm";
import { NewChangeReasonForm } from "@/components/compensation/NewChangeReasonForm";

// Gated on compensation.manage_structure — deliberately not the same
// permission as changing one employee's individual compensation
// (compensation.manage/.approve). Configuring the pay-group/grade/
// component catalog an organization uses is a different grant from
// acting on any specific person's pay.
export default async function CompensationSettingsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");
  if (!sessionCan(session, "compensation.manage_structure")) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: payGroups }, { data: payGrades }, { data: components }, { data: reasons }] = await Promise.all([
    supabase.from("pay_groups").select("*").eq("organization_id", orgId).order("name"),
    supabase.from("pay_grades").select("*").eq("organization_id", orgId).order("name"),
    supabase.from("compensation_components").select("*").eq("organization_id", orgId).order("name"),
    supabase.from("compensation_change_reasons").select("*").eq("organization_id", orgId).order("name"),
  ]);

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Compensation structure</span>
        <h1>Set up how compensation is organized.</h1>
        <p>Pay groups, grades, components, and change reasons — the building blocks Change Compensation draws from. Halomanage never calculates tax or net pay from any of this.</p>
      </div>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-900">Pay groups</h2><NewPayGroupForm organizationId={orgId} /></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Name</th><th className="pb-2">Code</th><th className="pb-2">Currency</th><th className="pb-2">Frequency</th><th className="pb-2">Active</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {(payGroups ?? []).length === 0 && <tr><td colSpan={5} className="py-4 text-stone-400">No pay groups yet.</td></tr>}
            {(payGroups ?? []).map((g) => (
              <tr key={g.id}><td className="py-2 font-medium text-stone-900">{g.name}</td><td className="py-2 text-stone-500">{g.code}</td><td className="py-2">{g.currency}</td><td className="py-2">{g.pay_frequency}</td><td className="py-2">{g.is_active ? "Yes" : "No"}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-900">Pay grades</h2><NewPayGradeForm organizationId={orgId} /></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Name</th><th className="pb-2">Code</th><th className="pb-2">Range</th><th className="pb-2">Active</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {(payGrades ?? []).length === 0 && <tr><td colSpan={4} className="py-4 text-stone-400">No pay grades yet.</td></tr>}
            {(payGrades ?? []).map((g) => (
              <tr key={g.id}>
                <td className="py-2 font-medium text-stone-900">{g.name}</td>
                <td className="py-2 text-stone-500">{g.code ?? "—"}</td>
                <td className="py-2 text-xs">{g.currency} {[g.minimum_amount, g.midpoint_amount, g.maximum_amount].filter((v) => v !== null).map((v) => Number(v).toLocaleString()).join(" / ") || "—"}</td>
                <td className="py-2">{g.is_active ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-900">Compensation components</h2><NewCompensationComponentForm organizationId={orgId} /></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Name</th><th className="pb-2">Type</th><th className="pb-2">Recurrence</th><th className="pb-2">Value</th><th className="pb-2">Payable to</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {(components ?? []).length === 0 && <tr><td colSpan={5} className="py-4 text-stone-400">No compensation components yet.</td></tr>}
            {(components ?? []).map((c) => (
              <tr key={c.id}>
                <td className="py-2 font-medium text-stone-900">{c.name} <span className="text-xs text-stone-400">({c.code})</span></td>
                <td className="py-2 text-stone-500">{c.component_type.replace(/_/g, " ")}</td>
                <td className="py-2">{c.recurrence.replace(/_/g, " ")}</td>
                <td className="py-2">{c.value_type === "percentage" ? `${c.default_percentage ?? "—"}%` : (c.default_amount !== null ? Number(c.default_amount).toLocaleString() : "—")}</td>
                <td className="py-2">{c.payable_to.replace(/_/g, " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-900">Compensation change reasons</h2><NewChangeReasonForm organizationId={orgId} /></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Name</th><th className="pb-2">Code</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {(reasons ?? []).length === 0 && <tr><td colSpan={2} className="py-4 text-stone-400">No change reasons yet.</td></tr>}
            {(reasons ?? []).map((r) => (
              <tr key={r.id}><td className="py-2 font-medium text-stone-900">{r.name}</td><td className="py-2 text-stone-500">{r.code ?? "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
