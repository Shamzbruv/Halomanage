import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import type { OnboardingRun } from "@/lib/onboarding";
import { OnboardingTaskCard } from "@/components/OnboardingTaskCard";
import { ReassignOnboardingTask } from "@/components/OnboardingResponsibilitiesForm";
import { CancelOnboardingRunButton } from "@/components/OnboardingTaskActions";
import { formatDateTime } from "@/lib/timezone";
export default async function OnboardingRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient(),
    { data, error } = await db.rpc("get_onboarding_run", { p_run_id: id });
  if (error || !data)
    return (
      <div className="card">
        <h1>Onboarding record unavailable</h1>
        <p role="alert">{error?.message ?? "Record not found."}</p>
        <Link className="btn-secondary" href="/admin/onboarding">
          Back to onboarding
        </Link>
      </div>
    );
  const run = data as OnboardingRun,
    { data: people } = run.can_manage
      ? await db.rpc("list_onboarding_people", {
          p_organization_id: run.organization_id,
        })
      : { data: [] };
  const tasks = run.tasks,
    completed = tasks.filter((t) => t.status === "completed").length,
    waived = tasks.filter((t) => t.status === "skipped").length,
    required = tasks.filter((t) => t.required),
    requiredDone = required.filter((t) =>
      ["completed", "skipped"].includes(t.status),
    ).length,
    timezone = session.organization?.timezone;
  return (
    <div className="space-y-5">
      <Link href="/admin/onboarding" className="btn-secondary">
        Back to onboarding
      </Link>
      <div className="page-intro">
        <span className="eyebrow">Onboarding record</span>
        <h1>{run.employee_name}</h1>
        <p>
          {run.template_name} · version {run.template_version_number} ·{" "}
          {run.status.replaceAll("_", " ")}
        </p>
      </div>
      <section className="card space-y-2">
        <p>Started {formatDateTime(run.started_at, timezone)}</p>
        <p>
          {completed} completed · {waived} waived · {tasks.length} total steps
        </p>
        <p>
          {requiredDone}/{required.length} required steps resolved. Optional
          steps may still be completed after required work closes the plan.
        </p>
        {run.completed_at && (
          <p>
            Required work resolved {formatDateTime(run.completed_at, timezone)}
          </p>
        )}
        {run.cancelled_at && (
          <p>
            Cancelled {formatDateTime(run.cancelled_at, timezone)}:{" "}
            {run.cancel_reason}
          </p>
        )}
        {run.can_manage && run.status === "in_progress" && (
          <CancelOnboardingRunButton runId={run.id} />
        )}
      </section>
      {tasks.map((task) => (
        <section key={task.id} className="space-y-2">
          <OnboardingTaskCard task={task} timezone={timezone} detail />
          {run.can_manage &&
            run.status !== "cancelled" &&
            !["completed", "skipped"].includes(task.status) && (
              <div className="flex flex-wrap gap-3">
                <Link
                  className="btn-secondary"
                  href={`/onboarding/tasks/${task.id}`}
                >
                  Work on step / change due date
                </Link>
                <ReassignOnboardingTask
                  taskId={task.id}
                  people={(people ?? []).map(
                    (p: { id: string; label: string }) => ({
                      id: p.id,
                      label: p.label,
                    }),
                  )}
                  currentEmployeeId={task.assignee_employee_id}
                />
              </div>
            )}
        </section>
      ))}
    </div>
  );
}
