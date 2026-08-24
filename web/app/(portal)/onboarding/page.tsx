import Link from "next/link";
import { redirect } from "next/navigation";
import { CompleteOnboardingTaskButton } from "@/components/CompleteOnboardingTaskButton";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";

export default async function OnboardingPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const { data: tasks } = await supabase.from("onboarding_tasks").select("*").order("run_id").order("sequence");
  const runs = new Map<string, any[]>();
  for (const task of tasks ?? []) {
    if (!runs.has(task.run_id)) runs.set(task.run_id, []);
    runs.get(task.run_id)!.push(task);
  }
  const total = (tasks ?? []).length;
  const completed = (tasks ?? []).filter((task) => task.status === "completed" || task.status === "skipped").length;
  const progress = total ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Getting settled</span><h1>Your path from new to fully onboarded.</h1><p>Work through each step in order. Dependencies, owners, and evidence stay attached to the task so everyone knows what comes next.</p></div>

      {runs.size === 0 ? (
        <div className="empty-state card"><span><Icon name="onboarding" size={26} /></span><h2>No onboarding work right now</h2><p>You have no assigned onboarding tasks. New steps will appear here automatically when HR starts a workflow.</p>{session.roles.includes("admin") && <Link className="btn-primary empty-state-action" href="/admin/onboarding">Start an onboarding plan</Link>}</div>
      ) : (
        <>
          <div className="onboarding-summary card">
            <div><span className="metric-icon mint"><Icon name="onboarding" /></span><div><small>Overall progress</small><strong>{progress}% complete</strong><p>{completed} of {total} tasks finished</p></div></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          </div>
          <div className="onboarding-runs">
            {[...runs.entries()].map(([runId, runTasks]) => {
              const runCompleted = runTasks.filter((task) => task.status === "completed" || task.status === "skipped").length;
              return (
                <section key={runId} className="card">
                  <div className="panel-heading"><div><span className="panel-icon"><Icon name="onboarding" /></span><div><h3>{runTasks[0].employee_id === session.employee!.id ? "Your onboarding plan" : "Tasks assigned to you"}</h3><p>{runCompleted} of {runTasks.length} steps completed.</p></div></div><span className="badge badge-neutral">{runTasks.length - runCompleted} remaining</span></div>
                  <ol className="onboarding-task-list">
                    {runTasks.map((task) => {
                      const done = task.status === "completed" || task.status === "skipped";
                      return (
                        <li key={task.id} className={done ? "done" : ""}>
                          <span className="task-marker">{done ? <Icon name="check" size={15} /> : task.sequence}</span>
                          <div><strong>{task.title}</strong>{task.description && <p>{task.description}</p>}<small>{task.step_type.replace(/_/g, " ")}{task.due_date ? ` · Due ${task.due_date}` : ""}</small></div>
                          <div>{done ? <span className="badge badge-emerald">Done</span> : <CompleteOnboardingTaskButton taskId={task.id} />}</div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
