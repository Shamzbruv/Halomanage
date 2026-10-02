import { EmergencyContactsEditor } from "@/components/EmergencyContactsEditor";
import { EmployeeIdentifiersForm } from "@/components/EmployeeIdentifiersForm";
import { EmployeeHrNotes } from "@/components/EmployeeHrNotes";
import { EmployeePersonalInfoForm, PERSONAL_INFO_COLUMNS, type CollectionSetting } from "@/components/EmployeePersonalInfoForm";
import { createClient } from "@/lib/supabase/server";
import type { EmployeeRecord } from "@/components/employee/types";

// Everything here is protected PII (employee_private, employee_identifiers,
// employee_emergency_contacts): the employee and employee.manage only —
// never a supervisor or manager merely because of the reporting line.

export async function PersonalInfoCard({ employee }: { employee: EmployeeRecord }) {
  const supabase = await createClient();
  const [{ data: privateInfo }, { data: prefs }] = await Promise.all([
    supabase.from("employee_private").select(PERSONAL_INFO_COLUMNS).eq("employee_id", employee.id).maybeSingle(),
    supabase.from("employee_setup_preferences").select("collect_gender, collect_marital_status").eq("organization_id", employee.organization_id).maybeSingle(),
  ]);
  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">Personal information</h2>
      <p className="mb-4 text-xs text-stone-500">Visible only to {employee.first_name} and HR. The employee can keep their contact details and address current; date of birth stays HR controlled.</p>
      <EmployeePersonalInfoForm
        organizationId={employee.organization_id}
        employeeId={employee.id}
        initial={privateInfo}
        collectGender={(prefs?.collect_gender ?? "off") as CollectionSetting}
        collectMaritalStatus={(prefs?.collect_marital_status ?? "off") as CollectionSetting}
      />
    </section>
  );
}

// HR-only notes (employee_hr_notes) — never visible to the employee or
// their managers, unlike employee_private where HR notes used to live.
export async function HrNotesCard({ employee, timezone }: { employee: EmployeeRecord; timezone: string | undefined }) {
  const supabase = await createClient();
  const { data: notes } = await supabase
    .from("employee_hr_notes")
    .select("id, category, body, created_at, created_by, updated_at")
    .eq("employee_id", employee.id)
    .order("created_at", { ascending: false });
  const authorIds = [...new Set((notes ?? []).map((n) => n.created_by).filter(Boolean))] as string[];
  const { data: authors } = authorIds.length
    ? await supabase.from("employees").select("user_id, first_name, last_name").eq("organization_id", employee.organization_id).in("user_id", authorIds)
    : { data: [] as { user_id: string; first_name: string; last_name: string }[] };
  const nameByUser = new Map((authors ?? []).map((a) => [a.user_id, `${a.first_name} ${a.last_name}`]));
  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">HR notes</h2>
      <p className="mb-4 text-xs text-stone-500">🔒 Visible only to people who manage employee records. {employee.first_name} and their managers can never see these. The audit trail records that a note was added, not what it says.</p>
      <EmployeeHrNotes
        organizationId={employee.organization_id}
        employeeId={employee.id}
        timezone={timezone}
        notes={(notes ?? []).map((n) => ({ id: n.id, category: n.category, body: n.body, created_at: n.created_at, updated_at: n.updated_at, created_by_name: n.created_by ? nameByUser.get(n.created_by) ?? null : null }))}
      />
    </section>
  );
}

export async function IdentifiersCard({ employee, timezone }: { employee: EmployeeRecord; timezone: string | undefined }) {
  const supabase = await createClient();
  const { data: identifiers } = await supabase
    .from("employee_identifiers")
    .select("id, identifier_type, label, identifier_value, country_code, issued_on, expires_on, verified_at")
    .eq("employee_id", employee.id)
    .order("identifier_type");
  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">Government &amp; compliance IDs</h2>
      <p className="mb-4 text-xs text-stone-500">TRN, NIS, national ID, passport and any other identifier your organization records. Numbers are masked by default and never copied in full into the audit trail.</p>
      <EmployeeIdentifiersForm organizationId={employee.organization_id} employeeId={employee.id} identifiers={identifiers ?? []} timezone={timezone} />
    </section>
  );
}

export async function EmergencyContactsCard({ employee }: { employee: EmployeeRecord }) {
  const supabase = await createClient();
  const { data: contacts } = await supabase
    .from("employee_emergency_contacts")
    .select("id, full_name, relationship, phone, alternate_phone, email, is_primary")
    .eq("employee_id", employee.id)
    .order("is_primary", { ascending: false })
    .order("created_at");
  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">Emergency contacts</h2>
      <p className="mb-4 text-xs text-stone-500">Add as many as needed and mark one as primary. {employee.first_name} can also keep these up to date from their own profile.</p>
      <EmergencyContactsEditor organizationId={employee.organization_id} employeeId={employee.id} contacts={contacts ?? []} />
    </section>
  );
}
