"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Starts an employee-information verification round: every active employee
// with an account gets a required notification to review and confirm their
// details (request_profile_confirmation()). Progress shows on People.
export function RequestProfileConfirmationButton({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!window.confirm("Ask every active employee to review and confirm their details?")) return;
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("request_profile_confirmation", { p_organization_id: organizationId });
    if (rpcError) setError(rpcError.message);
    else setMessage(`Sent to ${Number(data ?? 0)} employee${Number(data) === 1 ? "" : "s"}.`);
    setLoading(false);
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" className="btn-secondary" disabled={loading} onClick={send}>{loading ? "Sending…" : "Ask everyone to confirm their details"}</button>
      {message && <span role="status" className="text-xs text-emerald-700">{message}</span>}
      {error && <span role="alert" className="text-xs text-ruby-600">{error}</span>}
    </div>
  );
}
