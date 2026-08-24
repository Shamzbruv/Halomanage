"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Calls the invite-employee Edge Function (supabase/functions/invite-employee)
// rather than any direct Auth admin call from the browser — that admin
// operation requires the service_role key, which must never reach client
// code. See docs/ARCHITECTURE.md "Authentication strategy".
export function InviteButton({ employeeId, alreadyInvited, portalSlug }: { employeeId: string; alreadyInvited: boolean; portalSlug: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (alreadyInvited) {
    return <span className="badge badge-neutral">Invited</span>;
  }

  async function handleInvite() {
    setLoading(true);
    setError(null);
    const { error } = await supabase.functions.invoke("invite-employee", {
      body: {
        employee_id: employeeId,
        redirect_to: `${window.location.origin}/auth/callback?next=${encodeURIComponent(`/update-password?portal=${portalSlug}`)}`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn-secondary px-3 py-1 text-xs" disabled={loading} onClick={handleInvite}>
        {loading ? "Inviting…" : "Invite"}
      </button>
      {error && <span className="text-xs text-ruby-600">{error}</span>}
    </div>
  );
}
