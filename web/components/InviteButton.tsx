"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

// Calls the invite-employee Edge Function (supabase/functions/invite-employee)
// rather than any direct Auth admin call from the browser — that admin
// operation requires the service_role key, which must never reach client
// code. See docs/ARCHITECTURE.md "Authentication strategy".
export function InviteButton({
  employeeId,
  alreadyInvited,
  accepted,
  portalSlug,
}: {
  employeeId: string;
  alreadyInvited: boolean;
  // Only meaningful when alreadyInvited is true — resolved separately via
  // list_employee_invite_status() (auth.users.last_sign_in_at), since
  // employees.user_id alone only ever meant "an account was created," not
  // "they actually signed in and accepted it."
  accepted: boolean;
  portalSlug: string;
}) {
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
        redirect_to: `${window.location.origin}/update-password?portal=${portalSlug}`,
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

  if (alreadyInvited && accepted) {
    // Matches the Edge Function's own rule (last_sign_in_at set means
    // "there's nothing to resend") — no Resend button shown for the same
    // reason, rather than letting someone click it into an error.
    return <span className="badge badge-emerald">Accepted</span>;
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
      <div className="flex max-w-[220px] flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="badge badge-gold">Pending</span>
          <button className="btn-secondary shrink-0 px-2.5 py-1 text-xs" disabled={loading} onClick={() => invoke(true)}>
            {loading ? "Resending…" : "Resend"}
          </button>
        </div>
        {resent && !error && <span className="text-xs text-emerald-600">Sent — check their inbox.</span>}
        {error && <span className="text-xs leading-snug text-ruby-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex max-w-[220px] flex-col gap-1">
      <button className="btn-secondary w-fit px-3 py-1 text-xs" disabled={loading} onClick={() => invoke(false)}>
        {loading ? "Inviting…" : "Invite"}
      </button>
      {error && <span className="text-xs leading-snug text-ruby-600">{error}</span>}
    </div>
  );
}
