import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { todayIn, formatDate } from "@/lib/timezone";
import {
  recognitionPage,
  type RecognitionState,
  type RecognitionFeed,
} from "@/lib/recognition";
import { RecognitionSettingsForm } from "@/components/rewards/RecognitionSettingsForm";
import { NewRecognitionValueForm } from "@/components/rewards/NewRecognitionValueForm";
import { RecognitionActions } from "@/components/rewards/RecognitionActions";
type Reports = {
  total: number;
  items: {
    id: string;
    recognition_id: string;
    reporter_name: string;
    points_given: number;
    reason: string;
    status: string;
    resolution: string | null;
    created_at: string;
  }[];
};
type Health = {
  active_employees: number;
  recognitions: number;
  givers: number;
  recipients: number;
  points: number;
  private_count: number;
  removed: number;
  points_reversed: number;
  open_reports: number;
  values: { name: string; recognitions: number }[];
};
export const dynamic = "force-dynamic";
export default async function AdminRecognition({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    page?: string;
    reports?: string;
    status?: string;
  }>;
}) {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  if (!s.organizationId) redirect("/dashboard");
  const canManage =
      sessionCan(s, "recognition.manage") ||
      sessionCan(s, "rewards.manage_catalog"),
    canModerate = sessionCan(s, "recognition.moderate");
  if (!canManage && !canModerate) redirect("/dashboard");
  const p = await searchParams,
    org = s.organizationId,
    db = await createClient(),
    today = todayIn(s.organization?.timezone),
    from = /^\d{4}-\d{2}-\d{2}$/.test(p.from ?? "")
      ? p.from!
      : today.slice(0, 8) + "01",
    to = /^\d{4}-\d{2}-\d{2}$/.test(p.to ?? "") ? p.to! : today,
    page = recognitionPage(p.page),
    reportPage = recognitionPage(p.reports),
    status = ["open", "resolved", "all"].includes(p.status ?? "")
      ? p.status!
      : "open";
  const [stateResult, valuesResult, healthResult, feedResult, reportsResult] =
    await Promise.all([
      db.rpc("get_recognition_state", { p_organization_id: org }),
      canManage
        ? db
            .from("recognition_values")
            .select("id,name,description,is_active")
            .eq("organization_id", org)
            .order("name")
        : Promise.resolve({ data: [], error: null }),
      canModerate
        ? db.rpc("recognition_health", {
            p_organization_id: org,
            p_from: from,
            p_to: to,
          })
        : Promise.resolve({ data: null, error: null }),
      canModerate
        ? db.rpc("list_recognition_feed", {
            p_organization_id: org,
            p_scope: "moderation",
            p_page: page,
            p_from: from,
            p_to: to,
          })
        : Promise.resolve({ data: null, error: null }),
      canModerate
        ? db.rpc("list_recognition_reports", {
            p_organization_id: org,
            p_status: status,
            p_page: reportPage,
            p_self: false,
          })
        : Promise.resolve({ data: null, error: null }),
    ]);
  const state = stateResult.data as RecognitionState | null,
    health = healthResult.data as Health | null,
    feed = feedResult.data as RecognitionFeed | null,
    reports = reportsResult.data as Reports | null,
    error =
      stateResult.error ||
      valuesResult.error ||
      healthResult.error ||
      feedResult.error ||
      reportsResult.error;
  const href = (n: number, rp = reportPage) =>
    `/admin/recognition?${new URLSearchParams({ from, to, page: String(n), reports: String(rp), status })}`;
  return (
    <div className="recognition-workspace space-y-6">
      <div className="page-intro">
        <span className="eyebrow">HR recognition administration</span>
        <h1>Run a fair, accountable recognition program.</h1>
        <p>
          Manage values and limits, investigate concerns and monitor program
          participation. Counts help identify gaps; they are not performance
          ratings or evidence of misconduct.
        </p>
        <Link href="/recognition">Employee recognition</Link> ·{" "}
        <Link href="/admin/rewards">Rewards and redemption review</Link>
      </div>
      {error && (
        <p className="alert-error" role="alert">
          Some administration details could not be loaded. {error.message}
        </p>
      )}
      {canManage && state && (
        <section className="card space-y-4">
          <h2>Program policy</h2>
          {!state.rewards_enabled && (
            <p>
              Rewards redemption is disabled. Kudos-only recognition and this
              administration screen remain available.
            </p>
          )}
          <RecognitionSettingsForm
            organizationId={org}
            initial={state.settings}
          />
        </section>
      )}
      {canManage && (
        <section className="card">
          <h2>Organization values</h2>
          <NewRecognitionValueForm organizationId={org} />
          {(valuesResult.data ?? []).map((v) => (
            <div className="recognition-item" key={v.id}>
              <h3>
                {v.name}
                {!v.is_active ? " (archived)" : ""}
              </h3>
              <p>{v.description}</p>
              <NewRecognitionValueForm organizationId={org} initial={v} />
            </div>
          ))}
        </section>
      )}
      {canModerate && (
        <>
          <section className="card space-y-4">
            <h2>Program health</h2>
            <form className="flex flex-wrap gap-3 items-end">
              <label>
                From
                <input
                  className="input"
                  name="from"
                  type="date"
                  required
                  defaultValue={from}
                />
              </label>
              <label>
                Through
                <input
                  className="input"
                  name="to"
                  type="date"
                  required
                  defaultValue={to}
                />
              </label>
              <button className="btn-secondary">Review period</button>
            </form>
            {health && (
              <>
                <dl className="grid gap-4 md:grid-cols-4">
                  {[
                    ["Active recognition", health.recognitions],
                    ["Distinct givers", health.givers],
                    ["Distinct recipients", health.recipients],
                    ["Currently eligible employees", health.active_employees],
                    ["Points on retained recognition", health.points],
                    ["Private recognition", health.private_count],
                    ["Removed recognition", health.removed],
                    [
                      "Points reversed on removed recognition",
                      health.points_reversed,
                    ],
                    ["Open reports (all dates)", health.open_reports],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt>{label}</dt>
                      <dd className="text-xl font-semibold">
                        {Number(value).toLocaleString()}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p>
                  Historical counts follow posting dates in the organization’s
                  timezone; the employee denominator is current. Review job,
                  team and opportunity differences before drawing conclusions.
                  No employee popularity ranking is generated.
                </p>
                <ul>
                  {health.values.map((v) => (
                    <li key={v.name}>
                      {v.name}: {v.recognitions}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="card space-y-4">
            <h2>Reports for HR review</h2>
            <form className="flex items-end gap-3">
              <input type="hidden" name="from" value={from} />
              <input type="hidden" name="to" value={to} />
              <label>
                Status
                <select className="input" name="status" defaultValue={status}>
                  <option value="open">Open</option>
                  <option value="resolved">Resolved</option>
                  <option value="all">All</option>
                </select>
              </label>
              <button className="btn-secondary">Filter reports</button>
            </form>
            <p>
              Report reasons and reporter identities are restricted to the
              reporter and authorized moderators.
            </p>
            {reports?.items.map((r) => (
              <article className="recognition-item" key={r.id}>
                <h3>
                  {r.reporter_name} · {r.status}
                </h3>
                <p className="whitespace-pre-wrap">{r.reason}</p>
                <p>{formatDate(r.created_at, state?.timezone)}</p>
                <Link href={`/recognition?item=${r.recognition_id}`}>
                  View related recognition
                </Link>
                {r.resolution && <p>HR decision: {r.resolution}</p>}
                {r.status === "open" && (
                  <RecognitionActions
                    id={r.recognition_id}
                    canMakePrivate={false}
                    moderator
                    points={r.points_given}
                  />
                )}
              </article>
            ))}
            {!reportsResult.error && !reports?.items.length && (
              <p>No matching reports.</p>
            )}
            <nav className="flex gap-4">
              {reportPage > 1 && (
                <Link href={href(page, reportPage - 1)}>Previous reports</Link>
              )}
              {reports && reportPage * 20 < reports.total && (
                <Link href={href(page, reportPage + 1)}>More reports</Link>
              )}
            </nav>
          </section>
          <section className="card">
            <h2>Recognition records for this period</h2>
            <p>
              Removed records remain available to authorized moderators.
              Removing a record is permanent and reverses its exact points; it
              does not restore the giver’s consumed allowance. Already spent
              points can produce a negative Rewards balance. Review affected
              redemptions separately.
            </p>
            {feed?.items.map((i) => (
              <article className="recognition-item" key={i.id}>
                <h3>
                  {i.giver_name} → {i.recipient_name} · {i.status}
                </h3>
                <p className="whitespace-pre-wrap">{i.message}</p>
                <small>
                  {i.value_name ?? "General appreciation"} · {i.points_given}{" "}
                  points · {i.visibility} ·{" "}
                  {formatDate(i.created_at, state?.timezone)}
                </small>
                {i.status === "active" && (
                  <RecognitionActions
                    id={i.id}
                    canMakePrivate={false}
                    moderator
                    points={i.points_given}
                  />
                )}
              </article>
            ))}
            {!feedResult.error && !feed?.items.length && (
              <p>No recognition in this period.</p>
            )}
            <nav className="flex gap-4">
              {page > 1 && <Link href={href(page - 1)}>Previous records</Link>}
              {feed && page * 20 < feed.total && (
                <Link href={href(page + 1)}>More records</Link>
              )}
            </nav>
          </section>
        </>
      )}
    </div>
  );
}
