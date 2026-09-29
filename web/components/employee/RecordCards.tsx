import { AddCertificationForm } from "@/components/AddCertificationForm";
import { AssignAssetForm } from "@/components/AssignAssetForm";
import { AssignTrainingForm } from "@/components/AssignTrainingForm";
import { ChangeCompensationForm } from "@/components/ChangeCompensationForm";
import { DocumentDownloadButton } from "@/components/DocumentDownloadButton";
import { DocumentUploadForm } from "@/components/DocumentUploadForm";
import { GrantLeaveBalanceForm } from "@/components/GrantLeaveBalanceForm";
import { ReturnAssetButton } from "@/components/ReturnAssetButton";
import { TrainingStatusSelect } from "@/components/TrainingStatusSelect";
import { historyLabel } from "@/lib/employeeSetup";
import { createClient } from "@/lib/supabase/server";
import { todayIn } from "@/lib/timezone";
import type { EmployeeRecord } from "@/components/employee/types";

const CATEGORY_LABELS: Record<string, string> = {
  contract: "Contract", identification: "Identification", certificate: "Certificate", policy: "Policy",
  hr_letter: "HR letter", medical: "Medical", appraisal: "Appraisal", payroll: "Payroll", other: "Other",
};

export async function DocumentsCard({ employee }: { employee: EmployeeRecord }) {
  const supabase = await createClient();
  const { data: documents } = await supabase
    .from("documents")
    .select("id, title, category, visibility, requires_acknowledgement, expires_on, created_at, current_version_id")
    .eq("employee_id", employee.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  const versionIds = (documents ?? []).map((d) => d.current_version_id).filter(Boolean) as string[];
  const [{ data: versions }, { data: acknowledgements }] = await Promise.all([
    versionIds.length
      ? supabase.from("document_versions").select("id, storage_bucket, storage_path, file_name").in("id", versionIds)
      : Promise.resolve({ data: [] as any[] }),
    versionIds.length
      ? supabase.from("document_acknowledgements").select("document_version_id, acknowledged_at").eq("employee_id", employee.id).in("document_version_id", versionIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const versionById = new Map((versions ?? []).map((v: any) => [v.id, v]));
  const ackByVersion = new Map((acknowledgements ?? []).map((a: any) => [a.document_version_id, a.acknowledged_at]));

  return (
    <>
      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Employee documents</h2>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Document</th><th className="pb-2">Category</th><th className="pb-2">Added</th><th className="pb-2">Acknowledgement</th><th className="pb-2" /></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {(documents ?? []).length === 0 && <tr><td colSpan={5} className="py-4 text-stone-400">No documents on {employee.first_name}&apos;s record yet.</td></tr>}
            {(documents ?? []).map((doc) => {
              const version = doc.current_version_id ? versionById.get(doc.current_version_id) : null;
              const acknowledged = doc.current_version_id ? ackByVersion.get(doc.current_version_id) : null;
              return (
                <tr key={doc.id}>
                  <td className="py-2"><span className="font-medium text-stone-900">{doc.title}</span>{doc.visibility === "hr_only" && <span className="badge badge-neutral ml-2">HR only</span>}{doc.expires_on && <span className="ml-2 text-xs text-stone-500">Expires {doc.expires_on}</span>}</td>
                  <td className="py-2">{CATEGORY_LABELS[doc.category] ?? doc.category}</td>
                  <td className="py-2">{String(doc.created_at).slice(0, 10)}</td>
                  <td className="py-2">{doc.requires_acknowledgement ? acknowledged ? <span className="badge badge-emerald">Acknowledged {String(acknowledged).slice(0, 10)}</span> : <span className="badge badge-gold">Pending</span> : "—"}</td>
                  <td className="py-2 text-right">{version && <DocumentDownloadButton bucket={version.storage_bucket} path={version.storage_path} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2 className="mb-1 text-sm font-semibold text-stone-900">Add a document</h2>
        <p className="mb-4 text-xs text-stone-500">Contracts, job descriptions, identification, certificates, HR letters and signed forms. Stored privately on {employee.first_name}&apos;s record.</p>
        <DocumentUploadForm organizationId={employee.organization_id} employees={[]} fixedEmployeeId={employee.id} />
      </section>
    </>
  );
}

export async function LearningAndAssetsCard({ employee, canManageTraining, canManageAssets }: { employee: EmployeeRecord; canManageTraining: boolean; canManageAssets: boolean }) {
  const supabase = await createClient();
  const orgId = employee.organization_id;
  const [
    { data: trainingCourses }, { data: employeeTraining }, { data: certifications },
    { data: orgAssets }, { data: assetAssignments }, { data: openAssetAssignments },
  ] = await Promise.all([
    supabase.from("training_courses").select("id, name, validity_months").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("employee_training").select("*, training_courses(name, description, is_required)").eq("employee_id", employee.id).order("created_at", { ascending: false }),
    supabase.from("certifications").select("*").eq("employee_id", employee.id).order("expires_on", { ascending: true }),
    supabase.from("assets").select("id, name, serial_number").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("employee_asset_assignments").select("*, assets(name, category, serial_number)").eq("employee_id", employee.id).is("returned_at", null).order("assigned_at", { ascending: false }),
    // Org-wide open assignments so the picker excludes assets someone else
    // already has (the partial unique index would reject it anyway).
    supabase.from("employee_asset_assignments").select("asset_id").eq("organization_id", orgId).is("returned_at", null),
  ]);
  const assignedOrgWide = new Set((openAssetAssignments ?? []).map((a) => a.asset_id));
  const availableAssets = (orgAssets ?? []).filter((a) => !assignedOrgWide.has(a.id));

  if (!canManageTraining && !canManageAssets) {
    return <section className="card"><p className="text-sm text-stone-500">Your role doesn&apos;t include training or asset management.</p></section>;
  }

  return (
    <>
      {canManageTraining && (
        <section className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Learning</h2>
          <ul className="mb-4 space-y-2 text-sm">
            {(employeeTraining ?? []).length === 0 && <li className="text-stone-400">No training assigned yet.</li>}
            {(employeeTraining ?? []).map((t: any) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-cream-100 px-3 py-2">
                <div>
                  <span className="font-medium text-stone-900">{t.training_courses?.name ?? "Training course"}</span>
                  {t.training_courses?.is_required && <span className="ml-2 text-xs text-stone-500">Required</span>}
                  {t.expires_on && <span className="ml-2 text-xs text-stone-500">Expires {t.expires_on}</span>}
                </div>
                <TrainingStatusSelect id={t.id} status={t.status} />
              </li>
            ))}
          </ul>
          <AssignTrainingForm organizationId={orgId} employeeId={employee.id} courses={trainingCourses ?? []} />

          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase text-stone-400">Certifications</h3>
          <ul className="mb-2 space-y-2 text-sm">
            {(certifications ?? []).length === 0 && <li className="text-stone-400">No certifications recorded.</li>}
            {(certifications ?? []).map((c) => (
              <li key={c.id} className="rounded-lg bg-cream-100 px-3 py-2">
                <span className="font-medium text-stone-900">{c.name}</span>
                <span className="ml-2 text-xs text-stone-500">
                  {c.issuing_body ?? "Issuing body not recorded"}
                  {c.issued_on ? ` · Issued ${c.issued_on}` : ""}
                  {c.expires_on ? ` · Expires ${c.expires_on}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <AddCertificationForm organizationId={orgId} employeeId={employee.id} />
        </section>
      )}

      {canManageAssets && (
        <section className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Assets</h2>
          <ul className="mb-4 space-y-2 text-sm">
            {(assetAssignments ?? []).length === 0 && <li className="text-stone-400">No equipment currently assigned.</li>}
            {(assetAssignments ?? []).map((a: any) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-cream-100 px-3 py-2">
                <div>
                  <span className="font-medium text-stone-900">{a.assets?.name ?? "Company asset"}</span>
                  <span className="ml-2 text-xs text-stone-500">
                    {a.assets?.category?.replace(/_/g, " ")}
                    {a.assets?.serial_number ? ` · ${a.assets.serial_number}` : ""} · Assigned {String(a.assigned_at).slice(0, 10)}
                  </span>
                </div>
                <ReturnAssetButton assignmentId={a.id} />
              </li>
            ))}
          </ul>
          <AssignAssetForm organizationId={orgId} employeeId={employee.id} availableAssets={availableAssets} />
        </section>
      )}
    </>
  );
}

export async function LeaveCard({ employee }: { employee: EmployeeRecord }) {
  const supabase = await createClient();
  const [{ data: leaveTypes }, { data: balances }] = await Promise.all([
    supabase.from("leave_types").select("id, name").eq("organization_id", employee.organization_id).eq("is_active", true).order("name"),
    supabase.from("leave_balance_v").select("balance, leave_type_name").eq("employee_id", employee.id),
  ]);
  return (
    <section className="card">
      <h2 className="mb-3 text-sm font-semibold text-stone-900">Leave balances</h2>
      <ul className="mb-4 flex flex-wrap gap-4 text-sm">
        {(balances ?? []).length === 0 && <li className="text-stone-400">No balances recorded yet.</li>}
        {(balances ?? []).map((b: any) => (
          <li key={b.leave_type_name} className="rounded-lg bg-cream-100 px-3 py-1.5">
            <span className="text-stone-600">{b.leave_type_name}:</span> <span className="font-semibold text-stone-900">{b.balance} days</span>
          </li>
        ))}
      </ul>
      <GrantLeaveBalanceForm organizationId={employee.organization_id} employeeId={employee.id} leaveTypes={leaveTypes ?? []} />
    </section>
  );
}

// Compensation access is its own grant (compensation.read_org), separate
// from employee.manage — see 20260829110000_compensation_pay_administration.sql.
export async function CompensationCard({ employee, canManage, timezone }: { employee: EmployeeRecord; canManage: boolean; timezone: string | undefined }) {
  const supabase = await createClient();
  const orgId = employee.organization_id;
  const [{ data: history }, { data: payGroups }, { data: payGrades }, { data: reasons }] = await Promise.all([
    supabase.from("employee_compensation").select("*").eq("employee_id", employee.id).order("start_date", { ascending: false }),
    supabase.from("pay_groups").select("id, name, pay_calendar_id").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("pay_grades").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("compensation_change_reasons").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
  ]);
  const today = todayIn(timezone);
  const current = (history ?? []).find((c) => c.start_date <= today && (!c.end_date || c.end_date >= today)) ?? null;
  const payGroup = (payGroups ?? []).find((g) => g.id === current?.pay_group_id) ?? null;
  const payGradeName = (payGrades ?? []).find((g) => g.id === current?.pay_grade_id)?.name ?? null;

  let nextPayDate: string | null = null;
  if (payGroup?.pay_calendar_id) {
    const { data: nextPeriod } = await supabase.from("pay_periods").select("pay_date").eq("pay_calendar_id", payGroup.pay_calendar_id).gte("pay_date", today).order("pay_date", { ascending: true }).limit(1).maybeSingle();
    nextPayDate = nextPeriod?.pay_date ?? null;
  }

  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Compensation</h2>
          <p className="text-xs text-stone-500">Gross rate only — Halomanage never calculates tax, deductions, or net pay.</p>
        </div>
        {canManage && <ChangeCompensationForm employeeId={employee.id} payGroups={(payGroups ?? []).map((g) => ({ id: g.id, name: g.name }))} payGrades={payGrades ?? []} reasons={reasons ?? []} />}
      </div>
      {current ? (
        <>
          {current.needs_review && (
            <p className="alert-error mb-3 text-xs">This record was carried over from an earlier schema version and its pay type/rate unit were inferred — please confirm or correct it with Change compensation.</p>
          )}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div><dt className="text-xs uppercase text-stone-400">Pay type</dt><dd>{current.pay_type === "other" ? current.pay_type_other_label : current.pay_type ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Rate</dt><dd>{current.currency} {Number(current.amount).toLocaleString()}{current.rate_unit ? ` / ${current.rate_unit}` : ""}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Pay frequency</dt><dd>{current.pay_frequency ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Pay group</dt><dd>{payGroup?.name ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Next pay date</dt><dd>{nextPayDate ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Pay grade</dt><dd>{payGradeName ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Standard weekly hours</dt><dd>{current.standard_weekly_hours ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">FTE</dt><dd>{current.fte ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Overtime eligible</dt><dd>{current.overtime_eligible === null ? "—" : current.overtime_eligible ? "Yes" : "No"}</dd></div>
            <div><dt className="text-xs uppercase text-stone-400">Effective since</dt><dd>{current.start_date}</dd></div>
          </dl>
        </>
      ) : (
        <p className="text-sm text-stone-400">No compensation on record yet.</p>
      )}
      {(history ?? []).some((c) => c.end_date !== null) && (
        <>
          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase text-stone-400">History</h3>
          <ul className="space-y-1 text-xs text-stone-500">
            {(history ?? []).filter((c) => c.end_date !== null).map((c) => (
              <li key={c.id}>{c.start_date} → {c.end_date}: {c.currency} {Number(c.amount).toLocaleString()} ({c.pay_type ?? "unspecified"})</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function describeDetails(action: string, details: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof details.employee_number === "string") parts.push(String(details.employee_number));
  if (typeof details.identifier_type === "string") parts.push(String(details.identifier_type).toUpperCase().replace("_", " ") + (details.value ? ` ${details.value}` : ""));
  if (Array.isArray(details.fields)) parts.push(`Fields: ${(details.fields as string[]).map((f) => f.replace(/_/g, " ")).join(", ")}`);
  if (typeof details.role === "string") parts.push(`Role: ${details.role}`);
  if (typeof details.title === "string") parts.push(String(details.title));
  if (typeof details.reason === "string") parts.push(`Reason: ${details.reason}`);
  if (typeof details.change_reason === "string") parts.push(String(details.change_reason));
  if (action === "EMPLOYEE_INVITED" && typeof details.work_email === "string") parts.push(String(details.work_email));
  return parts.length ? parts.join(" · ") : null;
}

export async function HistoryCard({ employeeId }: { employeeId: string }) {
  const supabase = await createClient();
  const { data: events, error } = await supabase.rpc("list_employee_history", { p_employee_id: employeeId });
  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-stone-900">HR timeline</h2>
      <p className="mb-4 text-xs text-stone-500">Every recorded change to this person&apos;s HR record, newest first. Protected values (like full TRNs) are never shown here — only that they changed.</p>
      {error && <p className="alert-error">Could not load history: {error.message}</p>}
      <ol className="hr-timeline">
        {(events ?? []).length === 0 && !error && <li className="text-sm text-stone-400">No history recorded yet.</li>}
        {(events ?? []).map((event: any) => {
          const detail = describeDetails(event.action, event.details ?? {});
          return (
            <li key={event.id}>
              <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
              <div>
                <strong>{historyLabel(event.action)}</strong>
                {detail && <p>{detail}</p>}
                <small>by {event.actor_name}</small>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
