"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RewardDialog } from "./RewardDialog";
type EmployeeOption = { id: string; label: string; balance: number };
export function AwardPointsForm({
  organizationId,
}: {
  organizationId: string;
}) {
  const router = useRouter(),
    retry = useRef<{ payload: string; key: string } | null>(null),
    submitting = useRef(false);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [employees, setEmployees] = useState<EmployeeOption[]>([]),
    [employeeId, setEmployeeId] = useState(""),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [searched, setSearched] = useState(false);
  async function search() {
    setBusy(true);
    setError(null);
    try {
      const { data, error } = await createClient().rpc(
        "search_reward_employees",
        { p_organization_id: organizationId, p_query: query },
      );
      if (error) throw error;
      setEmployees(data ?? []);
      setEmployeeId("");
      setSearched(true);
    } catch (error) {
      setError((error as { message?: string }).message ?? "Search failed.");
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const payload = JSON.stringify([employeeId, Number(amount), reason.trim()]);
    if (retry.current?.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    try {
      const { error } = await createClient().rpc("grant_reward_points", {
        p_employee_id: employeeId,
        p_amount: Number(amount),
        p_reason: reason.trim(),
        p_client_request_id: retry.current.key,
      });
      if (error) throw error;
      retry.current = null;
      setOpen(false);
      setAmount("");
      setReason("");
      setEmployeeId("");
      router.refresh();
    } catch (error) {
      setError(
        (error as { message?: string }).message ??
          "Award failed. You can retry safely.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn-primary"
        onClick={() => setOpen(true)}
      >
        Award points
      </button>
      <RewardDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Award employee points"
        busy={busy}
      >
        <form onSubmit={submit} className="space-y-3">
          <p>
            Use a consistent, work-related reason. Another authorized colleague
            must approve awards to you.
          </p>
          <label className="label">
            Find employee by name or employee number
            <input
              className="input"
              minLength={2}
              maxLength={120}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || query.trim().length < 2}
            onClick={() => void search()}
          >
            Search employees
          </button>
          <label className="label">
            Employee
            <select
              className="input"
              required
              value={employeeId}
              disabled={busy}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">Select an employee</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} · balance {Number(e.balance).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {searched && !employees.length && (
            <p role="status">
              No eligible employees found. Search uses active staff and staff on
              leave.
            </p>
          )}
          <label className="label">
            Points
            <input
              required
              type="number"
              min={1}
              max={1000000}
              step={1}
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="label">
            Reason (visible to the employee)
            <textarea
              required
              minLength={3}
              maxLength={1000}
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </label>
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          <button className="btn-primary" disabled={busy || !employeeId}>
            {busy ? "Saving…" : "Confirm award"}
          </button>
        </form>
      </RewardDialog>
    </>
  );
}
