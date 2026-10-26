import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { formatDate } from "@/lib/timezone";
import { rewardPage, type RewardsState } from "@/lib/rewards";
import { RedeemRewardButton } from "@/components/rewards/RedeemRewardButton";
import { RewardReceipt } from "@/components/rewards/RewardReceipt";
import { RewardsPagination } from "@/components/rewards/RewardsPagination";
export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  if (!sessionCan(session, "rewards.read_self")) redirect("/dashboard");
  const params = await searchParams,
    catalogPage = rewardPage(params.catalog),
    historyPage = rewardPage(params.history),
    ledgerPage = rewardPage(params.ledger),
    query = (params.q ?? "").slice(0, 120),
    id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      params.redemption ?? "",
    )
      ? params.redemption
      : null;
  const { data, error } = await (
    await createClient()
  ).rpc("get_rewards_state", {
    p_organization_id: session.organizationId,
    p_catalog_page: catalogPage,
    p_history_page: historyPage,
    p_ledger_page: ledgerPage,
    p_query: query,
    p_redemption_id: id,
  });
  if (error || !data)
    return (
      <div className="card space-y-3">
        <h1>Rewards could not be loaded</h1>
        <p role="alert">{error?.message ?? "Please try again."}</p>
        <Link href="/settings" className="btn-secondary">
          Account security
        </Link>
        <Link href="/rewards" className="btn-secondary">
          Reload Rewards
        </Link>
      </div>
    );
  const state = data as RewardsState,
    timezone = session.organization?.timezone;
  function href(key: string, page: number) {
    const p = new URLSearchParams({
      q: query,
      catalog: String(catalogPage),
      history: String(historyPage),
      ledger: String(ledgerPage),
    });
    p.set(key, String(page));
    return "/rewards?" + p.toString();
  }
  return (
    <div className="space-y-6 recognition-workspace">
      <div className="page-intro">
        <span className="eyebrow">Rewards</span>
        <h1>Your rewards and points.</h1>
        <p>
          Choose from your organization’s rewards. HR arranges collection or
          delivery.
        </p>
        <Link href="/recognition" className="btn-secondary">
          Recognition
        </Link>
      </div>
      <div className="metric-card" style={{ maxWidth: 320 }}>
        <div>
          <small>Available points</small>
          <strong>{Number(state.balance).toLocaleString()}</strong>
        </div>
      </div>
      {state.balance < 0 && (
        <p className="alert-error">
          A points correction reduced your balance below zero. New redemptions
          are paused until your balance covers the cost. Contact HR about
          pending requests. This does not deduct salary.
        </p>
      )}
      {!state.enabled && (
        <p className="alert-error">
          The marketplace is paused. Your points and history are preserved, and
          you can still cancel pending requests.
        </p>
      )}
      {id && (
        <section className="card space-y-3">
          <h2>Selected reward request</h2>
          {state.selected ? (
            <RewardReceipt receipt={state.selected} timezone={timezone} />
          ) : (
            <p>This request is unavailable to your account.</p>
          )}
        </section>
      )}
      {state.enabled && (
        <section className="card space-y-4">
          <h2>Rewards catalog</h2>
          <form className="flex flex-wrap items-end gap-3">
            <label className="label">
              Search rewards or vendors
              <input
                name="q"
                maxLength={120}
                className="input"
                defaultValue={query}
              />
            </label>
            <button className="btn-secondary">Search</button>
          </form>
          {state.catalog.length === 0 && (
            <p>
              No matching rewards are available. HR can add or restock items.
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {state.catalog.map((p) => (
              <article
                key={p.id}
                className="rounded-xl border border-stone-200 p-4 space-y-3"
              >
                {p.image_url && (
                  <img
                    src={p.image_url}
                    alt=""
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    style={{ height: 100, width: "100%", objectFit: "contain" }}
                  />
                )}
                <h3 className="font-semibold">{p.name}</h3>
                <p className="text-sm">{p.vendor_name}</p>
                <strong>{p.points_cost.toLocaleString()} points</strong>
                {p.description && <p>{p.description}</p>}
                <p>
                  {p.inventory_quantity === null
                    ? "Available"
                    : `${p.inventory_quantity} available`}
                </p>
                {p.terms && (
                  <details>
                    <summary>Collection and reward terms</summary>
                    <p className="whitespace-pre-wrap">{p.terms}</p>
                  </details>
                )}
                {state.can_redeem ? (
                  <RedeemRewardButton
                    product={p}
                    balance={Number(state.balance)}
                  />
                ) : (
                  <p>
                    Your role can view rewards; redemption requires HR to enable
                    permission.
                  </p>
                )}
              </article>
            ))}
          </div>
          <RewardsPagination
            page={catalogPage}
            total={state.catalog_total}
            size={12}
            href={(n) => href("catalog", n)}
          />
        </section>
      )}
      <section className="card space-y-4">
        <h2>Your redemption history</h2>
        <p>
          Pending requests reserve points immediately. Cancelled or failed
          requests refund their original cost once.
        </p>
        {!state.history.length && <p>No requests on this page.</p>}
        {state.history.map((r) => (
          <RewardReceipt key={r.id} receipt={r} timezone={timezone} />
        ))}
        <RewardsPagination
          page={historyPage}
          total={state.history_total}
          size={10}
          href={(n) => href("history", n)}
        />
      </section>
      <section className="card space-y-3">
        <h2>Your points history</h2>
        <p className="text-sm">
          Giving allowance in Recognition is separate from your spendable
          points. Points have no automatic cash or payroll conversion.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th>Activity</th>
                <th>Points</th>
                <th>Reason</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {state.ledger.map((l) => (
                <tr key={l.id} className="border-t border-stone-100">
                  <td className="py-3">{l.entry_type.replaceAll("_", " ")}</td>
                  <td>
                    {l.amount > 0 ? "+" : ""}
                    {l.amount.toLocaleString()}
                  </td>
                  <td className="max-w-md whitespace-pre-wrap">
                    {l.reason || "—"}
                    {l.related_redemption_id && (
                      <Link
                        className="block underline"
                        href={`/rewards?redemption=${l.related_redemption_id}`}
                      >
                        View reward receipt
                      </Link>
                    )}
                    {l.related_recognition_id && (
                      <Link
                        className="block underline"
                        href={`/recognition?item=${l.related_recognition_id}`}
                      >
                        View recognition
                      </Link>
                    )}
                  </td>
                  <td>{formatDate(l.created_at, timezone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!state.ledger.length && <p>No points activity on this page.</p>}
        <RewardsPagination
          page={ledgerPage}
          total={state.ledger_total}
          size={20}
          href={(n) => href("ledger", n)}
        />
      </section>
    </div>
  );
}
