import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import {
  GiveRecognitionForm,
  type CoworkerOption,
} from "@/components/rewards/GiveRecognitionForm";
import {
  RecognitionActions,
  RecognitionPreference,
} from "@/components/rewards/RecognitionActions";
import { formatDate } from "@/lib/timezone";
import {
  recognitionPage,
  type RecognitionState,
  type RecognitionFeed,
  type RecognitionItem,
} from "@/lib/recognition";
export const dynamic = "force-dynamic";
export default async function RecognitionPage({
  searchParams,
}: {
  searchParams: Promise<{
    scope?: string;
    page?: string;
    value?: string;
    from?: string;
    to?: string;
    item?: string;
  }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee || !session.organizationId) redirect("/dashboard");
  if (
    !["recognition.read", "recognition.give", "recognition.moderate"].some(
      (p) =>
        sessionCan(
          session,
          p as "recognition.read" | "recognition.give" | "recognition.moderate",
        ),
    )
  )
    redirect("/dashboard");
  const org = session.organizationId,
    db = await createClient(),
    p = await searchParams,
    page = recognitionPage(p.page),
    scope = ["all", "given", "received", "public"].includes(p.scope ?? "")
      ? p.scope!
      : "all",
    value = /^[0-9a-f-]{36}$/i.test(p.value ?? "") ? p.value : null,
    from = /^\d{4}-\d{2}-\d{2}$/.test(p.from ?? "") ? p.from : null,
    to = /^\d{4}-\d{2}-\d{2}$/.test(p.to ?? "") ? p.to : null;
  const [
    stateResult,
    feedResult,
    valueResult,
    reportResult,
    coworkerResult,
    itemResult,
  ] = await Promise.all([
    db.rpc("get_recognition_state", { p_organization_id: org }),
    db.rpc("list_recognition_feed", {
      p_organization_id: org,
      p_scope: scope,
      p_page: page,
      p_value_id: value,
      p_from: from,
      p_to: to,
    }),
    db
      .from("recognition_values")
      .select("id,name,description,is_active")
      .eq("organization_id", org)
      .order("name"),
    db
      .from("recognition_reports")
      .select("id,reason,status,resolution,created_at,recognition_id")
      .eq("reporter_employee_id", session.employee.id)
      .order("created_at", { ascending: false })
      .limit(20),
    sessionCan(session, "recognition.give")
      ? db.rpc("search_recognition_coworkers", {
          p_organization_id: org,
          p_search: "",
        })
      : Promise.resolve({ data: [], error: null }),
    p.item && /^[0-9a-f-]{36}$/i.test(p.item)
      ? db.rpc("get_recognition", { p_recognition_id: p.item })
      : Promise.resolve({ data: null, error: null }),
  ]);
  const focused = itemResult.data as RecognitionItem | null;
  const state = stateResult.data as RecognitionState | null,
    feed = feedResult.data as RecognitionFeed | null,
    values = valueResult.data ?? [],
    error =
      stateResult.error ||
      feedResult.error ||
      valueResult.error ||
      reportResult.error ||
      coworkerResult.error;
  const href = (n: number) =>
    `/recognition?${new URLSearchParams({ scope, page: String(n), ...(value ? { value } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) })}`;
  return (
    <div className="recognition-workspace space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Recognition</span>
        <h1>Recognize a meaningful contribution.</h1>
        <p>
          Thank a coworker for a specific action and the difference it made.
          Recognition supports appreciation; it does not replace a fair
          appraisal, salary or a formal grievance process.
        </p>
      </div>
      {error && (
        <p className="alert-error" role="alert">
          Some recognition details could not be loaded. Refresh this page or
          contact HR. {stateResult.error?.message}
        </p>
      )}
      {state && (
        <>
          <section className="card space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <small>Monthly giving allowance remaining</small>
                <h2>
                  {state.remaining_points.toLocaleString()} /{" "}
                  {state.settings.monthly_point_allowance.toLocaleString()}
                </h2>
                <p>
                  Resets {formatDate(state.resets_at, state.timezone)}. This is
                  separate from your Rewards balance.
                </p>
              </div>
              <div>
                <small>Recognition posts remaining today</small>
                <h2>{state.daily_remaining}</h2>
                <p>
                  Counts follow {state.timezone}. Removed posts still use the
                  original allowance.
                </p>
              </div>
              {state.points_balance !== null && (
                <div>
                  <small>Your Rewards points balance</small>
                  <h2>{state.points_balance.toLocaleString()}</h2>
                  <p>
                    {state.rewards_enabled ? (
                      <Link href="/rewards">
                        View points history and rewards
                      </Link>
                    ) : (
                      "Reward redemption is not enabled for this organization."
                    )}
                  </p>
                </div>
              )}
            </div>
            {state.points_balance !== null && state.points_balance < 0 && (
              <p className="alert-error">
                A points reversal exceeds your current balance. Contact HR about
                affected redemptions. This is a Rewards adjustment, not a salary
                deduction.
              </p>
            )}
            {(!state.settings.monthly_point_allowance ||
              !state.rewards_enabled) && (
              <p>
                Kudos are available without points. Points require an enabled
                Rewards program and an HR giving allowance.
              </p>
            )}
            {!stateResult.error && (
              <GiveRecognitionForm
                organizationId={org}
                initialCoworkers={
                  (coworkerResult.data ?? []) as CoworkerOption[]
                }
                values={values.filter((v) => v.is_active)}
                state={state}
              />
            )}
          </section>
          <section className="card">
            <h2>My recognition privacy</h2>
            <RecognitionPreference
              organizationId={org}
              allowPublic={state.allow_public}
            />
          </section>
          {(state.can_manage || state.can_moderate) && (
            <Link className="btn-secondary" href="/admin/recognition">
              Open HR recognition administration
            </Link>
          )}
        </>
      )}
      <section className="card space-y-4">
        <h2>Recognition history</h2>
        <p>
          Private messages are visible to the giver, recipient and authorized HR
          moderators. HR-removed recognition is excluded from the employee feed.
        </p>
        <form className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label>
            View
            <select className="input" name="scope" defaultValue={scope}>
              <option value="all">Public and my recognition</option>
              <option value="received">Received by me</option>
              <option value="given">Given by me</option>
              <option value="public">Organization feed</option>
            </select>
          </label>
          <label>
            Value
            <select className="input" name="value" defaultValue={value ?? ""}>
              <option value="">All values</option>
              {values.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name}
                  {!v.is_active ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              className="input"
              name="from"
              defaultValue={from ?? ""}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              className="input"
              name="to"
              defaultValue={to ?? ""}
            />
          </label>
          <button className="btn-secondary">Apply filters</button>
        </form>
        {p.item && !focused && (
          <p>
            The linked recognition is unavailable to this account. Its audience
            or moderation status may have changed.
          </p>
        )}
        {focused && (
          <article className="recognition-item recognition-focused">
            <h3>
              Linked recognition: {focused.giver_name} →{" "}
              {focused.recipient_name}
            </h3>
            {focused.status === "removed" ? (
              <p>
                HR removed this recognition. Associated points have been
                reversed where applicable; view Rewards or contact HR for
                details.
              </p>
            ) : (
              <>
                <p className="whitespace-pre-wrap">{focused.message}</p>
                <small>
                  {focused.value_name ?? "General appreciation"} ·{" "}
                  {formatDate(focused.created_at, state?.timezone)} ·{" "}
                  {focused.visibility} · {focused.points_given} points
                </small>
                <RecognitionActions
                  id={focused.id}
                  canMakePrivate={focused.can_make_private}
                />
              </>
            )}
          </article>
        )}
        {feed?.items
          .filter((item) => item.id !== focused?.id)
          .map((item) => (
            <article
              id={`recognition-${item.id}`}
              key={item.id}
              className="recognition-item"
            >
              <h3>
                {item.giver_name} → {item.recipient_name}
              </h3>
              <p className="whitespace-pre-wrap">{item.message}</p>
              <small>
                {item.value_name ?? "General appreciation"} ·{" "}
                {formatDate(item.created_at, state?.timezone)} ·{" "}
                {item.visibility === "private"
                  ? "Private"
                  : "Organization feed"}
                {item.points_given > 0
                  ? ` · +${item.points_given.toLocaleString()} points`
                  : ""}
              </small>
              <RecognitionActions
                id={item.id}
                canMakePrivate={item.can_make_private}
              />
            </article>
          ))}
        {!feedResult.error && !feed?.items.length && (
          <p>No recognition matches these filters yet.</p>
        )}
        <nav aria-label="Recognition history pages" className="flex gap-4">
          {page > 1 && <Link href={href(page - 1)}>Previous page</Link>}
          {feed && (
            <span>
              Page {page} · {feed.total} records
            </span>
          )}
          {feed && page * 20 < feed.total && (
            <Link href={href(page + 1)}>Next page</Link>
          )}
        </nav>
      </section>
      <section className="card">
        <h2>My reports to HR</h2>
        <Link href="/recognition/reports">View all my reports</Link>
        <p>
          The latest 20 reports you submitted. HR reviews the concern and
          records its decision.
        </p>
        {(reportResult.data ?? []).map((r) => (
          <article key={r.id} className="recognition-item">
            <strong>
              {r.status === "open" ? "Awaiting HR review" : "Reviewed by HR"}
            </strong>
            <p className="whitespace-pre-wrap">{r.reason}</p>
            {r.resolution && <p>HR response: {r.resolution}</p>}
            <small>{formatDate(r.created_at, state?.timezone)}</small>
          </article>
        ))}
        {!reportResult.error && !reportResult.data?.length && (
          <p>No reports submitted.</p>
        )}
      </section>
    </div>
  );
}
