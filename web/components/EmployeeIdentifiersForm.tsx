"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { IDENTIFIER_TYPES, identifierTypeLabel, maskIdentifier } from "@/lib/employeeSetup";
import { formatDate } from "@/lib/timezone";

export type EmployeeIdentifier = {
  id: string;
  identifier_type: string;
  label: string | null;
  identifier_value: string;
  country_code: string | null;
  issued_on: string | null;
  expires_on: string | null;
  verified_at: string | null;
};

const blank = { identifier_type: "trn", label: "", identifier_value: "", country_code: "JM", issued_on: "", expires_on: "" };

// HR-only editor for employee_identifiers (TRN, NIS, passport…). Values are
// masked until HR chooses to reveal one; the audit trail only ever records
// the masked form (see private.employee_identifiers_audit()).
export function EmployeeIdentifiersForm({
  organizationId,
  employeeId,
  identifiers,
  timezone,
}: {
  organizationId: string;
  employeeId: string;
  identifiers: EmployeeIdentifier[];
  timezone: string | undefined;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(identifier: EmployeeIdentifier) {
    setEditingId(identifier.id);
    setForm({
      identifier_type: identifier.identifier_type,
      label: identifier.label ?? "",
      identifier_value: identifier.identifier_value,
      country_code: identifier.country_code ?? "",
      issued_on: identifier.issued_on ?? "",
      expires_on: identifier.expires_on ?? "",
    });
  }

  function reset() {
    setEditingId(null);
    setForm(blank);
  }

  function friendly(message: string, code?: string) {
    if (code === "23505") return "That number is already on file — for this employee or someone else in your organization.";
    return message;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const values = {
      identifier_type: form.identifier_type,
      label: form.identifier_type === "other" ? form.label.trim() || null : null,
      identifier_value: form.identifier_value.trim(),
      country_code: form.country_code.trim().toUpperCase() || null,
      issued_on: form.issued_on || null,
      expires_on: form.expires_on || null,
    };
    const { error: saveError } = editingId
      ? await supabase.from("employee_identifiers").update(values).eq("id", editingId)
      : await supabase.from("employee_identifiers").insert({ ...values, organization_id: organizationId, employee_id: employeeId });
    if (saveError) {
      setError(friendly(saveError.message, saveError.code));
      setLoading(false);
      return;
    }
    reset();
    setLoading(false);
    router.refresh();
  }

  async function setVerified(identifier: EmployeeIdentifier, verified: boolean) {
    setBusyId(identifier.id);
    setError(null);
    const { error: verifyError } = await supabase
      .from("employee_identifiers")
      .update({ verified_at: verified ? new Date().toISOString() : null })
      .eq("id", identifier.id);
    if (verifyError) setError(verifyError.message);
    setBusyId(null);
    router.refresh();
  }

  async function remove(identifier: EmployeeIdentifier) {
    if (!window.confirm(`Remove this ${identifierTypeLabel(identifier.identifier_type, identifier.label)}?`)) return;
    setBusyId(identifier.id);
    setError(null);
    const { error: deleteError } = await supabase.from("employee_identifiers").delete().eq("id", identifier.id);
    if (deleteError) setError(deleteError.message);
    setBusyId(null);
    router.refresh();
  }

  function toggleReveal(id: string) {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-stone-100" id="trn">
        {identifiers.length === 0 && <li className="py-2 text-sm text-stone-400">No government or compliance IDs recorded yet.</li>}
        {identifiers.map((identifier) => (
          <li key={identifier.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
            <div>
              <p className="font-medium text-stone-900">{identifierTypeLabel(identifier.identifier_type, identifier.label)}</p>
              <p className="font-mono text-xs text-stone-600">
                {revealed.has(identifier.id) ? identifier.identifier_value : maskIdentifier(identifier.identifier_value)}
                <button type="button" className="ml-2 text-royal-700 hover:underline" onClick={() => toggleReveal(identifier.id)}>
                  {revealed.has(identifier.id) ? "Hide" : "Show"}
                </button>
              </p>
              <p className="text-xs text-stone-400">
                {identifier.country_code ?? ""}
                {identifier.issued_on ? ` · Issued ${identifier.issued_on}` : ""}
                {identifier.expires_on ? ` · Expires ${identifier.expires_on}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {identifier.verified_at
                ? <span className="badge badge-emerald">Verified {formatDate(identifier.verified_at, timezone, { dateStyle: "medium" })}</span>
                : <span className="badge badge-gold">Not verified</span>}
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === identifier.id} onClick={() => setVerified(identifier, !identifier.verified_at)}>
                {identifier.verified_at ? "Unverify" : "Mark verified"}
              </button>
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => startEdit(identifier)}>Edit</button>
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === identifier.id} onClick={() => remove(identifier)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={handleSubmit} className="rounded-xl border border-stone-100 p-3">
        <h4 className="mb-2 text-xs font-semibold uppercase text-stone-400">{editingId ? "Edit identifier" : "Add identifier"}</h4>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="identifier-type">Type</label>
            <select id="identifier-type" className="input" value={form.identifier_type} onChange={(e) => setForm({ ...form, identifier_type: e.target.value })}>
              {IDENTIFIER_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </div>
          {form.identifier_type === "other" && (
            <div>
              <label className="label" htmlFor="identifier-label">Name of identifier</label>
              <input id="identifier-label" required className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </div>
          )}
          <div>
            <label className="label" htmlFor="identifier-value">Number</label>
            <input id="identifier-value" required className="input font-mono" autoComplete="off" value={form.identifier_value} onChange={(e) => setForm({ ...form, identifier_value: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="identifier-country">Issuing country</label>
            <input id="identifier-country" className="input" maxLength={2} value={form.country_code} onChange={(e) => setForm({ ...form, country_code: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="identifier-issued">Issued on</label>
            <input id="identifier-issued" type="date" className="input" value={form.issued_on} onChange={(e) => setForm({ ...form, issued_on: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="identifier-expires">Expires on</label>
            <input id="identifier-expires" type="date" className="input" value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
          </div>
        </div>
        {error && <p role="alert" className="alert-error mt-3">{error}</p>}
        <div className="mt-3 flex gap-2">
          <button type="submit" disabled={loading || !form.identifier_value.trim()} className="btn-primary">{loading ? "Saving…" : editingId ? "Save changes" : "Add identifier"}</button>
          {editingId && <button type="button" className="btn-secondary" onClick={reset}>Cancel</button>}
        </div>
      </form>
    </div>
  );
}
