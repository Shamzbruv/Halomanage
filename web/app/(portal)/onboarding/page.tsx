import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { OnboardingTaskCard } from "@/components/OnboardingTaskCard";
import { RewardsPagination as Pagination } from "@/components/rewards/RewardsPagination";
import { onboardingPage, type OnboardingTask } from "@/lib/onboarding";
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  const p = await searchParams,
    view = ["open", "history", "all"].includes(p.view ?? "") ? p.view! : "open",
    page = onboardingPage(p.page);
  const { data, error } = await (
    await createClient()
  ).rpc("list_onboarding_work", {
    p_organization_id: session.organizationId,
    p_view: view,
    p_page: page,
  });
  const work = data as { total: number; tasks: OnboardingTask[] } | null;
  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Onboarding</span>
        <h1>Your plan and assigned work.</h1>
        <p>
          Follow your new-role plan, help coworkers get settled, and raise
          anything that needs support. HR retains completed and cancelled
          records.
        </p>
      </div>
      <nav className="flex flex-wrap gap-3" aria-label="Onboarding view">
        {[
          ["open", "Open work"],
          ["history", "History"],
          ["all", "All steps"],
        ].map(([key, label]) => (
          <Link
            className="btn-secondary"
            aria-current={view === key ? "page" : undefined}
            key={key}
            href={`/onboarding?view=${key}`}
          >
            {label}
          </Link>
        ))}
        {(sessionCan(session, "employee.manage") ||
          sessionCan(session, "onboarding.manage_templates") ||
          sessionCan(session, "onboarding.manage_team") ||
          sessionCan(session, "onboarding.read_team")) && (
          <Link className="btn-secondary" href="/admin/onboarding">
            Manage onboarding
          </Link>
        )}
      </nav>
      {error && (
        <div className="card">
          <p role="alert">{error.message}</p>
          <Link className="btn-secondary" href="/settings">
            Account security
          </Link>
        </div>
      )}
      {work && !work.tasks.length && (
        <div className="card">
          <h2>No steps in this view</h2>
          <p>
            Your assigned work appears when HR starts a plan. Check History for
            closed work or contact HR if something is missing.
          </p>
        </div>
      )}
      {work?.tasks.map((t) => (
        <OnboardingTaskCard
          key={t.id}
          task={t}
          timezone={session.organization?.timezone}
        />
      ))}
      {work && (
        <Pagination
          page={page}
          total={work.total}
          size={20}
          href={(n) => `/onboarding?view=${view}&page=${n}`}
        />
      )}
    </div>
  );
}
