"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export function RejectDocumentRequestButton({ requestId, employeeName }: { requestId: string; employeeName: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("reject_document_request", { p_request_id: requestId, p_reason: reason.trim() });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setOpen(false);
    setReason("");
    setLoading(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn-danger px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>Decline</button>
      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby={`reject-title-${requestId}`}>
          <button className="modal-backdrop" type="button" aria-label="Close" onClick={() => setOpen(false)} />
          <form className="modal-card" onSubmit={handleSubmit}>
            <div className="modal-head">
              <div><span className="eyebrow">Decline request</span><h3 id={`reject-title-${requestId}`}>Tell {employeeName} why</h3><p>They&apos;ll see this reason on their request.</p></div>
              <button className="icon-button" type="button" aria-label="Close" onClick={() => setOpen(false)}><Icon name="x" /></button>
            </div>
            <div><label className="label" htmlFor={`reject-reason-${requestId}`}>Reason</label><textarea id={`reject-reason-${requestId}`} className="input" required minLength={3} maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Please confirm your correct mailing address with HR first." /></div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="modal-actions"><button className="btn-secondary" type="button" onClick={() => setOpen(false)}>Back</button><button className="btn-danger" disabled={loading} type="submit">{loading ? "Declining…" : "Decline request"}</button></div>
          </form>
        </div>
      )}
    </>
  );
}
