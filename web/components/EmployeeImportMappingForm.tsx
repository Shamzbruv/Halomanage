"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

const fields = [
  ["", "Ignore this column"],
  ["employee_number", "Employee number *"],
  ["first_name", "First name *"],
  ["last_name", "Last name *"],
  ["preferred_name", "Preferred name"],
  ["work_email", "Work email"],
  ["work_phone", "Work phone"],
  ["status", "Employment status"],
  ["hire_date", "Hire date"],
  ["probation_end_date", "Probation end date"],
  ["external_payroll_id", "External payroll ID"],
] as const;

export function EmployeeImportMappingForm({
  batchId,
  headers,
  initialMapping,
  initialDuplicateStrategy,
}: {
  batchId: string;
  headers: string[];
  initialMapping: Record<string, string>;
  initialDuplicateStrategy: string;
}) {
  const router = useRouter();
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(headers.map((header) => [header, initialMapping[header] ?? ""])));
  const [duplicateStrategy, setDuplicateStrategy] = useState(initialDuplicateStrategy);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mappedRequired = useMemo(() => new Set(Object.values(mapping).filter(Boolean)), [mapping]);
  const missing = ["employee_number", "first_name", "last_name"].filter((field) => !mappedRequired.has(field));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const cleanMapping = Object.fromEntries(Object.entries(mapping).filter(([, target]) => target));
    const supabase = createClient();

    const { error: mappingError } = await supabase.rpc("update_employee_import_mapping", {
      p_batch_id: batchId,
      p_column_mapping: cleanMapping,
      p_duplicate_strategy: duplicateStrategy,
    });
    if (mappingError) {
      setError(mappingError.message);
      setLoading(false);
      return;
    }

    const { error: processError } = await supabase.functions.invoke("employee-import", { body: { batch_id: batchId } });
    if (processError) {
      setError(processError.message);
      setLoading(false);
      return;
    }

    setMessage("Mapping saved and every row was revalidated.");
    setLoading(false);
    router.refresh();
  }

  return (
    <form className="card migration-mapping-card" onSubmit={handleSubmit}>
      <div className="panel-heading">
        <div><span className="panel-icon"><Icon name="settings" /></span><div><h3>Column mapping</h3><p>Confirm what each source column means before importing.</p></div></div>
      </div>
      <div className="mapping-grid">
        {headers.map((header) => (
          <label key={header}>
            <span title={header}>{header}</span>
            <Icon name="arrow-right" size={15} />
            <select className="input" value={mapping[header] ?? ""} onChange={(event) => setMapping((current) => ({ ...current, [header]: event.target.value }))}>
              {fields.map(([value, label]) => <option key={value || "ignore"} value={value}>{label}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="mapping-footer">
        <label><span className="label">When an employee already exists</span><select className="input" value={duplicateStrategy} onChange={(event) => setDuplicateStrategy(event.target.value)}><option value="update">Update their employee record</option><option value="skip">Skip and preserve their record</option></select></label>
        <button className="btn-primary" disabled={loading || missing.length > 0} type="submit">{loading ? "Revalidating…" : "Save mapping & revalidate"}</button>
      </div>
      {missing.length > 0 && <p className="alert-warning">Map Employee number, First name, and Last name to continue.</p>}
      {error && <p className="alert-error" role="alert">{error}</p>}
      {message && <p className="portal-card-status" role="status"><Icon name="check" size={15} /> {message}</p>}
    </form>
  );
}
