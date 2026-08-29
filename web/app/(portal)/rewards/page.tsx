import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import { RedeemRewardButton } from "@/components/rewards/RedeemRewardButton";

export default async function RewardsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  if (!sessionCan(session, "rewards.read_self")) redirect("/dashboard");

  const supabase = await createClient();
  const employeeId = session.employee.id;
  const orgId = session.organizationId;
  const canRedeem = sessionCan(session, "rewards.redeem_self");

  const { data: enabled } = await supabase.rpc("organization_has_feature", { p_org_id: orgId, p_feature_key: "rewards_marketplace" });

  if (!enabled) {
    return (
      <div className="space-y-6">
        <div className="page-intro"><span className="eyebrow">Rewards</span><h1>Not available yet.</h1></div>
        <div className="context-empty card"><span><Icon name="spark" size={22} /></span><div><strong>Rewards aren&apos;t enabled for your organization yet.</strong><p>Check back once your HR team turns this on.</p></div></div>
      </div>
    );
  }

  const [{ data: balanceRow }, { data: products }, { data: history }, { data: ledger }] = await Promise.all([
    supabase.from("employee_points_balance_v").select("balance").eq("employee_id", employeeId).maybeSingle(),
    supabase.from("reward_products").select("id, name, description, image_url, points_cost, inventory_quantity, is_active, reward_vendors(name, is_active)").eq("organization_id", orgId).eq("is_active", true).order("points_cost"),
    supabase.from("reward_redemptions").select("id, points_spent, status, fulfillment_note, created_at, fulfilled_at, reward_products(name)").eq("employee_id", employeeId).order("created_at", { ascending: false }).limit(20),
    supabase.from("employee_points_ledger").select("id, entry_type, amount, reason, created_at").eq("employee_id", employeeId).order("created_at", { ascending: false }).limit(30),
  ]);

  const balance = balanceRow?.balance ?? 0;
  const availableProducts = (products ?? []).filter((p: any) => p.reward_vendors?.is_active);

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Rewards &amp; recognition</span>
        <h1>Spend your points.</h1>
        <p>Points you&apos;ve earned from recognition can be redeemed for anything in your organization&apos;s catalog.</p>
      </div>

      <div className="metric-card" style={{ maxWidth: 260 }}>
        <span className="metric-icon sun"><Icon name="spark" /></span>
        <div><small>Your points balance</small><strong>{balance.toLocaleString()}</strong></div>
      </div>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Catalog</h2>
        {availableProducts.length === 0 ? (
          <p className="text-sm text-stone-400">No rewards are available yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Reward</th><th className="pb-2">Vendor</th><th className="pb-2">Points</th><th className="pb-2">Stock</th><th className="pb-2"></th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {availableProducts.map((p: any) => {
                const outOfStock = p.inventory_quantity !== null && p.inventory_quantity <= 0;
                return (
                  <tr key={p.id}>
                    <td className="py-3">
                      <div className="flex items-center gap-3">
                        {p.image_url ? (
                          <img src={p.image_url} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                        ) : (
                          <span className="metric-icon mint small" style={{ flexShrink: 0 }}><Icon name="spark" size={16} /></span>
                        )}
                        <div><strong className="block font-medium text-stone-900">{p.name}</strong>{p.description && <small className="text-stone-500">{p.description}</small>}</div>
                      </div>
                    </td>
                    <td className="py-3 text-stone-600">{p.reward_vendors?.name}</td>
                    <td className="py-3 font-medium text-stone-900">{p.points_cost.toLocaleString()}</td>
                    <td className="py-3">{p.inventory_quantity === null ? "—" : outOfStock ? <span className="text-ruby-600">Out of stock</span> : p.inventory_quantity}</td>
                    <td className="py-3">{canRedeem && !outOfStock && <RedeemRewardButton productId={p.id} canAfford={balance >= p.points_cost} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Your redemption history</h2>
        {(history ?? []).length === 0 ? (
          <p className="text-sm text-stone-400">No redemptions yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Reward</th><th className="pb-2">Points</th><th className="pb-2">Status</th><th className="pb-2">Requested</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {(history ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td className="py-2 font-medium text-stone-900">{r.reward_products?.name}</td>
                  <td className="py-2">{r.points_spent.toLocaleString()}</td>
                  <td className="py-2"><span className={`badge ${statusBadgeClass(r.status)}`}>{r.status.replace(/_/g, " ")}</span></td>
                  <td className="py-2 text-xs text-stone-500">{new Date(r.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Points history</h2>
        {(ledger ?? []).length === 0 ? (
          <p className="text-sm text-stone-400">No points activity yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Type</th><th className="pb-2">Points</th><th className="pb-2">Reason</th><th className="pb-2">Date</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {(ledger ?? []).map((entry) => (
                <tr key={entry.id}>
                  <td className="py-2"><span className="badge badge-neutral">{entry.entry_type}</span></td>
                  <td className={`py-2 font-medium ${entry.amount > 0 ? "text-emerald-700" : "text-stone-900"}`}>{entry.amount > 0 ? "+" : ""}{entry.amount.toLocaleString()}</td>
                  <td className="py-2 text-stone-600">{entry.reason ?? "—"}</td>
                  <td className="py-2 text-xs text-stone-500">{new Date(entry.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
