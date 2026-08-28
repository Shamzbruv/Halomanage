"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

// Calls the invite-employee Edge Function (supabase/functions/invite-employee)
// rather than any direct Auth admin call from the browser — that admin
// operation requires the service_role key, which must never reach client
// code. See docs/ARCHITECTURE.md "Authentication strategy".
export function InviteButton({ employeeId, alreadyInvited, portalSlug }: { employeeId: string; alreadyInvited: boolean; portalSlug: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function invoke(resend: boolean) {
    setLoading(true);
    setError(null);
    setResent(false);
    const { error: invokeError } = await supabase.functions.invoke("invite-employee", {
      body: {
        employee_id: employeeId,
        redirect_to: `${window.location.origin}/auth/callback?next=${encodeURIComponent(`/update-password?portal=${portalSlug}`)}`,
        resend,
      },
    });
    if (invokeError) {
      setError(await resolveFunctionErrorMessage(invokeError, resend ? "Could not resend the invitation." : "Could not send the invitation."));
      setLoading(false);
      return;
    }
    setLoading(false);
    if (resend) {
      setResent(true);
    } else {
      router.refresh();
    }
  }

  if (alreadyInvited) {
    // A person can be stuck here indefinitely if their original invite
    // link never worked (the real incident this covers: the project's
    // Site URL was still the dev default of localhost:3000, so every
    // invite email ever sent had a dead link) — with no way to fix it
    // short of an admin editing the database directly. This gives that
    // path a UI instead: generates and sends a fresh link to the same
    // account rather than trying to create a new one, which Supabase
    // Auth won't allow for an email that already has a user.
    return (
      <div className="flex items-center gap-2">
        <span className="badge badge-neutral">Invited</span>
        <button className="btn-secondary px-2.5 py-1 text-xs" disabled={loading} onClick={() => invoke(true)}>
          {loading ? "Resending…" : "Resend"}
        </button>
        {resent && !error && <span className="text-xs text-emerald-600">Sent</span>}
        {error && <span className="text-xs text-ruby-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn-secondary px-3 py-1 text-xs" disabled={loading} onClick={() => invoke(false)}>
        {loading ? "Inviting…" : "Invite"}
      </button>
      {error && <span className="text-xs text-ruby-600">{error}</span>}
    </div>
  );
}
