import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { CompleteOnboardingTaskButton } from "@/components/CompleteOnboardingTaskButton";

export default async function OnboardingPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) return null;

  const supabase = await createClient();

  // RLS already scopes this to tasks the caller is entitled to see (their
  // own onboarding, or tasks assigned to them as someone else's supervisor)
  // — no extra filtering needed here beyond ordering.
  const { data: tasks } = await supabase
    .from("onboarding_tasks")
    .select("*")
    .order("run_id")
    .order("sequence");

  const runs = new Map<string, any[]>();
  for (const t of tasks ?? []) {
    if (!runs.has(t.run_id)) runs.set(t.run_id, []);
    runs.get(t.run_id)!.push(t);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold text-stone-900">Onboarding</h1>

      {runs.size === 0 && (
        <div className="card text-sm text-stone-400">No onboarding tasks assigned to you right now.</div>
      )}

      {[...runs.entries()].map(([runId, runTasks]) => (
        <div key={runId} className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">
            {runTasks[0].employee_id === session.employee!.id ? "Your onboarding" : "Assigned to you"}
          </h2>
          <ul className="divide-y divide-stone-100">
            {runTasks.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className={t.status === "completed" ? "text-sm text-stone-400 line-through" : "text-sm font-medium text-stone-900"}>
                    {t.sequence}. {t.title}
                  </p>
                  {t.description && <p className="text-xs text-stone-500">{t.description}</p>}
                  <p className="text-xs text-stone-400">
                    {t.step_type.replace(/_/g, " ")} {t.due_date && `· due ${t.due_date}`}
                  </p>
                </div>
                {t.status === "completed" ? (
                  <span className="badge badge-emerald">Done</span>
                ) : (
                  <CompleteOnboardingTaskButton taskId={t.id} />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
