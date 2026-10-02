"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { CORRECTABLE_FIELDS, REQUEST_STATUS_LABELS, type CorrectableField, type RecordRequest } from "@/lib/recordRequests";
import { formatDate } from "@/lib/timezone";

// "Request a correction" — submit_employee_record_request(). HR is notified,
// decides, and (for names and date of birth) the record is corrected
// automatically on approval; every step is audited.
export function RequestCorrectionButton({
  defaultField,
  label = "Request a correction",
  compact = false,
}: {
  defaultField?: CorrectableField;
  label?: string;
  compact?: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<CorrectableField>(defaultField ?? "other");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("submit_employee_record_request", {
      p_kind: "correction",
      p_field_key: field,
      p_requested_value: value,
      p_reason: reason || null,
    });
    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }
    setLoading(false);
    setDone(true);
    setValue("");
    setReason("");
    router.refresh();
  }

  function close() {
    setOpen(false);
    setDone(false);
    setError(null);
  }

  return (
    <>
      <button type="button" className={compact ? "text-xs font-medium text-royal-700 hover:underline" : "btn-secondary"} onClick={() => setOpen(true)}>
        {!compact && <Icon name="edit" size={15} />} {label}
      </button>
      {open && (
        <div className="modal-layer" role="presentation">
          <button className="modal-backdrop" aria-label="Close dialog" onClick={close} />
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="correction-title">
            <div className="modal-head">
              <div><span className="eyebrow">Your record</span><h3 id="correction-title">Request a correction</h3><p>Tell HR what&apos;s wrong and what it should be. You&apos;ll be notified when they respond, and the change is recorded on your file.</p></div>
              <button type="button" className="icon-button" aria-label="Close dialog" onClick={close}><Icon name="x" size={18} /></button>
            </div>
            {done ? (
              <div className="space-y-4">
                <p className="portal-card-status" role="status"><Icon name="check" size={15} /> Sent to HR. You can follow it under &quot;My requests&quot;.</p>
                <div className="modal-actions"><button type="button" className="btn-primary" onClick={close}>Done</button></div>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="label" htmlFor="correction-field">What needs correcting?</label>
                  <select id="correction-field" className="input" value={field} onChange={(e) => setField(e.target.value as CorrectableField)}>
                    {CORRECTABLE_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="correction-value">{field === "other" ? "Describe what's wrong and what it should be" : "What it should be"}</label>
                  {field === "date_of_birth" ? (
                    <input id="correction-value" type="date" required className="input" value={value} onChange={(e) => setValue(e.target.value)} />
                  ) : field === "other" || field === "government_id" ? (
                    <textarea id="correction-value" required rows={3} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
                  ) : (
                    <input id="correction-value" required className="input" value={value} onChange={(e) => setValue(e.target.value)} />
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="correction-reason">Anything HR should know? <span className="font-normal text-stone-400">(optional)</span></label>
                  <input id="correction-reason" className="input" placeholder="e.g. Name changed after marriage" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
                {error && <p role="alert" className="alert-error">{error}</p>}
                <div className="modal-actions"><button type="button" className="btn-secondary" onClick={close}>Cancel</button><button type="submit" className="btn-primary" disabled={loading || !value.trim()}>{loading ? "Sending…" : "Send to HR"}</button></div>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}

export function MyRecordRequests({ requests, timezone }: { requests: RecordRequest[]; timezone: string | undefined }) {
  const supabase = createClient();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function withdraw(id: string) {
    setBusyId(id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("cancel_employee_record_request", { p_request_id: id });
    if (rpcError) setError(rpcError.message);
    setBusyId(null);
    router.refresh();
  }

  if (requests.length === 0) return <p className="text-sm text-stone-400">You haven&apos;t made any requests.</p>;
  return (
    <div className="space-y-2">
      {error && <p role="alert" className="alert-error">{error}</p>}
      <ul className="divide-y divide-stone-100">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-stone-900">{r.kind === "data_access" ? "Copy of my personal information" : `Correct my ${r.field_label?.toLowerCase()}`}</p>
              {r.kind === "correction" && <p className="text-xs text-stone-500">Requested: {r.requested_value}</p>}
              <p className="text-xs text-stone-400">Sent {formatDate(r.requested_at, timezone, { dateStyle: "medium" })}{r.decided_at && r.status !== "pending" ? ` · ${REQUEST_STATUS_LABELS[r.status].toLowerCase()} ${formatDate(r.decided_at, timezone, { dateStyle: "medium" })}` : ""}</p>
              {r.decision_note && <p className="mt-1 text-xs text-stone-700">HR: “{r.decision_note}”</p>}
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${r.status === "approved" ? "badge-emerald" : r.status === "rejected" ? "badge-ruby" : r.status === "cancelled" ? "badge-neutral" : "badge-gold"}`}>{REQUEST_STATUS_LABELS[r.status]}</span>
              {r.status === "pending" && <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busyId === r.id} onClick={() => withdraw(r.id)}>Withdraw</button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// "My details are still correct" — confirm_my_profile().
export function ConfirmProfileButton() {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("confirm_my_profile");
    if (rpcError) setError(rpcError.message);
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" className="btn-primary" disabled={loading} onClick={confirm}><Icon name="check" size={15} /> {loading ? "Confirming…" : "Confirm my details are correct"}</button>
      {error && <span role="alert" className="text-xs text-ruby-600">{error}</span>}
    </div>
  );
}

// Self-service copy of the personal information HaloManage holds
// (get_my_personal_data()), downloaded as a JSON file.
export function DownloadMyDataButton() {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("get_my_personal_data");
    if (rpcError || !data) {
      setError(rpcError?.message ?? "Could not prepare your information.");
      setLoading(false);
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `my-employee-information-${new Date().toLocaleDateString("en-CA")}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setLoading(false);
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" className="btn-secondary" disabled={loading} onClick={download}><Icon name="download" size={15} /> {loading ? "Preparing…" : "Download my information"}</button>
      {error && <span role="alert" className="text-xs text-ruby-600">{error}</span>}
    </div>
  );
}

// A formal request to HR for everything held, including what self-service
// can't show (e.g. HR-only records).
export function RequestDataCopyButton({ hasPending }: { hasPending: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("submit_employee_record_request", {
      p_kind: "data_access", p_field_key: null, p_requested_value: null, p_reason: null,
    });
    if (rpcError) setError(rpcError.message);
    else setMessage("Request sent to HR. You'll be notified when it's complete.");
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" className="btn-secondary" disabled={loading || hasPending} onClick={request}>
        {hasPending ? "Formal request pending" : loading ? "Sending…" : "Formal request to HR"}
      </button>
      {message && <span role="status" className="text-xs text-emerald-700">{message}</span>}
      {error && <span role="alert" className="text-xs text-ruby-600">{error}</span>}
    </div>
  );
}
