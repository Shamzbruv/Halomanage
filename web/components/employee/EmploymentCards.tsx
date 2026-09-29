import { ChangeAssignmentForm } from "@/components/ChangeAssignmentForm";
import { EmployeeIdentityForm, EmploymentDatesForm } from "@/components/EmployeeIdentityForm";
import { EMPLOYMENT_TYPE_LABELS } from "@/lib/employeeSetup";
import { createClient } from "@/lib/supabase/server";
import type { EmployeeRecord } from "@/components/employee/types";

export function IdentityCard({ employee }: { employee: EmployeeRecord }) {
  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">Identity</h2>
      <p className="mb-4 text-xs text-stone-500">Legal name, employee number, and work contact details. HR controlled — the employee sees these but can&apos;t change them.</p>
      <EmployeeIdentityForm
        employeeId={employee.id}
        hasAccount={!!employee.user_id}
        initial={{
          employee_number: employee.employee_number,
          first_name: employee.first_name,
          middle_name: employee.middle_name,
          last_name: employee.last_name,
          preferred_name: employee.preferred_name,
          work_email: employee.work_email,
          work_phone: employee.work_phone,
          external_payroll_id: employee.external_payroll_id,
        }}
      />
    </section>
  );
}

// Dates on employees + the effective-dated assignment. A pre-hire's
// assignment is corrected in place while HR is still setting them up;
// after that every change opens a new history row (change_employee_assignment()).
export async function EmploymentCard({ employee, organizationId, showHistory = true }: { employee: EmployeeRecord; organizationId: string; showHistory?: boolean }) {
  const supabase = await createClient();
  const [{ data: current }, { data: history }, { data: orgUnits }, { data: positions }, { data: locations }, { data: people }] = await Promise.all([
    supabase.from("employee_assignments").select("*, org_units(name), positions(title), locations(name)").eq("employee_id", employee.id).is("end_date", null).maybeSingle(),
    showHistory
      ? supabase.from("employee_assignments").select("*, org_units(name), positions(title), locations(name)").eq("employee_id", employee.id).order("start_date", { ascending: false })
      : Promise.resolve({ data: [] as any[] }),
    supabase.from("org_units").select("id, name").eq("organization_id", organizationId).order("name"),
    supabase.from("positions").select("id, title").eq("organization_id", organizationId).order("title"),
    supabase.from("locations").select("id, name").eq("organization_id", organizationId).order("name"),
    supabase.from("employees").select("id, first_name, last_name, status").eq("organization_id", organizationId).neq("status", "terminated").order("last_name"),
  ]);
  const nameOf = (id: string | null) => {
    const person = (people ?? []).find((p) => p.id === id);
    return person ? `${person.first_name} ${person.last_name}` : "—";
  };
  const isPrehire = employee.status === "prehire";

  return (
    <>
      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Employment dates</h2>
        <p className="mb-4 text-xs text-stone-500">Onboarding tasks scheduled relative to these dates move automatically when they change.</p>
        <EmploymentDatesForm employeeId={employee.id} hireDate={employee.hire_date} probationEndDate={employee.probation_end_date} />
      </section>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Assignment &amp; reporting line</h2>
            <p className="text-xs text-stone-500">
              {isPrehire
                ? "While this person is a pre-hire, saving corrects their assignment in place — no history is created for setup changes."
                : "Changes are effective-dated: the current assignment is closed and a new one starts on the effective date, so history stays accurate."}
            </p>
          </div>
        </div>
        {current && (
          <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div><dt className="text-xs uppercase text-stone-400">Department</dt><dd>{current.org_units?.name ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Position</dt><dd>{current.positions?.title ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Location</dt><dd>{current.locations?.name ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Employment type</dt><dd>{current.employment_type ? EMPLOYMENT_TYPE_LABELS[current.employment_type] ?? current.employment_type : "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Supervisor</dt><dd>{nameOf(current.supervisor_employee_id)}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Manager</dt><dd>{nameOf(current.manager_employee_id)}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Effective since</dt><dd>{current.start_date}</dd></div>
          </dl>
        )}
        {(orgUnits ?? []).length === 0 && (positions ?? []).length === 0 && (
          <p className="alert-warning mb-3 text-xs">Your organization has no departments or positions yet — add them under Organization first.</p>
        )}
        <ChangeAssignmentForm
          key={current?.id ?? "new"}
          employeeId={employee.id}
          orgUnits={(orgUnits ?? []).map((o) => ({ id: o.id, label: o.name }))}
          positions={(positions ?? []).map((p) => ({ id: p.id, label: p.title }))}
          locations={(locations ?? []).map((l) => ({ id: l.id, label: l.name }))}
          employees={(people ?? []).map((p) => ({ id: p.id, label: `${p.first_name} ${p.last_name}` }))}
          initial={current}
          defaultStartDate={isPrehire ? current?.start_date ?? employee.hire_date : null}
          submitLabel={isPrehire || !current ? "Save assignment" : "Save as new assignment"}
        />
      </section>

      {showHistory && (history ?? []).length > 1 && (
        <section className="card overflow-x-auto">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Assignment history</h2>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">From</th><th className="pb-2">To</th><th className="pb-2">Department</th><th className="pb-2">Position</th><th className="pb-2">Location</th><th className="pb-2">Reason</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {(history ?? []).map((row: any) => (
                <tr key={row.id}>
                  <td className="py-2">{row.start_date}</td>
                  <td className="py-2">{row.end_date ?? "Current"}</td>
                  <td className="py-2">{row.org_units?.name ?? "—"}</td>
                  <td className="py-2">{row.positions?.title ?? "—"}</td>
                  <td className="py-2">{row.locations?.name ?? "—"}</td>
                  <td className="py-2 text-stone-500">{row.change_reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
