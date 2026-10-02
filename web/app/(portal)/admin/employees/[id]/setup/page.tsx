import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmployeeSetupReadiness } from "@/components/EmployeeSetupReadiness";
import { Icon } from "@/components/Icon";
import { InviteButton } from "@/components/InviteButton";
import { AccessCard } from "@/components/employee/AccessCard";
import { EmploymentCard, IdentityCard } from "@/components/employee/EmploymentCards";
import { OnboardingPlanCard } from "@/components/employee/OnboardingCards";
import { EmergencyContactsCard, IdentifiersCard, PersonalInfoCard } from "@/components/employee/PersonalCards";
import type { EmployeeRecord } from "@/components/employee/types";
import { SETUP_GROUPS, SETUP_STEPS, isSetupStep, setupHref, stepForSection, type SetupReadiness, type SetupStepKey } from "@/lib/employeeSetup";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

// Prepare & Invite (blueprint §6): HR completes the record step by step and
// the invitation is the final step. Readiness comes from
// get_employee_setup_readiness(); the invite-employee Edge Function
// re-checks it server-side, so this page is guidance, not the enforcement.
export default async function EmployeeSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string; created?: string }>;
}) {
  const { id } = await params;
  const { step: requestedStep, created } = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId || !session.organization) redirect("/dashboard");

  const supabase = await createClient();
  const [{ data: employeeRow }, { data: readinessData }] = await Promise.all([
    supabase.from("employees").select("*").eq("id", id).eq("organization_id", session.organizationId).maybeSingle(),
    supabase.rpc("get_employee_setup_readiness", { p_employee_id: id }),
  ]);
  if (!employeeRow) notFound();
  const employee = employeeRow as EmployeeRecord;
  if (!readinessData) throw new Error("Could not load this employee's setup status.");
  const readiness = readinessData as SetupReadiness;

  // Without an explicit step, land on the first step that still has a blocker.
  const firstIncomplete: SetupStepKey = readiness.blockers[0] ? stepForSection(readiness.blockers[0].section) : "review";
  const step: SetupStepKey = isSetupStep(requestedStep) ? requestedStep : firstIncomplete;
  const stepIndex = SETUP_STEPS.findIndex((s) => s.key === step);
  const previous = SETUP_STEPS[stepIndex - 1];
  const next = SETUP_STEPS[stepIndex + 1];
  const base = `/admin/employees/${employee.id}/setup`;

  function stepComplete(key: SetupStepKey) {
    if (key === "review") return readiness.ready;
    const sections = SETUP_GROUPS.filter((g) => g.step === key).flatMap((g) => g.sections);
    return readiness.items.filter((i) => sections.includes(i.section) && i.required).every((i) => i.complete);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/admin/employees/${employee.id}`} className="text-xs text-royal-700 hover:text-royal-800">← {employee.first_name} {employee.last_name}&apos;s record</Link>
        <div className="page-intro mt-2">
          <span className="eyebrow">Prepare &amp; invite · <span className="font-mono">{employee.employee_number}</span></span>
          <h1>Set up {employee.preferred_name || employee.first_name} before they get access.</h1>
          <p>When they sign in for the first time, their role, reporting line, and onboarding plan will already be waiting.</p>
        </div>
        {created && <p className="portal-card-status mt-3" role="status"><Icon name="check" size={15} /> Employee record created with number <strong className="font-mono">{employee.employee_number}</strong>. Status: pre-hire.</p>}
      </div>

      <ol className="setup-stepper" aria-label="Setup steps">
        {SETUP_STEPS.map((s, index) => (
          <li key={s.key} className={`${s.key === step ? "current" : ""} ${stepComplete(s.key) ? "complete" : ""}`.trim()}>
            <Link href={`${base}?step=${s.key}`} aria-current={s.key === step ? "step" : undefined}>
              <span className="setup-step-number">{stepComplete(s.key) ? <Icon name="check" size={13} /> : index + 1}</span>
              <span>{s.label}</span>
            </Link>
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {step === "identity" && <IdentityCard employee={employee} />}
          {step === "personal" && (
            <>
              <PersonalInfoCard employee={employee} />
              <IdentifiersCard timezone={session.organization.timezone} employee={employee} />
              <EmergencyContactsCard employee={employee} />
            </>
          )}
          {step === "employment" && <EmploymentCard employee={employee} organizationId={session.organizationId} showHistory={false} />}
          {step === "access" && <AccessCard timezone={session.organization.timezone} employee={employee} organizationId={session.organizationId} viewerUserId={session.userId} readiness={readiness} />}
          {step === "onboarding" && <OnboardingPlanCard employee={employee} organizationId={session.organizationId} readiness={readiness} />}
          {step === "review" && (
            <section className="card">
              <h2 className="mb-3 text-sm font-semibold text-stone-900">Review</h2>
              <ul className="review-checklist">
                {SETUP_GROUPS.map((group) => {
                  const items = readiness.items.filter((i) => group.sections.includes(i.section));
                  const required = items.filter((i) => i.required);
                  const complete = required.every((i) => i.complete);
                  return (
                    <li key={group.label} className={complete ? "done" : "todo"}>
                      <span aria-hidden="true">{complete ? "✓" : "•"}</span>
                      <span>{group.label} {required.length === 0 ? "(optional)" : complete ? "complete" : "incomplete"}</span>
                    </li>
                  );
                })}
              </ul>

              {employee.user_id ? (
                <p className="mt-4 text-sm text-stone-600">
                  {employee.first_name} already has an account ({readiness.account.state === "active" ? "active" : "invitation pending"}).
                </p>
              ) : readiness.ready ? (
                <div className="mt-5 space-y-3">
                  <p className="text-sm text-stone-700">Everything required is in place. Sending the invitation will create {employee.first_name}&apos;s account, apply their access, start their onboarding, and email <strong>{employee.work_email}</strong>.</p>
                  <InviteButton employeeId={employee.id} alreadyInvited={false} accepted={false} portalSlug={session.organization.slug} setup={{ ready: true, percent: readiness.percent }} />
                </div>
              ) : (
                <div className="alert-warning mt-5">
                  <p className="font-semibold">Invitation cannot be sent yet.</p>
                  <p>{readiness.blockers.length} item{readiness.blockers.length === 1 ? " requires" : "s require"} attention:</p>
                  <ul className="mt-2 list-disc pl-5">
                    {readiness.blockers.map((b) => <li key={b.code}><Link className="underline" href={setupHref(employee.id, b)}>{b.label}</Link></li>)}
                  </ul>
                </div>
              )}
            </section>
          )}

          <div className="flex items-center justify-between gap-3">
            {previous ? <Link className="btn-secondary" href={`${base}?step=${previous.key}`}>← {previous.label}</Link> : <span />}
            {next && <Link className="btn-primary" href={`${base}?step=${next.key}`}>Next: {next.label} →</Link>}
          </div>
        </div>
        <div>
          <EmployeeSetupReadiness timezone={session.organization.timezone} employeeId={employee.id} readiness={readiness} />
        </div>
      </div>
    </div>
  );
}
