import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getCurrentSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { OnboardingTaskCard } from "@/components/OnboardingTaskCard";
import { OnboardingTaskForm } from "@/components/OnboardingTaskForm";
import type { OnboardingTask } from "@/lib/onboarding";
export default async function OnboardingTaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data, error } = await (
    await createClient()
  ).rpc("get_onboarding_task", { p_task_id: id });
  if (error || !data)
    return (
      <div className="card space-y-3">
        <h1>Onboarding step unavailable</h1>
        <p role="alert">
          {error?.message ?? "This task is not available to your account."}
        </p>
        <Link href="/onboarding" className="btn-secondary">
          Back to onboarding
        </Link>
        <Link href="/settings" className="btn-secondary">
          Account security
        </Link>
      </div>
    );
  const task = data as OnboardingTask;
  return (
    <div className="space-y-5">
      <Link href="/onboarding" className="btn-secondary">
        Back to onboarding
      </Link>
      <h1 className="text-xl font-semibold">Onboarding step</h1>
      <OnboardingTaskCard
        task={task}
        timezone={session.organization?.timezone}
        detail
      />
      <OnboardingTaskForm task={task} />
    </div>
  );
}
