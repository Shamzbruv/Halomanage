"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Ref: PRODUCT_BLUEPRINT.md "The upload process should not instantly change
// records" — Upload → Validate → Map → Preview → Approve → Post → Audit.
// This form only performs the first step (upload + stage); nothing here
// touches an employee's visible pay record. The payroll-import Edge
// Function does the parsing (supabase/functions/payroll-import), and a
// human still has to call approve_payroll_import() afterwards.
async function sha256Hex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function PayrollUploadForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [batchType, setBatchType] = useState<"pay_run_results" | "compensation_change">("pay_run_results");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [payDate, setPayDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setStatus("Uploading file…");

    const path = `${organizationId}/${crypto.randomUUID()}-${file.name}`;
    const buffer = await file.arrayBuffer();
    const hash = await sha256Hex(buffer);

    const { error: uploadError } = await supabase.storage
      .from("payroll-imports")
      .upload(path, file, { contentType: file.type || "application/octet-stream" });

    if (uploadError) {
      setError(uploadError.message);
      setLoading(false);
      return;
    }

    setStatus("Creating import batch…");
    const { data: batch, error: batchError } = await supabase.rpc("create_payroll_import_batch", {
      p_organization_id: organizationId,
      p_batch_type: batchType,
      p_original_file_name: file.name,
      p_original_file_path: path,
      p_file_hash: hash,
      p_pay_period_start: periodStart || null,
      p_pay_period_end: periodEnd || null,
      p_pay_date: payDate || null,
      p_currency: "USD",
      p_column_map_id: null,
      p_supersedes_batch_id: null,
    });

    if (batchError || !batch) {
      setError(batchError?.message ?? "Failed to create batch");
      setLoading(false);
      return;
    }

    setStatus("Parsing and matching rows…");
    const { error: fnError } = await supabase.functions.invoke("payroll-import", {
      body: { batch_id: (batch as any).id },
    });

    if (fnError) {
      setError(`Uploaded, but processing failed: ${fnError.message}`);
      setLoading(false);
      return;
    }

    setStatus(null);
    setFile(null);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">Import payroll results</h3>

      <div>
        <label className="label">Import type</label>
        <select className="input" value={batchType} onChange={(e) => setBatchType(e.target.value as any)}>
          <option value="pay_run_results">Pay run results (informational)</option>
          <option value="compensation_change">Compensation change (updates ongoing salary)</option>
        </select>
      </div>

      {batchType === "pay_run_results" && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="label">Period start</label>
            <input type="date" className="input" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div>
            <label className="label">Period end</label>
            <input type="date" className="input" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
          <div>
            <label className="label">Pay date</label>
            <input type="date" className="input" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </div>
        </div>
      )}

      <div>
        <label className="label">File (.csv or .xlsx)</label>
        <input
          type="file"
          required
          accept=".csv,.xlsx,.xls"
          className="input"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {status && <p className="text-xs text-slate-500">{status}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <button type="submit" disabled={loading || !file} className="btn-primary">
        {loading ? "Working…" : "Upload & stage"}
      </button>
    </form>
  );
}
