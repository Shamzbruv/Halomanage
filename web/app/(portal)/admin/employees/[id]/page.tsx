import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActivateEmployeeButton } from "@/components/ActivateEmployeeButton";
import { EmployeeSetupReadiness } from "@/components/EmployeeSetupReadiness";
import { InviteButton } from "@/components/InviteButton";
import { TerminateEmployeeButton } from "@/components/TerminateEmployeeButton";
import { AccessCard } from "@/components/employee/AccessCard";
import { EmploymentCard, IdentityCard } from "@/components/employee/EmploymentCards";
import { OnboardingHistoryCard, OnboardingPlanCard } from "@/components/employee/OnboardingCards";
import { EmergencyContactsCard, IdentifiersCard, PersonalInfoCard } from "@/components/employee/PersonalCards";
import { CompensationCard, DocumentsCard, HistoryCard, LeaveCard, LearningAndAssetsCard } from "@/components/employee/RecordCards";
import type { EmployeeRecord } from "@/components/employee/types";
import { EMPLOYMENT_TYPE_LABELS, accountLabel, type SetupReadiness } from "@/lib/employeeSetup";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { statusBadgeClass } from "@/lib/ui";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "employment", label: "Employment" },
  { key: "personal", label: "Personal" },
  { key: "ids", label: "Government IDs" },
  { key: "emergency", label: "Emergency contacts" },
  { key: "access", label: "Access" },
  { key: "onboarding", label: "Onboarding" },
  { key: "documents", label: "Documents" },
  { key: "learning", label: "Learning & assets" },
  { key: "leave", label: "Leave" },
  { key: "compensation", label: "Compensation" },
  { key: "history", label: "History" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// The complete HR record for one person (blueprint §3). Each tab renders
// its own card(s) from components/employee/*, the same cards the Prepare &
// Invite wizard (./setup) uses, so there is one form per fact.
export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: requestedTab } = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId || !session.organization) redirect("/dashboard");
  const orgId = session.organizationId;
  const canReadCompensation = sessionCan(session, "compensation.read_org");
  const canManageCompensation = sessionCan(session, "compensation.manage") || sessionCan(session, "compensation.approve");

  const visibleTabs = TABS.filter((t) => t.key !== "compensation" || canReadCompensation);
  const tab: TabKey = (visibleTabs.find((t) => t.key === requestedTab)?.key ?? "overview") as TabKey;

  const supabase = await createClient();
  const [{ data: employeeRow }, { data: readinessData }] = await Promise.all([
    supabase.from("employees").select("*").eq("id", id).eq("organization_id", orgId).maybeSingle(),
    supabase.rpc("get_employee_setup_readiness", { p_employee_id: id }),
  ]);
  if (!employeeRow) notFound();
  const employee = employeeRow as EmployeeRecord;
  const readiness = (readinessData as SetupReadiness | null) ?? null;
  const fullName = `${employee.first_name} ${employee.last_name}`;
  const displayName = `${employee.preferred_name || employee.first_name} ${employee.last_name}`;

  const [{ data: current }, avatar] = await Promise.all([
    supabase.from("employee_assignments").select("org_unit_id, position_id, org_units(name), positions(title)").eq("employee_id", id).is("end_date", null).maybeSingle(),
    employee.avatar_url ? supabase.storage.from("employee-avatars").createSignedUrl(employee.avatar_url, 3600) : Promise.resolve(null),
  ]);
  const avatarUrl = avatar?.data?.signedUrl ?? null;
  const currentAny = current as any;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/employees" className="text-xs text-royal-700 hover:text-royal-800">← All employees</Link>
        <div className="employee-profile-head">
          <span className="user-avatar large">{avatarUrl ? <img src={avatarUrl} alt="" /> : `${employee.first_name[0]}${employee.last_name[0]}`}</span>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl font-bold text-stone-900">{displayName}</h1>
            <p className="text-sm text-stone-500">
              <span className="font-mono">{employee.employee_number}</span>
              {" · "}{currentAny?.positions?.title ?? "No position"}{currentAny?.org_units?.name ? ` · ${currentAny.org_units.name}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge ${statusBadgeClass(employee.status)}`}>{employee.status}</span>
            {(employee.status === "prehire" || employee.status === "leave" || employee.status === "suspended") && <ActivateEmployeeButton employeeId={employee.id} />}
            {!employee.user_id && employee.status !== "terminated" && (
              <Link href={`/admin/employees/${employee.id}/setup`} className="btn-primary px-3 py-1.5 text-xs">
                {readiness?.ready ? "Review & invite" : "Prepare & invite"}
              </Link>
            )}
            {employee.user_id && (
              <InviteButton employeeId={employee.id} alreadyInvited accepted={readiness?.account.state === "active"} portalSlug={session.organization.slug} />
            )}
            {employee.status !== "terminated" && <TerminateEmployeeButton employeeId={employee.id} employeeName={fullName} isSelf={employee.user_id === session.userId} />}
          </div>
        </div>
      </div>

      <nav className="profile-tabs" aria-label="Employee record sections">
        {visibleTabs.map((t) => (
          <Link key={t.key} href={`/admin/employees/${employee.id}${t.key === "overview" ? "" : `?tab=${t.key}`}`} aria-current={tab === t.key ? "page" : undefined} className={tab === t.key ? "active" : ""}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <OverviewSummary employee={employee} readiness={readiness} />
            <OnboardingHistoryCard employeeId={employee.id} />
          </div>
          <div>{readiness && <EmployeeSetupReadiness employeeId={employee.id} readiness={readiness} />}</div>
        </div>
      )}
      {tab === "employment" && (
        <div className="space-y-6">
          <IdentityCard employee={employee} />
          <EmploymentCard employee={employee} organizationId={orgId} />
        </div>
      )}
      {tab === "personal" && <PersonalInfoCard employee={employee} />}
      {tab === "ids" && <IdentifiersCard employee={employee} />}
      {tab === "emergency" && <EmergencyContactsCard employee={employee} />}
      {tab === "access" && <AccessCard employee={employee} organizationId={orgId} viewerUserId={session.userId} readiness={readiness} />}
      {tab === "onboarding" && (
        <div className="space-y-6">
          <OnboardingPlanCard employee={employee} organizationId={orgId} readiness={readiness} />
          <OnboardingHistoryCard employeeId={employee.id} />
        </div>
      )}
      {tab === "documents" && <div className="space-y-6"><DocumentsCard employee={employee} /></div>}
      {tab === "learning" && (
        <div className="space-y-6">
          <LearningAndAssetsCard employee={employee} canManageTraining={sessionCan(session, "training.manage")} canManageAssets={sessionCan(session, "assets.manage")} />
        </div>
      )}
      {tab === "leave" && <LeaveCard employee={employee} />}
      {tab === "compensation" && canReadCompensation && <CompensationCard employee={employee} canManage={canManageCompensation} timezone={session.organization.timezone} />}
      {tab === "history" && <HistoryCard employeeId={employee.id} />}
    </div>
  );
}

async function OverviewSummary({ employee, readiness }: { employee: EmployeeRecord; readiness: SetupReadiness | null }) {
  const supabase = await createClient();
  const { data: current } = await supabase
    .from("employee_assignments")
    .select("employment_type, supervisor_employee_id, manager_employee_id, org_units(name), positions(title), locations(name)")
    .eq("employee_id", employee.id)
    .is("end_date", null)
    .maybeSingle();
  const leaderIds = [current?.supervisor_employee_id, current?.manager_employee_id].filter(Boolean) as string[];
  const { data: leaders } = leaderIds.length
    ? await supabase.from("employees").select("id, first_name, last_name").in("id", leaderIds)
    : { data: [] as { id: string; first_name: string; last_name: string }[] };
  const nameOf = (leaderId: string | null | undefined) => {
    const person = (leaders ?? []).find((l) => l.id === leaderId);
    return person ? `${person.first_name} ${person.last_name}` : "—";
  };
  const c = current as any;
  const legalName = [employee.first_name, employee.middle_name, employee.last_name].filter(Boolean).join(" ");

  const rows: [string, React.ReactNode][] = [
    ["Legal name", legalName],
    ["Preferred name", employee.preferred_name ?? "—"],
    ["Employee number", <span key="n" className="font-mono">{employee.employee_number}</span>],
    ["Status", employee.status],
    ["Position", c?.positions?.title ?? "—"],
    ["Department", c?.org_units?.name ?? "—"],
    ["Location", c?.locations?.name ?? "—"],
    ["Supervisor", nameOf(c?.supervisor_employee_id)],
    ["Manager", nameOf(c?.manager_employee_id)],
    ["Employment type", c?.employment_type ? EMPLOYMENT_TYPE_LABELS[c.employment_type] ?? c.employment_type : "—"],
    ["Hire date", employee.hire_date ?? "—"],
    ["Probation end", employee.probation_end_date ?? "—"],
    ["Work email", employee.work_email ?? "—"],
    ["Work phone", employee.work_phone ?? "—"],
    ["Portal account", accountLabel(readiness?.account)],
  ];

  return (
    <section className="card">
      <h2 className="mb-4 text-sm font-semibold text-stone-900">Overview</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label}><dt className="text-xs uppercase text-stone-400">{label}</dt><dd className="mt-0.5 text-stone-900">{value}</dd></div>
        ))}
      </dl>
    </section>
  );
}
