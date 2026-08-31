import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmployeeImportActions } from "@/components/EmployeeImportActions";
import { EmployeeImportMappingForm } from "@/components/EmployeeImportMappingForm";
import { Icon } from "@/components/Icon";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { statusBadgeClass } from "@/lib/ui";

type ImportRow = {
  id: string;
  row_number: number;
  normalized_row: Record<string, unknown>;
  matched_employee_id: string | null;
  operation: string;
  validation_status: string;
  validation_errors: unknown;
  commit_status: string;
  committed_employee_id: string | null;
};

function value(row: ImportRow, key: string) {
  const current = row.normalized_row?.[key];
  return current === null || current === undefined || current === "" ? "—" : String(current);
}

function errors(row: ImportRow) {
  return Array.isArray(row.validation_errors) ? row.validation_errors.map(String) : [];
}

export default async function MigrationBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage") || !session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const [{ data: batch }, { data: rows }, { data: employees }] = await Promise.all([
    supabase.from("employee_import_batches").select("*").eq("id", id).eq("organization_id", session.organizationId).maybeSingle(),
    supabase.from("employee_import_rows").select("*").eq("batch_id", id).order("row_number").limit(250),
    supabase.from("employees").select("id, employee_number, first_name, last_name").eq("organization_id", session.organizationId),
  ]);
  if (!batch) notFound();

  const employeeById = new Map((employees ?? []).map((employee) => [employee.id, employee]));
  const headers = Array.isArray(batch.source_headers) ? batch.source_headers.map(String) : [];
  const mapping = batch.column_mapping && typeof batch.column_mapping === "object" && !Array.isArray(batch.column_mapping)
    ? batch.column_mapping as Record<string, string>
    : {};

  return (
    <div className="space-y-6 migration-batch-page">
      <div className="migration-batch-head">
        <div>
          <Link className="table-action" href="/admin/migrations">← Migration Center</Link>
          <span className="eyebrow">Employee import dry-run</span>
          <h1>{batch.original_file_name}</h1>
          <p>{batch.source_system.replace(/_/g, " ")} export uploaded {new Date(batch.uploaded_at).toLocaleString()}.</p>
        </div>
        <span className={`badge ${statusBadgeClass(batch.status)}`}>{batch.status.replace(/_/g, " ")}</span>
      </div>

      <section className="migration-batch-metrics" aria-label="Batch result">
        <div><small>Total rows</small><strong>{batch.total_rows}</strong></div>
        <div className="good"><small>New employees</small><strong>{batch.create_rows}</strong></div>
        <div><small>Existing updates</small><strong>{batch.update_rows}</strong></div>
        <div><small>Skipped</small><strong>{batch.skip_rows}</strong></div>
        <div className={batch.error_rows ? "bad" : "good"}><small>Errors</small><strong>{batch.error_rows}</strong></div>
      </section>

      {batch.error_message && <p className="alert-error" role="alert">{batch.error_message}</p>}
      <EmployeeImportActions batchId={batch.id} status={batch.status} />

      {headers.length > 0 && !["committed", "rolled_back"].includes(batch.status) && (
        <EmployeeImportMappingForm batchId={batch.id} headers={headers} initialMapping={mapping} initialDuplicateStrategy={batch.duplicate_strategy} />
      )}

      <section className="card migration-preview-card">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="people" /></span><div><h3>Row-by-row preview</h3><p>Review exactly who will be created, updated, or skipped. Up to 250 rows are shown here.</p></div></div></div>
        {(rows ?? []).length === 0 ? (
          <div className="context-empty"><span><Icon name="help" /></span><div><strong>No staged rows</strong><p>Process the workbook again or check that its first worksheet contains a header row and employee data.</p></div></div>
        ) : (
          <div className="migration-table-wrap">
            <table className="migration-preview-table">
              <thead><tr><th>Row</th><th>Employee</th><th>Employee #</th><th>Email</th><th>Status</th><th>Outcome</th><th>Validation</th></tr></thead>
              <tbody>
                {(rows as ImportRow[]).map((row) => {
                  const matched = row.matched_employee_id ? employeeById.get(row.matched_employee_id) : null;
                  const rowErrors = errors(row);
                  return (
                    <tr key={row.id} className={row.validation_status === "error" ? "has-error" : ""}>
                      <td><span className="row-number">{row.row_number}</span></td>
                      <td><strong>{value(row, "first_name")} {value(row, "last_name")}</strong>{matched && <small>Matches {matched.first_name} {matched.last_name}</small>}</td>
                      <td><code>{value(row, "employee_number")}</code></td>
                      <td>{value(row, "work_email")}</td>
                      <td>{value(row, "status")}</td>
                      <td><span className={`badge ${row.operation === "create" ? "badge-emerald" : row.operation === "skip" ? "badge-neutral" : "badge-gold"}`}>{row.operation}</span></td>
                      <td>{rowErrors.length > 0 ? <ul className="row-errors">{rowErrors.map((message) => <li key={message}>{message}</li>)}</ul> : <span className="row-valid"><Icon name="check" size={14} /> Ready</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
