import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DocumentDownloadButton } from "@/components/DocumentDownloadButton";
import { ReassignOnboardingTask } from "@/components/OnboardingResponsibilitiesForm";
import { CancelOnboardingRunButton, OnboardingTaskActions } from "@/components/OnboardingTaskActions";
import { ONBOARDING_PHASE_LABELS } from "@/lib/employeeSetup";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { statusBadgeClass } from "@/lib/ui";
import { formatDateTime, todayIn } from "@/lib/timezone";

const ASSIGNEE_LABELS: Record<string, string> = { employee: "Employee", supervisor: "Supervisor", manager: "Manager", hr: "HR", it: "IT" };

function formatWhen(value: string | null | undefined, timezone: string | undefined) {
  return value ? formatDateTime(value, timezone, { dateStyle: "medium", timeStyle: "short" }) : null;
}

// The permanent onboarding record (blueprint §13): runs are never deleted,
// so this is retrievable years later with the exact template version,
// every step, who completed it and when, notes, and attached evidence.
// RLS decides what a viewer sees: HR org-wide, managers/supervisors their
// own scope (onboarding.read_team / manage_team).
export default async function OnboardingRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");
  const canManage = sessionCan(session, "onboarding.manage_team") || sessionCan(session, "employee.manage");
  if (!canManage && !sessionCan(session, "onboarding.read_team")) redirect("/dashboard");

  const supabase = await createClient();
  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("*, onboarding_template_versions(version_number, onboarding_templates(id, name))")
    .eq("id", id)
    .maybeSingle();
  if (!run) notFound();

  const [{ data: employee }, { data: tasks }, { data: people }, { data: evidence }, { data: employeeDocs }] = await Promise.all([
    supabase.from("employees").select("id, first_name, last_name, preferred_name, employee_number").eq("id", run.employee_id).maybeSingle(),
    supabase.from("onboarding_tasks").select("*").eq("run_id", id).order("sequence"),
    supabase.from("employees").select("id, user_id, first_name, last_name, status").eq("organization_id", session.organizationId).order("last_name"),
    supabase.from("onboarding_task_documents").select("task_id, document_id, attached_at, documents(title, current_version_id)").eq("organization_id", session.organizationId),
    canManage
      ? supabase.from("documents").select("id, title").eq("employee_id", run.employee_id).eq("is_active", true).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ]);
  const nameByUser = new Map((people ?? []).filter((p) => p.user_id).map((p) => [p.user_id, `${p.first_name} ${p.last_name}`]));
  const nameByEmployee = new Map((people ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]));
  const assignable = (people ?? []).filter((p) => p.status !== "terminated").map((p) => ({ id: p.id, label: `${p.first_name} ${p.last_name}` }));
  // Supervisors/managers reach this page from the Team hub; only HR uses /admin/onboarding.
  const backHref = sessionCan(session, "employee.manage") || sessionCan(session, "onboarding.manage_templates") ? "/admin/onboarding" : `/team/${run.employee_id}`;
  const taskIds = new Set((tasks ?? []).map((t) => t.id));
  const evidenceRows = (evidence ?? []).filter((e: any) => taskIds.has(e.task_id));
  const versionIds = evidenceRows.map((e: any) => e.documents?.current_version_id).filter(Boolean);
  const { data: versions } = versionIds.length
    ? await supabase.from("document_versions").select("id, storage_bucket, storage_path").in("id", versionIds)
    : { data: [] as any[] };
  const versionById = new Map((versions ?? []).map((v: any) => [v.id, v]));

  const total = (tasks ?? []).length;
  const closed = (tasks ?? []).filter((t) => t.status === "completed" || t.status === "skipped").length;
  const percent = total ? Math.round((closed / total) * 100) : 0;
  const timezone = session.organization?.timezone;
  // The organization's calendar day, so "overdue" doesn't flip at 7pm Jamaica time.
  const today = todayIn(timezone);
  const template = (run as any).onboarding_template_versions;
  const employeeName = employee ? `${employee.preferred_name || employee.first_name} ${employee.last_name}` : "Employee";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={backHref} className="text-xs text-royal-700 hover:text-royal-800">← {backHref === "/admin/onboarding" ? "Onboarding" : "Team member"}</Link>
          <h1 className="mt-1 font-display text-xl font-bold text-stone-900">{employeeName}</h1>
          <p className="text-sm text-stone-500">
            <span className="font-mono">{employee?.employee_number}</span> · {template?.onboarding_templates?.name ?? "Onboarding"} · version {template?.version_number ?? "?"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`badge ${statusBadgeClass(run.status)}`}>{run.status.replace("_", " ")}</span>
          {employee && sessionCan(session, "employee.manage") && <Link className="btn-secondary px-3 py-1.5 text-xs" href={`/admin/employees/${employee.id}?tab=onboarding`}>HR record</Link>}
          {canManage && run.status === "in_progress" && <CancelOnboardingRunButton runId={run.id} />}
        </div>
      </div>

      <section className="card">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs uppercase text-stone-400">Started</dt><dd>{formatWhen(run.started_at, timezone)}</dd></div>
          <div><dt className="text-xs uppercase text-stone-400">Started by</dt><dd>{nameByUser.get(run.created_by) ?? "System"}</dd></div>
          <div><dt className="text-xs uppercase text-stone-400">{run.status === "cancelled" ? "Cancelled" : "Completed"}</dt><dd>{formatWhen(run.status === "cancelled" ? run.cancelled_at : run.completed_at, timezone) ?? "—"}</dd></div>
          <div><dt className="text-xs uppercase text-stone-400">Progress</dt><dd>{closed}/{total} steps ({percent}%)</dd></div>
        </dl>
        <div className="setup-progress mt-4"><span style={{ width: `${percent}%` }} /></div>
        {run.status === "cancelled" && run.cancel_reason && (
          <p className="mt-3 text-sm text-stone-600">Cancelled by {nameByUser.get(run.cancelled_by) ?? "an administrator"}: {run.cancel_reason}</p>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Steps</h2>
        <ol className="run-task-list">
          {(tasks ?? []).map((task, index, all) => {
            const showPhase = index === 0 || all[index - 1].phase !== task.phase;
            const done = task.status === "completed" || task.status === "skipped";
            const overdue = !done && run.status === "in_progress" && task.due_date && task.due_date < today;
            const taskEvidence = evidenceRows.filter((e: any) => e.task_id === task.id);
            const data = (task.completion_data ?? {}) as Record<string, unknown>;
            return (
              <li key={task.id}>
                {showPhase && <h3 className="mb-1 mt-4 text-xs font-semibold uppercase text-stone-400">{task.phase ? ONBOARDING_PHASE_LABELS[task.phase] ?? task.phase : "Steps"}</h3>}
                <div className={`run-task ${done ? "done" : ""}`}>
                  <span className="task-marker" aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "skipped" ? "–" : task.sequence}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-stone-900">
                      {task.title}
                      {!task.required && <span className="badge badge-neutral ml-2">Optional</span>}
                      {overdue && <span className="badge badge-ruby ml-2">Overdue</span>}
                    </p>
                    <p className="text-xs text-stone-500">
                      {ASSIGNEE_LABELS[task.assignee_type] ?? task.assignee_type}
                      {task.assignee_employee_id
                        ? ` · ${nameByEmployee.get(task.assignee_employee_id) ?? "assigned"}${task.assigned_to_user_id ? "" : " (no sign-in account yet)"}`
                        : task.assigned_to_user_id
                          ? ` · ${nameByUser.get(task.assigned_to_user_id) ?? "assigned"}`
                          : task.assignee_type === "hr" || task.assignee_type === "it"
                            ? " · anyone who manages onboarding"
                            : task.assignee_type === "employee" ? " · assigned when they accept their invitation" : " · no one in this role yet"}
                      {task.assignment_locked ? " · reassigned" : ""}
                      {task.due_date ? ` · due ${task.due_date}` : ""}
                    </p>
                    {task.status === "completed" && (
                      <p className="text-xs text-emerald-700">Completed {formatWhen(task.completed_at, timezone)} by {nameByUser.get(task.completed_by) ?? "—"}{task.signed_at ? ` · signed ${formatWhen(task.signed_at, timezone)}` : ""}</p>
                    )}
                    {task.status === "skipped" && (
                      <p className="text-xs text-stone-500">Skipped {formatWhen(task.completed_at, timezone)} by {nameByUser.get(task.completed_by) ?? "—"}{typeof data.skip_reason === "string" ? ` — ${data.skip_reason}` : ""}</p>
                    )}
                    {typeof data.notes === "string" && data.notes && <p className="mt-1 text-xs text-stone-700">“{data.notes}”</p>}
                    {taskEvidence.map((e: any) => {
                      const version = e.documents?.current_version_id ? versionById.get(e.documents.current_version_id) : null;
                      return (
                        <div key={e.document_id} className="mt-1 flex items-center gap-2 text-xs text-stone-600">
                          <span>📎 {e.documents?.title ?? "Document"}</span>
                          {version && <DocumentDownloadButton bucket={version.storage_bucket} path={version.storage_path} />}
                        </div>
                      );
                    })}
                  </div>
                  {!done && run.status === "in_progress" && canManage && (
                    <div className="flex flex-col items-end gap-1.5">
                      <OnboardingTaskActions taskId={task.id} canSkip={sessionCan(session, "onboarding.manage_team")} documents={employeeDocs ?? []} />
                      <ReassignOnboardingTask taskId={task.id} people={assignable} currentEmployeeId={task.assignee_employee_id} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
