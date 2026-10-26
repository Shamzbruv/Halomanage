import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { OnboardingResponsibilitiesForm } from "@/components/OnboardingResponsibilitiesForm";
import { OnboardingTemplateForm } from "@/components/OnboardingTemplateForm";
import { StartOnboardingForm } from "@/components/StartOnboardingForm";
import { RewardsPagination as Pagination } from "@/components/rewards/RewardsPagination";
import { onboardingPage } from "@/lib/onboarding";
import { formatDate } from "@/lib/timezone";
type RunRow = {
  id: string;
  employee_name: string;
  template_name: string;
  template_version_number: number;
  status: string;
  started_at: string;
  completed_tasks: number;
  total_tasks: number;
  waived_tasks: number;
  blocked_tasks: number;
  unassigned_tasks: number;
  overdue_tasks: number;
  active_plan_count: number;
};
export default async function OnboardingAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string; q?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");
  const canTemplates = sessionCan(session, "onboarding.manage_templates"),
    canStart =
      sessionCan(session, "employee.manage") ||
      sessionCan(session, "onboarding.manage_team"),
    canResponsibilities =
      canTemplates || sessionCan(session, "employee.manage");
  if (
    !canTemplates &&
    !canStart &&
    !sessionCan(session, "onboarding.read_team")
  )
    redirect("/dashboard");
  const p = await searchParams,
    view = ["all", "in_progress", "completed", "cancelled"].includes(
      p.view ?? "",
    )
      ? p.view!
      : "in_progress",
    page = onboardingPage(p.page),
    q = (p.q ?? "").slice(0, 120),
    db = await createClient(),
    org = session.organizationId;
  const [state, templatesResult, peopleResult, responsibilityResult] =
    await Promise.all([
      db.rpc("list_onboarding_admin", {
        p_organization_id: org,
        p_view: view,
        p_page: page,
        p_query: q,
      }),
      db
        .from("onboarding_templates")
        .select("id,name,is_default,is_active")
        .eq("organization_id", org)
        .order("name"),
      canStart || canResponsibilities
        ? db.rpc("list_onboarding_people", { p_organization_id: org })
        : Promise.resolve({ data: [], error: null }),
      canResponsibilities
        ? db
            .from("onboarding_responsibilities")
            .select("assignee_type,employee_id")
            .eq("organization_id", org)
        : Promise.resolve({ data: [], error: null }),
    ]);
  const data = state.data as { total: number; runs: RunRow[] } | null,
    templates = templatesResult.data ?? [],
    people = (peopleResult.data ?? []) as {
      id: string;
      label: string;
      status: string;
    }[];
  function href(n: number) {
    return (
      "/admin/onboarding?" + new URLSearchParams({ view, q, page: String(n) })
    );
  }
  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Onboarding administration</span>
        <h1>Prepare, support and follow through.</h1>
        <p>
          Keep a consistent framework, assign real owners, and review blockers.
          Completion does not automatically confirm probation, change pay or
          grant access.
        </p>
      </div>
      {[
        state.error,
        templatesResult.error,
        peopleResult.error,
        responsibilityResult.error,
      ]
        .filter(Boolean)
        .map((e, i) => (
          <p key={i} role="alert" className="alert-error">
            {e?.message}
          </p>
        ))}
      <section className="card space-y-4">
        <h2 className="font-semibold">Onboarding records</h2>
        <form className="flex flex-wrap gap-3 items-end">
          <label className="label">
            Status
            <select name="view" className="input" defaultValue={view}>
              <option value="in_progress">Active</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All records</option>
            </select>
          </label>
          <label className="label">
            Employee or plan
            <input
              name="q"
              className="input"
              maxLength={120}
              defaultValue={q}
            />
          </label>
          <button className="btn-secondary">Apply filters</button>
        </form>
        {data?.runs.map((r) => (
          <article key={r.id} className="border rounded-xl p-4 space-y-2">
            <Link
              className="font-semibold underline"
              href={`/admin/onboarding/runs/${r.id}`}
            >
              {r.employee_name}
            </Link>
            <p>
              {r.template_name} · v{r.template_version_number} ·{" "}
              {r.status.replaceAll("_", " ")} · Started{" "}
              {formatDate(r.started_at, session.organization?.timezone)}
            </p>
            <p>
              {Number(r.completed_tasks) - Number(r.waived_tasks)} completed ·{" "}
              {r.waived_tasks} waived · {r.total_tasks} total
            </p>
            <p>
              {r.overdue_tasks} overdue · {r.blocked_tasks} blocked ·{" "}
              {r.unassigned_tasks} awaiting an owner
            </p>
            {r.status === "in_progress" && r.active_plan_count > 1 && (
              <p className="alert-error">
                This employee has {r.active_plan_count} active plans. Review the
                preserved records and decide which plan should continue.
              </p>
            )}
          </article>
        ))}
        {data && !data.runs.length && <p>No matching onboarding records.</p>}
        {data && (
          <Pagination page={page} total={data.total} size={25} href={href} />
        )}
      </section>
      {canResponsibilities && (
        <section className="card space-y-3">
          <h2 className="font-semibold">HR and IT owners</h2>
          <p>
            Default changes update open tasks that follow that default. Named
            template owners and manual reassignments stay separate.
          </p>
          <OnboardingResponsibilitiesForm
            organizationId={org}
            people={people.filter((p) => p.status !== "prehire")}
            current={Object.fromEntries(
              (responsibilityResult.data ?? []).map(
                (r: { assignee_type: string; employee_id: string }) => [
                  r.assignee_type,
                  r.employee_id,
                ],
              ),
            )}
          />
        </section>
      )}
      {canStart && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Start a plan</h2>
          <p>
            For new hires, select the plan in{" "}
            <Link href="/admin/employees" className="underline">
              Prepare &amp; invite
            </Link>
            . Preboarding can begin before an account exists. Repeated starts
            return the existing active plan; review it before changing
            templates.
          </p>
          <StartOnboardingForm
            employees={people}
            templates={templates
              .filter((t) => t.is_active)
              .map((t) => ({ id: t.id, label: t.name }))}
          />
        </section>
      )}
      {canTemplates && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Templates</h2>
          {templates.map((t) => (
            <div className="flex justify-between gap-3" key={t.id}>
              <Link
                className="underline"
                href={`/admin/onboarding/templates/${t.id}`}
              >
                {t.name}
              </Link>
              <span>
                {t.is_default ? "Default · " : ""}
                {t.is_active ? "Active" : "Archived"}
              </span>
            </div>
          ))}
          <OnboardingTemplateForm organizationId={org} />
        </section>
      )}
    </div>
  );
}
