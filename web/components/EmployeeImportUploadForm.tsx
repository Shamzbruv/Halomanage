"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

async function sha256Hex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function downloadTemplate() {
  const csv = [
    "Employee Number,First Name,Last Name,Preferred Name,Work Email,Work Phone,Status,Hire Date,Probation End Date,External Payroll ID",
    "EMP-0002,Jordan,Brown,Jordan,jordan@example.com,+1 876 555 0100,active,2026-09-01,2026-12-01,PAY-0002",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "halomanage-employee-import-template.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function EmployeeImportUploadForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [sourceSystem, setSourceSystem] = useState("spreadsheet");
  const [duplicateStrategy, setDuplicateStrategy] = useState("update");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdBatchId, setCreatedBatchId] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setCreatedBatchId(null);
    const supabase = createClient();
    let path: string | null = null;

    try {
      setStage("Checking and securely uploading your workbook…");
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      path = `${organizationId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;

      const { error: uploadError } = await supabase.storage
        .from("employee-imports")
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (uploadError) throw new Error(uploadError.message);

      setStage("Creating an auditable import batch…");
      const { data: batchData, error: batchError } = await supabase.rpc("create_employee_import_batch", {
        p_organization_id: organizationId,
        p_source_system: sourceSystem,
        p_original_file_name: file.name,
        p_original_file_path: path,
        p_file_hash: hash,
        p_duplicate_strategy: duplicateStrategy,
        p_column_mapping: {},
      });
      if (batchError || !batchData) {
        await supabase.storage.from("employee-imports").remove([path]);
        throw new Error(batchError?.message ?? "The import batch could not be created");
      }

      const batch = Array.isArray(batchData) ? batchData[0] : batchData;
      const batchId = String(batch.id);
      setCreatedBatchId(batchId);
      setStage("Detecting columns and validating every row…");
      const { error: processError } = await supabase.functions.invoke("employee-import", {
        body: { batch_id: batchId },
      });
      if (processError) throw new Error(`The file was uploaded, but validation needs attention: ${await resolveFunctionErrorMessage(processError)}`);

      router.push(`/admin/migrations/${batchId}`);
      router.refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The workbook could not be processed");
      setLoading(false);
      setStage(null);
    }
  }

  return (
    <section className="card migration-upload-card">
      <div className="panel-heading">
        <div>
          <span className="panel-icon"><Icon name="people" /></span>
          <div><h3>Start a people import</h3><p>Nothing changes until you review and commit the validated batch.</p></div>
        </div>
      </div>

      <form className="migration-upload-form" onSubmit={handleSubmit}>
        <div className="migration-form-grid">
          <div>
            <label className="label" htmlFor="migration-source">Source</label>
            <select id="migration-source" className="input" value={sourceSystem} onChange={(event) => setSourceSystem(event.target.value)}>
              <option value="spreadsheet">Spreadsheet / CSV</option>
              <option value="orangehrm">OrangeHRM export</option>
              <option value="bamboohr">BambooHR export</option>
              <option value="zoho_people">Zoho People export</option>
              <option value="other">Another HR system</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="migration-duplicates">Existing employee match</label>
            <select id="migration-duplicates" className="input" value={duplicateStrategy} onChange={(event) => setDuplicateStrategy(event.target.value)}>
              <option value="update">Update the existing employee</option>
              <option value="skip">Keep existing employee unchanged</option>
            </select>
          </div>
        </div>

        <label className="migration-dropzone" htmlFor="migration-file">
          <span className="metric-icon mint"><Icon name="document" /></span>
          <span><strong>{file ? file.name : "Choose a CSV or Excel workbook"}</strong><small>{file ? `${(file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB selected` : "Up to 10,000 employee rows and 50 MB"}</small></span>
          <em>{file ? "Change file" : "Browse"}</em>
          <input id="migration-file" type="file" required accept=".csv,.xls,.xlsx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>

        <div className="migration-upload-actions">
          <button className="btn-primary" type="submit" disabled={loading || !file}>{loading ? "Preparing preview…" : <>Upload & validate <Icon name="arrow-right" size={16} /></>}</button>
          <button className="btn-secondary" type="button" onClick={downloadTemplate}>Download template</button>
        </div>
        {stage && <p className="migration-progress" role="status"><span className="setup-spinner small" /> {stage}</p>}
        {error && <p className="alert-error" role="alert">{error}{createdBatchId && <> <Link href={`/admin/migrations/${createdBatchId}`}>Open the saved batch</Link>.</>}</p>}
      </form>
    </section>
  );
}
