import { EmergencyContactsEditor } from "@/components/EmergencyContactsEditor";
import { EmployeeIdentifiersForm } from "@/components/EmployeeIdentifiersForm";
import { EmployeePersonalInfoForm } from "@/components/EmployeePersonalInfoForm";
import { createClient } from "@/lib/supabase/server";
import type { EmployeeRecord } from "@/components/employee/types";

// Everything here is protected PII (employee_private, employee_identifiers,
// employee_emergency_contacts): the employee and employee.manage only —
// never a supervisor or manager merely because of the reporting line.

export async function PersonalInfoCard({ employee }: { employee: EmployeeRecord }) {
  const supabase = await createClient();
  const { data: privateInfo } = await supabase.from("employee_private").select("*").eq("employee_id", employee.id).maybeSingle();
  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">Personal information</h2>
      <p className="mb-4 text-xs text-stone-500">Visible only to {employee.first_name} and HR. The employee can keep their contact details and address current; date of birth stays HR controlled.</p>
      <EmployeePersonalInfoForm organizationId={employee.organization_id} employeeId={employee.id} initial={privateInfo} />
    </section>
  );
}

export async function IdentifiersCard({ employee }: { employee: EmployeeRecord }) {
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
      <EmployeeIdentifiersForm organizationId={employee.organization_id} employeeId={employee.id} identifiers={identifiers ?? []} />
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
