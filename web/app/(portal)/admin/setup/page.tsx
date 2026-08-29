import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon, type IconName } from "@/components/Icon";
import { InitializeWorkspaceButton } from "@/components/InitializeWorkspaceButton";
import { OrganizationPortalCard } from "@/components/OrganizationPortalCard";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";

type SetupItem = {
  title: string;
  description: string;
  href: string;
  complete: boolean;
  icon: IconName;
  action: string;
};

export default async function SetupGuidePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "organization.manage") || !session.organizationId || !session.organization) redirect("/dashboard");

  const supabase = await createClient();
  const organizationId = session.organizationId;
  const queryNames = [
    "people",
    "departments",
    "positions",
    "locations",
    "leave policies",
    "onboarding templates",
    "performance templates",
    "documents",
    "employee imports",
  ] as const;
  const results = await Promise.all([
    supabase.from("employees").select("id, user_id").eq("organization_id", organizationId),
    supabase.from("org_units").select("id").eq("organization_id", organizationId),
    supabase.from("positions").select("id").eq("organization_id", organizationId),
    supabase.from("locations").select("id").eq("organization_id", organizationId),
    supabase.from("leave_types").select("id").eq("organization_id", organizationId).eq("is_active", true),
    supabase.from("onboarding_templates").select("id").eq("organization_id", organizationId).eq("is_active", true),
    supabase.from("appraisal_templates").select("id").eq("organization_id", organizationId).eq("is_active", true),
    supabase.from("documents").select("id").eq("organization_id", organizationId).eq("is_active", true),
    supabase.from("employee_import_batches").select("id, status").eq("organization_id", organizationId).eq("status", "committed"),
  ]);
  const { data: branding } = await supabase
    .from("organization_branding")
    .select("portal_title, portal_message, logo_path, primary_color, accent_color")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const queryFailures = results.flatMap((result, index) => result.error ? [{
    module: queryNames[index],
    code: result.error.code,
    message: result.error.message,
    hint: result.error.hint,
  }] : []);
  if (queryFailures.length) console.error("setup guide: failed to load setup modules", queryFailures);

  const [employees, orgUnits, positions, locations, leaveTypes, onboardingTemplates, appraisalTemplates, documents, employeeImports] = results.map((result) => result.data ?? []);
  const invitedEmployees = employees.filter((employee: any) => employee.user_id).length;
  const hasStructure = orgUnits.length > 0 && positions.length > 0 && locations.length > 0;
  const initialized = Boolean(session.organization.settings.starter_workspace_initialized_at);
  const settings = session.organization.settings;
  // Portal branding moved out of organizations.settings JSON into its own
  // table (see 20260829142948_employee_experience_branding.sql).
  const portalTitle = branding?.portal_title ?? `Welcome to ${session.organization.name}`;
  const portalMessage = branding?.portal_message ?? "Sign in to manage your workday, time away, documents, and development.";
  const portalLogoUrl = branding?.logo_path
    ? supabase.storage.from("organization-branding").getPublicUrl(branding.logo_path).data.publicUrl
    : null;

  const items: SetupItem[] = [
    { title: "Employee portal", description: "Preview and share your organization-specific sign-in page.", href: `#employee-portal`, complete: Boolean(session.organization.slug), icon: "shield", action: "View portal" },
    { title: "Business structure", description: "Add departments, positions, and work locations.", href: "/admin/organization", complete: hasStructure, icon: "organization", action: "Configure structure" },
    { title: "Bring over your team", description: "Import a spreadsheet or HR-system export with a validated dry-run.", href: "/admin/migrations", complete: employeeImports.length > 0 || employees.length > 1, icon: "reports", action: "Open Migration Center" },
    { title: "People and access", description: "Create employee records and send secure invitations.", href: "/admin/employees", complete: employees.length > 1 && invitedEmployees > 1, icon: "people", action: "Add employees" },
    { title: "Leave policies", description: "Define vacation, sick, unpaid, and company-specific leave.", href: "/admin/leave-types", complete: leaveTypes.length > 0, icon: "leave", action: "Review policies" },
    { title: "Onboarding workflow", description: "Prepare a repeatable checklist for every new hire.", href: "/admin/onboarding", complete: onboardingTemplates.length > 0, icon: "onboarding", action: "Open onboarding" },
    { title: "Performance checkpoints", description: "Build useful review templates and launch a cycle.", href: "/admin/appraisals", complete: appraisalTemplates.length > 0, icon: "performance", action: "Set up performance" },
    { title: "Document library", description: "Upload policies, handbooks, contracts, and HR letters.", href: "/admin/documents", complete: documents.length > 0, icon: "document", action: "Add a document" },
  ];
  const completed = items.filter((item) => item.complete).length;
  const progress = Math.round((completed / items.length) * 100);

  return (
    <div className="space-y-7">
      <section className="setup-hero">
        <div><span className="eyebrow">Workspace launch plan</span><h1>Turn {session.organization.name} into a working people system.</h1><p>Follow the checklist once, then invite employees into a workspace that already knows how your organization operates.</p></div>
        <div className="setup-progress"><strong>{progress}%</strong><span>{completed} of {items.length} essentials ready</span><div><i style={{ width: `${progress}%` }} /></div></div>
      </section>

      {queryFailures.length > 0 && (
        <div className="alert-error" role="alert">
          Could not verify {queryFailures.map((failure) => failure.module).join(", ")}. The other setup modules remain usable. An administrator should check the latest Supabase migrations and Data API grants.
        </div>
      )}

      {!initialized && (
        <section className="starter-setup-banner">
          <span className="metric-icon sun"><Icon name="spark" /></span>
          <div><h2>Start with a useful foundation</h2><p>Add a standard work week, attendance policy, vacation/sick/unpaid leave, owner assignment, onboarding checklist, performance template, and orientation course. Existing data is preserved.</p></div>
          <InitializeWorkspaceButton organizationId={organizationId} />
        </section>
      )}

      <section className="setup-grid" aria-label="Organization setup checklist">
        {items.map((item, index) => (
          <Link className={`setup-item ${item.complete ? "complete" : ""}`} href={item.href} key={item.title}>
            <span className="setup-item-number">{item.complete ? <Icon name="check" size={16} /> : String(index + 1).padStart(2, "0")}</span>
            <span className={`metric-icon ${index % 3 === 1 ? "sun" : index % 3 === 2 ? "coral" : "mint"}`}><Icon name={item.icon} /></span>
            <span className="setup-item-copy"><strong>{item.title}</strong><small>{item.description}</small><em>{item.action} <Icon name="arrow-right" size={14} /></em></span>
          </Link>
        ))}
      </section>

      <div id="employee-portal">
        <OrganizationPortalCard
          organizationId={organizationId}
          organizationName={session.organization.name}
          initialSlug={session.organization.slug}
          initialTitle={portalTitle}
          initialMessage={portalMessage}
          initialLogoUrl={portalLogoUrl}
          initialPrimaryColor={branding?.primary_color ?? "#101B3D"}
          initialAccentColor={branding?.accent_color ?? "#F2B84B"}
          siteUrl={process.env.NEXT_PUBLIC_SITE_URL ?? ""}
        />
      </div>

      <section className="card first-employee-flow">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="people" /></span><div><h3>Your first employee journey</h3><p>What happens after the workspace foundation is ready.</p></div></div></div>
        <ol>
          <li><span>1</span><div><strong>Create the employee record</strong><p>Add their work email, start date, and status in People.</p></div></li>
          <li><span>2</span><div><strong>Assign their role and reporting line</strong><p>Choose a department, position, location, supervisor, and schedule.</p></div></li>
          <li><span>3</span><div><strong>Send the secure invitation</strong><p>Their account is tied to the employee record before they ever sign in.</p></div></li>
          <li><span>4</span><div><strong>Start onboarding</strong><p>Assign the starter template or build one that matches the role.</p></div></li>
          <li><span>5</span><div><strong>Share the employee portal</strong><p>They use one branded link for shifts, leave, documents, onboarding, and performance.</p></div></li>
        </ol>
      </section>
    </div>
  );
}
