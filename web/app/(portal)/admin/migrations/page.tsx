import Link from "next/link";
import { redirect } from "next/navigation";
import { EmployeeImportUploadForm } from "@/components/EmployeeImportUploadForm";
import { Icon } from "@/components/Icon";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { statusBadgeClass } from "@/lib/ui";

export default async function MigrationCenterPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage") || !session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const { data: batches, error } = await supabase
    .from("employee_import_batches")
    .select("*")
    .eq("organization_id", session.organizationId)
    .order("uploaded_at", { ascending: false })
    .limit(25);

  if (error) console.error("migration center: failed to load batches", { code: error.code });

  const committed = (batches ?? []).filter((batch) => batch.status === "committed");
  const importedPeople = committed.reduce((sum, batch) => sum + Number(batch.create_rows || 0), 0);
  const needsAttention = (batches ?? []).filter((batch) => ["needs_mapping", "needs_review", "failed"].includes(batch.status)).length;

  return (
    <div className="space-y-6 migration-center">
      <div className="admin-page-head">
        <div className="page-intro">
          <span className="eyebrow">Migration Center</span>
          <h1>Bring your people over without the spreadsheet anxiety.</h1>
          <p>Upload an export, confirm the field mapping, review every validation issue, then commit one auditable batch when it is clean.</p>
        </div>
        <button className="migration-trust-pill" type="button" disabled><Icon name="shield" size={16} /> Dry-run before every import</button>
      </div>

      <section className="dashboard-metrics" aria-label="Migration summary">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="people" /></span><div><small>People created</small><strong>{importedPeople}</strong><em>through committed imports</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="document" /></span><div><small>Import batches</small><strong>{(batches ?? []).length}</strong><em>{committed.length} committed</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="help" /></span><div><small>Needs attention</small><strong>{needsAttention}</strong><em>{needsAttention ? "open a batch to resolve" : "all imports are clear"}</em></div></div>
      </section>

      <div className="migration-layout">
        <EmployeeImportUploadForm organizationId={session.organizationId} />
        <aside className="card migration-how-it-works">
          <span className="eyebrow">Guardrails included</span>
          <h3>What happens before a record changes</h3>
          <ol>
            <li><span>1</span><div><strong>Detect</strong><small>Read the first worksheet and suggest source mappings.</small></div></li>
            <li><span>2</span><div><strong>Validate</strong><small>Check required identifiers, dates, email, duplicates, and existing matches.</small></div></li>
            <li><span>3</span><div><strong>Preview</strong><small>Show creates, updates, skips, and row-level errors before posting.</small></div></li>
            <li><span>4</span><div><strong>Commit</strong><small>Write the clean batch in one transaction with an audit event.</small></div></li>
          </ol>
        </aside>
      </div>

      <section className="card migration-history">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="reports" /></span><div><h3>Import history</h3><p>Every workbook, decision, and outcome stays traceable.</p></div></div></div>
        {(batches ?? []).length === 0 ? (
          <div className="context-empty"><span><Icon name="document" /></span><div><strong>No employee imports yet</strong><p>Use the upload area above or download the Halomanage template to prepare your first batch.</p></div></div>
        ) : (
          <div className="migration-history-list">
            {(batches ?? []).map((batch) => (
              <Link href={`/admin/migrations/${batch.id}`} key={batch.id}>
                <span className={`metric-icon ${batch.status === "committed" ? "mint" : batch.error_rows ? "coral" : "sun"}`}><Icon name="document" size={17} /></span>
                <span><strong>{batch.original_file_name}</strong><small>{batch.source_system.replace(/_/g, " ")} · {new Date(batch.uploaded_at).toLocaleString()} · {batch.total_rows} row{batch.total_rows === 1 ? "" : "s"}</small></span>
                <span className="migration-row-summary"><small>{batch.create_rows} create · {batch.update_rows} update · {batch.error_rows} error</small><span className={`badge ${statusBadgeClass(batch.status)}`}>{batch.status.replace(/_/g, " ")}</span></span>
                <Icon name="arrow-right" size={16} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
