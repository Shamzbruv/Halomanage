import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { rewardPage, type RewardsAdminState } from "@/lib/rewards";
import { formatDate } from "@/lib/timezone";
import { NewRewardVendorForm } from "@/components/rewards/NewRewardVendorForm";
import { NewRewardProductForm } from "@/components/rewards/NewRewardProductForm";
import { AwardPointsForm } from "@/components/rewards/AwardPointsForm";
import { RewardReceipt } from "@/components/rewards/RewardReceipt";
import { ReverseAwardButton } from "@/components/rewards/ReverseAwardButton";
import { RewardsPagination } from "@/components/rewards/RewardsPagination";
export default async function RewardsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (
    !session.organizationId ||
    !["rewards.manage_catalog", "rewards.award_points", "rewards.fulfill"].some(
      (p) =>
        sessionCan(
          session,
          p as
            | "rewards.manage_catalog"
            | "rewards.award_points"
            | "rewards.fulfill",
        ),
    )
  )
    redirect("/dashboard");
  const params = await searchParams,
    page = rewardPage(params.page),
    awardPage = rewardPage(params.awards),
    catalog = rewardPage(params.catalog),
    status = [
      "all",
      "pending_fulfillment",
      "fulfilled",
      "cancelled",
      "failed",
    ].includes(params.status ?? "")
      ? params.status!
      : "pending_fulfillment",
    q = (params.q ?? "").slice(0, 120);
  const supabase = await createClient();
  const [{ data, error }, awardsResult] = await Promise.all([
    supabase.rpc("get_rewards_admin_state", {
      p_organization_id: session.organizationId,
      p_status: status,
      p_page: page,
      p_catalog_page: catalog,
      p_query: q,
    }),
    sessionCan(session, "rewards.award_points")
      ? supabase.rpc("list_reward_awards", {
          p_organization_id: session.organizationId,
          p_page: awardPage,
          p_query: q,
        })
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (error || !data)
    return (
      <div className="card">
        <h1>Rewards administration unavailable</h1>
        <p role="alert">{error?.message ?? "Please reload."}</p>
        <Link href="/admin/rewards" className="btn-secondary">
          Reload
        </Link>
      </div>
    );
  const awards = awardsResult.data as {
    total: number;
    items: {
      id: string;
      employee_name: string;
      amount: number;
      reason: string;
      created_at: string;
      reversal_reason: string | null;
      reversed_at: string | null;
    }[];
  } | null;
  const state = data as RewardsAdminState,
    org = session.organizationId,
    timezone = session.organization?.timezone;
  function href(key: string, n: number) {
    const p = new URLSearchParams({
      status,
      q,
      page: String(page),
      catalog: String(catalog),
      awards: String(awardPage),
    });
    p.set(key, String(n));
    return "/admin/rewards?" + p.toString();
  }
  return (
    <div className="space-y-6 recognition-workspace">
      <div className="page-intro">
        <span className="eyebrow">Rewards administration</span>
        <h1>Manage rewards and fulfillment.</h1>
        <p>
          Curate useful rewards, explain award decisions, and complete employee
          requests consistently.
        </p>
        {[
          "recognition.manage",
          "recognition.moderate",
          "rewards.manage_catalog",
        ].some((p) =>
          sessionCan(
            session,
            p as
              | "recognition.manage"
              | "recognition.moderate"
              | "rewards.manage_catalog",
          ),
        ) && (
          <Link href="/admin/recognition" className="btn-secondary">
            Recognition policy and HR review
          </Link>
        )}
      </div>
      {!state.enabled && (
        <p className="alert-error">
          The marketplace is paused. New awards and catalog changes are
          disabled; resolve existing requests and refunds below.
        </p>
      )}
      {(state.can_fulfill || state.can_award) && (
        <section className="card space-y-2">
          <h2>Program operations</h2>
          {state.can_fulfill && (
            <p>
              {state.pending_count} pending requests
              {state.oldest_pending
                ? ` · Oldest requested ${formatDate(state.oldest_pending, timezone)}`
                : ""}
            </p>
          )}
          <p>
            {state.negative_balances} employees have a negative points balance.
            Review affected requests and Recognition moderation before granting
            corrective points.
          </p>
          <p className="text-sm">
            Reward points do not change salary or statutory leave. HR and
            payroll must review the tax treatment of benefits externally.
          </p>
        </section>
      )}
      {state.can_award && (
        <section className="card space-y-3">
          <h2>Award points</h2>
          <p>
            Use clear, consistent eligibility and employee-visible reasons.
            Self-awards are blocked.
          </p>
          {state.enabled && <AwardPointsForm organizationId={org} />}
        </section>
      )}
      {state.can_award && (
        <section className="card space-y-3">
          <h2>Award history and corrections</h2>
          <p>
            Correct an incorrect award with an exact reversal. Issue any
            replacement as a new documented award.
          </p>
          {awardsResult.error && (
            <p role="alert" className="alert-error">
              Award history could not be loaded. Reload before correcting an
              award.
            </p>
          )}
          {awards?.items.map((a) => (
            <article key={a.id} className="border rounded-xl p-4 space-y-2">
              <strong>
                {a.employee_name} · +{a.amount.toLocaleString()} points
              </strong>
              <p className="whitespace-pre-wrap">{a.reason}</p>
              <p className="text-sm">{formatDate(a.created_at, timezone)}</p>
              {a.reversed_at ? (
                <p className="whitespace-pre-wrap">
                  Reversed {formatDate(a.reversed_at, timezone)}:{" "}
                  {a.reversal_reason}
                </p>
              ) : (
                <ReverseAwardButton awardId={a.id} amount={a.amount} />
              )}
            </article>
          ))}
          {awards?.items.length === 0 && <p>No matching awards.</p>}
          {awards && (
            <RewardsPagination
              page={awardPage}
              total={awards.total}
              size={20}
              href={(n) => href("awards", n)}
            />
          )}
        </section>
      )}
      <form className="card flex flex-wrap items-end gap-3">
        <label className="label">
          Search rewards, employees or request reference
          <input name="q" maxLength={120} className="input" defaultValue={q} />
        </label>
        {state.can_fulfill && (
          <label className="label">
            Request status
            <select name="status" className="input" defaultValue={status}>
              <option value="pending_fulfillment">Awaiting fulfillment</option>
              <option value="all">All outcomes</option>
              <option value="fulfilled">Fulfilled</option>
              <option value="cancelled">Cancelled</option>
              <option value="failed">Failed</option>
            </select>
          </label>
        )}
        <button className="btn-secondary">Apply filters</button>
        <Link className="btn-secondary" href="/admin/rewards">
          Reset
        </Link>
      </form>
      {state.can_fulfill && (
        <section className="card space-y-4">
          <h2>Reward requests</h2>
          <p>
            Oldest pending requests appear first. Outcome explanations are
            visible to employees.
          </p>
          {!state.requests.length && <p>No matching requests.</p>}
          {state.requests.map((r) => (
            <RewardReceipt key={r.id} receipt={r} timezone={timezone} admin />
          ))}
          <RewardsPagination
            page={page}
            total={state.requests_total}
            size={20}
            href={(n) => href("page", n)}
          />
        </section>
      )}
      {state.can_catalog && (
        <>
          <section className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2>Vendors</h2>
              {state.enabled && (
                <NewRewardVendorForm
                  organizationId={org}
                  providers={state.providers}
                />
              )}
            </div>
            <p>
              Manual fulfillment is available without a third-party service.
              Archive unavailable vendors to stop new requests.
            </p>
            {!state.vendors.length && (
              <p>Add a vendor before creating a reward.</p>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              {state.vendors.map((v) => (
                <article key={v.id} className="border rounded-xl p-4 space-y-2">
                  <h3 className="font-semibold">
                    {v.name} · {v.is_active ? "Active" : "Archived"}
                  </h3>
                  <p>{v.description}</p>
                  <p className="text-sm">
                    {[v.contact_name, v.contact_email, v.contact_phone]
                      .filter(Boolean)
                      .join(" · ") || "No vendor contact recorded"}
                  </p>
                  {state.enabled && (
                    <NewRewardVendorForm
                      organizationId={org}
                      providers={state.providers}
                      initial={v}
                    />
                  )}
                </article>
              ))}
            </div>
          </section>
          <section className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2>Catalog and available stock</h2>
              {state.enabled && (
                <NewRewardProductForm
                  organizationId={org}
                  vendors={state.vendors}
                />
              )}
            </div>
            <p>
              Publish collection instructions and expiry terms. Stock excludes
              pending reservations. Changes preserve existing receipts.
            </p>
            {!state.products.length && <p>No matching rewards.</p>}
            <div className="grid gap-3 md:grid-cols-2">
              {state.products.map((p) => (
                <article key={p.id} className="border rounded-xl p-4 space-y-2">
                  <h3 className="font-semibold">
                    {p.name} · {p.is_active ? "Active" : "Archived"}
                  </h3>
                  <p>
                    {p.vendor_name} · {p.points_cost.toLocaleString()} points ·{" "}
                    {p.inventory_quantity === null
                      ? "Unlimited stock"
                      : `${p.inventory_quantity} available`}
                  </p>
                  <p>{p.description}</p>
                  <p className="whitespace-pre-wrap">
                    {p.terms || "Collection / expiry terms not recorded"}
                  </p>
                  {state.enabled && (
                    <NewRewardProductForm
                      organizationId={org}
                      vendors={state.vendors}
                      initial={p}
                    />
                  )}
                </article>
              ))}
            </div>
            <RewardsPagination
              page={catalog}
              total={state.products_total}
              size={25}
              href={(n) => href("catalog", n)}
            />
          </section>
        </>
      )}
    </div>
  );
}
