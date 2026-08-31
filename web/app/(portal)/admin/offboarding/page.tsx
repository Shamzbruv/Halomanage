import Link from "next/link";
import { redirect } from "next/navigation";
import { CompleteOffboardingTaskButton } from "@/components/CompleteOffboardingTaskButton";
import { Icon } from "@/components/Icon";
import { OffboardingTemplateForm } from "@/components/OffboardingTemplateForm";
import { StartOffboardingForm } from "@/components/StartOffboardingForm";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

type OffboardingTemplate = {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
};

type EmployeeSummary = {
  id: string;
  first_name: string;
  last_name: string;
  employee_number: string;
  status: string;
};

type OffboardingRun = {
  id: string;
  employee_id: string;
  template_id: string;
  final_work_date: string | null;
  status: "in_progress" | "completed" | "cancelled";
  started_at: string;
  completed_at: string | null;
};

type OffboardingTask = {
  id: string;
  run_id: string;
  title: string;
  description: string | null;
  assignee_type: string;
  sequence: number;
  due_date: string | null;
  required: boolean;
  status: "pending" | "completed" | "skipped";
};

function formatDate(value: string | null) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function personName(employee: EmployeeSummary | undefined) {
  return employee ? `${employee.first_name} ${employee.last_name}` : "Unknown employee";
}

function ownerLabel(value: string) {
  if (value === "hr") return "HR / admin";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default async function OffboardingAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const organizationId = session.organizationId;
  const [templateResult, employeeResult, runResult] = await Promise.all([
    supabase
      .from("offboarding_templates")
      .select("id, name, is_default, is_active")
      .eq("organization_id", organizationId)
      .order("is_default", { ascending: false })
      .order("name"),
    supabase
      .from("employees")
      .select("id, first_name, last_name, employee_number, status")
      .eq("organization_id", organizationId)
      .order("last_name"),
    supabase
      .from("offboarding_runs")
      .select("id, employee_id, template_id, final_work_date, status, started_at, completed_at")
      .eq("organization_id", organizationId)
      .order("started_at", { ascending: false })
      .limit(100),
  ]);

  const templates = (templateResult.data ?? []) as OffboardingTemplate[];
  const employees = (employeeResult.data ?? []) as EmployeeSummary[];
  const eligibleEmployees = employees.filter((employee) => employee.status !== "terminated");
  const runs = (runResult.data ?? []) as OffboardingRun[];
  const [stepResult, taskResult] = await Promise.all([
    templates.length > 0
      ? supabase
          .from("offboarding_template_steps")
          .select("id, template_id")
          .in("template_id", templates.map((template) => template.id))
      : Promise.resolve({ data: [], error: null }),
    runs.length > 0
      ? supabase
          .from("offboarding_tasks")
          .select("id, run_id, title, description, assignee_type, sequence, due_date, required, status")
          .in("run_id", runs.map((run) => run.id))
          .order("sequence")
      : Promise.resolve({ data: [], error: null }),
  ]);

  const tasks = (taskResult.data ?? []) as OffboardingTask[];
  const stepCounts = new Map<string, number>();
  for (const step of stepResult.data ?? []) {
    stepCounts.set(step.template_id, (stepCounts.get(step.template_id) ?? 0) + 1);
  }

  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const templatesById = new Map(templates.map((template) => [template.id, template]));
  const tasksByRun = new Map<string, OffboardingTask[]>();
  for (const task of tasks) {
    tasksByRun.set(task.run_id, [...(tasksByRun.get(task.run_id) ?? []), task]);
  }

  const activeRuns = runs.filter((run) => run.status === "in_progress");
  const completedRuns = runs.filter((run) => run.status === "completed");
  const today = new Date().toISOString().slice(0, 10);
  const overdueTasks = tasks.filter((task) => task.status === "pending" && task.due_date && task.due_date < today).length;
  const dataError = templateResult.error || employeeResult.error || runResult.error || stepResult.error || taskResult.error;

  return (
    <div className="space-y-6">
      <section className="setup-hero">
        <div>
          <span className="eyebrow">Employee lifecycle</span>
          <h1>Handle every employee exit with care and control.</h1>
          <p>Plan the final day, coordinate access and equipment handoffs, and keep an auditable checklist from first notice through completion.</p>
        </div>
        <div className="setup-progress">
          <strong>{activeRuns.length}</strong>
          <span>active employee {activeRuns.length === 1 ? "exit" : "exits"}</span>
          <div><i style={{ width: activeRuns.length > 0 ? "100%" : "0%" }} /></div>
        </div>
      </section>

      {dataError && (
        <div className="alert-error" role="alert">Some offboarding information could not be loaded. Refresh the page or check your workspace connection.</div>
      )}

      <section className="dashboard-metrics" aria-label="Offboarding summary">
        <div className="metric-card"><span className="metric-icon coral"><Icon name="people" /></span><div><small>Active exits</small><strong>{activeRuns.length}</strong><em>being coordinated</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="clock" /></span><div><small>Overdue tasks</small><strong>{overdueTasks}</strong><em>need attention</em></div></div>
        <div className="metric-card"><span className="metric-icon"><Icon name="check" /></span><div><small>Completed exits</small><strong>{completedRuns.length}</strong><em>in recent history</em></div></div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,.9fr)]">
        <section className="card">
          <div className="panel-heading">
            <div><span className="panel-icon"><Icon name="onboarding" size={17} /></span><div><h3>Start an employee exit</h3><p>Choose the employee, final date, and checklist.</p></div></div>
          </div>
          <StartOffboardingForm
            employees={eligibleEmployees.map((employee) => ({ id: employee.id, label: `${employee.first_name} ${employee.last_name} · ${employee.employee_number}` }))}
            templates={templates.filter((template) => template.is_active).map((template) => ({ id: template.id, label: `${template.name}${template.is_default ? " (default)" : ""}` }))}
            defaultTemplateId={templates.find((template) => template.is_default && template.is_active)?.id ?? null}
          />
        </section>

        <section className="card">
          <div className="panel-heading">
            <div><span className="panel-icon"><Icon name="settings" size={17} /></span><div><h3>Checklist templates</h3><p>Reusable steps for consistent, compliant exits.</p></div></div>
          </div>
          <ul className="mb-5 divide-y divide-stone-100">
            {templates.length === 0 && <li className="pb-4 text-sm text-stone-400">No templates yet. Create your first checklist below.</li>}
            {templates.map((template) => (
              <li key={template.id} className="flex items-center justify-between gap-3 py-3 first:pt-0">
                <div className="min-w-0">
                  <Link href={`/admin/offboarding/templates/${template.id}`} className="block truncate text-sm font-semibold text-royal-700 hover:underline">{template.name}</Link>
                  <small className="text-stone-400">{stepCounts.get(template.id) ?? 0} checklist {(stepCounts.get(template.id) ?? 0) === 1 ? "step" : "steps"}</small>
                </div>
                <div className="flex gap-1.5">
                  {template.is_default && <span className="badge badge-gold">Default</span>}
                  {!template.is_active && <span className="badge badge-neutral">Inactive</span>}
                </div>
              </li>
            ))}
          </ul>
          <OffboardingTemplateForm organizationId={organizationId} hasTemplates={templates.length > 0} />
        </section>
      </div>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div><span className="eyebrow">Live checklist</span><h2 className="mt-1 text-lg font-semibold text-stone-900">Active employee exits</h2></div>
          <span className="text-xs text-stone-400">{activeRuns.length} open</span>
        </div>
        {activeRuns.length === 0 && (
          <div className="context-empty">
            <span><Icon name="check" /></span>
            <div><strong>No exits are in progress</strong><p>Start one above when a departure is confirmed. The checklist will appear here with owners and due dates.</p></div>
          </div>
        )}
        {activeRuns.map((run) => {
          const runTasks = tasksByRun.get(run.id) ?? [];
          const completed = runTasks.filter((task) => task.status === "completed").length;
          const percent = runTasks.length > 0 ? Math.round((completed / runTasks.length) * 100) : 0;
          return (
            <article className="card" key={run.id}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-stone-900">{personName(employeesById.get(run.employee_id))}</h3>
                    <span className="badge badge-gold">In progress</span>
                  </div>
                  <p className="mt-1 text-xs text-stone-500">{templatesById.get(run.template_id)?.name ?? "Checklist"} · final day {formatDate(run.final_work_date)}</p>
                </div>
                <div className="min-w-44">
                  <div className="mb-1.5 flex justify-between text-xs"><span className="text-stone-400">Checklist</span><strong className="text-stone-700">{completed}/{runTasks.length} · {percent}%</strong></div>
                  <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
                </div>
              </div>
              <div className="mt-5 divide-y divide-stone-100 border-t border-stone-100">
                {runTasks.length === 0 && <p className="py-4 text-sm text-stone-400">This template has no tasks. Add checklist steps before starting future exits.</p>}
                {runTasks.map((task) => {
                  const overdue = task.status === "pending" && Boolean(task.due_date && task.due_date < today);
                  return (
                    <div key={task.id} className="grid gap-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                      <span className={`flex h-8 w-8 items-center justify-center rounded-full ${task.status === "completed" ? "bg-emerald-50 text-emerald-700" : overdue ? "bg-red-50 text-red-700" : "bg-stone-100 text-stone-500"}`}>
                        {task.status === "completed" ? <Icon name="check" size={16} /> : task.sequence}
                      </span>
                      <div>
                        <div className="flex flex-wrap items-center gap-2"><strong className={`text-sm ${task.status === "completed" ? "text-stone-400 line-through" : "text-stone-800"}`}>{task.title}</strong>{overdue && <span className="badge badge-ruby">Overdue</span>}</div>
                        <p className="mt-0.5 text-xs text-stone-400">{ownerLabel(task.assignee_type)} · due {formatDate(task.due_date)}{!task.required ? " · optional" : ""}</p>
                        {task.description && <p className="mt-1 text-xs leading-5 text-stone-500">{task.description}</p>}
                      </div>
                      {task.status === "pending" && <CompleteOffboardingTaskButton taskId={task.id} />}
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </section>

      <section className="card overflow-x-auto">
        <div className="panel-heading">
          <div><span className="panel-icon"><Icon name="reports" size={17} /></span><div><h3>Completed exits</h3><p>A concise history of finished offboarding runs.</p></div></div>
        </div>
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-2">Employee</th><th className="pb-2">Template</th><th className="pb-2">Final day</th><th className="pb-2">Started</th><th className="pb-2">Completed</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {completedRuns.length === 0 && <tr><td colSpan={5} className="py-5 text-stone-400">No completed exits yet.</td></tr>}
            {completedRuns.slice(0, 20).map((run) => (
              <tr key={run.id}>
                <td className="py-3 font-medium text-stone-800">{personName(employeesById.get(run.employee_id))}</td>
                <td className="py-3">{templatesById.get(run.template_id)?.name ?? "—"}</td>
                <td className="py-3">{formatDate(run.final_work_date)}</td>
                <td className="py-3">{formatDate(run.started_at)}</td>
                <td className="py-3">{formatDate(run.completed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
