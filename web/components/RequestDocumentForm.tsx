"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { REQUEST_TYPES } from "@/lib/documentRequests";

// Ref: 20260906100000_document_requests.sql request_document() — this only
// ever creates the request row. HR fulfilling it (FulfillDocumentRequestForm)
// is what actually creates the file, in the existing documents table.
export function RequestDocumentForm() {
  const supabase = createClient();
  const router = useRouter();
  const [requestType, setRequestType] = useState<(typeof REQUEST_TYPES)[number]["value"]>("employment_verification");
  const [otherLabel, setOtherLabel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    const { error } = await supabase.rpc("request_document", {
      p_request_type: requestType,
      p_request_type_other_label: requestType === "other" ? otherLabel.trim() : null,
      p_purpose: purpose.trim() || null,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setOtherLabel("");
    setPurpose("");
    setSuccess(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="label" htmlFor="request-type">What do you need?</label>
        <select id="request-type" className="input" value={requestType} onChange={(event) => setRequestType(event.target.value as typeof requestType)}>
          {REQUEST_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        </select>
      </div>
      {requestType === "other" && (
        <div>
          <label className="label" htmlFor="request-other-label">Describe what you need</label>
          <input id="request-other-label" required className="input" value={otherLabel} onChange={(event) => setOtherLabel(event.target.value)} placeholder="e.g. Tax registration letter" />
        </div>
      )}
      <div>
        <label className="label" htmlFor="request-purpose">What is it for? (optional, but helps HR prepare it correctly)</label>
        <textarea id="request-purpose" className="input" rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="e.g. For a bank loan application, addressed to Scotia Bank" />
      </div>
      {error && <p className="alert-error" role="alert">{error}</p>}
      {success && <p className="text-xs font-medium text-emerald-700">Request submitted — HR will be in touch once it&apos;s ready.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Submitting…" : "Submit request"}</button>
    </form>
  );
}
