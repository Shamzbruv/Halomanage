import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { NewRewardVendorForm } from "@/components/rewards/NewRewardVendorForm";
import { NewRewardProductForm } from "@/components/rewards/NewRewardProductForm";
import { AwardPointsForm } from "@/components/rewards/AwardPointsForm";
import { RedemptionFulfillmentActions } from "@/components/rewards/RedemptionFulfillmentActions";

// Gated behind the rewards_marketplace platform feature (see
// 20260830110000_rewards_marketplace.sql) — an org needs it turned on by a
// platform operator before any of this is reachable, same pattern as the
// SSO admin page's organization_has_feature() gate.
export default async function RewardsAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;
  const { data: enabled } = await supabase.rpc("organization_has_feature", { p_org_id: orgId, p_feature_key: "rewards_marketplace" });

  const canManageCatalog = sessionCan(session, "rewards.manage_catalog");
  const canAwardPoints = sessionCan(session, "rewards.award_points");
  const canFulfill = sessionCan(session, "rewards.fulfill");
  if (!canManageCatalog && !canAwardPoints && !canFulfill) redirect("/dashboard");

  if (!enabled) {
    return (
      <div className="space-y-6">
        <div className="page-intro"><span className="eyebrow">Rewards &amp; recognition</span><h1>Not enabled yet.</h1></div>
        <div className="card"><p className="text-sm text-stone-500">The rewards marketplace isn&apos;t turned on for your organization yet. Contact your Halomanage account team to enable it.</p></div>
      </div>
    );
  }

  const [{ data: providers }, { data: vendors }, { data: products }, { data: pendingRedemptions }, { data: employees }] = await Promise.all([
    supabase.from("reward_providers").select("id, name, fulfillment_type").eq("is_active", true).order("name"),
    supabase.from("reward_vendors").select("id, name, description, is_active, reward_providers(name, fulfillment_type)").eq("organization_id", orgId).order("name"),
    supabase.from("reward_products").select("id, name, points_cost, inventory_quantity, is_active, reward_vendors(name)").eq("organization_id", orgId).order("name"),
    canFulfill
      ? supabase.from("reward_redemptions").select("id, points_spent, fulfillment_type, created_at, employees(first_name, last_name), reward_products(name)").eq("organization_id", orgId).eq("status", "pending_fulfillment").order("created_at")
      : Promise.resolve({ data: [] }),
    canAwardPoints
      ? supabase.from("employees").select("id, first_name, last_name").eq("organization_id", orgId).eq("status", "active").order("last_name")
      : Promise.resolve({ data: [] }),
  ]);

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Rewards &amp; recognition</span>
        <h1>Curate your own reward catalog.</h1>
        <p>Any source of a reward — a local supplier, an API-connected gift card provider, an internal perk — is a vendor your organization controls.</p>
      </div>

      {canFulfill && (pendingRedemptions ?? []).length > 0 && (
        <section className="card overflow-x-auto">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Awaiting fulfillment</h2>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Employee</th><th className="pb-2">Reward</th><th className="pb-2">Points</th><th className="pb-2">Fulfillment</th><th className="pb-2">Requested</th><th className="pb-2"></th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {(pendingRedemptions ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td className="py-2 font-medium text-stone-900">{r.employees?.first_name} {r.employees?.last_name}</td>
                  <td className="py-2">{r.reward_products?.name}</td>
                  <td className="py-2">{r.points_spent.toLocaleString()}</td>
                  <td className="py-2 text-xs text-stone-500">{r.fulfillment_type}</td>
                  <td className="py-2 text-xs text-stone-500">{new Date(r.created_at).toLocaleDateString()}</td>
                  <td className="py-2"><RedemptionFulfillmentActions redemptionId={r.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {canAwardPoints && (
        <section className="card">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-900">Recognition</h2><AwardPointsForm employees={(employees ?? []).map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }))} /></div>
          <p className="text-xs text-stone-500">Award points to an employee for anything worth recognizing — they can spend them in the catalog below.</p>
        </section>
      )}

      {canManageCatalog && (
        <>
          <section className="card overflow-x-auto">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-900">Vendors</h2><NewRewardVendorForm organizationId={orgId} providers={providers ?? []} /></div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Name</th><th className="pb-2">Fulfillment</th><th className="pb-2">Active</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {(vendors ?? []).length === 0 && <tr><td colSpan={3} className="py-4 text-stone-400">No vendors yet.</td></tr>}
                {(vendors ?? []).map((v: any) => (
                  <tr key={v.id}><td className="py-2 font-medium text-stone-900">{v.name}</td><td className="py-2 text-xs text-stone-500">{v.reward_providers?.name} ({v.reward_providers?.fulfillment_type})</td><td className="py-2">{v.is_active ? "Yes" : "No"}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card overflow-x-auto">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-900">Rewards catalog</h2><NewRewardProductForm organizationId={orgId} vendors={(vendors ?? []).filter((v: any) => v.is_active).map((v: any) => ({ id: v.id, name: v.name }))} /></div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Reward</th><th className="pb-2">Vendor</th><th className="pb-2">Points</th><th className="pb-2">Stock</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {(products ?? []).length === 0 && <tr><td colSpan={4} className="py-4 text-stone-400">No rewards yet.</td></tr>}
                {(products ?? []).map((p: any) => (
                  <tr key={p.id}><td className="py-2 font-medium text-stone-900">{p.name}</td><td className="py-2 text-xs text-stone-500">{p.reward_vendors?.name}</td><td className="py-2">{p.points_cost.toLocaleString()}</td><td className="py-2">{p.inventory_quantity === null ? "Unlimited" : p.inventory_quantity}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
