"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
export function PayrollMatch({
  rowId,
  employees,
  compensation,
  organizationId,
}: {
  rowId: string;
  employees: { id: string; name: string }[];
  compensation: boolean;
  organizationId: string;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState(employees),
    [search, setSearch] = useState("");
  async function find() {
    setBusy(true);
    const { data, error } = await createClient().rpc("list_payroll_employees", {
      p_organization_id: organizationId,
      p_search: search,
    });
    setBusy(false);
    if (error) setError(error.message);
    else
      setOptions(
        (data ?? []).map(
          (e: {
            id: string;
            employee_number: string;
            first_name: string;
            last_name: string;
          }) => ({
            id: e.id,
            name: `${e.employee_number} — ${e.first_name} ${e.last_name}`,
          }),
        ),
      );
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (
      !confirm(
        "Confirm this source row belongs to the selected employee. This will be recorded in the audit trail.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("reconcile_payroll_row", {
      p_row_id: rowId,
      p_employee_id: String(f.get("employee")),
      p_note: String(f.get("note")),
      p_compensation: compensation,
    });
    setBusy(false);
    if (error) setError(error.message);
    else router.refresh();
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <label>
        Find employee by number or name
        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        className="btn-secondary"
        onClick={find}
      >
        Search employees
      </button>
      <label>
        Match employee
        <select className="input" required name="employee">
          <option value="">Select employee</option>
          {options.map((e) => (
            <option value={e.id} key={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason
        <input
          className="input"
          name="note"
          required
          minLength={10}
          maxLength={1000}
        />
      </label>
      <button className="btn-secondary" disabled={busy}>
        Confirm match
      </button>
      {error && (
        <p className="alert-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
export function PayrollBatchActions({
  batchId,
  status,
}: {
  batchId: string;
  status: string;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function run(
    action: "recompute" | "process" | "reject",
    reason?: string,
  ) {
    setBusy(true);
    setError(null);
    const db = createClient();
    let error;
    if (action === "process") {
      const result = await db.functions.invoke("payroll-import", {
        body: { batch_id: batchId },
      });
      error = result.error
        ? { message: await resolveFunctionErrorMessage(result.error) }
        : null;
    } else {
      const result = await db.rpc(
        action === "reject"
          ? "reject_payroll_import"
          : "recompute_payroll_batch_status",
        action === "reject"
          ? { p_batch_id: batchId, p_reason: reason }
          : { p_batch_id: batchId },
      );
      error = result.error;
    }
    setBusy(false);
    if (error) setError(error.message);
    router.refresh();
  }
  if (["approved", "superseded", "rejected"].includes(status)) return null;
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        {status === "uploaded" && (
          <button
            disabled={busy}
            className="btn-secondary"
            onClick={() => run("process")}
          >
            Process uploaded file
          </button>
        )}
        <button
          disabled={busy}
          className="btn-secondary"
          onClick={() => run("recompute")}
        >
          Revalidate rows
        </button>
      </div>
      <form
        className="flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const reason = String(new FormData(e.currentTarget).get("reason"));
          if (confirm("Reject this batch? Its rows will not be published."))
            run("reject", reason);
        }}
      >
        <label>
          Rejection reason
          <input
            className="input"
            required
            minLength={5}
            maxLength={2000}
            name="reason"
          />
        </label>
        <button disabled={busy} className="btn-secondary">
          Reject batch
        </button>
      </form>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
    </div>
  );
}
